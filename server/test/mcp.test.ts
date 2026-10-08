import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import type { Phase } from "../src/tracker/types.js";
import { handoffPath } from "../src/core/continuity.js";
import { outlookMirrorPath } from "../src/core/outlook.js";
import { listSessions } from "../src/sessions/store.js";
import { PROVIDERS } from "../src/peers/run.js";

// Controllable failure injection for the continuity resilience test below.
// Mocks ONLY writeHandoff (everything else passes through to the real module)
// so a single test can simulate an unwritable ~/.cairn/handoff without
// chmodding the real shared homedir directory -- vitest runs test files in
// parallel workers, and other suites write handoffs there unguarded, so a
// chmod window would EACCES-flake unrelated tests.
const continuityFailure = vi.hoisted(() => ({
  failWrites: false,
  failedAttempts: 0,
}));
vi.mock("../src/core/continuity.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/core/continuity.js")>();
  return {
    ...actual,
    writeHandoff: (...args: Parameters<typeof actual.writeHandoff>) => {
      if (continuityFailure.failWrites) {
        continuityFailure.failedAttempts += 1;
        throw new Error("simulated EACCES: handoff dir unwritable");
      }
      return actual.writeHandoff(...args);
    },
  };
});

describe("cairn MCP server", () => {
  let client: Client;
  let projectDir: string;
  // The fake behind the server — test accessor for comments posted by tools.
  let fakeTracker: FakeTracker;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    fakeTracker = new FakeTracker();
    const server = buildServer({
      projectDir,
      tracker: fakeTracker,
      // Deterministic npm-latest lookup (#82): no network in unit tests.
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  const listToolNames = async (): Promise<string[]> =>
    (await client.listTools()).tools.map((t) => t.name).sort();

  it("lists the expected tools", async () => {
    const tools = await listToolNames();
    expect(tools).toEqual(
      [
        "context_get",
        "context_meter",
        "context_set",
        "issue_close",
        "issue_create",
        "issue_get",
        "issue_list",
        "issue_update",
        "issue_link",
        "issue_unlink",
        "issue_links",
        "graph_report",
        "tracker_migrate",
        "phase_create",
        "phase_list",
        "plan_drift",
        "plan_import",
        "plan_issues_set",
        "plan_phase_ensure",
        "plan_scaffold_project",
        "plan_scaffold_phase",
        "plan_status",
        "plan_unplanned",
        "mem_index",
        "mem_search",
        "mem_stats",
        "mem_card_create",
        "mem_card_list",
        "mem_card_recall",
        "mem_card_update",
        "mem_compact",
        "mem_timeline",
        "continuity_checkpoint",
        "continuity_get",
        "continuity_clear",
        "ledger_append",
        "budget_check",
        "run_manifest",
        "milestone_create",
        "milestone_list",
        "milestone_complete",
        "plan_resync",
        "plan_tracker_delta",
        "plan_meta_set",
        "config_get",
        "config_set",
        "config_probe",
        "issue_comment",
        "issue_attach",
        "trace_start",
        "trace_log",
        "trace_list",
        "trace_close",
        "probe_start",
        "probe_log",
        "probe_close",
        "draft_start",
        "draft_log",
        "draft_close",
        "thread_start",
        "thread_log",
        "thread_close",
        "session_landscape",
        "plan_check",
        "audit_record",
        "map_set",
        "map_get",
        "map_query",
        "workspace_list",
        "workspace_focus",
        "workspace_status",
        "board_get",
        "board_update",
        "peer_list",
        "peer_run",
        "peer_state",
        "seat_roster",
        "docs_publish",
        "docs_status",
        "docs_drift",
        "distill_manifest",
        "token_estimate",
        "research_sections",
        "outlook_get",
        "outlook_emit",
        "outlook_refresh",
        "outlook_forget",
      ].sort(),
    );
  });

  it("pins the tool count at 87", async () => {
    expect((await listToolNames()).length).toBe(87);
  });

  it("issue_attach reads the file and forwards to the tracker; missing file is NOT_FOUND", async () => {
    const made = await call("issue_create", { title: "attach target" });
    writeFileSync(join(projectDir, "shot.png"), Buffer.from([137, 80, 78, 71]));
    const res = await call("issue_attach", {
      id: made.json.id,
      path: "shot.png",
    });
    expect(res.json.id).toBeTruthy();
    const missing = await client.callTool({
      name: "issue_attach",
      arguments: { id: made.json.id, path: "nope.png" },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0].text).toContain(
      "NOT_FOUND",
    );
  });

  it("tracker_migrate refuses a non-local source", async () => {
    const res = await call("tracker_migrate", {
      targetType: "github",
      targetConfig: { repo: "o/r" },
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("workspace_list without a workspace returns { workspace: null }, not an error", async () => {
    const out = await call("workspace_list", {});
    expect(out.isError).toBeFalsy();
    expect(out.json.workspace).toBeNull();
  });

  it("workspace_focus without a workspace is a PRECONDITION_FAILED error", async () => {
    const res = await call("workspace_focus", { project: "anything" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("PRECONDITION_FAILED");
  });

  it("board_get without a workspace is a PRECONDITION_FAILED error", async () => {
    const res = await call("board_get", {});
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("PRECONDITION_FAILED");
  });

  it("registers the Tier A tools", async () => {
    const names = await listToolNames();
    for (const n of [
      "milestone_create",
      "milestone_list",
      "milestone_complete",
      "plan_resync",
      "plan_meta_set",
    ])
      expect(names).toContain(n);
  });

  it("plan_check runs clean on an empty project", async () => {
    const out = await call("plan_check", {});
    expect(out.json).toEqual({ findings: [], scanned: 0 });
  });

  it("plan_check phase filter matches a decimal phase (1.5) — real dir is 01.5-slug (#40)", async () => {
    await call("plan_scaffold_phase", { number: 1.5, name: "Decimal Check" });
    const out = await call("plan_check", { phase: 1.5 });
    expect(out.isError).toBeFalsy();
    expect(out.json.scanned).toBe(1);
  });

  it("plan_check rejects an over-precise decimal (1.55) as CONFIG_INVALID (#40)", async () => {
    const res = await call("plan_check", { phase: 1.55 });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("audit_record writes and validates", async () => {
    const out = await call("audit_record", {
      scope: "drill-scope",
      verdict: "findings",
      findings: [{ severity: "important", title: "t", failure_scenario: "x → y",
        panel: [{ seat: "correctness", verdict: "CONFIRMED", evidence: "reproduced at x" }] }],
    });
    expect(out.json.findings).toBe(1);
    expect(out.json.survived).toBe(1);
    expect(out.json.results[0]).toMatchObject({ outcome: "confirmed", survived: true });
    // Phase 21: a critical finding with no panel never reaches the record.
    const unpanelled = await call("audit_record", {
      scope: "drill-scope",
      verdict: "findings",
      findings: [{ severity: "critical", title: "t", failure_scenario: "x → y" }],
    });
    expect(unpanelled.isError).toBe(true);
    expect(unpanelled.json.code).toBe("PRECONDITION_FAILED");
    const bad = await call("audit_record", {
      scope: "drill-scope",
      verdict: "pass",
      findings: [{ severity: "critical", title: "boom", failure_scenario: "x → y" }],
    });
    expect(bad.isError).toBe(true);
    // Phase 21: the schema itself refuses a finding with no failure_scenario
    // (input validation, so the body is the SDK's text, not cairn JSON).
    const hunch = await client.callTool({ name: "audit_record", arguments: {
      scope: "drill-scope",
      verdict: "findings",
      findings: [{ severity: "critical", title: "boom" }],
    } });
    expect(hunch.isError).toBe(true);
    expect((hunch.content as Array<{ text: string }>)[0].text).toMatch(/failure_scenario/);
  });

  it("audit_record carries a sweep manifest's legs and returns its delta — no new tool (#215)", async () => {
    const footer = { severity: "minor", title: "settings footer is stale",
      failure_scenario: "open /settings and the footer still says 2025" };
    const leg = await call("audit_record", { scope: "docs-full", verdict: "findings", findings: [footer] });
    const legs = [{ scope: "docs-full", path: leg.json.path }];
    const first = await call("audit_record", {
      scope: "sweep-2026-01-01", verdict: "findings", findings: [footer], legs,
    });
    expect(first.isError).toBeFalsy();
    expect(first.json.delta).toBeNull();
    const raw = readFileSync(first.json.path, "utf8");
    expect(raw).toContain(`leg: docs-full => ${leg.json.path}`);
    expect(raw).toMatch(/settings footer is stale\nscenario: [^\n]*\nsource leg: docs-full/);

    // The leg's own judgment binds the manifest through the tool too (#248).
    const killedLeg = await call("audit_record", { scope: "review-sweep", verdict: "findings", findings: [
      { severity: "important", title: "phantom race", failure_scenario: "two writers interleave and lose an update",
        panel: [{ seat: "v", verdict: "REFUTED", evidence: "single writer by construction" }] }] });
    const resurrected = await call("audit_record", { scope: "sweep-2026-01-02", verdict: "findings", findings: [
      { severity: "important", title: "phantom race", failure_scenario: "two writers interleave and lose an update",
        panel: [{ seat: "v", verdict: "CONFIRMED", evidence: "looked again" }] }],
      legs: [{ scope: "review-sweep", path: killedLeg.json.path }] });
    expect(resurrected.isError).toBe(true);
    expect(resurrected.json.code).toBe("PRECONDITION_FAILED");

    // The docs leg re-runs clean; the next manifest diffs against the first.
    const clean = await call("audit_record", { scope: "docs-full", verdict: "pass", findings: [] });
    const second = await call("audit_record", { scope: "sweep-2026-01-02", verdict: "pass", findings: [],
      legs: [{ scope: "docs-full", path: clean.json.path }] });
    expect(second.json.delta).toMatchObject({ baseline: { path: first.json.path }, new: [], persisting: [], regressed: [] });
    expect(second.json.delta.fixed.map((f: { title: string }) => f.title)).toEqual(["settings footer is stale"]);
  });

  it("plan lifecycle through tools: scaffold → ensure → issues_set → status → drift", async () => {
    const proj = await call("plan_scaffold_project", { name: "T" });
    expect(proj.json.created.length).toBe(2);
    const ph = await call("plan_scaffold_phase", { number: 1, name: "Core" });
    expect(ph.json.dir).toBe("01-core");
    const ensured = await call("plan_phase_ensure", {
      number: 1,
      name: "Core",
    });
    expect(ensured.json.name).toBe("Phase 1: Core");
    const made = await call("issue_create", {
      title: "req 1",
      phase: ensured.json.id,
    });
    await call("plan_issues_set", {
      phaseDir: "01-core",
      issues: [made.json.id],
    });
    const status = await call("plan_status", {});
    expect(status.json.phases[0].issues).toEqual([made.json.id]);
    const drift = await call("plan_drift", {});
    expect(drift.json.ok).toEqual([made.json.id]);
    expect(drift.json.flagged).toEqual([]);
  });

  it("plan_scaffold_phase accepts a decimal phase number (1.5) — dir is 01.5-slug", async () => {
    const ph = await call("plan_scaffold_phase", {
      number: 1.5,
      name: "Gamma",
    });
    expect(ph.json.dir).toBe("01.5-gamma");
    const ensured = await call("plan_phase_ensure", {
      number: 1.5,
      name: "Gamma",
    });
    expect(ensured.json.name).toBe("Phase 1.5: Gamma");
  });

  it("issue_create resolves a cairn phase number to the tracker phase id (#138)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 41,
      name: "Auto Docs",
    });
    const made = await call("issue_create", {
      title: "phase-number resolution",
      phase: "41",
    });
    expect(made.isError).toBeFalsy();
    expect(made.json.phase).toBe(ensured.json.id);
  });

  it("issue_create still accepts a raw tracker phase id (#138)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 42,
      name: "Raw Id",
    });
    const made = await call("issue_create", {
      title: "raw-id passthrough",
      phase: ensured.json.id,
    });
    expect(made.isError).toBeFalsy();
    expect(made.json.phase).toBe(ensured.json.id);
  });

  it("issue_create resolves a decimal cairn phase number (41.5) (#138)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 41.5,
      name: "Decimal Insert",
    });
    const made = await call("issue_create", {
      title: "decimal phase-number resolution",
      phase: "41.5",
    });
    expect(made.isError).toBeFalsy();
    expect(made.json.phase).toBe(ensured.json.id);
  });

  it("issue_create with an unmatched phase number errors naming the title lookup and the id: escape (#138, #271)", async () => {
    const res = await call("issue_create", {
      title: "no such phase",
      phase: "99",
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.message).toContain("Phase 99:");
    expect(res.json.message).toContain("never as a tracker phase id");
    expect(res.json.nextAction).toContain("id:99");
  });

  it("issue_create with a non-numeric unmatched phase errors explaining the skipped number lookup (#138)", async () => {
    const res = await call("issue_create", {
      title: "bogus phase string",
      phase: "not-a-phase",
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.message).toContain("tracker phase id");
    expect(res.json.message).toContain("not a cairn phase number");
  });

  it("issue_update resolves a cairn phase number and re-phases the issue (#142)", async () => {
    const from = await call("plan_phase_ensure", { number: 43, name: "From" });
    const to = await call("plan_phase_ensure", { number: 44, name: "To" });
    const made = await call("issue_create", {
      title: "re-phase by number",
      phase: from.json.id,
    });
    const updated = await call("issue_update", {
      id: made.json.id,
      phase: "44",
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.json.phase).toBe(to.json.id);
    expect(updated.json.phaseSkipped).toBeUndefined();
  });

  it("issue_update still accepts a raw tracker phase id (#142)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 45,
      name: "Raw Update",
    });
    const made = await call("issue_create", { title: "re-phase by raw id" });
    const updated = await call("issue_update", {
      id: made.json.id,
      phase: ensured.json.id,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.json.phase).toBe(ensured.json.id);
  });

  it("issue_update with an unmatched phase number errors naming the title lookup and the id: escape (#142, #271)", async () => {
    const made = await call("issue_create", { title: "bad re-phase target" });
    const res = await call("issue_update", { id: made.json.id, phase: "99" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.message).toContain("Phase 99:");
    expect(res.json.nextAction).toContain("id:99");
  });

  it("issue_list resolves a cairn phase number in the phase filter (#142)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 46,
      name: "List Filter",
    });
    const inPhase = await call("issue_create", {
      title: "listed by phase number",
      phase: ensured.json.id,
    });
    const outOfPhase = await call("issue_create", { title: "not in phase 46" });
    const listed = await call("issue_list", { phase: "46" });
    const ids = listed.json.map((i: { id: string }) => i.id);
    expect(ids).toContain(inPhase.json.id);
    expect(ids).not.toContain(outOfPhase.json.id);
  });

  it("issue_list still accepts a raw tracker phase id (#142)", async () => {
    const ensured = await call("plan_phase_ensure", {
      number: 47,
      name: "Raw List",
    });
    const inPhase = await call("issue_create", {
      title: "listed by raw id",
      phase: ensured.json.id,
    });
    const listed = await call("issue_list", { phase: ensured.json.id });
    const ids = listed.json.map((i: { id: string }) => i.id);
    expect(ids).toContain(inPhase.json.id);
  });

  it("issue_list with an unmatched phase-number filter is NOT_FOUND naming the title lookup (#142, #271)", async () => {
    const res = await call("issue_list", { phase: "98" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.message).toContain("Phase 98:");
  });

  it("plan_scaffold_phase rejects an over-precise decimal (1.55) as CONFIG_INVALID", async () => {
    const res = await call("plan_scaffold_phase", {
      number: 1.55,
      name: "Bad",
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("plan_phase_ensure rejects an over-precise decimal (1.55) as CONFIG_INVALID", async () => {
    const res = await call("plan_phase_ensure", { number: 1.55, name: "Bad" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("round-trip: scaffold 1, 1.5, 2 → plan_status lists them ordered 1, 1.5, 2 with correct numbers", async () => {
    await call("plan_scaffold_phase", { number: 1, name: "One" });
    await call("plan_scaffold_phase", { number: 1.5, name: "OnePointFive" });
    await call("plan_scaffold_phase", { number: 2, name: "Two" });
    const status = await call("plan_status", {});
    const relevant = (
      status.json.phases as Array<{ number: number; dir: string }>
    ).filter((p) => ["01-one", "01.5-onepointfive", "02-two"].includes(p.dir));
    expect(relevant.map((p) => p.dir)).toEqual([
      "01-one",
      "01.5-onepointfive",
      "02-two",
    ]);
    expect(relevant.map((p) => p.number)).toEqual([1, 1.5, 2]);
  });

  it("plan_issues_set on a decimal phaseDir round-trips the phase number into the handoff (not the slice(0,2) bug)", async () => {
    await call("plan_scaffold_phase", { number: 1.5, name: "Handoff Check" });
    const made = await call("issue_create", { title: "decimal handoff req" });
    const res = await call("plan_issues_set", {
      phaseDir: "01.5-handoff-check",
      issues: [made.json.id],
    });
    expect(res.isError).toBeFalsy();
    const handoff = await call("continuity_get", {});
    expect(handoff.json.handoff.phase).toEqual({
      number: 1.5,
      slug: "handoff-check",
    });
  });

  it("plan_issues_set rejects traversal-shaped phaseDir", async () => {
    const res = await call("plan_issues_set", {
      phaseDir: "../evil",
      issues: [],
    });
    expect(res.isError).toBe(true);
  });

  it("plan_issues_set rejects a phaseDir with no scaffolded PLAN.md", async () => {
    const res = await call("plan_issues_set", {
      phaseDir: "99-unscaffolded",
      issues: [],
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
  });

  it("plan_issues_set rejects an issue id containing a comma", async () => {
    const res = await call("plan_issues_set", {
      phaseDir: "01-core",
      issues: ["A,B"],
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("ledger_append writes a formatted line to the phase's LEDGER.md", async () => {
    const res = await call("ledger_append", {
      phaseDir: "01-core",
      taskRef: "task-1",
      summary: "wire the tool",
      baseCommit: "a1b2c3d4e5f6",
      headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-1",
      closedDate: "2026-07-16",
      evidence: { command: "npm test", result: "3 passed" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.json.line).toBe(
      "- [x] task-1 — wire the tool — commits a1b2c3d..d4e5f6a — evidence npm test => 3 passed — actuals wall=none degraded=no_receipt — PROJ-1 closed 2026-07-16",
    );
    // Phase 23: neither evidence nor a waiver is refused at the tool.
    const bare = await call("ledger_append", {
      phaseDir: "01-core", taskRef: "task-2", summary: "s", baseCommit: "a1b2c3d4e5f6",
      headCommit: "d4e5f6a1b2c3", issueId: "PROJ-2", closedDate: "2026-07-16",
    });
    expect(bare.isError).toBe(true);
    expect(bare.json.code).toBe("PRECONDITION_FAILED");
  });

  it("ledger_append rejects a phaseDir with no scaffolded phase", async () => {
    const res = await call("ledger_append", {
      phaseDir: "99-unscaffolded",
      taskRef: "task-1",
      summary: "x",
      baseCommit: "a1b2c3d4e5f6",
      headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-1",
      closedDate: "2026-07-16",
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.nextAction).toBeTruthy();
  });

  it("issue lifecycle: create → in_progress → close through tools", async () => {
    const made = await call("issue_create", { title: "via mcp" });
    expect(made.json.state).toBe("open");
    const wip = await call("issue_update", {
      id: made.json.id,
      state: "in_progress",
    });
    expect(wip.json.state).toBe("in_progress");
    const closed = await call("issue_close", { id: made.json.id });
    expect(closed.json.state).toBe("closed");
    expect(closed.json).not.toHaveProperty("evidenceCommented");
  });

  it("issue_close with typed evidence posts one standard comment before closing (#200)", async () => {
    const made = await call("issue_create", { title: "prove it" });
    const closed = await call("issue_close", {
      id: made.json.id, evidence: { command: "npm test", result: "1408 passed" },
    });
    expect(closed.json.state).toBe("closed");
    expect(closed.json.evidenceCommented).toBe(true);
    expect(fakeTracker.comments(made.json.id).map((c) => c.text))
      .toContain("evidence: `npm test` → 1408 passed\n"
        + "measured: not derivable at close (the ledger append takes it from the commit range)");
  });

  it("claiming an unassigned issue auto-assigns the working user", async () => {
    const made = await call("issue_create", { title: "claim me" });
    const wip = await call("issue_update", {
      id: made.json.id,
      state: "in_progress",
    });
    expect(wip.json.assignee).toBe("fake-user");
    expect(wip.json.autoAssigned).toBe(true);
  });

  it("an explicit assignee wins over auto-assign", async () => {
    const made = await call("issue_create", { title: "explicit" });
    const wip = await call("issue_update", {
      id: made.json.id,
      state: "in_progress",
      assignee: "someone-else",
    });
    expect(wip.json.assignee).toBe("someone-else");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("an already-assigned issue is left untouched on claim", async () => {
    const made = await call("issue_create", { title: "taken" });
    await call("issue_update", { id: made.json.id, assignee: "owner" });
    const wip = await call("issue_update", {
      id: made.json.id,
      state: "in_progress",
    });
    expect(wip.json.assignee).toBe("owner");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("issue_link → issue_links → issue_unlink roundtrip", async () => {
    const a = await call("issue_create", { title: "link a" });
    const b = await call("issue_create", { title: "link b" });
    await call("issue_link", {
      from: a.json.id,
      type: "blocks",
      to: b.json.id,
    });
    const links = await call("issue_links", { id: a.json.id });
    expect(links.json.links).toContainEqual({
      from: a.json.id,
      type: "blocks",
      to: b.json.id,
    });
    await call("issue_unlink", {
      from: a.json.id,
      type: "blocks",
      to: b.json.id,
    });
    expect((await call("issue_links", { id: a.json.id })).json.links).toEqual(
      [],
    );
  });

  it("graph_report: frontier, inherited priority, lineage", async () => {
    const blocker = await call("issue_create", {
      title: "graph blocker",
      labels: ["priority:P3"],
    });
    const blocked = await call("issue_create", {
      title: "graph blocked",
      labels: ["priority:P1"],
    });
    await call("issue_link", {
      from: blocker.json.id,
      type: "blocks",
      to: blocked.json.id,
    });
    const v2 = await call("issue_create", { title: "graph v2" });
    await call("issue_link", {
      from: v2.json.id,
      type: "supersedes",
      to: blocker.json.id,
    });

    const report = await call("graph_report", { lineageOf: v2.json.id });
    const frontierIds = report.json.frontier.map((i: { id: string }) => i.id);
    expect(frontierIds).toContain(blocker.json.id); // nothing blocks it
    expect(frontierIds).not.toContain(blocked.json.id); // blocker still open
    expect(report.json.priorities).toContainEqual({
      id: blocker.json.id,
      declared: "P3",
      effective: "P1",
      inheritedFrom: blocked.json.id,
    });
    expect(report.json.lineage).toEqual([blocker.json.id, v2.json.id]);
    expect(report.json.dangling).toEqual([]);
  });

  it("issue_link surfaces cycle rejection as a typed error", async () => {
    const a = await call("issue_create", { title: "cyc a" });
    const b = await call("issue_create", { title: "cyc b" });
    await call("issue_link", {
      from: a.json.id,
      type: "blocks",
      to: b.json.id,
    });
    const res = await call("issue_link", {
      from: b.json.id,
      type: "blocks",
      to: a.json.id,
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("non-claim transitions never auto-assign", async () => {
    const made = await call("issue_create", { title: "close only" });
    const closed = await call("issue_update", {
      id: made.json.id,
      state: "closed",
    });
    expect(closed.json.assignee).toBeUndefined();
  });

  it("issue_close with timeSpentMinutes on a no-worklog backend says why it skipped", async () => {
    const made = await call("issue_create", { title: "timed close" });
    const closed = await call("issue_close", {
      id: made.json.id,
      timeSpentMinutes: 15,
    });
    expect(closed.json.state).toBe("closed");
    expect(closed.json.worklogLogged).toBe(false);
    expect(closed.json.worklogError).toMatch(/no worklog support/);
  });

  it("issue_close leaves a receipt that ledger_append folds into the line (#233)", async () => {
    const made = await call("issue_create", {
      title: "receipted close", estimatePoints: 3, estimateMinutes: 90,
    });
    const closed = await call("issue_close", { id: made.json.id, timeSpentMinutes: 15 });
    expect(closed.json.receiptWritten).toBe(true);
    const appended = await call("ledger_append", {
      phaseDir: "01-core", taskRef: "r1", summary: "receipted",
      baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
      issueId: made.json.id, closedDate: "2026-10-01",
      evidence: { command: "npm test", result: "1 passed" },
    });
    expect(appended.isError).toBeFalsy();
    expect(appended.json.line).toContain(
      `— actuals wall=none claimed=15m est=3pt:field,90m:field worklog=unsupported — ${made.json.id} closed`);
    expect(appended.json.degraded).toBeUndefined();
    // Consumed: a second append for the same issue has nothing to read.
    const again = await call("ledger_append", {
      phaseDir: "01-core", taskRef: "r1b", summary: "again",
      baseCommit: "a1b2c3d4e5f6", headCommit: "d4e5f6a1b2c3",
      issueId: made.json.id, closedDate: "2026-10-01", evidenceWaived: "repeat",
    });
    expect(again.json.degraded).toEqual(["no_receipt"]);
  });

  it("an unwritable receipt folder never fails a close (#233)", async () => {
    const state = join(projectDir, ".cairn", "state", "receipts");
    rmSync(state, { recursive: true, force: true });
    writeFileSync(state, "a file squatting on the folder");
    try {
      const made = await call("issue_create", { title: "close regardless" });
      const closed = await call("issue_close", { id: made.json.id });
      expect(closed.isError).toBeFalsy();
      expect(closed.json.state).toBe("closed");
      expect(closed.json.receiptWritten).toBe(false);
    } finally {
      rmSync(state, { force: true });
    }
  });

  it("issue_create passes an estimate through on a hasEstimates backend, no skip note", async () => {
    const made = await call("issue_create", {
      title: "estimated on jira-like",
      estimatePoints: 3,
      estimateMinutes: 90,
    });
    expect(made.json.estimate).toEqual({ points: 3, minutes: 90 });
    expect(made.json.estimateSkipped).toBeUndefined();
  });

  it("issue_create with no estimate requested carries no skip note", async () => {
    const made = await call("issue_create", { title: "no estimate requested" });
    expect(made.json.estimate).toBeUndefined();
    expect(made.json.estimateSkipped).toBeUndefined();
  });

  describe("estimates capability gate (no-hasEstimates backend)", () => {
    // FakeTracker defaults to hasEstimates: true (it stands in for jira/local
    // in the rest of this suite) -- these tests need the OTHER six backends'
    // posture, so a dedicated tracker + server/client pair overrides it, same
    // pattern as the git-fixture server above.
    class NoEstimatesFake extends FakeTracker {
      override readonly capabilities = {
        ...new FakeTracker().capabilities,
        hasEstimates: false,
      };
    }

    let neClient: Client;
    const neCall = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await neClient.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]
        .text;
      return { ...res, json: JSON.parse(text) };
    };

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "cairn-mcp-no-estimates-"));
      const server = buildServer({
        projectDir: dir,
        tracker: new NoEstimatesFake(),
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      neClient = new Client({ name: "test-no-estimates", version: "0.0.0" });
      await Promise.all([server.connect(st), neClient.connect(ct)]);
    });

    it("issue_create drops the estimate and reports estimateSkipped", async () => {
      const made = await neCall("issue_create", {
        title: "unestimatable",
        estimatePoints: 5,
        estimateMinutes: 120,
      });
      expect(made.json.estimate).toBeUndefined();
      expect(made.json.estimateSkipped).toBe(
        "backend has no estimate support; fold points/minutes into the issue body",
      );
    });

    it("issue_create with no estimate requested carries no skip note", async () => {
      const made = await neCall("issue_create", {
        title: "plain, no estimate",
      });
      expect(made.json.estimate).toBeUndefined();
      expect(made.json.estimateSkipped).toBeUndefined();
    });

    it("issue_update drops the estimate and reports estimateSkipped", async () => {
      const made = await neCall("issue_create", { title: "update target" });
      const updated = await neCall("issue_update", {
        id: made.json.id,
        estimatePoints: 8,
      });
      expect(updated.json.estimate).toBeUndefined();
      expect(updated.json.estimateSkipped).toBe(
        "backend has no estimate support; fold points/minutes into the issue body",
      );
    });

    it("issue_update with no estimate requested carries no skip note", async () => {
      const made = await neCall("issue_create", {
        title: "update target, no estimate",
      });
      const updated = await neCall("issue_update", {
        id: made.json.id,
        title: "renamed",
      });
      expect(updated.json.estimate).toBeUndefined();
      expect(updated.json.estimateSkipped).toBeUndefined();
    });
  });

  describe("re-phase capability gate (no-hasPhaseReassign backend) (#142)", () => {
    // Same posture as the estimates gate above: FakeTracker stands in for
    // clickup, where a task's list is a creation-time parent with no move
    // primitive — issue_update must drop the phase and say so, never
    // silently ignore it (that silence bit two live sessions).
    class NoRephaseFake extends FakeTracker {
      override readonly capabilities = {
        ...new FakeTracker().capabilities,
        hasPhaseReassign: false,
      };
    }

    let nrClient: Client;
    const nrCall = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await nrClient.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]
        .text;
      return { ...res, json: JSON.parse(text) };
    };

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "cairn-mcp-no-rephase-"));
      const server = buildServer({
        projectDir: dir,
        tracker: new NoRephaseFake(),
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      nrClient = new Client({ name: "test-no-rephase", version: "0.0.0" });
      await Promise.all([server.connect(st), nrClient.connect(ct)]);
    });

    it("issue_update drops the phase and reports phaseSkipped", async () => {
      const made = await nrCall("issue_create", { title: "unmovable" });
      const updated = await nrCall("issue_update", {
        id: made.json.id,
        phase: "1",
      });
      expect(updated.isError).toBeFalsy();
      expect(updated.json.phase).toBeUndefined();
      expect(updated.json.phaseSkipped).toBe(
        "backend can't move an existing issue between phases; recreate the issue in the target phase",
      );
    });

    it("issue_update with no phase requested carries no skip note", async () => {
      const made = await nrCall("issue_create", { title: "stationary" });
      const updated = await nrCall("issue_update", {
        id: made.json.id,
        title: "renamed in place",
      });
      expect(updated.json.phaseSkipped).toBeUndefined();
    });

    it("issue_create with a phase still works — the gate is re-parenting only", async () => {
      const ph = await nrCall("phase_create", { name: "creation-time parent" });
      const made = await nrCall("issue_create", {
        title: "born in phase",
        phase: ph.json.id,
      });
      expect(made.json.phase).toBe(ph.json.id);
      expect(made.json.phaseSkipped).toBeUndefined();
    });
  });

  it("context_set then context_get roundtrips", async () => {
    await call("context_set", { phase: 1, issueId: "FAKE-1" });
    const got = await call("context_get");
    expect(got.json).toEqual({ phase: 1, issueId: "FAKE-1" });
  });

  it("context_set accepts a decimal phase (1.5) and persists it (#40)", async () => {
    await call("context_set", { phase: 1.5 });
    const got = await call("context_get");
    expect(got.json.phase).toBe(1.5);
  });

  it("context_set rejects an over-precise decimal phase (1.55) as CONFIG_INVALID (#40)", async () => {
    const res = await call("context_set", { phase: 1.55 });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("context_set({phase: null}) still clears the phase after the decimal guard lands (#40)", async () => {
    await call("context_set", { phase: 1.5 });
    await call("context_set", { phase: null });
    const got = await call("context_get");
    expect(got.json.phase).toBeUndefined();
  });

  it("config_set merges and config_get reflects it", async () => {
    const set = await call("config_set", {
      patch: { continuity: { resume: "auto" } },
    });
    expect(set.json.continuity.resume).toBe("auto");
    const got = await call("config_get", {});
    expect(got.json.continuity.resume).toBe("auto");
    expect(got.json.leakGuard.enabled).toBe(true); // defaults visible in effective view
  });

  it("config_probe reports tracker verdict + installed versions, no docs block configured (CRN-48, #82)", async () => {
    const res = await call("config_probe", {});
    expect(res.isError).toBeFalsy();
    expect(res.json.tracker).toEqual({ verdict: "ok" });
    expect(res.json.docs).toBeUndefined();
    // Versions section (#82): server version comes from server/package.json
    // (same source serverInfo reports at the MCP handshake); this test runs
    // from the repo tree so pluginCache is null and the temp project dir is
    // not the cairn repo so repo is null.
    const serverVersion = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
    expect(res.json.versions.server).toBe(serverVersion);
    expect(res.json.versions.pluginCache).toBeNull();
    expect(res.json.versions.repo).toBeNull();
    expect(res.json.versions.npmLatest).toBe("9.9.9"); // injected lookup
    expect(res.json.versions.drift).toContain(
      `installed v${serverVersion}, available v9.9.9 -- update the plugin (or npm install) to adopt`,
    );
    // Native-bindings preflight (#108): real binding is healthy here.
    expect(res.json.native).toEqual({
      module: "better-sqlite3",
      status: "ok",
    });
    // contextEconomy (task 7): no contextEconomy block configured, so cairn
    // has expressed no preference -- unset, not drift.
    expect(res.json.contextEconomy).toEqual({
      status: "unset",
      desired: null,
      live: null,
    });
  });

  it("CairnError surfaces as isError with code + nextAction", async () => {
    const res = await call("issue_get", { id: "nope" });
    expect(res.isError).toBe(true);
  });

  it("trace lifecycle round-trips against the fake tracker", async () => {
    const started = await call("trace_start", { description: "mcp drill bug" });
    expect(started.json.id).toMatch(/^trace-[0-9a-f]{8}$/);
    expect(started.json.issue).toBeTruthy();
    await call("trace_log", {
      id: started.json.id,
      kind: "evidence",
      text: "e1",
    });
    await call("trace_log", {
      id: started.json.id,
      kind: "verdict",
      text: "cause found",
    });
    // Phase 23 repro gate: evidence + verdict is not enough — the close
    // refuses until a test entry (the repro) exists.
    const early = await call("trace_close", { id: started.json.id, resolution: "fixed" });
    expect(early.isError).toBe(true);
    expect(early.json.code).toBe("PRECONDITION_FAILED");
    await call("trace_log", {
      id: started.json.id,
      kind: "test",
      text: "npm test -- drill → FAIL: expected 1, got 0",
    });
    const open = await call("trace_list", { status: "open" });
    expect(
      open.json.some((t: { id: string }) => t.id === started.json.id),
    ).toBe(true);
    const closed = await call("trace_close", {
      id: started.json.id,
      resolution: "fixed",
    });
    expect(closed.json.issueClosed).toBe(true);
    expect(closed.json.repro).toBe("npm test -- drill → FAIL: expected 1, got 0");
    const gone = await call("trace_list", { status: "open" });
    expect(
      gone.json.some((t: { id: string }) => t.id === started.json.id),
    ).toBe(false);
  });

  it("probe_start creates a cairn:spike issue and stamps the active phase", async () => {
    await call("context_set", { phase: 3 });
    const out = await call("probe_start", {
      description: "can the SDK stream?",
    });
    expect(out.json.id).toMatch(/^probe-[0-9a-f]{8}$/);
    const issue = await call("issue_get", { id: out.json.issue });
    expect(issue.json.labels).toContain("cairn:spike");
    // phase stamp: assert via the store directly (session_landscape arrives in Task 3)
    expect(listSessions(projectDir, "probe")[0].phase).toBe("3");
  });

  it("probe_log enforces the probe entry vocabulary", async () => {
    const started = await call("probe_start", { description: "vocab" });
    await call("probe_log", {
      id: started.json.id,
      kind: "experiment",
      text: "ran it",
    });
    // "hypothesis" isn't a probe entry kind -- the input schema's z.enum rejects
    // it at the protocol layer before appendSession's UNSUPPORTED check ever runs
    // (same shape as the mem_search negative-limit boundary test above).
    await expect(
      call("probe_log", {
        id: started.json.id,
        kind: "hypothesis",
        text: "nope",
      }),
    ).rejects.toThrow();
  });

  it("probe_close gates on verdict then closes the issue", async () => {
    const started = await call("probe_start", { description: "gate" });
    const early = await call("probe_close", {
      id: started.json.id,
      resolution: "stop",
    });
    expect(early.isError).toBe(true);
    await call("probe_log", {
      id: started.json.id,
      kind: "verdict",
      text: "VALIDATED",
    });
    const out = await call("probe_close", {
      id: started.json.id,
      resolution: "proceed — holds up",
    });
    expect(out.json.issueClosed).toBe(true);
    expect(
      (await call("issue_get", { id: started.json.issue })).json.state,
    ).toBe("closed");
  });

  it("draft tools: cairn:sketch label, decision gate", async () => {
    const started = await call("draft_start", {
      description: "dashboard layout",
    });
    expect(
      (await call("issue_get", { id: started.json.issue })).json.labels,
    ).toContain("cairn:sketch");
    await call("draft_log", {
      id: started.json.id,
      kind: "variant",
      text: "001-cards.html",
    });
    const early = await call("draft_close", {
      id: started.json.id,
      resolution: "cards",
    });
    expect(early.isError).toBe(true);
    await call("draft_log", {
      id: started.json.id,
      kind: "decision",
      text: "card grid",
    });
    expect(
      (
        await call("draft_close", {
          id: started.json.id,
          resolution: "card grid locked",
        })
      ).json.issueClosed,
    ).toBe(true);
  });

  it("thread tools: cairn:thread label, wrap gate", async () => {
    const started = await call("thread_start", {
      description: "design musing",
    });
    expect(
      (await call("issue_get", { id: started.json.issue })).json.labels,
    ).toContain("cairn:thread");
    await call("thread_log", {
      id: started.json.id,
      kind: "note",
      text: "a note worth keeping",
    });
    const early = await call("thread_close", {
      id: started.json.id,
      resolution: "landed here",
    });
    expect(early.isError).toBe(true);
    await call("thread_log", {
      id: started.json.id,
      kind: "wrap",
      text: "wrapped: landed here",
    });
    expect(
      (
        await call("thread_close", {
          id: started.json.id,
          resolution: "landed here",
        })
      ).json.issueClosed,
    ).toBe(true);
  });

  it("map tools: round-trips a two-node one-edge graph and rejects a dangling edge", async () => {
    const set = await call("map_set", {
      patch: {
        nodes: {
          "mod-a": { type: "module", label: "A" },
          "mod-b": { type: "module", label: "B" },
        },
        edges: [{ from: "mod-a", to: "mod-b", type: "depends-on" }],
      },
      rebuild: true,
    });
    expect(set.json).toEqual({ nodes: 2, edges: 1 });

    const got = await call("map_get", {});
    expect(got.json.nodes["mod-a"]).toEqual({ type: "module", label: "A" });
    expect(got.json.edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
    ]);

    const dangling = await call("map_set", {
      patch: {
        edges: [{ from: "mod-a", to: "mod-ghost", type: "depends-on" }],
      },
      rebuild: true,
    });
    expect(dangling.isError).toBe(true);
  });

  it("map_query: neighborhood + filters over the wire, with the meta envelope", async () => {
    await call("map_set", {
      patch: {
        nodes: {
          "mod-a": { type: "module", label: "A" },
          "mod-b": { type: "module", label: "B" },
          "issue-x": { type: "issue", label: "b leaks" },
        },
        edges: [
          { from: "mod-a", to: "mod-b", type: "depends-on" },
          { from: "mod-b", to: "issue-x", type: "implements" },
        ],
      },
      rebuild: true,
    });
    const out = await call("map_query", {
      node: "mod-a",
      depth: 1,
      nodeType: "module",
    });
    expect(Object.keys(out.json.nodes).sort()).toEqual(["mod-a", "mod-b"]);
    expect(out.json.edges).toEqual([
      { from: "mod-a", to: "mod-b", type: "depends-on" },
    ]);
    expect(out.json.meta.generation).toBeGreaterThanOrEqual(1);
  });

  it("session_landscape's openByKind reflects an open probe created via probe_start", async () => {
    const started = await call("probe_start", {
      description: "landscape check",
    });
    const scape = await call("session_landscape", {});
    expect(Object.keys(scape.json.openByKind).sort()).toEqual([
      "draft",
      "probe",
      "thread",
      "trace",
    ]);
    expect(scape.json.openByKind.probe).toBeGreaterThanOrEqual(1);
    const found = scape.json.sessions.find(
      (s: { id: string }) => s.id === started.json.id,
    );
    expect(found?.kind).toBe("probe");
    expect(found?.status).toBe("open");
  });

  it("memory lifecycle: index -> search -> stats -> card create -> list -> recall (fresh)", async () => {
    await call("mem_index", {
      content: "GitHub secondary rate limits return 403",
      source: "research",
      phase: 1,
    });
    const found = await call("mem_search", { query: "rate limits" });
    expect(found.json.length).toBeGreaterThan(0);

    const stats = await call("mem_stats", {});
    expect(stats.json.chunkCount).toBeGreaterThan(0);

    const card = await call("mem_card_create", {
      type: "gotcha",
      body: "GitHub 403 can mean auth failure OR rate limiting.",
      scopePhase: 1,
    });
    expect(card.json.id).toBeTruthy();

    const list = await call("mem_card_list", { scopePhase: 1 });
    expect(list.json.length).toBe(1);

    const recall = await call("mem_card_recall", {});
    expect(
      recall.json.find((c: { id: string }) => c.id === card.json.id).stale,
    ).toBe(false);
  });

  it("mem_index/mem_search accept a decimal phase (1.5) and round-trip the scoped search (#40)", async () => {
    await call("mem_index", {
      content: "decimal phase gremlin",
      source: "research",
      phase: 1.5,
    });
    const found = await call("mem_search", { query: "gremlin", phase: 1.5 });
    expect(found.json.length).toBeGreaterThan(0);
  });

  it("mem_index rejects an over-precise decimal phase (1.55) as CONFIG_INVALID (#40)", async () => {
    const res = await call("mem_index", {
      content: "x",
      source: "research",
      phase: 1.55,
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("mem_search rejects an over-precise decimal phase (1.55) as CONFIG_INVALID (#40)", async () => {
    const res = await call("mem_search", { query: "x", phase: 1.55 });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("mem_card_create/mem_card_list accept a decimal scopePhase (1.5) and recall it (#40)", async () => {
    const card = await call("mem_card_create", {
      type: "note",
      body: "decimal-scoped card",
      scopePhase: 1.5,
    });
    expect(card.isError).toBeFalsy();
    const list = await call("mem_card_list", { scopePhase: 1.5 });
    expect(list.json.some((c: { id: string }) => c.id === card.json.id)).toBe(
      true,
    );
  });

  it("mem_card_create rejects an over-precise decimal scopePhase (1.55) as CONFIG_INVALID (#40)", async () => {
    const res = await call("mem_card_create", {
      type: "note",
      body: "bad",
      scopePhase: 1.55,
    });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("mem_card_list/mem_card_recall reject an over-precise decimal scopePhase (1.55) as CONFIG_INVALID (#40)", async () => {
    const list = await call("mem_card_list", { scopePhase: 1.55 });
    expect(list.isError).toBe(true);
    expect(list.json.code).toBe("CONFIG_INVALID");
    const recall = await call("mem_card_recall", { scopePhase: 1.55 });
    expect(recall.isError).toBe(true);
    expect(recall.json.code).toBe("CONFIG_INVALID");
  });

  it("mem_card_create round-trips flat provenanceFiles/provenanceCommits (#164)", async () => {
    const card = await call("mem_card_create", {
      type: "gotcha",
      body: "flat provenance arrays used to vanish silently",
      provenanceFiles: ["server/src/memory/cards.ts", "server/src/index.ts"],
      provenanceCommits: ["abc1234", "def5678"],
    });
    expect(card.isError).toBeFalsy();
    expect(card.json.frontmatter.provenanceFiles).toEqual([
      "server/src/memory/cards.ts",
      "server/src/index.ts",
    ]);
    expect(card.json.frontmatter.provenanceCommits).toEqual([
      "abc1234",
      "def5678",
    ]);
    // and the persisted card carries them, not just the create echo
    const list = await call("mem_card_list", {});
    const found = list.json.find((c: { id: string }) => c.id === card.json.id);
    expect(found.frontmatter.provenanceFiles).toEqual([
      "server/src/memory/cards.ts",
      "server/src/index.ts",
    ]);
    expect(found.frontmatter.provenanceCommits).toEqual([
      "abc1234",
      "def5678",
    ]);
  });

  it("mem_card_update accepts a provenance-only patch without confidence (#164)", async () => {
    const card = await call("mem_card_create", {
      type: "note",
      body: "provenance patched in after the fact",
    });
    const updated = await call("mem_card_update", {
      id: card.json.id,
      provenanceFiles: ["server/src/memory/staleness.ts"],
      provenanceCommits: ["0badf00d"],
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.json.frontmatter.provenanceFiles).toEqual([
      "server/src/memory/staleness.ts",
    ]);
    expect(updated.json.frontmatter.provenanceCommits).toEqual(["0badf00d"]);
    expect(updated.json.frontmatter.confidence).toBeUndefined();
  });

  it("mem_card_update rejects an empty patch as CONFIG_INVALID (#164)", async () => {
    const card = await call("mem_card_create", {
      type: "note",
      body: "empty patch target",
    });
    const res = await call("mem_card_update", { id: card.json.id });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("scopeRole scopes cards through create/list/recall/update (#165)", async () => {
    const scoped = await call("mem_card_create", {
      type: "decision",
      body: "the security seat prefers allowlists",
      scopeRole: "security",
    });
    await call("mem_card_create", {
      type: "decision",
      body: "roleless card for the scopeRole filter test",
    });

    const list = await call("mem_card_list", { scopeRole: "security" });
    expect(list.json.length).toBe(1);
    expect(list.json[0].id).toBe(scoped.json.id);
    expect(list.json[0].frontmatter.scopeRole).toBe("security");

    const recall = await call("mem_card_recall", { scopeRole: "security" });
    expect(recall.json.length).toBe(1);
    expect(recall.json[0].id).toBe(scoped.json.id);
    expect(recall.json[0].stale).toBe(false);

    const retagged = await call("mem_card_update", {
      id: scoped.json.id,
      scopeRole: "appsec",
    });
    expect(retagged.json.frontmatter.scopeRole).toBe("appsec");
    const after = await call("mem_card_list", { scopeRole: "security" });
    expect(after.json.length).toBe(0);
  });

  it("mem_index/mem_search carry and filter by role (#165)", async () => {
    await call("mem_index", {
      content: "role-tagged research on tls pinning",
      source: "research",
      role: "security",
    });
    await call("mem_index", {
      content: "roleless research on tls pinning",
      source: "research",
    });
    const scoped = await call("mem_search", {
      query: "tls pinning",
      role: "security",
    });
    expect(scoped.json.length).toBe(1);
    expect(scoped.json[0].role).toBe("security");
    const all = await call("mem_search", { query: "tls pinning" });
    expect(all.json.length).toBe(2);
  });

  it("mem_search rejects a negative limit at the schema boundary", async () => {
    // Zod's positive() check runs at the MCP input-validation layer, before our
    // handler ever sees it -- so this surfaces as a protocol-level rejection
    // rather than a { isError: true } tool result. Either way, -1 never reaches
    // the query (SQLite treats LIMIT -1 as "unlimited").
    await expect(
      call("mem_search", { query: "anything", limit: -1 }),
    ).rejects.toThrow();
  });

  it("mem_card_recall flags a card stale when its provenance file changed", async () => {
    const gitDir = mkdtempSync(join(tmpdir(), "cairn-mcp-git-"));
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir });
    writeFileSync(join(gitDir, "f.ts"), "v1\n");
    execFileSync("git", ["add", "f.ts"], { cwd: gitDir });
    execFileSync("git", ["commit", "-q", "-m", "v1"], { cwd: gitDir });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir })
      .toString()
      .trim();

    const gitServer = buildServer({
      projectDir: gitDir,
      tracker: new FakeTracker(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const gitClient = new Client({ name: "test-git", version: "0.0.0" });
    await Promise.all([gitServer.connect(st), gitClient.connect(ct)]);
    const gitCall = async (
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const res = await gitClient.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0]
        .text;
      return { ...res, json: JSON.parse(text) };
    };

    await gitCall("mem_card_create", {
      type: "gotcha",
      body: "test",
      provenance: [{ file: "f.ts", commit }],
    });
    writeFileSync(join(gitDir, "f.ts"), "v2 changed\n");
    const recall = await gitCall("mem_card_recall", {});
    expect(recall.json[0].stale).toBe(true);
    expect(recall.json[0].staleReasons[0]).toContain("f.ts");
  });

  it("plan_unplanned surfaces tracker issues no plan references", async () => {
    const stray = await call("issue_create", { title: "tracker-origin stray" });
    const report = await call("plan_unplanned", {});
    expect(report.json.unplanned.map((i: { id: string }) => i.id)).toContain(
      stray.json.id,
    );
  });

  it("plan_import reverse-mirrors a tracker phase into plan artifacts", async () => {
    const ph = await call("phase_create", { name: "Phase 7: Imported Work" });
    const issue = await call("issue_create", {
      title: "imported req",
      phase: ph.json.id,
    });
    const result = await call("plan_import", { phaseRef: ph.json.id });
    expect(result.json).toMatchObject({
      dir: "07-imported-work",
      number: 7,
      issues: [issue.json.id],
    });
    const status = await call("plan_status", {});
    expect(
      status.json.phases.find((p: { number: number }) => p.number === 7).issues,
    ).toEqual([issue.json.id]);
  });

  it("peer_list reports all four providers plus the fan-out budget, onPath false in the bare harness", async () => {
    const ORIGINAL_PATH = process.env.PATH;
    const emptyDir = mkdtempSync(join(tmpdir(), "cairn-mcp-empty-path-"));
    process.env.PATH = emptyDir;
    try {
      const out = await call("peer_list", {});
      expect(out.isError).toBeFalsy();
      // Wire shape (#75): {peers: [...], maxConcurrent} — the budget rides
      // along so council mode can batch its fan-out instead of dispatching
      // every seat at once.
      expect(out.json.peers).toHaveLength(4);
      expect(
        out.json.peers.map((p: { provider: string }) => p.provider).sort(),
      ).toEqual([...PROVIDERS].sort());
      for (const entry of out.json.peers) expect(entry.onPath).toBe(false);
      expect(Number.isInteger(out.json.maxConcurrent)).toBe(true);
      expect(out.json.maxConcurrent).toBeGreaterThanOrEqual(1);
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // peer_run spawns a real child process via execFile, which inherits
  // process.env at spawn time -- since this server runs in-process (no
  // subprocess transport for the MCP server itself), staging a stub CLI
  // onto process.env.PATH here reaches peerRun's execFile call directly.
  // Restored after the test so the stub never leaks into later tests.
  it("peer_run executes a stub staged on PATH and returns its output", async () => {
    const ORIGINAL_PATH = process.env.PATH;
    const stubDir = mkdtempSync(join(tmpdir(), "cairn-mcp-peer-stub-"));
    const stubPath = join(stubDir, "codex");
    writeFileSync(stubPath, '#!/bin/sh\ncat > /dev/null\necho "stub ok"\n');
    chmodSync(stubPath, 0o755);
    process.env.PATH = `${stubDir}${delimiter}${ORIGINAL_PATH}`;
    try {
      const res = await call("peer_run", { provider: "codex", input: "hello" });
      expect(res.isError).toBeFalsy();
      expect(res.json.provider).toBe("codex");
      expect(res.json.exitCode).toBe(0);
      expect(res.json.output.trim()).toBe("stub ok");
    } finally {
      process.env.PATH = ORIGINAL_PATH;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  // peer_state's envelope is a permissive object with in-handler op checks
  // -- the wire test covers the dispatch plus the structured CONFIG_INVALID
  // for a missing op-specific field (never a raw SDK -32602).
  it("peer_state dispatches ops over the wire; missing op field is CONFIG_INVALID", async () => {
    const missing = await call("peer_state", {
      slug: "mcp smoke",
      op: "start",
    });
    expect(missing.isError).toBe(true);
    expect(missing.json.code).toBe("CONFIG_INVALID");

    const started = await call("peer_state", {
      slug: "mcp smoke",
      op: "start",
      mode: "review",
      target: "diff",
      peers: ["codex"],
    });
    expect(started.isError).toBeFalsy();
    expect(started.json.slug).toBe("mcp-smoke");

    await call("peer_state", {
      slug: "mcp smoke",
      op: "record_output",
      peer: "codex",
      round: 1,
      output: "raw reply",
    });
    await call("peer_state", {
      slug: "mcp smoke",
      op: "record_findings",
      peer: "codex",
      round: 1,
      findings: [
        {
          claim: "c",
          evidence: "e",
          severity: "minor",
          recommendation: "r",
        },
      ],
    });
    await call("peer_state", {
      slug: "mcp smoke",
      op: "verdict",
      findingId: "f1",
      verdict: "verified",
    });

    const status = await call("peer_state", {
      slug: "mcp smoke",
      op: "status",
    });
    expect(status.json.resumable.complete).toBe(true);

    const closed = await call("peer_state", { slug: "mcp smoke", op: "close" });
    expect(closed.json.verdict).toBe("findings");
    expect(closed.json.findings[0].detail).toBe(
      "raised by codex round 1; verdict verified",
    );
  });

  it("peer_state start accepts mode 'council' over the wire (#71)", async () => {
    const started = await call("peer_state", {
      slug: "mcp council",
      op: "start",
      mode: "council",
      target: "product council",
      peers: ["codex"],
    });
    expect(started.isError).toBeFalsy();
    expect(started.json.state.meta.mode).toBe("council");
  });

  it("peer_state close refuses a silent seat; allowIncomplete stamps incompleteSeats (#71)", async () => {
    await call("peer_state", {
      slug: "mcp incomplete",
      op: "start",
      mode: "review",
      target: "diff",
      peers: ["codex", "grok"],
    });
    await call("peer_state", {
      slug: "mcp incomplete",
      op: "record_output",
      peer: "codex",
      round: 1,
      output: "raw reply",
    });
    await call("peer_state", {
      slug: "mcp incomplete",
      op: "record_findings",
      peer: "codex",
      round: 1,
      findings: [
        {
          claim: "c",
          evidence: "e",
          severity: "minor",
          recommendation: "r",
        },
      ],
    });
    await call("peer_state", {
      slug: "mcp incomplete",
      op: "verdict",
      findingId: "f1",
      verdict: "verified",
    });

    const refused = await call("peer_state", {
      slug: "mcp incomplete",
      op: "close",
    });
    expect(refused.isError).toBe(true);
    expect(refused.json.code).toBe("CONFIG_INVALID");
    expect(refused.json.message).toContain("grok");

    const closed = await call("peer_state", {
      slug: "mcp incomplete",
      op: "close",
      allowIncomplete: true,
    });
    expect(closed.isError).toBeFalsy();
    expect(closed.json.incompleteSeats).toEqual(["grok"]);
  });
});

describe("phase param over a numeric-id tracker (#271)", () => {
  // GitHub milestone numbers are bare digits, and once they catch up with
  // the phase numbers a raw id and a cairn phase number look the same. The
  // shared fake mints "FP-n" ids, so this fixture seeds the live shape that
  // misfiled ten issues: milestone #21 is titled "Phase 23".
  class NumericPhaseTracker extends FakeTracker {
    private numbered: Phase[] = [];
    seed(id: string, name: string): void {
      this.numbered.push({ id, name, state: "open" });
    }
    override async listPhases(): Promise<Phase[]> {
      return this.numbered.map((p) => ({ ...p }));
    }
  }

  let projectDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-numeric-phase-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    const tracker = new NumericPhaseTracker();
    tracker.seed("19", "Phase 21: the-refutation");
    tracker.seed("21", "Phase 23: the-method");
    tracker.seed("25", "Phase 24.7: measured-actuals");
    const server = buildServer({ projectDir, tracker });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-numeric-phase", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(handoffPath(projectDir), { force: true });
    rmSync(outlookMirrorPath(projectDir), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("issue_create files cairn phase 21 under the milestone titled 'Phase 21', not milestone #21", async () => {
    const made = await call("issue_create", { title: "refutation work", phase: "21" });
    expect(made.isError).toBeFalsy();
    expect(made.json.phase).toBe("19");
  });

  it("issue_update re-phases by title, and id:<raw> reaches a number-shaped id", async () => {
    const made = await call("issue_create", { title: "moves twice", phase: "23" });
    expect(made.json.phase).toBe("21");
    const byNumber = await call("issue_update", { id: made.json.id, phase: "21" });
    expect(byNumber.json.phase).toBe("19");
    const byId = await call("issue_update", { id: made.json.id, phase: "id:21" });
    expect(byId.json.phase).toBe("21");
  });

  it("issue_list filters by the titled phase, not the colliding id", async () => {
    const inPhase = await call("issue_create", { title: "method work", phase: "23" });
    const decoy = await call("issue_create", { title: "refutation decoy", phase: "21" });
    const listed = await call("issue_list", { phase: "23" });
    const ids = listed.json.map((i: { id: string }) => i.id);
    expect(ids).toContain(inPhase.json.id);
    expect(ids).not.toContain(decoy.json.id);
  });

  it("a milestone number with no matching title is NOT_FOUND, and the hint names the id: form", async () => {
    // milestone #25 exists; nothing is titled 'Phase 25:'
    const res = await call("issue_create", { title: "nowhere", phase: "25" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("NOT_FOUND");
    expect(res.json.message).toContain("Phase 25:");
    expect(res.json.nextAction).toContain("id:25");
  });
});

describe("continuity: write-through + tools", () => {
  // A dedicated registered project (cairn.json present) + server/client pair --
  // write-through only fires when the project is registered (Task 1's
  // unregistered guard), so this needs its own fixture rather than the shared
  // suite's tmpdir above, which is deliberately left unregistered.
  let projectDir: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-continuity-mcp-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    const server = buildServer({ projectDir, tracker: new FakeTracker() });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-continuity", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(handoffPath(projectDir), { force: true });
    rmSync(outlookMirrorPath(projectDir), { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("issue_update leaves a handoff naming that issue", async () => {
    const made = await call("issue_create", { title: "via mcp" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.issue).toBe(made.json.id);
    expect(got.json.handoff.source).toBe("tool");
  });

  it("write-through points also emit an outlook snapshot (#88)", async () => {
    const made = await call("issue_create", { title: "outlook ride-along" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    const mirror = outlookMirrorPath(projectDir);
    expect(existsSync(mirror)).toBe(true);
    const snap = JSON.parse(readFileSync(mirror, "utf8"));
    expect(snap.version).toBe(1);
    expect(snap.path).toBe(projectDir);
    expect(existsSync(join(projectDir, ".cairn", "outlook.json"))).toBe(true);
  });

  it("outlook_emit attaches a tracker block that later plain emits keep (#90)", async () => {
    const out = await call("outlook_emit", {
      tracker: {
        open: 3,
        blocked: 1,
        nextVerb: "verify 2",
        asOf: "2026-08-14",
      },
    });
    expect(out.json.emitted).toBe(true);

    // a routine write-through emit must not erase the verb-supplied block
    const made = await call("issue_create", { title: "post-gate ride-along" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });

    const snap = JSON.parse(
      readFileSync(outlookMirrorPath(projectDir), "utf8"),
    );
    expect(snap.tracker).toEqual({
      open: 3,
      blocked: 1,
      nextVerb: "verify 2",
      asOf: "2026-08-14",
    });
  });

  it("context_set({issueId: null}) clears a stale issue out of the handoff", async () => {
    const made = await call("issue_create", { title: "to be cleared" });
    await call("issue_update", { id: made.json.id, state: "in_progress" });
    const before = await call("continuity_get", {});
    expect(before.json.handoff.issue).toBe(made.json.id); // stale issue landed, per the test above

    await call("context_set", { issueId: null });

    const after = await call("continuity_get", {});
    expect(after.json.handoff.issue).toBeUndefined(); // explicit null must drop the field, not just skip patching it
  });

  it("ledger_append leaves a handoff naming the phase and issue", async () => {
    await call("plan_scaffold_project", { name: "T" });
    await call("plan_scaffold_phase", { number: 1, name: "Core" });
    await call("ledger_append", {
      phaseDir: "01-core",
      taskRef: "task-1",
      summary: "wire the tool",
      baseCommit: "a1b2c3d4e5f6",
      headCommit: "d4e5f6a1b2c3",
      issueId: "PROJ-9",
      closedDate: "2026-07-16",
      evidenceWaived: "handoff drill — no runnable change",
    });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.phase).toEqual({ number: 1, slug: "core" });
    expect(got.json.handoff.issue).toBe("PROJ-9");
  });

  it("continuity_checkpoint then continuity_get round-trips", async () => {
    await call("continuity_checkpoint", {
      next_action: "finish the write-through wiring",
      notes: "task 2",
    });
    const got = await call("continuity_get", {});
    expect(got.json.handoff.next_action).toBe(
      "finish the write-through wiring",
    );
    expect(got.json.handoff.notes).toBe("task 2");
    expect(got.json.stale).toBe(false);
  });

  it("continuity_checkpoint accepts a decimal phase ref and rejects an over-precise one as CONFIG_INVALID", async () => {
    const ok = await call("continuity_checkpoint", {
      phase: { number: 1.5, slug: "gamma" },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.json.handoff.phase).toEqual({ number: 1.5, slug: "gamma" });
    const bad = await call("continuity_checkpoint", {
      phase: { number: 1.55, slug: "gamma" },
    });
    expect(bad.isError).toBe(true);
    expect(bad.json.code).toBe("CONFIG_INVALID");
  });

  it("continuity_clear deletes the handoff", async () => {
    await call("continuity_checkpoint", { next_action: "x" });
    const cleared = await call("continuity_clear", {});
    expect(cleared.json.cleared).toBe(true);
    const got = await call("continuity_get", {});
    expect(got.json).toBeNull();
  });

  it("primary tool still succeeds when the handoff write fails", async () => {
    continuityFailure.failWrites = true; // writeHandoff throws (simulated unwritable dir)
    continuityFailure.failedAttempts = 0;
    try {
      const made = await call("issue_create", {
        title: "unaffected by continuity failure",
      });
      const updated = await call("issue_update", {
        id: made.json.id,
        state: "closed",
      });
      expect(updated.json.state).toBe("closed"); // primary tool result, unaffected
      expect(updated.isError).toBeFalsy();
      // Prove the failing path was actually exercised, not vacuously skipped:
      // issue_update's write-through must have attempted (and swallowed) a write.
      expect(continuityFailure.failedAttempts).toBeGreaterThan(0);
    } finally {
      continuityFailure.failWrites = false;
    }
  });
});

// A valid single-member cairn.json body, reused across the workspace fixtures.
const CAIRN_JSON = JSON.stringify({
  tracker: { type: "github", config: { repo: "o/r" } },
});

describe("workspace: focus redirect + board (two-member fixture)", () => {
  let wsRoot: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    wsRoot = mkdtempSync(join(tmpdir(), "cairn-ws-"));
    mkdirSync(join(wsRoot, "member-a"));
    mkdirSync(join(wsRoot, "member-b"));
    writeFileSync(join(wsRoot, "member-a", "cairn.json"), CAIRN_JSON);
    writeFileSync(join(wsRoot, "member-b", "cairn.json"), CAIRN_JSON);
    writeFileSync(
      join(wsRoot, "cairn-workspace.json"),
      JSON.stringify({
        workspace: "ws-test",
        members: [
          { name: "a", path: "member-a" },
          { name: "b", path: "member-b" },
        ],
      }),
    );
    const server = buildServer({
      projectDir: wsRoot,
      tracker: new FakeTracker(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-ws", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("workspace_list reports the workspace, members, and null focus", async () => {
    const out = await call("workspace_list", {});
    expect(out.json.workspace).toBe("ws-test");
    expect(
      out.json.members.map((m: { name: string }) => m.name).sort(),
    ).toEqual(["a", "b"]);
    expect(
      out.json.members.every((m: { configured: boolean }) => m.configured),
    ).toBe(true);
    expect(out.json.focus).toBeNull();
  });

  it("workspace_focus rejects an unknown member", async () => {
    const res = await call("workspace_focus", { project: "ghost" });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });

  it("focus on b redirects context_set into member b's .cairn/ only", async () => {
    const focused = await call("workspace_focus", { project: "b" });
    expect(focused.json).toEqual({
      focus: "b",
      projectDir: join(wsRoot, "member-b"),
    });

    await call("context_set", { phase: 7 });
    const got = await call("context_get", {});
    expect(got.json).toEqual({ phase: 7 });

    // the context landed in member b's store -- and NOWHERE else
    const ctxFile = join(".cairn", "state", "active-context.json");
    expect(existsSync(join(wsRoot, "member-b", ctxFile))).toBe(true);
    expect(existsSync(join(wsRoot, "member-a", ctxFile))).toBe(false);
    expect(existsSync(join(wsRoot, ctxFile))).toBe(false);

    // clearing focus lands reads back at the launch dir, which has no context
    const cleared = await call("workspace_focus", { project: null });
    expect(cleared.json.focus).toBeNull();
    const back = await call("context_get", {});
    expect(back.json).toEqual({});
  });

  it("board round-trips through board_update / board_get", async () => {
    const created = await call("board_update", {
      patch: { ws1: { title: "wire the resolver", project: "a" } },
    });
    expect(created.json).toEqual({ workstreams: 1 });

    const got = await call("board_get", {});
    expect(got.json.workstreams.ws1).toMatchObject({
      title: "wire the resolver",
      project: "a",
      status: "queued",
    });
    expect(got.json.counts).toEqual({
      queued: 1,
      active: 0,
      blocked: 0,
      done: 0,
    });

    await call("board_update", {
      patch: { ws1: { status: "active", note: "claimed" } },
    });
    const after = await call("board_get", {});
    expect(after.json.workstreams.ws1).toMatchObject({
      status: "active",
      note: "claimed",
    });
    expect(after.json.counts.active).toBe(1);

    const deleted = await call("board_update", { patch: { ws1: null } });
    expect(deleted.json).toEqual({ workstreams: 0 });
  });

  it("board_update rejects a workstream naming a non-member project", async () => {
    const res = await call("board_update", {
      patch: { bad: { title: "t", project: "ghost" } },
    });
    expect(res.isError).toBe(true);
  });
});

describe("workspace_status: per-member isolation", () => {
  let wsRoot: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };

  beforeAll(async () => {
    wsRoot = mkdtempSync(join(tmpdir(), "cairn-ws-status-"));
    // member "a" IS the workspace root (path ".") so the test-injected
    // FakeTracker -- bound to the launch dir -- serves its tracker reads.
    writeFileSync(join(wsRoot, "cairn.json"), CAIRN_JSON);
    // member "broken" has a cairn.json whose tracker config fails adapter
    // validation (repo isn't owner/name) -- makeTracker throws fast, no network.
    mkdirSync(join(wsRoot, "member-broken"));
    writeFileSync(
      join(wsRoot, "member-broken", "cairn.json"),
      JSON.stringify({
        tracker: { type: "github", config: { repo: "not-a-slug" } },
      }),
    );
    writeFileSync(
      join(wsRoot, "cairn-workspace.json"),
      JSON.stringify({
        workspace: "ws-status",
        members: [
          { name: "a", path: "." },
          { name: "broken", path: "member-broken" },
        ],
      }),
    );
    const server = buildServer({
      projectDir: wsRoot,
      tracker: new FakeTracker(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-ws-status", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  afterAll(() => {
    rmSync(wsRoot, { recursive: true, force: true });
  });

  it("one erroring member yields { name, error } without failing the call", async () => {
    await call("issue_create", { title: "open issue for status" });
    await call("context_set", { phase: 2 });

    const out = await call("workspace_status", {});
    expect(out.isError).toBeFalsy();
    expect(out.json.workspace).toBe("ws-status");

    const a = out.json.members.find((m: { name: string }) => m.name === "a");
    expect(a).toMatchObject({ name: "a", phase: 2, openSessions: 0 });
    expect(a.openIssues).toBeGreaterThanOrEqual(1);
    expect(a.error).toBeUndefined();

    const broken = out.json.members.find(
      (m: { name: string }) => m.name === "broken",
    );
    expect(broken.error).toBeTruthy();
    expect(broken.openIssues).toBeUndefined();
  });
});

describe("config_set tracker memo eviction", () => {
  // Regression: the per-dir tracker memo used to survive a config_set that
  // changed the tracker config, so every later tracker call kept hitting the
  // old backend (stale baseUrl) until the server was restarted.
  it("rebuilds the tracker from the new config after config_set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-evict-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({
        tracker: {
          type: "jira",
          config: { baseUrl: "https://old.example.com", projectKey: "T" },
        },
      }),
    );
    vi.stubEnv("JIRA_EMAIL", "t@example.com");
    vi.stubEnv("JIRA_API_TOKEN", "tok");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ issues: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      // no injected tracker -- getTracker must build the real (stubbed) jira adapter
      const server = buildServer({ projectDir: dir });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "evict-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);

      await c.callTool({ name: "issue_list", arguments: {} });
      expect(urls.at(-1)).toContain("old.example.com");

      await c.callTool({
        name: "config_set",
        arguments: {
          patch: {
            tracker: { config: { baseUrl: "https://new.example.com" } },
          },
        },
      });
      await c.callTool({ name: "issue_list", arguments: {} });
      expect(urls.at(-1)).toContain("new.example.com");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("docs tools over an injected fake connector", () => {
  it("docs_publish publishes the tree; docs_status reports the landing page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({
        tracker: { type: "github", config: { repo: "o/r" } },
        docs: {
          connector: "confluence",
          config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" },
        },
      }),
    );
    writeFileSync(join(dir, "README.md"), "# Landing");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nBody.");
    const { FakeDocsConnector } = await import("../src/docs/fake.js");
    const fake = new FakeDocsConnector();
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
        docsConnector: fake,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);

      const pub = await c.callTool({
        name: "docs_publish",
        arguments: { projectName: "proj", confirm: true },
      });
      const pubJson = JSON.parse(
        (pub.content as Array<{ text: string }>)[0].text,
      );
      expect(pub.isError).toBeFalsy();
      expect(pubJson.published).toBe(2);
      expect(pubJson.root.title).toBe("proj");
      expect(fake.pages.size).toBe(2);

      const status = await c.callTool({
        name: "docs_status",
        arguments: { projectName: "proj" },
      });
      const statusJson = JSON.parse(
        (status.content as Array<{ text: string }>)[0].text,
      );
      expect(statusJson.configured).toBe(true);
      expect(statusJson.connector).toBe("confluence");
      expect(statusJson.root.title).toBe("proj");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("docs_publish refuses without the owner's confirm and publishes nothing (#253)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-confirm-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({
        tracker: { type: "github", config: { repo: "o/r" } },
        docs: {
          connector: "confluence",
          config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" },
        },
      }),
    );
    writeFileSync(join(dir, "README.md"), "# Landing");
    const { FakeDocsConnector } = await import("../src/docs/fake.js");
    const fake = new FakeDocsConnector();
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
        docsConnector: fake,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-confirm-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);

      // No confirm, and an explicit false -- both refused, nothing published
      for (const args of [{ projectName: "proj" }, { projectName: "proj", confirm: false }]) {
        const res = await c.callTool({ name: "docs_publish", arguments: args });
        const text = (res.content as Array<{ text: string }>)[0].text;
        expect(res.isError).toBe(true);
        expect(text).toContain("PRECONDITION_FAILED");
        expect(text).toContain("owner");
        expect(fake.pages.size).toBe(0);
      }

      // The owner's yes -- publishes
      const ok = await c.callTool({
        name: "docs_publish",
        arguments: { projectName: "proj", confirm: true },
      });
      expect(ok.isError).toBeFalsy();
      expect(fake.pages.size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("docs_status reports a graceful shape when a configured connector is unreachable (#46)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-down-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({
        tracker: { type: "github", config: { repo: "o/r" } },
        docs: {
          connector: "confluence",
          config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" },
        },
      }),
    );
    const { CairnError } = await import("../src/errors.js");
    const unreachable: import("../src/docs/types.js").DocsConnector = {
      capabilities: {
        hasPageTree: true,
        hasAttachments: false,
        hasLabels: false,
        hasNativeToc: false,
      },
      ensureRoot: () => {
        throw new CairnError(
          "AUTH_MISSING",
          "HTTP 401 from https://x — body: invalid token",
          "token was rejected — regenerate or check it matches the account",
        );
      },
      getPage: () => {
        throw new Error("not used");
      },
      findPage: async () => {
        throw new CairnError(
          "AUTH_MISSING",
          "HTTP 401 from https://x — body: invalid token",
          "token was rejected — regenerate or check it matches the account",
        );
      },
      listChildren: () => {
        throw new Error("not used");
      },
      createPage: () => {
        throw new Error("not used");
      },
      updatePage: () => {
        throw new Error("not used");
      },
    };
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
        docsConnector: unreachable,
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test-3", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const status = await c.callTool({
        name: "docs_status",
        arguments: { projectName: "proj" },
      });
      const statusJson = JSON.parse(
        (status.content as Array<{ text: string }>)[0].text,
      );
      expect(status.isError).toBeFalsy();
      expect(statusJson.configured).toBe(true);
      expect(statusJson.reachable).toBe(false);
      expect(statusJson.error).toBe("AUTH_MISSING");
      expect(statusJson.message).toContain("invalid token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("docs_status reports configured:false without a docs block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-nodocs-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-test-2", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const status = await c.callTool({ name: "docs_status", arguments: {} });
      const statusJson = JSON.parse(
        (status.content as Array<{ text: string }>)[0].text,
      );
      expect(statusJson.configured).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("config_probe also probes a configured docs connector (CRN-48)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-docs-probe-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({
        tracker: { type: "github", config: { repo: "o/r" } },
        docs: {
          connector: "confluence",
          config: { baseUrl: "https://x.atlassian.net/wiki", spaceKey: "D" },
        },
      }),
    );
    const { FakeDocsConnector } = await import("../src/docs/fake.js");
    const fake = new FakeDocsConnector();
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
        docsConnector: fake,
        fetchLatestVersion: async () => {
          throw new Error("offline");
        },
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "docs-probe-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const res = await c.callTool({ name: "config_probe", arguments: {} });
      const json = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      expect(res.isError).toBeFalsy();
      expect(json.tracker).toEqual({ verdict: "ok" });
      expect(json.docs).toEqual({ verdict: "ok" });
      // #82: a rejecting npm lookup fails SOFT -- "unknown", probe stays green.
      expect(json.versions.npmLatest).toBe("unknown");
      expect(json.versions.drift).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("broken native binding (#108): probe advises, index tools fail typed, card tools keep working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-native-probe-"));
    writeFileSync(
      join(dir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    try {
      const server = buildServer({
        projectDir: dir,
        tracker: new FakeTracker(),
        fetchLatestVersion: async () => "9.9.9",
        // Simulated missing compiled binding -- the real one stays intact.
        loadSqlite: () => {
          throw new Error(
            "Could not locate the bindings file. Tried:\n → .../better_sqlite3.node",
          );
        },
      });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: "native-probe-test", version: "0.0.0" });
      await Promise.all([server.connect(st), c.connect(ct)]);
      const callC = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await c.callTool({ name, arguments: args });
        const text = (res.content as Array<{ text: string }>)[0].text;
        return { ...res, json: JSON.parse(text) };
      };

      // Preflight: advisory broken line with the fix command -- probe itself
      // still succeeds.
      const probe = await callC("config_probe", {});
      expect(probe.isError).toBeFalsy();
      expect(probe.json.native.status).toBe("broken");
      expect(probe.json.native.module).toBe("better-sqlite3");
      // #178: the two modes are told apart -- nothing compiled here at all.
      expect(probe.json.native.kind).toBe("absent");
      expect(probe.json.native.fix).toMatch(
        /^cd .+ && npm rebuild better-sqlite3, then reload plugins/,
      );

      // Tier-1 index tools degrade to the typed error, never the raw stack
      // -- the loader throws the raw loader message here, and MemoryIndex's
      // own translation turns it into NATIVE_MODULE_BROKEN.
      const search = await callC("mem_search", { query: "anything" });
      expect(search.isError).toBe(true);
      expect(search.json.code).toBe("NATIVE_MODULE_BROKEN");
      expect(search.json.message).toContain(
        `native module better-sqlite3 has no compiled binding in this install (node ${process.version})`,
      );
      expect(search.json.message).toContain("npm rebuild better-sqlite3");
      expect(search.json.message).not.toContain(
        "Could not locate the bindings file",
      );

      // Card tools never touch sqlite -- they keep working.
      const card = await callC("mem_card_create", {
        type: "note",
        body: "cards are file-backed, no native binding involved",
      });
      expect(card.isError).toBeFalsy();
      const list = await callC("mem_card_list", {});
      expect(list.isError).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
