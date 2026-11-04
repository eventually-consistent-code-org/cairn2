// The circuit breaker's server half (#358), end to end: the real run guard
// freezes a live run by writing its manifest, then the server that named
// the run refuses its claims and closes with RUN_FROZEN, posts the one
// plain-language comment the freeze owes, and carries `frozen` on the
// outlook emit. A second server -- another session, the owner's -- that
// never named the run is never frozen. The run is staged with its session's
// id (#431), the one whose refusals the breaker counts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { runManifestPath } from "../src/planning/run-manifest.js";

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts", "pretooluse-runguard.mjs");
const RUN = "run-frz";
const estimate = { low: 1, high: 2, estUsd: { low: 0, high: 0 } };

describe("a frozen run's claims and closes refuse RUN_FROZEN (#358)", () => {
  // run_manifest writes under ~/.cairn/runs, so HOME is a scratch dir for
  // this file -- a running manifest must never land in the real home
  let savedHome: string | undefined;
  let home: string;
  let projectDir: string;
  const run: { tracker: FakeTracker; client: Client } = {} as never;
  const owner: { tracker: FakeTracker; client: Client } = {} as never;

  async function connect(into: { tracker: FakeTracker; client: Client }, name: string): Promise<void> {
    into.tracker = new FakeTracker();
    const server = buildServer({ projectDir, tracker: into.tracker });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    into.client = new Client({ name, version: "0.0.0" });
    await Promise.all([server.connect(st), into.client.connect(ct)]);
  }

  const call = async (who: { client: Client }, name: string, args: Record<string, unknown> = {}) => {
    const res = await who.client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: res.isError === true, json: JSON.parse(text) };
  };

  /** One run-guard refusal from the run's session, judged against this file's cairn home. */
  const refuse = () => spawnSync(process.execPath, [RUNGUARD], {
    cwd: projectDir, encoding: "utf8", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CAIRN_HOME: join(home, ".cairn") },
    input: JSON.stringify({
      tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: projectDir, session_id: "sess-run",
    }),
  });

  const manifest = () => JSON.parse(readFileSync(runManifestPath(projectDir, RUN, join(home, ".cairn")), "utf8"));

  beforeAll(async () => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cairn-breaker-home-"));
    process.env.HOME = home;
    projectDir = mkdtempSync(join(tmpdir(), "cairn-breaker-proj-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    await connect(run, "test-breaker-run");
    await connect(owner, "test-breaker-owner");
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("stages, runs, freezes, then refuses claim and close, commenting once", async () => {
    // the run's server stages and starts the run -- naming it binds them
    expect((await call(run, "run_manifest", {
      action: "create", runId: RUN, phases: [{ number: 1, name: "one", estimate }], sessionId: "sess-run",
    })).isError).toBe(false);
    await call(run, "run_manifest", { action: "set_status", runId: RUN, status: "running" });
    await call(run, "run_manifest", { action: "set_phase", runId: RUN, phase: 1 });
    const issue = (await call(run, "issue_create", { title: "task one" })).json;
    const claimed = await call(run, "issue_update", { id: issue.id, claim: { baseCommit: "abc1234" } });
    expect(claimed.isError).toBe(false); // live and unfrozen: an ordinary claim

    // three guard refusals in the run's session freeze it
    for (let i = 0; i < 3; i++) expect(refuse().status).toBe(2);
    expect(manifest().status).toBe("stopped");
    expect(manifest().stop.reason).toBe("breaker");
    const before = run.tracker.comments(issue.id).length;

    const claim = await call(run, "issue_update", { id: issue.id, claim: { baseCommit: "abc1234" } });
    expect(claim.isError).toBe(true);
    expect(claim.json.code).toBe("RUN_FROZEN");
    expect(claim.json.message).toContain(`batch run '${RUN}' is frozen`);
    expect(claim.json.nextAction).toContain("/cairn:auto --batch");
    const added = run.tracker.comments(issue.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].text).toMatch(/^Batch run run-frz was frozen by cairn's circuit breaker/);
    expect(added[0].text).toContain("the run guard refused `git reset --hard` (discards-work)");
    expect(added[0].text).not.toContain(projectDir);
    expect(manifest().stop.commentedOn).toBe(issue.id);

    // close refuses too, before any tracker write -- and the comment isn't repeated
    const close = await call(run, "issue_close", { id: issue.id });
    expect(close.json.code).toBe("RUN_FROZEN");
    expect(run.tracker.comments(issue.id).slice(before)).toHaveLength(1);
    expect((await run.tracker.getIssue(issue.id)).category).not.toBe("closed");

    // a plain in_progress move is a claim; a create-and-claim leaves no orphan; a title edit is neither
    expect((await call(run, "issue_update", { id: issue.id, state: "in_progress" })).json.code).toBe("RUN_FROZEN");
    const count = (await run.tracker.listIssues()).length;
    expect((await call(run, "issue_create", { title: "orphan", claim: { baseCommit: "abc1234" } })).json.code)
      .toBe("RUN_FROZEN");
    expect(await run.tracker.listIssues()).toHaveLength(count);
    expect((await call(run, "issue_update", { id: issue.id, title: "task one, renamed" })).isError).toBe(false);
  });

  it("the owner's session never named the run, so it is never frozen", async () => {
    const mine = (await call(owner, "issue_create", { title: "owner work" })).json;
    const claim = await call(owner, "issue_update", { id: mine.id, claim: { baseCommit: "abc1234" } });
    expect(claim.isError).toBe(false);
    expect(claim.json.claimAt).toBeDefined();
    expect((await call(owner, "issue_close", { id: mine.id })).isError).toBe(false);
  });

  it("the run's manifest moves refuse RUN_FROZEN; the wrap's stop is a no-op; outlook_emit carries frozen", async () => {
    expect((await call(run, "run_manifest", { action: "set_phase", runId: RUN, phase: 1 })).json.code)
      .toBe("RUN_FROZEN");
    const stop = await call(run, "run_manifest", { action: "set_status", runId: RUN, status: "stopped" });
    expect(stop.isError).toBe(false);
    expect(stop.json.status).toBe("stopped");
    const read = await call(run, "run_manifest", { action: "read", runId: RUN });
    expect(read.json.stop.refusals).toHaveLength(3); // what the run report lists
    expect(read.json.sessionId).toBe("sess-run"); // the session staging named (#431), as the tool carried it
    expect(read.json.breakerLimit).toBe(3); // cairn.json's auto.breaker (its default) staged into the manifest (#433)

    const emit = await call(run, "outlook_emit");
    expect(emit.json).toMatchObject({ emitted: true, frozen: { runId: RUN, refusals: 3 } });
    const snapshot = JSON.parse(readFileSync(join(projectDir, ".cairn", "outlook.json"), "utf8"));
    expect(snapshot.frozen).toMatchObject({ runId: RUN, refusals: 3 });
  });
});

describe("a frozen run cannot close an issue through issue_update (#427)", () => {
  // Its own home, project and run: the block above tears its freeze down,
  // and this one needs a live frozen run of its own to try to walk around.
  const RUN2 = "run-frz-close";
  let savedHome: string | undefined;
  let home: string;
  let projectDir: string;
  let tracker: FakeTracker;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: res.isError === true, json: JSON.parse(text) };
  };

  /** One run-guard refusal from the run's session, judged against this block's cairn home. */
  const refuse = () => spawnSync(process.execPath, [RUNGUARD], {
    cwd: projectDir, encoding: "utf8", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CAIRN_HOME: join(home, ".cairn") },
    input: JSON.stringify({
      tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: projectDir, session_id: "sess-run-close",
    }),
  });

  beforeAll(async () => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cairn-breaker-close-home-"));
    process.env.HOME = home;
    projectDir = mkdtempSync(join(tmpdir(), "cairn-breaker-close-proj-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    // a custom display name for in-progress and for closed beside the
    // canonical three -- the smaller gap #427 names
    tracker = new FakeTracker({ Doing: "in_progress", Done: "closed" });
    const server = buildServer({ projectDir, tracker });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-breaker-close", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await call("run_manifest", {
      action: "create", runId: RUN2, phases: [{ number: 1, name: "one", estimate }], sessionId: "sess-run-close",
    })).isError).toBe(false);
    await call("run_manifest", { action: "set_status", runId: RUN2, status: "running" });
    await call("run_manifest", { action: "set_phase", runId: RUN2, phase: 1 });
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("state: \"closed\" on a frozen run returns RUN_FROZEN, posts only the one freeze comment, and the issue stays open", async () => {
    const issue = (await call("issue_create", { title: "walk-around" })).json;
    expect((await call("issue_update", { id: issue.id, claim: { baseCommit: "abc1234" } })).isError).toBe(false);
    for (let i = 0; i < 3; i++) expect(refuse().status).toBe(2);
    const before = tracker.comments(issue.id).length;

    const closed = await call("issue_update", { id: issue.id, state: "closed" });
    expect(closed.isError).toBe(true);
    expect(closed.json.code).toBe("RUN_FROZEN");
    expect((await tracker.getIssue(issue.id)).category).toBe("in_progress");
    const added = tracker.comments(issue.id).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].text).toMatch(/^Batch run run-frz-close was frozen by cairn's circuit breaker/);
    // again: refused, and the comment is not repeated
    expect((await call("issue_update", { id: issue.id, state: "closed" })).json.code).toBe("RUN_FROZEN");
    expect(tracker.comments(issue.id).slice(before)).toHaveLength(1);
  });

  it("a display name that resolves to in_progress or closed is refused the same way; a label edit and a move to open are not", async () => {
    const issue = (await call("issue_create", { title: "custom names" })).json;
    expect((await call("issue_update", { id: issue.id, state: "Doing" })).json.code).toBe("RUN_FROZEN");
    expect((await call("issue_update", { id: issue.id, state: "Done" })).json.code).toBe("RUN_FROZEN");
    expect((await tracker.getIssue(issue.id)).category).toBe("open");
    expect((await call("issue_update", { id: issue.id, labels: ["later"] })).isError).toBe(false);
    expect((await call("issue_update", { id: issue.id, state: "open" })).isError).toBe(false);
  });
});

