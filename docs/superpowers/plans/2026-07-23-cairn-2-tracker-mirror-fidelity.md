# Tracker-Mirror Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inbound tracker delta detection (`plan_tracker_delta` cursor tool) plus outbound paper trail (comment lifecycle + Jira worklog), per `docs/superpowers/specs/2026-07-23-cairn-2-tracker-mirror-fidelity-design.md`.

**Architecture:** New planning module `tracker-delta.ts` keeps a JSON snapshot cursor at `.cairn/tracker-marker.json`, diffs live `listIssues()`/`listPhases()` against it, and returns a categorized delta with peek-vs-ack semantics. Server mutation handlers write through to the snapshot so cairn's own actions never echo as external changes. Worklog is a new adapter capability (`hasWorklog` + optional `logWork`), Jira implements it, `issue_close` gains `timeSpentMinutes`. Verb docs pick both halves up: `status`/`plan`/`work` peek the delta as step 0, `resync` goes two-directional, and every claiming verb gains the comment lifecycle.

**Tech Stack:** TypeScript MCP server (`@modelcontextprotocol/sdk`, zod), vitest, `FakeTracker` for contract tests, dependency-free Node hook scripts.

## Global Constraints

- Typed errors only (`CairnError` codes: `TRACKER_DOWN`, `RATE_LIMITED`, `NOT_FOUND`, `CONFIG_INVALID`) — never stack traces to the user.
- A failed scan leaves the cursor untouched (spec: error handling).
- No new verb, no new command shim, no new `cairn.json` key.
- Hook scripts stay dependency-free and fire-and-forget; the SessionStart hook never touches the network.
- Comment discipline (leak guard): plain language, no code blocks, no internal refs; commit refs as short refs on their own line.
- `node scripts/check-surface.mjs` must pass after every verb-doc task (check (d) validates tool names referenced in verb docs against the server registry).
- Run all tests from `server/`: `npm test`.

---

### Task 1: Delta core — `trackerDelta()` with cursor, peek/ack

**Files:**
- Create: `server/src/planning/tracker-delta.ts`
- Test: `server/test/tracker-delta.test.ts`

