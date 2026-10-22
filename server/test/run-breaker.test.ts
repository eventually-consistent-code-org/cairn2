// The circuit breaker's server half (#358), end to end: the real run guard
// freezes a live run by writing its manifest, then the server that named
// the run refuses its claims and closes with RUN_FROZEN, posts the one
// plain-language comment the freeze owes, and carries `frozen` on the
// outlook emit. A second server -- another session, the owner's -- that
// never named the run is never frozen.

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
      action: "create", runId: RUN, phases: [{ number: 1, name: "one", estimate }],
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

    const emit = await call(run, "outlook_emit");
    expect(emit.json).toMatchObject({ emitted: true, frozen: { runId: RUN, refusals: 3 } });
    const snapshot = JSON.parse(readFileSync(join(projectDir, ".cairn", "outlook.json"), "utf8"));
    expect(snapshot.frozen).toMatchObject({ runId: RUN, refusals: 3 });
  });
});
