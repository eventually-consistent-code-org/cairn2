import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase, scaffoldProject } from "../src/planning/artifacts.js";
import {
  claimCommentTime, closeEvidenceText, composeClaimComment, composeCloseComment, gitSpan,
  headCommit, isClaimComment, measureAtClose, measuredText,
} from "../src/planning/duration.js";
import { metricsPath } from "../src/core/continuity.js";
import { issueCostUsd } from "../src/core/metrics.js";
import { readClaim, readClaimRecord, receiptsDir } from "../src/planning/close-receipt.js";

// The work verb's real claim comment opens this way -- every issue in this
// repo since phase 21 was claimed with it, so it is the shape rung one must
// recognise.
const CLAIM = "Starting now. Phase 24.7, wave 1, second task.\n\nBase commit:\n4777015";
const T0 = "2026-10-01T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

describe("isClaimComment", () => {
  it("recognises the work verb's claim comment", () => {
    expect(isClaimComment(CLAIM)).toBe(true);
  });

  it("recognises every shape the server itself composes (#343)", () => {
    expect(isClaimComment(composeClaimComment({ baseCommit: "a1b2c3d4e5f6" }))).toBe(true);
    expect(isClaimComment(composeClaimComment({
      baseCommit: "a1b2c3d4e5f6", wave: "2", task: "the adapter", verifyCommand: "npm test",
    }))).toBe(true);
    // one phrase, one place: the composer and the parser agree by construction
    expect(composeClaimComment({ baseCommit: "a1b2c3d4e5f6", task: "the adapter." }))
      .toBe("Starting now. the adapter.\n\nBase: a1b2c3d");
    // a non-hex base (a tag, a branch) is quoted back whole, never truncated
    expect(composeClaimComment({ baseCommit: "v2.8.3" })).toBe("Starting now.\n\nBase: v2.8.3");
  });

  it("does not mistake progress, close, or evidence comments for a claim", () => {
    expect(isClaimComment("Done. The close step now leaves a small receipt.")).toBe(false);
    expect(isClaimComment("evidence: `npm test` → 12 passed")).toBe(false);
    expect(isClaimComment("RED committed; GREEN next, starting now on the adapter.")).toBe(false);
  });
});

describe("the ladder at close (rungs one and two)", () => {
  it("rung one: the claim comment's timestamp to close", () => {
    const m = measureAtClose({
      comments: [{ text: CLAIM, at: T0 }, { text: "progress", at: at(5) }],
      observedClaimAt: at(2), closedAt: at(12),
    });
    expect(m).toEqual({ minutes: 12, source: "claim_comment", claimedAt: T0 });
  });

  it("the earliest claim wins -- a re-claim after a park still measures from first pickup", () => {
    expect(claimCommentTime([
      { text: CLAIM, at: at(30) }, { text: CLAIM, at: T0 },
    ])).toBe(T0);
  });

  it("rung two: no comment enumeration falls to the claim the server saw", () => {
    const m = measureAtClose({ observedClaimAt: T0, closedAt: at(9) });
    expect(m).toEqual({ minutes: 9, source: "observed_claim", claimedAt: T0 });
  });

  it("a claim comment stamped after the close is skew, not a duration -- next rung", () => {
    const m = measureAtClose({
      comments: [{ text: CLAIM, at: at(20) }], observedClaimAt: T0, closedAt: at(10),
    });
    expect(m.source).toBe("observed_claim");
  });

  it("nothing derivable records none rather than guessing", () => {
    const m = measureAtClose({ comments: [], observedClaimAt: null, closedAt: at(10) });
    expect(m).toEqual({ minutes: null, source: "none", claimedAt: null });
    expect(measuredText(m)).toMatch(/not derivable at close/);
  });
});

describe("rung three: git span over the commit range", () => {
  let dir: string;
  let base: string;
  let head: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commitAt = (file: string, author: string, committer: string) => {
    writeFileSync(join(dir, file), file);
    git("add", file);
    execFileSync("git", ["commit", "-qm", file, "--no-gpg-sign"], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer },
    });
    return git("rev-parse", "HEAD");
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-span-"));
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    base = commitAt("base", at(-60), at(-60));
    commitAt("a", at(0), at(1));
    head = commitAt("b", at(10), at(25));
  });

  it("first author date to last committer date", () => {
    expect(gitSpan(dir, base, head)).toEqual({ minutes: 25, source: "git_span" });
  });

  it("an empty range or an unknown sha is none, never a throw", () => {
    expect(gitSpan(dir, head, head)).toEqual({ minutes: null, source: "none" });
    expect(gitSpan(dir, "deadbee", head)).toEqual({ minutes: null, source: "none" });
  });
});