**Interfaces:**
- Consumes: `Tracker`, `Issue`, `Phase`, `IssueState` from `server/src/tracker/types.ts`; `FakeTracker` from `server/src/tracker/fake.ts` (tests only).
- Produces (later tasks rely on these exact names):
  - `trackerDelta(projectDir: string, tracker: Tracker, opts?: { ack?: boolean }): Promise<TrackerDeltaReport>`
  - `snapshotNote(projectDir: string, issue: Issue): void` (Task 2 calls it from mutation handlers)
  - `markerPath(projectDir: string): string` → `<projectDir>/.cairn/tracker-marker.json` (Task 4's hook reads the same file)
  - `TrackerDeltaReport = { initialized: boolean, new: Issue[], newPhases: Phase[], edited: EditedItem[], stateChanged: StateChange[] }`
  - `EditedItem = { issue: Issue, changes: FieldChange[] }`, `FieldChange = { field: "title" | "body" | "labels" | "assignee", from?: string, to?: string }` (body changes carry no from/to — hash only)
  - `StateChange = { issue: Issue, from: IssueState, to: IssueState }`

- [ ] **Step 1: Write the failing tests**

`server/test/tracker-delta.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { trackerDelta, snapshotNote, markerPath } from "../src/planning/tracker-delta.js";

describe("trackerDelta", () => {
  let dir: string;
  let tracker: FakeTracker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-td-"));
    tracker = new FakeTracker();
  });

  it("first run initializes the cursor and reports nothing", async () => {
    await tracker.createIssue({ title: "pre-existing" });
    const r = await trackerDelta(dir, tracker);
    expect(r.initialized).toBe(true);
    expect(r.new).toEqual([]);
    expect(r.edited).toEqual([]);
    expect(r.stateChanged).toEqual([]);
    expect(existsSync(markerPath(dir))).toBe(true);
  });

  it("detects new issues and new phases after init", async () => {
    await trackerDelta(dir, tracker); // init
    const added = await tracker.createIssue({ title: "PM added this" });
    await tracker.createPhase("PM epic");
    const r = await trackerDelta(dir, tracker);
    expect(r.initialized).toBe(false);
    expect(r.new.map((i) => i.id)).toEqual([added.id]);
    expect(r.newPhases.map((p) => p.name)).toEqual(["PM epic"]);
  });

  it("detects field edits with per-field diffs; body reports field only", async () => {
    const i = await tracker.createIssue({ title: "orig", body: "b1" });
    await trackerDelta(dir, tracker, { ack: true });
    await tracker.updateIssue(i.id, { title: "renamed", body: "b2" });
    const r = await trackerDelta(dir, tracker);
    expect(r.edited).toHaveLength(1);
    const fields = r.edited[0].changes.map((c) => c.field).sort();
    expect(fields).toEqual(["body", "title"]);
    const title = r.edited[0].changes.find((c) => c.field === "title")!;
    expect(title.from).toBe("orig");
    expect(title.to).toBe("renamed");
    const body = r.edited[0].changes.find((c) => c.field === "body")!;
    expect(body.from).toBeUndefined();
  });

  it("detects state changes separately from edits", async () => {
    const i = await tracker.createIssue({ title: "x" });
    await trackerDelta(dir, tracker, { ack: true });
    await tracker.updateIssue(i.id, { state: "closed" });
    const r = await trackerDelta(dir, tracker);
    expect(r.edited).toEqual([]);
    expect(r.stateChanged).toEqual([
      expect.objectContaining({ from: "open", to: "closed" }),
    ]);
  });

  it("peek does not advance the cursor; ack does", async () => {
    await trackerDelta(dir, tracker); // init
    const added = await tracker.createIssue({ title: "sticky" });
    const peek1 = await trackerDelta(dir, tracker);
    const peek2 = await trackerDelta(dir, tracker);
    expect(peek1.new.map((i) => i.id)).toEqual([added.id]);
    expect(peek2.new.map((i) => i.id)).toEqual([added.id]); // re-surfaces
    await trackerDelta(dir, tracker, { ack: true });
    const after = await trackerDelta(dir, tracker);
    expect(after.new).toEqual([]);
  });

  it("snapshotNote absorbs cairn-side mutations so they never echo", async () => {
    const i = await tracker.createIssue({ title: "mine" });
    await trackerDelta(dir, tracker, { ack: true });
    const closed = await tracker.closeIssue(i.id);
    snapshotNote(dir, closed); // what index.ts handlers will do
    const r = await trackerDelta(dir, tracker);
    expect(r.stateChanged).toEqual([]);
  });

  it("snapshotNote is a silent no-op before init", () => {
    expect(() =>
      snapshotNote(dir, {
        id: "X-1", title: "t", body: "", state: "open", labels: [],
        updatedAt: new Date().toISOString(), url: "fake://x",
      }),
    ).not.toThrow();
    expect(existsSync(markerPath(dir))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/tracker-delta.test.ts`
Expected: FAIL — `Cannot find module '../src/planning/tracker-delta.js'`

- [ ] **Step 3: Implement `tracker-delta.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Issue, IssueState, Phase, Tracker } from "../tracker/types.js";

interface IssueSnap {
  title: string;
  bodyHash: string;
  labels: string[];
  assignee?: string;
  state: IssueState;
  updatedAt: string;
}

interface Marker {
  lastScan: string;
  issues: Record<string, IssueSnap>;
  phases: Record<string, string>; // id -> name
}

export interface FieldChange {
  field: "title" | "body" | "labels" | "assignee";
  from?: string;
  to?: string;
}
export interface EditedItem { issue: Issue; changes: FieldChange[] }
export interface StateChange { issue: Issue; from: IssueState; to: IssueState }
export interface TrackerDeltaReport {
  initialized: boolean;
  new: Issue[];
  newPhases: Phase[];
  edited: EditedItem[];
  stateChanged: StateChange[];
}

export const markerPath = (projectDir: string) =>
  join(projectDir, ".cairn", "tracker-marker.json");

const bodyHash = (body: string) =>
  createHash("sha256").update(body).digest("hex").slice(0, 16);

const snap = (i: Issue): IssueSnap => ({
  title: i.title, bodyHash: bodyHash(i.body), labels: [...i.labels].sort(),
  assignee: i.assignee, state: i.state, updatedAt: i.updatedAt,
});

const readMarker = (projectDir: string): Marker | null => {
  const p = markerPath(projectDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Marker;
};

const writeMarker = (projectDir: string, m: Marker) => {
  const p = markerPath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2));
};

/** Absorb a cairn-side mutation so it never echoes as an external change.
 *  Silent no-op before the first scan initializes the marker. */
export function snapshotNote(projectDir: string, issue: Issue): void {
  const m = readMarker(projectDir);
  if (!m) return;
  m.issues[issue.id] = snap(issue);
  writeMarker(projectDir, m);
}

export async function trackerDelta(
  projectDir: string,
  tracker: Tracker,
  opts: { ack?: boolean } = {},
): Promise<TrackerDeltaReport> {
  const [issues, phases] = await Promise.all([
    tracker.listIssues(),
    tracker.capabilities.hasPhases ? tracker.listPhases() : Promise.resolve([]),
  ]);

  const next: Marker = {
    lastScan: new Date().toISOString(),
    issues: Object.fromEntries(issues.map((i) => [i.id, snap(i)])),
    phases: Object.fromEntries(phases.map((p) => [p.id, p.name])),
  };

  const prev = readMarker(projectDir);
  if (!prev) {
    writeMarker(projectDir, next);
    return { initialized: true, new: [], newPhases: [], edited: [], stateChanged: [] };
  }

  const added: Issue[] = [];
  const edited: EditedItem[] = [];
  const stateChanged: StateChange[] = [];

  for (const i of issues) {
    const old = prev.issues[i.id];
    if (!old) { added.push(i); continue; }
    if (old.state !== i.state) stateChanged.push({ issue: i, from: old.state, to: i.state });
    const changes: FieldChange[] = [];
    if (old.title !== i.title) changes.push({ field: "title", from: old.title, to: i.title });
    if (old.bodyHash !== bodyHash(i.body)) changes.push({ field: "body" });
    if (old.labels.join(",") !== [...i.labels].sort().join(","))
      changes.push({ field: "labels", from: old.labels.join(", "), to: [...i.labels].sort().join(", ") });
    if ((old.assignee ?? "") !== (i.assignee ?? ""))
      changes.push({ field: "assignee", from: old.assignee, to: i.assignee });
    if (changes.length) edited.push({ issue: i, changes });
  }

  const newPhases = phases.filter((p) => !(p.id in prev.phases));

  if (opts.ack) writeMarker(projectDir, next);

  return { initialized: false, new: added, newPhases, edited, stateChanged };
}
```

Note: the scan happens BEFORE the marker write in every path, so a thrown
adapter error (`TRACKER_DOWN`, `RATE_LIMITED`) propagates without touching
the cursor — the global constraint falls out of the ordering, no extra code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/tracker-delta.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/planning/tracker-delta.ts server/test/tracker-delta.test.ts
git commit -m "feat(server): trackerDelta cursor diff with peek/ack semantics"
```

---

### Task 2: Register `plan_tracker_delta` + snapshot write-through on mutations

**Files:**
- Modify: `server/src/index.ts` (new registerTool near `plan_resync` at ~line 563; write-through in `issue_create`/`issue_update`/`issue_close` handlers, lines ~200-222)
- Test: `server/test/tracker-delta.test.ts` (extend)

**Interfaces:**
- Consumes: `trackerDelta`, `snapshotNote` from Task 1; existing `dir()`, `getTracker()`, `wrap()` helpers in `index.ts`.
- Produces: MCP tool `plan_tracker_delta` with input `{ ack?: boolean }` returning `TrackerDeltaReport` — the name verb docs (Task 5) reference; check-surface check (d) validates it against the registry.

- [ ] **Step 1: Register the tool in `index.ts`**

Add the import at the top alongside the other planning imports:

```ts
import { snapshotNote, trackerDelta } from "./planning/tracker-delta.js";
```

Register directly below the `plan_resync` registration:

```ts
server.registerTool("plan_tracker_delta",
  { description: "Diff the live tracker against the last-seen snapshot cursor: new issues/phases, "
      + "field edits, external state changes. Peek by default; ack: true advances the cursor. "
      + "First run initializes the cursor and reports nothing",
    inputSchema: { ack: z.boolean().optional() } },
  wrap(async (a: { ack?: boolean }) => {
    const d = dir();
    return trackerDelta(d, await getTracker(d), { ack: a.ack });
  }));
```

- [ ] **Step 2: Add write-through to the three mutation handlers**

In each of `issue_create`, `issue_update`, `issue_close` handlers in
`index.ts`, capture the returned `Issue` and pass it to `snapshotNote`
before returning. `issue_close` becomes (base shown as of `index.ts:215-222`;
Task 3 extends this same handler further):

```ts
wrap(async (a: { id: string }) => {
  const d = dir();
  const result = await (await getTracker(d)).closeIssue(a.id);
  snapshotNote(d, result);
  refreshHandoff({ source: "tool", issue: a.id }, d);
  return result;
}));
```

Apply the same one-line `snapshotNote(d, result)` after the adapter call in
`issue_create` and `issue_update` (both already bind `const d = dir()`; if a
handler currently calls `getTracker()` without `d`, bind `d` first).

- [ ] **Step 3: No new test** (decided in pre-flight review)

The write-through behavior is covered by Task 1's "snapshotNote absorbs
cairn-side mutations" test, and check-surface check (d) validates the
registered tool name at CI once verb docs reference it (Task 5). A
source-grep smoke test was considered and dropped as a non-behavioral
assertion.

- [ ] **Step 4: Build + full test run**

Run: `cd server && npm run build && npm test`
Expected: build clean, all suites PASS (479 existing + new)

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/test/tracker-delta.test.ts
git commit -m "feat(server): register plan_tracker_delta; snapshot write-through on issue mutations"
```

