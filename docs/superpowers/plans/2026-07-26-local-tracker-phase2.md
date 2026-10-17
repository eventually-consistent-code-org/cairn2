# Local Tracker Phase 2 — Graph Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the phase-1 edges into working graph features — ready-frontier detection, dependency-chain effective priority (CRN-22 native), iteration lineage, dangling-edge detection — surfaced through a `graph_report` MCP tool and the status/medic verbs. Spec: `docs/superpowers/specs/2026-07-26-local-tracker-design.md` §Graph data model, phase 2 of 4 (CRN-50).

**Architecture:** A pure functions module (`server/src/tracker/graph.ts`) computing over `Issue[]` + `IssueLink[]` — no filesystem, no backend coupling, works against ANY tracker with `hasDependencies`. One new server tool `graph_report` feeds it from `listIssues()` + `listLinks()`. Verb docs (status, medic) reference the report.

**Tech Stack:** TypeScript ESM, vitest. No new dependencies.

## Global Constraints

- Graph functions are pure — `(issues, links) => result`; all fs/IO stays in the adapter.
- Priority convention: `priority:<P0|P1|P2|P3|...>` labels; lower number = more urgent; unlabeled = lowest urgency; unknown formats ignored.
- Edge direction: `A blocks B` means B waits on A.
- Tool count moves 68 → 69: update both pins and the two doc counts (`server/README.md`, runbook `### The 68 MCP tools` heading + tracker section).

---

### Task 1: Pure graph module

**Files:**
- Create: `server/src/tracker/graph.ts`
- Test: `server/test/graph.test.ts` (create)

**Interfaces:**
- Produces (Task 2 consumes):

```ts
export interface PriorityEntry { id: string; declared?: string; effective: string; inheritedFrom?: string }
export function readyFrontier(issues: Issue[], links: IssueLink[]): Issue[];
export function effectivePriorities(issues: Issue[], links: IssueLink[]): PriorityEntry[]; // only entries where effective ≠ declared
export function lineage(issues: Issue[], links: IssueLink[], id: string): string[]; // oldest → newest chain through `supersedes`
export function danglingEdges(issues: Issue[], links: IssueLink[]): IssueLink[];
```

- [ ] **Step 1: Failing tests** (`graph.test.ts`) — build fixtures with a tiny `issue(id, state, labels?)` helper returning an `Issue` literal; no tracker needed.

```ts
import { describe, it, expect } from "vitest";
import { danglingEdges, effectivePriorities, lineage, readyFrontier } from "../src/tracker/graph.js";
import type { Issue, IssueLink } from "../src/tracker/types.js";

const issue = (id: string, state: Issue["state"] = "open", labels: string[] = []): Issue =>
  ({ id, title: id, body: "", state, labels, updatedAt: "2026-07-26T00:00:00Z", url: `x://${id}` });

const L = (from: string, type: IssueLink["type"], to: string): IssueLink => ({ from, type, to });

describe("readyFrontier", () => {
  it("open issues with no open blockers; closed blockers unblock", () => {
    const issues = [issue("a", "closed"), issue("b"), issue("c"), issue("d", "in_progress")];
    const links = [L("a", "blocks", "b"), L("c", "blocks", "d"), L("b", "blocks", "c")];
    // b: blocker a closed → ready. c: blocker b open → not ready. d: in_progress → not listed.
    expect(readyFrontier(issues, links).map((i) => i.id)).toEqual(["b"]);
  });

  it("ignores non-blocking edge types", () => {
    const issues = [issue("a"), issue("b")];
    expect(readyFrontier(issues, [L("a", "relates-to", "b")]).map((i) => i.id).sort())
      .toEqual(["a", "b"]);
  });
});

describe("effectivePriorities", () => {
  it("an issue inherits the strongest priority it transitively blocks", () => {
    const issues = [
      issue("low", "open", ["priority:P3"]),
      issue("mid", "open"),
      issue("high", "open", ["priority:P1"]),
    ];
    const links = [L("low", "blocks", "mid"), L("mid", "blocks", "high")];
    const out = effectivePriorities(issues, links);
    expect(out).toContainEqual({ id: "low", declared: "P3", effective: "P1", inheritedFrom: "high" });
    expect(out).toContainEqual({ id: "mid", declared: undefined, effective: "P1", inheritedFrom: "high" });
    expect(out.find((e) => e.id === "high")).toBeUndefined(); // unchanged → not reported
  });

  it("closed downstream issues confer nothing", () => {
    const issues = [issue("a", "open", ["priority:P3"]), issue("b", "closed", ["priority:P0"])];
    expect(effectivePriorities(issues, [L("a", "blocks", "b")])).toEqual([]);
  });
});

describe("lineage", () => {
  it("walks supersedes both directions, oldest first", () => {
    const issues = [issue("v1", "closed"), issue("v2", "closed"), issue("v3")];
    const links = [L("v2", "supersedes", "v1"), L("v3", "supersedes", "v2")];
    expect(lineage(issues, links, "v2")).toEqual(["v1", "v2", "v3"]);
  });

  it("no supersedes edges → just the issue itself", () => {
    expect(lineage([issue("solo")], [], "solo")).toEqual(["solo"]);
  });
});