describe("a name the adapter cannot place falls closed while a run is frozen (#471)", () => {
  // The fake has no custom vocabulary here, so "Done" is a name it cannot
  // place: the gate must refuse it on a frozen run rather than skip the
  // check, and must let it reach the adapter when no run is frozen --
  // fall closed, never a blanket refusal.
  const RUN3 = "run-frz-unknown";
  let savedHome: string | undefined;
  let home: string;
  let projectDir: string;
  let tracker: FakeTracker;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: res.isError === true, json: JSON.parse(text) };
  };

  /** One run-guard refusal from the run's session, judged against this block's cairn home. */
  const refuse = () => spawnSync(process.execPath, [RUNGUARD], {
    cwd: projectDir, encoding: "utf8", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CAIRN_HOME: join(home, ".cairn") },
    input: JSON.stringify({
      tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: projectDir, session_id: "sess-run-unknown",
    }),
  });

  beforeAll(async () => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cairn-breaker-unknown-home-"));
    process.env.HOME = home;
    projectDir = mkdtempSync(join(tmpdir(), "cairn-breaker-unknown-proj-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    tracker = new FakeTracker();
    const server = buildServer({ projectDir, tracker });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-breaker-unknown", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await call("run_manifest", {
      action: "create", runId: RUN3, phases: [{ number: 1, name: "one", estimate }], sessionId: "sess-run-unknown",
    })).isError).toBe(false);
    await call("run_manifest", { action: "set_status", runId: RUN3, status: "running" });
    await call("run_manifest", { action: "set_phase", runId: RUN3, phase: 1 });
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("before the freeze, an unknown name reaches the adapter; after it, the same name is RUN_FROZEN", async () => {
    const issue = (await call("issue_create", { title: "spelling" })).json;
    expect(tracker.stateCategory("Done")).toBeUndefined();
    const before = await call("issue_update", { id: issue.id, state: "Done" });
    expect(before.json.code).not.toBe("RUN_FROZEN");

    for (let i = 0; i < 3; i++) expect(refuse().status).toBe(2);
    const after = await call("issue_update", { id: issue.id, state: "Done" });
    expect(after.isError).toBe(true);
    expect(after.json.code).toBe("RUN_FROZEN");
    // the harmless twins: a label edit and the canonical open still pass
    expect((await call("issue_update", { id: issue.id, labels: ["later"] })).isError).toBe(false);
    expect((await call("issue_update", { id: issue.id, state: "open" })).isError).toBe(false);
  });
});