---

### Task 3: Worklog capability — types, adapters, Jira, `issue_close.timeSpentMinutes`

**Files:**
- Modify: `server/src/tracker/types.ts` (Capability + Tracker)
- Modify: `server/src/tracker/adapters/jira.ts` (capability true + `logWork`)
- Modify: `server/src/tracker/adapters/{github,gitlab,asana,azure-boards,clickup}.ts`, `server/src/tracker/fake.ts` (capability false)
- Modify: `server/src/index.ts` (`issue_close` schema + handler)
- Test: `server/test/jira.test.ts` (extend, following its existing injected-`FetchLike` mock pattern)

**Interfaces:**
- Consumes: `fetchJson` via the Jira adapter's private `api()` helper (`jira.ts:122-128`); `Capability` interface (`types.ts:22-30`).
- Produces:
  - `Capability.hasWorklog: boolean` (compile error forces every adapter to declare it)
  - `Tracker.logWork?(id: string, minutes: number): Promise<void>` (optional method; only Jira implements in this task)
  - `issue_close` input `{ id: string, timeSpentMinutes?: number }`, result gains `worklogLogged: boolean`

- [ ] **Step 1: Write the failing Jira test**

Add to `server/test/jira.test.ts`, using the file's existing mock-fetch
helper (a `FetchLike` that records calls and returns canned JSON — reuse
the helper the existing close/comment tests use):