describe("danglingEdges", () => {
  it("flags links whose endpoints no longer exist", () => {
    const links = [L("a", "blocks", "gone"), L("a", "relates-to", "b")];
    expect(danglingEdges([issue("a"), issue("b")], links))
      .toEqual([L("a", "blocks", "gone")]);
  });
});
```

- [ ] **Step 2: Run** `cd server && npx vitest run test/graph.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `graph.ts`.** Pure module, header comment stating it works over any hasDependencies backend. Details: priority rank = numeric part of `P<n>` (lower = stronger), missing/unparseable = Infinity; `effectivePriorities` walks `blocks` edges forward (what each issue transitively blocks, skipping closed downstream issues) and reports only rows where effective rank < declared rank, `inheritedFrom` = the strongest downstream contributor; `readyFrontier` = `state === "open"` and every `blocks` edge pointing AT it has a closed `from` issue; `lineage` = follow `supersedes` from-side backward (what this supersedes) and to-side forward, dedupe, oldest → newest; `danglingEdges` = endpoint not in the id set.

- [ ] **Step 4: Run** `npx vitest run test/graph.test.ts` — PASS; then full suite + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(tracker): pure graph module — ready frontier, effective priority, lineage, dangling edges`

---

### Task 2: `graph_report` server tool

**Files:**
- Modify: `server/src/index.ts` (new tool after `issue_links`)
- Test: `server/test/mcp.test.ts` (extend; update tool pins 68 → 69)
- Modify: `server/README.md`, `docs/01-runbook.md` (counts + tool listing)

**Interfaces:**
- Consumes: Task 1's four functions; existing `linkCapable()` gate from phase 1.
- Produces: tool `graph_report` → `{ frontier: Issue[], priorities: PriorityEntry[], dangling: IssueLink[], lineage?: string[] }`, `lineageOf` optional input.

- [ ] **Step 1: Failing tests** (append to `mcp.test.ts`; harness = FakeTracker, which has real links)

```ts
  it("graph_report: frontier, inherited priority, lineage", async () => {
    const blocker = await call("issue_create", { title: "graph blocker", labels: ["priority:P3"] });
    const blocked = await call("issue_create", { title: "graph blocked", labels: ["priority:P1"] });
    await call("issue_link", { from: blocker.json.id, type: "blocks", to: blocked.json.id });
    const v2 = await call("issue_create", { title: "graph v2" });
    await call("issue_link", { from: v2.json.id, type: "supersedes", to: blocker.json.id });

    const report = await call("graph_report", { lineageOf: v2.json.id });
    const frontierIds = report.json.frontier.map((i: { id: string }) => i.id);
    expect(frontierIds).toContain(blocker.json.id);      // nothing blocks it
    expect(frontierIds).not.toContain(blocked.json.id);  // blocker still open
    expect(report.json.priorities).toContainEqual({
      id: blocker.json.id, declared: "P3", effective: "P1", inheritedFrom: blocked.json.id,
    });
    expect(report.json.lineage).toEqual([blocker.json.id, v2.json.id]);
    expect(report.json.dangling).toEqual([]);
  });
```

Also update the two pin tests: add `"graph_report"` to the sorted list, `68` → `69`.

- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts` — FAIL (unknown tool + pins).

- [ ] **Step 3: Implement** in `index.ts` (imports: the four graph functions):

```ts
  server.registerTool("graph_report",
    { description: "Dependency-graph report: ready frontier (open issues with no open "
        + "blockers), inherited effective priorities, dangling edges, and optionally "
        + "one issue's supersedes lineage. UNSUPPORTED unless the tracker hasDependencies",
      inputSchema: { lineageOf: z.string().optional() } },
    wrap(async (a: { lineageOf?: string }) => {
      const t = await linkCapable();
      const [issues, links] = await Promise.all([t.listIssues(), t.listLinks!()]);
      return {
        frontier: readyFrontier(issues, links),
        priorities: effectivePriorities(issues, links),
        dangling: danglingEdges(issues, links),
        ...(a.lineageOf ? { lineage: lineage(issues, links, a.lineageOf) } : {}),
      };
    }));
```

Docs: `server/README.md` "68 tools" → "69 tools" (+ graph_report in the tracker clause); runbook heading `### The 68 MCP tools` → 69 and the Tracker/issues group gains `graph_report` (count 11 → 12).

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green.
- [ ] **Step 5: Commit** `feat(server): graph_report tool — frontier, inherited priority, lineage, dangling edges`

---

### Task 3: Verb docs — status + medic surface the graph

**Files:**
- Modify: `skills/cairn-trailhead/verbs/status.md`
- Modify: `skills/cairn-trailhead/verbs/medic.md`
- Modify: `docs/01-runbook.md` (short "Dependency graph" subsection under the local-tracker/verbs area — place near the status verb docs; find with `grep -n "## .*status" docs/01-runbook.md`)

**Interfaces:** none — instruction text for the verb LLM.

- [ ] **Step 1:** `status.md`: add one step — when the tracker `hasDependencies`, call `graph_report` and render: "Ready now" (frontier, this is the pick-next-work list), inherited-priority rows as `effective P1 (inherits from <id>)`, and a ⚠ line when `dangling` is non-empty pointing at `/cairn:medic`.
- [ ] **Step 2:** `medic.md`: add dangling-edge check — `graph_report.dangling`; report each as broken relationship; `--repair` removes them via `issue_unlink` (safe: the edge's endpoint is gone, nothing to preserve).
- [ ] **Step 3:** Runbook subsection: what the graph gives (ready frontier, inherited priority, lineage), one sentence each, plus "local tracker first; any backend that grows hasDependencies gets this for free".
- [ ] **Step 4: Commit** `docs(verbs): status + medic surface the dependency graph`

---

## Verification (phase gate)

- Full suite + typecheck green.
- Manual smoke: scratch local-tracker project through the real server — 4 issues, chain of blocks + a supersedes pair, `graph_report` returns the expected frontier/priorities/lineage; delete an issue dir by hand, report shows the dangling edge.
- Comment phase-2 progress on CRN-50.