// #466 -- through the tool, as the running batch would call it: its own
// session, refused twice, stages a second run to move the breaker's count.
// The server says RUN_LIVE and writes nothing; hooks.test.ts proves the
// breaker would have judged the first run anyway. Once the run has ended,
// the next run stages as before -- the owner's re-stage path is untouched.
describe("a running batch cannot stage a second run (#466)", () => {
  const RUN4 = "run-live-one";
  const RUN5 = "run-live-two";
  let savedHome: string | undefined;
  let home: string;
  let projectDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: res.isError === true, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cairn-breaker-live-home-"));
    process.env.HOME = home;
    projectDir = mkdtempSync(join(tmpdir(), "cairn-breaker-live-proj-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-breaker-live", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("create is RUN_LIVE while the run reads running, from any session; once it has ended, the next run stages", async () => {
    const phases = [{ number: 1, name: "one", estimate }];
    expect((await call("run_manifest", { action: "create", runId: RUN4, phases, sessionId: "sess-run" })).isError).toBe(false);
    await call("run_manifest", { action: "set_status", runId: RUN4, status: "running" });

    // the run's own session stages a second run to move the count
    const decoy = await call("run_manifest", { action: "create", runId: RUN5, phases, sessionId: "sess-run" });
    expect(decoy.isError).toBe(true);
    expect(decoy.json.code).toBe("RUN_LIVE");
    expect(decoy.json.message).toContain(RUN4);
    expect(decoy.json.nextAction).toContain("set_status");
    expect((await call("run_manifest", { action: "read", runId: RUN5 })).json.code).toBe("NOT_FOUND");
    // a different session id on the decoy changes nothing: the gate is the project's, not the session's
    expect((await call("run_manifest", { action: "create", runId: RUN5, phases, sessionId: "sess-other" })).json.code).toBe("RUN_LIVE");
    // the running run itself is untouched by the refused creates
    expect((await call("run_manifest", { action: "read", runId: RUN4 })).json.status).toBe("running");

    // the twin: the run ends, and the next one stages at the configured limit
    await call("run_manifest", { action: "set_status", runId: RUN4, status: "complete" });
    const next = await call("run_manifest", { action: "create", runId: RUN5, phases, sessionId: "sess-run" });
    expect(next.isError).toBe(false);
    expect(next.json).toMatchObject({ runId: RUN5, status: "staged", breakerLimit: 3 });
  });
});