```ts
it("logWork posts a Jira worklog with timeSpentSeconds", async () => {
  const { tracker, calls } = makeTracker(); // the file's existing factory
  await tracker.logWork!("PROJ-7", 90);
  const call = calls.find((c) => c.url.endsWith("/rest/api/3/issue/PROJ-7/worklog"));
  expect(call).toBeDefined();
  expect(call!.init.method).toBe("POST");
  expect(JSON.parse(call!.init.body as string)).toEqual({ timeSpentSeconds: 5400 });
});

it("declares hasWorklog", () => {
  const { tracker } = makeTracker();
  expect(tracker.capabilities.hasWorklog).toBe(true);
});
```

If the file's factory is named differently, use its actual name — the
pattern (injected fetch, recorded calls) is what matters, not the name.

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/jira.test.ts`
Expected: FAIL — `hasWorklog` missing / `logWork` undefined

- [ ] **Step 3: Implement**

`types.ts` — extend `Capability` and `Tracker`:

```ts
export interface Capability {
  hasInProgress: boolean;
  hasPhases: boolean;
  hasDependencies: boolean;
  hasLabels: boolean;
  hasMilestones: boolean;
  hasPhaseClose: boolean;
  hasComments: boolean;
  hasWorklog: boolean;
}
```

```ts
  commentIssue(id: string, text: string): Promise<{ id: string; url?: string }>;
  /** Log time against an issue. Present only on adapters with hasWorklog. */
  logWork?(id: string, minutes: number): Promise<void>;