describe("issue_close measures, ledger_append records (through the tools)", () => {
  class NoCommentListing extends FakeTracker {
    override listComments = undefined as unknown as FakeTracker["listComments"];
  }
  class WorklogFake extends FakeTracker {
    override readonly capabilities = { ...new FakeTracker().capabilities, hasWorklog: true };
    logged: number[] = [];
    async logWork(_id: string, minutes: number): Promise<void> { this.logged.push(minutes); }
  }

  // The project dir is a bare temp folder -- no git -- unless `git` is asked
  // for, in which case it is a repository with one commit so HEAD resolves.
  const harness = async (tracker: FakeTracker, opts: { git?: boolean } = {}) => {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-measure-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    scaffoldProject(projectDir, "P");
    scaffoldPhase(projectDir, 1, "Core");
    if (opts.git) {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: projectDir, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.email", "t@t");
      git("config", "user.name", "t");
      git("add", "cairn.json");
      execFileSync("git", ["commit", "-qm", "base", "--no-gpg-sign"], { cwd: projectDir });
    }
    let clock = Date.parse(T0);
    const now = () => new Date(clock);
    tracker.now = now;
    const server = buildServer({ projectDir, tracker, now });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "measure", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { ...res, json: JSON.parse(text) };
    };
    return { call, projectDir, advance: (min: number) => { clock += min * 60_000; } };
  };
  const append = (id: string) => ({
    phaseDir: "01-core", taskRef: id, summary: "s",
    baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
    issueId: id, closedDate: "2026-10-01",
    evidence: { command: "npm test", result: "1 passed" },
  });

  it("rung one end to end; a disagreeing claim is kept beside the measurement", async () => {
    const tracker = new FakeTracker();
    const { call, advance } = await harness(tracker);
    const made = await call("issue_create", { title: "measured" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    await call("issue_comment", { id: made.json.id, text: CLAIM });
    advance(12);
    const closed = await call("issue_close", {
      id: made.json.id, timeSpentMinutes: 128, evidence: { command: "npm test", result: "1 passed" },
    });
    expect(closed.json.measured).toEqual({ minutes: 12, source: "claim_comment" });
    expect(closed.json.claimedMinutes).toBe(128);
    expect(tracker.comments(made.json.id).at(-1)!.text)
      .toBe("evidence: `npm test` → 1 passed\nmeasured: ~12m (claim comment to close)");
    const line = (await call("ledger_append", append(made.json.id))).json.line;
    expect(line).toContain("actuals wall=12m:claim_comment claimed=128m");
  });

  it("rung one from the server-composed claim: one issue_update call starts the clock (#343)", async () => {
    const tracker = new FakeTracker();
    const { call, advance } = await harness(tracker);
    const made = await call("issue_create", { title: "claimed by the server" });
    const wip = await call("issue_update", {
      id: made.json.id, claim: { baseCommit: "a1b2c3d4e5f6", wave: "1", task: "first task" },
    });
    expect(wip.json.claimCommented).toBe(true);
    advance(12);
    const closed = await call("issue_close", {
      id: made.json.id, evidence: { command: "npm test", result: "1 passed" },
    });
    expect(closed.json.measured).toEqual({ minutes: 12, source: "claim_comment" });
    const line = (await call("ledger_append", append(made.json.id))).json.line;
    expect(line).toContain("actuals wall=12m:claim_comment");
  });

  it("rung two on a backend that cannot list comments, and it says which", async () => {
    const { call, advance } = await harness(new NoCommentListing());
    const made = await call("issue_create", { title: "no listing" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    advance(7);
    const closed = await call("issue_close", { id: made.json.id });
    expect(closed.json.measured).toEqual({ minutes: 7, source: "observed_claim" });
    const line = (await call("ledger_append", append(made.json.id))).json.line;
    expect(line).toContain("actuals wall=7m:observed_claim claimed=none");
  });

  it("a re-claim does not restart the observed clock", async () => {
    const { call, advance } = await harness(new NoCommentListing());
    const made = await call("issue_create", { title: "parked" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    advance(5);
    await call("issue_update", { id: made.json.id, state: "open" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    advance(5);
    const closed = await call("issue_close", { id: made.json.id });
    expect(closed.json.measured.minutes).toBe(10);
  });

  it("a close with nothing derivable records none -- the append then has only git", async () => {
    const { call } = await harness(new NoCommentListing());
    const made = await call("issue_create", { title: "never claimed" });
    const closed = await call("issue_close", { id: made.json.id });
    expect(closed.json.measured).toEqual({ minutes: null, source: "none" });
    const appended = (await call("ledger_append", append(made.json.id))).json;
    // fake shas: git has nothing either, and the line says so
    expect(appended.line).toContain("actuals wall=none claimed=none");
    expect(appended.measured).toEqual({ minutes: null, source: "none" });
  });

  it("the worklog gets the measured minutes, not the claim", async () => {
    const tracker = new WorklogFake();
    const { call, advance } = await harness(tracker);
    const made = await call("issue_create", { title: "logged" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    advance(11);
    const closed = await call("issue_close", { id: made.json.id, timeSpentMinutes: 90 });
    expect(closed.json.worklogLogged).toBe(true);
    expect(tracker.logged).toEqual([11]);
  });

  // Claim block, round two (#369): the server resolves the base commit and
  // keeps it in the receipt; issue_create takes the same block.
  describe("the base commit is the server's to resolve (#369)", () => {
    const sha40 = /^[0-9a-f]{40}$/;

    it("issue_update with no baseCommit resolves HEAD and reports it", async () => {
      const tracker = new FakeTracker();
      const { call, projectDir } = await harness(tracker, { git: true });
      const head = headCommit(projectDir)!;
      expect(head).toMatch(sha40);
      const made = await call("issue_create", { title: "resolved" });
      const wip = await call("issue_update", {
        id: made.json.id, claim: { wave: "1", task: "the resolver" },
      });
      expect(wip.isError).toBeFalsy();
      expect(wip.json.baseCommit).toBe(head);
      expect(wip.json.claimCommented).toBe(true);
      expect(wip.json.claimAt).toBe(T0);
      // the comment carries the short ref of the commit the server read
      expect(tracker.comments(made.json.id).at(-1)!.text)
        .toBe(`Starting now. Wave 1: the resolver.\n\nBase: ${head.slice(0, 7)}`);
    });

    it("the receipt carries baseCommit beside the time; the old shape still parses", async () => {
      const { call, projectDir } = await harness(new FakeTracker(), { git: true });
      const head = headCommit(projectDir)!;
      const made = await call("issue_create", { title: "receipted" });
      await call("issue_update", { id: made.json.id, claim: { task: "receipt" } });
      expect(readClaimRecord(projectDir, made.json.id))
        .toEqual({ issueId: made.json.id, at: T0, baseCommit: head });
      expect(readClaim(projectDir, made.json.id)).toBe(T0);
      // a stamp from before #369 -- two fields, no commit -- is not a corrupt stamp
      writeFileSync(join(receiptsDir(projectDir), "OLD-1.claim.json"),
        JSON.stringify({ issueId: "OLD-1", at: T0 }) + "\n");
      expect(readClaimRecord(projectDir, "OLD-1")).toEqual({ issueId: "OLD-1", at: T0 });
      expect(readClaim(projectDir, "OLD-1")).toBe(T0);
    });

    it("an explicit baseCommit still wins over HEAD", async () => {
      const { call, projectDir } = await harness(new FakeTracker(), { git: true });
      const made = await call("issue_create", { title: "explicit" });
      const wip = await call("issue_update", {
        id: made.json.id, claim: { baseCommit: "a1b2c3d4e5f6" },
      });
      expect(wip.json.baseCommit).toBe("a1b2c3d4e5f6");
      expect(readClaimRecord(projectDir, made.json.id)!.baseCommit).toBe("a1b2c3d4e5f6");
    });

    it("a bare in_progress transition stamps the time and no commit", async () => {
      const { call, projectDir } = await harness(new FakeTracker(), { git: true });
      const made = await call("issue_create", { title: "bare" });
      await call("issue_update", { id: made.json.id, state: "in_progress" });
      expect(readClaimRecord(projectDir, made.json.id)).toEqual({ issueId: made.json.id, at: T0 });
    });

    it("no git and no baseCommit: a typed refusal, before any tracker write", async () => {
      const tracker = new FakeTracker();
      const { call } = await harness(tracker);
      const made = await call("issue_create", { title: "no git" });
      const res = await call("issue_update", { id: made.json.id, claim: { task: "x" } });
      expect(res.isError).toBe(true);
      expect(res.json.code).toBe("PRECONDITION_FAILED");
      expect(res.json.message).toMatch(/no git HEAD/);
      expect(res.json.nextAction).toMatch(/claim\.baseCommit/);
      // nothing moved: still open, no claim comment
      expect((await call("issue_get", { id: made.json.id })).json.category).toBe("open");
      expect(tracker.comments(made.json.id)).toEqual([]);
      // the explicit form keeps working without git
      const wip = await call("issue_update", {
        id: made.json.id, claim: { baseCommit: "a1b2c3d4e5f6", task: "x" },
      });
      expect(wip.json.baseCommit).toBe("a1b2c3d4e5f6");
    });

    it("issue_create with a claim creates and claims in one call", async () => {
      const tracker = new FakeTracker();
      const { call, projectDir, advance } = await harness(tracker, { git: true });
      const head = headCommit(projectDir)!;
      const made = await call("issue_create", {
        title: "one call", labels: ["fast"],
        claim: { wave: "1", task: "create and claim", verifyCommand: "npm test" },
      });
      expect(made.isError).toBeFalsy();
      expect(made.json.category).toBe("in_progress");
      expect(made.json.labels).toEqual(["fast"]);
      expect(made.json.claimAt).toBe(T0);
      expect(made.json.baseCommit).toBe(head);
      expect(made.json.claimCommented).toBe(true);
      // the same composed comment the update path posts
      expect(tracker.comments(made.json.id).map((c) => c.text)).toEqual([
        "Starting now. Wave 1: create and claim.\n\nDeclared verify: `npm test`\n\n"
        + `Base: ${head.slice(0, 7)}`,
      ]);
      // the same receipt
      expect(readClaimRecord(projectDir, made.json.id))
        .toEqual({ issueId: made.json.id, at: T0, baseCommit: head });
      // and the same clock: rung one measures from the create-and-claim
      advance(12);
      const closed = await call("issue_close", {
        id: made.json.id, evidence: { command: "npm test", result: "1 passed" },
      });
      expect(closed.json.measured).toEqual({ minutes: 12, source: "claim_comment" });
    });

    it("issue_create with a claim and no git is refused before the issue exists", async () => {
      const tracker = new FakeTracker();
      const { call } = await harness(tracker);
      const res = await call("issue_create", { title: "orphan?", claim: { task: "x" } });
      expect(res.isError).toBe(true);
      expect(res.json.code).toBe("PRECONDITION_FAILED");
      expect((await call("issue_list", {})).json).toEqual([]);
    });

    it("issue_create without a claim is unchanged: open, no stamp, no comment", async () => {
      const tracker = new FakeTracker();
      const { call, projectDir } = await harness(tracker, { git: true });
      const made = await call("issue_create", { title: "plain" });
      expect(made.json.category).toBe("open");
      expect(made.json.claimAt).toBeUndefined();
      expect(made.json.baseCommit).toBeUndefined();
      expect(readClaimRecord(projectDir, made.json.id)).toBeNull();
      expect(tracker.comments(made.json.id)).toEqual([]);
    });

    it("headCommit is null outside a repository, never a throw", () => {
      expect(headCommit(mkdtempSync(join(tmpdir(), "cairn-nogit-")))).toBeNull();
    });

    it("the claim file on disk is the shape the close fold will read", async () => {
      const { call, projectDir } = await harness(new FakeTracker(), { git: true });
      const made = await call("issue_create", { title: "on disk", claim: {} });
      const raw = readFileSync(join(receiptsDir(projectDir), `${made.json.id}.claim.json`), "utf8");
      expect(JSON.parse(raw)).toEqual({
        issueId: made.json.id, at: T0, baseCommit: headCommit(projectDir),
      });
    });
  });

  describe("the close fold: issue_close(summary) writes the comment and the ledger line (#365)", () => {
    // The cost line reads the metrics log under ~/.cairn, so HOME is a temp
    // folder for this block -- a fixture log, and no real one touched.
    let savedHome: string | undefined;
    beforeAll(() => {
      savedHome = process.env.HOME;
      process.env.HOME = mkdtempSync(join(tmpdir(), "cairn-fold-home-"));
    });
    afterAll(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    const EVIDENCE = { command: "npm test", result: "1 passed" };
    // A claimed issue in a repository, one commit of work past its base,
    // twelve minutes on the clock, phase 1 active.
    const claimed = async (tracker = new FakeTracker()) => {
      const h = await harness(tracker, { git: true });
      const base = headCommit(h.projectDir)!;
      const made = await h.call("issue_create", { title: "fold", claim: { wave: "2", task: "fold" } });
      writeFileSync(join(h.projectDir, "work.txt"), "done\n");
      execFileSync("git", ["add", "work.txt"], { cwd: h.projectDir });
      execFileSync("git", ["commit", "-qm", "work", "--no-gpg-sign"], { cwd: h.projectDir });
      const head = headCommit(h.projectDir)!;
      await h.call("context_set", { phase: 1, issueId: made.json.id });
      h.advance(12);
      return { ...h, tracker, id: made.json.id as string, base, head };
    };
    const ledgerFile = (projectDir: string) =>
      join(projectDir, ".cairn", "plans", "phases", "01-core", "LEDGER.md");

    it("composes the close comment: summary, range, evidence + measured, agent cost", async () => {
      const { call, tracker, id, base, head, projectDir } = await claimed();
      const log = metricsPath(projectDir);
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, [
        { session_id: "s1", issue: id, est_cost_usd: 0.5 },
        { session_id: "s1", issue: id, est_cost_usd: 1.25 }, // cumulative: replaces, never adds
        { session_id: "s2", issue: `#${id}`, est_cost_usd: 0.5 },
        { session_id: "s3", issue: "elsewhere", est_cost_usd: 9 },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      const closed = await call("issue_close", { id, summary: "Close fold shipped", evidence: EVIDENCE });
      expect(closed.isError).toBeFalsy();
      expect(closed.json.category).toBe("closed");
      expect(tracker.comments(id).at(-1)!.text).toBe(
        "Close fold shipped\n\n"
        + `Commits: ${base.slice(0, 7)}..${head.slice(0, 7)}\n\n`
        + "evidence: `npm test` → 1 passed\n"
        + "measured: ~12m (claim comment to close)\n"
        + "agent cost: ~$1.75 (approximate)");
      // one comment for the close, beside the claim's -- not two
      expect(tracker.comments(id)).toHaveLength(2);
    });

    it("appends the ledger line in the same call, carrying the receipt's measured segment", async () => {
      const { call, id, base, head, projectDir } = await claimed();
      const closed = await call("issue_close", { id, summary: "Close fold shipped", evidence: EVIDENCE });
      const line = `- [x] ${id} — Close fold shipped — commits ${base.slice(0, 7)}..${head.slice(0, 7)} — `
        + "evidence npm test => 1 passed — "
        + "actuals wall=12m:claim_comment claimed=none est=none worklog=not_requested — "
        + `${id} closed 2026-10-01`;
      expect(closed.json.ledger.line).toBe(line);
      expect(closed.json.ledger.line).not.toContain("degraded");
      expect(closed.json.ledger.degraded).toBeUndefined();
      expect(closed.json.ledger.measured).toEqual({ minutes: 12, source: "claim_comment" });
      expect(readFileSync(ledgerFile(projectDir), "utf8").trimEnd().split("\n").at(-1)).toBe(line);
      // no cost rows for this issue: no agent-cost line, never a $0.00 one
      expect(closed.json.ledgerError).toBeUndefined();
    });

    it("an explicit phaseDir and the tdd pair reach the line", async () => {
      const { call, id } = await claimed();
      const closed = await call("issue_close", {
        id, summary: "tdd task", evidence: EVIDENCE,
        ledger: { phaseDir: "01-core", redCommit: "1111111aaaa", greenCommit: "2222222bbbb" },
      });
      expect(closed.json.ledger.line).toContain(" — tdd 1111111..2222222 — evidence npm test");
    });

    it("a close without summary behaves exactly as today: one evidence comment, no ledger line", async () => {
      const { call, tracker, id, projectDir } = await claimed();
      const closed = await call("issue_close", { id, evidence: EVIDENCE });
      expect(closed.isError).toBeFalsy();
      expect(tracker.comments(id).at(-1)!.text)
        .toBe("evidence: `npm test` → 1 passed\nmeasured: ~12m (claim comment to close)");
      expect(closed.json.ledger).toBeUndefined();
      expect(closed.json.receiptWritten).toBe(true);
      expect(existsSync(ledgerFile(projectDir))).toBe(false);
      // the receipt waits for the hand-made append, as it always has
      const appended = await call("ledger_append", append(id));
      expect(appended.json.line).toContain("actuals wall=12m:claim_comment claimed=none");
    });

    // Every refusal lands while the issue is still open: no comment, no
    // close, no line, the claim clock where it was.
    const refusedBeforeClose = async (
      args: Record<string, unknown>, code: string, setup?: (h: Awaited<ReturnType<typeof claimed>>) => Promise<void>,
    ) => {
      const h = await claimed();
      await setup?.(h);
      const before = h.tracker.comments(h.id).length;
      const res = await h.call("issue_close", { id: h.id, ...args });
      expect(res.isError).toBe(true);
      expect(res.json.code).toBe(code);
      expect((await h.call("issue_get", { id: h.id })).json.category).toBe("in_progress");
      expect(h.tracker.comments(h.id)).toHaveLength(before);
      expect(existsSync(ledgerFile(h.projectDir))).toBe(false);
      expect(readClaim(h.projectDir, h.id)).toBe(T0);
      return res;
    };

    it("summary without evidence is refused before the close", async () => {
      await refusedBeforeClose({ summary: "no proof" }, "PRECONDITION_FAILED");
    });

    it("a ledger block without summary is refused before the close", async () => {
      await refusedBeforeClose({ evidence: EVIDENCE, ledger: { phaseDir: "01-core" } }, "CONFIG_INVALID");
    });

    it("half a tdd pair is the ledger's own refusal, raised before the close", async () => {
      await refusedBeforeClose(
        { summary: "s", evidence: EVIDENCE, ledger: { redCommit: "1111111" } }, "CONFIG_INVALID");
    });

    it("an unknown phase dir is refused before the close", async () => {
      await refusedBeforeClose(
        { summary: "s", evidence: EVIDENCE, ledger: { phaseDir: "09-nowhere" } }, "NOT_FOUND");
    });

    it("no phaseDir and no active phase is refused before the close", async () => {
      await refusedBeforeClose({ summary: "s", evidence: EVIDENCE }, "PRECONDITION_FAILED",
        async (h) => { await h.call("context_set", { phase: null }); });
    });

    it("a claim with no recorded base commit is refused, never guessed", async () => {
      const tracker = new FakeTracker();
      const h = await harness(tracker, { git: true });
      const made = await h.call("issue_create", { title: "bare" });
      await h.call("issue_update", { id: made.json.id, state: "in_progress" }); // no claim block
      await h.call("context_set", { phase: 1 });
      const res = await h.call("issue_close", { id: made.json.id, summary: "s", evidence: EVIDENCE });
      expect(res.isError).toBe(true);
      expect(res.json.code).toBe("PRECONDITION_FAILED");
      expect(res.json.message).toContain("base commit");
      expect((await h.call("issue_get", { id: made.json.id })).json.category).toBe("in_progress");
    });
  });
});

describe("composeCloseComment and issueCostUsd (#365)", () => {
  const measured = { minutes: 12, source: "claim_comment" as const };
  it("short refs for shas, no cost line at zero", () => {
    expect(composeCloseComment({
      summary: "  shipped  ", baseCommit: "a1b2c3d4e5f6a1b2", headCommit: "d4e5f6a1b2c3d4e5",
      evidence: { command: " npm test ", result: " 3 passed " }, measured, costUsd: 0,
    })).toBe("shipped\n\nCommits: a1b2c3d..d4e5f6a\n\n"
      + "evidence: `npm test` → 3 passed\nmeasured: ~12m (claim comment to close)");
  });

  it("the no-summary block is the same evidence + measured text the close always posted", () => {
    expect(closeEvidenceText(measured, { command: "npm test", result: "1 passed" }))
      .toBe("evidence: `npm test` → 1 passed\nmeasured: ~12m (claim comment to close)");
    expect(closeEvidenceText({ minutes: null, source: "none" })).toBe(measuredText({ minutes: null, source: "none" }));
  });

  it("latest row per session across segments, # ignored, absent log is 0", () => {
    const d = mkdtempSync(join(tmpdir(), "cairn-cost-"));
    const live = join(d, "p-abc.jsonl");
    expect(issueCostUsd(live, "7")).toBe(0);
    writeFileSync(join(d, "p-abc.20261001T000000Z.jsonl"),
      JSON.stringify({ session_id: "s1", issue: "7", est_cost_usd: 1 }) + "\n");
    writeFileSync(live, [
      JSON.stringify({ session_id: "s1", issue: "7", est_cost_usd: 2 }),
      "{ corrupt",
      JSON.stringify({ session_id: "s2", issue: "#7", est_cost_usd: 0.25 }),
      JSON.stringify({ issue: "7", est_cost_usd: 100 }), // unattributable -- skipped
    ].join("\n") + "\n");
    expect(issueCostUsd(live, "#7")).toBe(2.25);
  });
});
