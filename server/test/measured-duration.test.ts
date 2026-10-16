import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase, scaffoldProject } from "../src/planning/artifacts.js";
import {
  claimCommentTime, composeClaimComment, gitSpan, headCommit, isClaimComment,
  measureAtClose, measuredText,
} from "../src/planning/duration.js";
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
});