```

Every adapter's `capabilities` literal gains `hasWorklog: false` (the
compiler lists them all once `Capability` changes) — except Jira:
`hasWorklog: true`, plus:

```ts
async logWork(id: string, minutes: number): Promise<void> {
  await this.api("POST", `/rest/api/3/issue/${id}/worklog`,
    { timeSpentSeconds: minutes * 60 }, "jira worklog");
}
```

`index.ts` — `issue_close` schema and handler (extends Task 2's version):

```ts
server.registerTool("issue_close",
  { description: "Close an issue; optionally log time spent (worklog on supporting "
      + "backends, otherwise the caller folds time into the close comment)",
    inputSchema: { id: z.string(), timeSpentMinutes: z.number().int().positive().optional() } },
  wrap(async (a: { id: string; timeSpentMinutes?: number }) => {
    const d = dir();
    const tracker = await getTracker(d);
    const result = await tracker.closeIssue(a.id);
    snapshotNote(d, result);
    let worklogLogged = false;
    if (a.timeSpentMinutes && tracker.capabilities.hasWorklog && tracker.logWork) {
      await tracker.logWork(a.id, a.timeSpentMinutes);
      worklogLogged = true;
    }
    refreshHandoff({ source: "tool", issue: a.id }, d);
    return { ...result, worklogLogged };
  }));
```

- [ ] **Step 4: Build + full test run**

Run: `cd server && npm run build && npm test`
Expected: PASS. The compile step is the real gate here — a missed adapter
fails the build on the `Capability` change.

- [ ] **Step 5: Commit**

```bash
git add server/src/tracker/ server/src/index.ts server/test/jira.test.ts
git commit -m "feat(tracker): hasWorklog capability, Jira worklog, issue_close timeSpentMinutes"
```

---

### Task 4: SessionStart cursor-staleness nudge

**Files:**
- Modify: `hooks/scripts/sessionstart-continuity.mjs`

**Interfaces:**
- Consumes: `markerPath` layout from Task 1 (`<project>/.cairn/tracker-marker.json`, field `lastScan`); the script's existing stdin-JSON parse (project dir = the hook payload's `cwd`) and its `parts` array feeding `additionalContext`.
- Produces: one extra plain-text part in the SessionStart `additionalContext` when the cursor is stale.

- [ ] **Step 1: Add the nudge**

After the existing `parts` are assembled (before the stdout write at
`sessionstart-continuity.mjs:55`), add — using the same swallowed-error
style the rest of the script uses:

```js
// Tracker-delta staleness nudge — local read only, never network.
try {
  const marker = JSON.parse(readFileSync(
    join(projectDir, ".cairn", "tracker-marker.json"), "utf8"));
  const ageMs = Date.now() - Date.parse(marker.lastScan);
  if (ageMs > 12 * 60 * 60 * 1000) {
    parts.push("tracker delta unchecked since " + marker.lastScan +
      " — the next /cairn:status, /cairn:plan, or /cairn:work scans it.");
  }
} catch { /* no marker or unreadable: no nudge */ }
```

`projectDir` is whatever variable the script already binds for the hook
payload's `cwd`; reuse it (do not re-parse stdin). Add `readFileSync`/`join`
to the existing imports if not present.

- [ ] **Step 2: Verify by hand (hooks have no vitest harness)**

```bash
mkdir -p /tmp/td-hook/.cairn
echo '{"lastScan":"2026-01-01T00:00:00Z","issues":{},"phases":{}}' > /tmp/td-hook/.cairn/tracker-marker.json
echo '{"cwd":"/tmp/td-hook","hook_event_name":"SessionStart"}' | node hooks/scripts/sessionstart-continuity.mjs
```

Expected: stdout JSON whose `additionalContext` contains "tracker delta
unchecked since 2026-01-01". Re-run with a fresh `lastScan` timestamp
(now-ish): no nudge line.

- [ ] **Step 3: Commit**

```bash
git add hooks/scripts/sessionstart-continuity.mjs
git commit -m "feat(hooks): SessionStart nudge when tracker-delta cursor is stale"
```

---

### Task 5: Verb docs — inbound delta (status/plan/work step 0, resync two-directional)

**Files:**
- Modify: `skills/cairn-trailhead/verbs/resync.md`
- Modify: `skills/cairn-trailhead/verbs/status.md` (insert step 0)
- Modify: `skills/cairn-trailhead/verbs/plan.md` (insert step 0)
- Modify: `skills/cairn-trailhead/verbs/work.md` (insert step 0)

**Interfaces:**
- Consumes: tool name `plan_tracker_delta` (Task 2). check-surface check (d) verifies the reference resolves.

- [ ] **Step 1: Rewrite `resync.md` body (keep frontmatter identical)**

Replace everything below the frontmatter with:

```markdown
Both directions of drift in one verb: commits the plan never saw (git
side) and tracker changes the plan never saw (tracker side).

## Git side

1. `plan_resync()` — first run just initializes the marker (say so).
2. No out-of-band commits → git side clean.
3. Otherwise group the commits by likely phase (file paths vs each phase's
   PLAN.md task areas — judgment, say your reasoning) and present the
   report: sha, subject, files, suspected phase.
4. For each affected phase, batched into one AskUserQuestion per phase at
   most: refresh CONTEXT.md (what the out-of-band work changed about the
   locked decisions) and PLAN.md task notes. Assumptions broken outright →
   offer `/cairn:plan <N> --gaps`.
5. The git marker already advanced (the tool did it) — re-running reports
   clean from here.

## Tracker side

6. `plan_tracker_delta()` — peek (no `ack`). First run initializes the
   cursor (say so, done). Clean → report clean, done.
7. Render the grouped delta, then batch adoption into one AskUserQuestion:
   - **New phase (epic)** → `plan_import` with the phase reference — the
     standard gap interview follows.
   - **New issue (story/task)** → best-fit phase by judgment (topic and
     file-path match against each phase's PLAN.md — show your reasoning),
     folded in via `plan_issues_set` plus a PLAN.md task note. No
     confident fit → offer the phase choice explicitly.
   - **Edited issue** → integrates forward: a cursor-detected edit is
     provenance-known newer human intent and wins over the plan docs.
     Title/scope → PLAN.md task text; labels/priority → wave and ordering
     notes; body → the phase CONTEXT.md refresh. Exception: an edit that
     collides with a locked decision in CONTEXT.md stops for the user —
     conflict, not adoption — with the collision spelled out.
   - **State change** → remedy only: externally closed-unverified points
     at `/cairn:verify <N>` (or reopen); externally reopened points at the
     phase's plan.
   - **Declined items** → label `cairn:backlog` via `issue_update` so
     `status` keeps surfacing them; declined edits get a ⚠ reconcile
     `issue_comment` so the editor sees why the plan didn't follow.
8. Adoption flow complete → `plan_tracker_delta(ack: true)` to advance the
   cursor. Un-acked deltas re-surface on every scan — never ack before the
   adoption question has been answered.
```

- [ ] **Step 2: Insert step 0 into `status.md`, `plan.md`, `work.md`**

At the top of each verb's numbered procedure (before the current step 1),
insert — exact text, same in all three files:

```markdown
0. `plan_tracker_delta()` — peek. Anything in the delta → say so in one
   line ("tracker delta: 2 new, 1 edited — `/cairn:resync` to integrate")
   and continue; a non-empty delta never blocks this verb. First run:
   the tool initializes silently, don't mention it.
```

Renumber nothing — the existing steps keep their numbers; step 0 sits
above them.

- [ ] **Step 3: Surface check + commit**

Run: `node scripts/check-surface.mjs`
Expected: `check-surface: clean` (check (d) resolves `plan_tracker_delta`
against the registry — requires Task 2 merged first).

```bash
git add skills/cairn-trailhead/verbs/
git commit -m "docs(verbs): two-directional resync; delta peek as step 0 of status/plan/work"
```

---

### Task 6: Verb docs — outbound paper trail (work/fast/trace/audit comment lifecycle)

**Files:**
- Modify: `skills/cairn-trailhead/verbs/work.md`
- Modify: `skills/cairn-trailhead/verbs/fast.md`
- Modify: `skills/cairn-trailhead/verbs/trace.md`
- Modify: `skills/cairn-trailhead/verbs/audit.md`

**Interfaces:**
- Consumes: `issue_comment` (existing), `issue_close` with `timeSpentMinutes` (Task 3).

- [ ] **Step 1: `work.md` — weave the lifecycle into the existing steps**

Three edits to the existing numbered procedure:

Edit A — step 4 (claim) gains `startedAt` and the claim comment. Replace
the current step 4 with:

```markdown
4. Before starting an issue: record `git rev-parse HEAD` as this issue's
   `baseCommit` and the current time as its `startedAt` (both feed the
   close in steps 6-7). Then `issue_update(id, state: "in_progress")` —
   and when `user.handle` is set in cairn.json, also pass
   `assignee: <handle>` so teammates see who holds it. Then post the
   claim comment: `issue_comment(id, ...)` — starting now, which wave and
   PLAN.md task this is, base commit as a short ref on its own line.
   Plain language throughout (leak-guard discipline, same as `trace`).
   Then `context_set(phase: <N>, issueId: id)`.
```

Edit B — append to step 5 (the work itself):

```markdown
   Progress comments as the work lands — real milestones only:
   RED/GREEN/REFACTOR committed, a subtask done, a blocker hit, a trace
   spun off. Several small steps batch into ONE `issue_comment`; tracker
   noise is a failure mode, not diligence. No silent state transitions,
   ever — if the tracker state changes, a comment says why.
```

Edit C — replace step 6 with:

```markdown
6. On completion **with tests passing**: post the close comment first —
   `issue_comment(id, ...)`: what shipped in plain language, the commit
   range as short refs on their own line, the test evidence (suite name +
   pass count), and "time spent: ~Xm (approximate)" computed from
   `startedAt`. Then `issue_close(id, timeSpentMinutes: <X>)` — backends
   with worklog support (`worklogLogged: true` in the result) get a real
   worklog entry; the comment line covers the rest. On stopping early:
   leave in_progress and post a parked comment — why it stopped, what
   remains.
```

- [ ] **Step 2: `fast.md`, `trace.md`, `audit.md` — same lifecycle, one paragraph**

Append to each file's body (after its existing procedure):

```markdown
## Paper trail

Every tracker state transition this verb makes carries a comment — claim
("starting: <one line of intent>"), close (what shipped, evidence, "time
spent: ~Xm (approximate)" from claim to close, passed to `issue_close` as
`timeSpentMinutes`), or parked (why, what remains). Milestone progress
comments where the work is long enough to have milestones; batch small
steps into one comment. Leak-guard discipline applies to every comment.
```

(For `trace.md` and `audit.md`, if the file already documents comment
behavior for its findings, place this section beside it — the lifecycle
governs the *claimed issue*, complementing, not replacing, finding
comments.)

- [ ] **Step 3: Surface check + full check + commit**

Run: `node scripts/check-surface.mjs`
Expected: clean.

```bash
git add skills/cairn-trailhead/verbs/
git commit -m "docs(verbs): paper-trail comment lifecycle on every claiming verb"
```

---

### Task 7: Dogfood checklist + version note

**Files:**
- Modify: `VERIFICATION.md` (append fidelity checklist)

- [ ] **Step 1: Append the dogfood checklist to `VERIFICATION.md`**

```markdown
## Tracker-mirror fidelity — dogfood checklist (pending live pass)

Inbound:
- [ ] PM-side: add one issue and edit one existing issue's title directly
      on the tracker mid-phase.
- [ ] Next `/cairn:status` prints the one-line delta nudge.
- [ ] `/cairn:resync` renders both, adoption folds the new issue into a
      phase and the title edit into PLAN.md; cursor acks; re-run reports
      clean.
- [ ] Declining an item labels it `cairn:backlog` and it re-surfaces in
      `status` marks.

Outbound (one full `work` issue):
- [ ] Claim comment present on the tracker at in_progress.
- [ ] At least one milestone progress comment.
- [ ] Close comment with shipped summary, short commit refs, test
      evidence, approximate time.
- [ ] Jira: worklog entry exists with matching minutes. Non-worklog
      backend: time line present in the close comment instead.
- [ ] New session after >12h idle: SessionStart nudge line appears.
```

- [ ] **Step 2: Full gate + commit**

Run: `cd server && npm run build && npm test && cd .. && node scripts/check-surface.mjs`
Expected: all green.

```bash
git add VERIFICATION.md
git commit -m "docs: tracker-mirror fidelity dogfood checklist"
```

---

## Self-review notes (done)

- Spec coverage: cursor/peek-ack (T1), tool + no-echo write-through (T2),
  worklog + timeSpentMinutes (T3), SessionStart nudge (T4), inbound verb
  flow incl. edits-integrate-forward + declined-item labeling (T5),
  comment lifecycle on all claiming verbs (T6), drill/dogfood checklist
  (T7). Error-handling constraint satisfied structurally in T1 step 3.
- The spec's "priority" field diff is not representable — the `Issue` type
  carries no priority; labels/title/body/assignee cover the diffable
  surface. Spec stands otherwise.
- Types consistent across tasks: `TrackerDeltaReport`, `snapshotNote`,
  `markerPath`, `timeSpentMinutes`, `hasWorklog`, `logWork` used
  identically in T1→T6.
