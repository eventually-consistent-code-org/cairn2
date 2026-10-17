# Cairn 2.0 — Tier E: Knowledge & Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `map`/`thread`/`profile`/`medic`/`backtrack` verbs, `thread` as the fourth session kind, `map_set`/`map_get` graph store, `audit docs` mode, `status --stats`. Spec: `docs/superpowers/specs/2026-07-22-cairn-2-tier-e-knowledge-diagnostics.md`.

**Architecture:** One PR, two stages. Stage 1 (Tasks 1–3): thread kind in the sessions core, `server/src/map/store.ts`, five tools registered (50 → 55), banner iterates four kinds. Stage 2 (Tasks 4–6): five verbs live (29 → 34), audit docs mode, status --stats, docs, drill procedures.

**Tech Stack:** TypeScript 5, Node ≥ 20, zod, vitest. No new dependencies.

## Global Constraints

- Base branch: `main`. Conventional commits, one per task. Green before every commit: `cd server && npx vitest run && npx tsc --noEmit`; from Task 4 on also `node scripts/check-surface.mjs`.
- New tools named EXACTLY: `thread_start`, `thread_log`, `thread_close`, `map_set`, `map_get`. Tool count 50 → 55. All 50 existing untouched.
- **Compatibility gate:** `trace-store.test.ts` unedited; `sessions-store.test.ts` and `banner.test.ts` gain NEW cases only — every pre-existing case passes byte-unedited.
- Thread kind EXACTLY: dir `.cairn/thread/`, entries `note|link|decision|wrap`, close gate `wrap`, issue label EXACTLY `cairn:thread`, phase stamped like probe/draft.
- Banner/landscape kind order EXACTLY `trace, probe, draft, thread` (appended — first-three rendered bytes unchanged for stores without threads).
- Map store EXACTLY at `.cairn/map/map.json`; node types `module|phase|issue|decision|person`; edge types `depends-on|implements|decided-in|owns`; nodes merge by id with `null` delete; an `edges` array in the patch REPLACES the whole edge list; dangling edges rejected PRECONDITION_FAILED naming the missing id; `map_get` deterministic (nodes by id, edges by from/to/type); missing store → empty graph.
- Live verbs after E EXACTLY: previous 29 + `map` + `thread` + `profile` + `medic` + `backtrack` (34). Reserved EXACTLY `basecamp`(F).
- check-surface `TOOL_PREFIXES` gains `map|thread`.
- `backtrack` doc: NEVER `reset --hard`, NEVER force-push, reverts only, `--apply` gated; `medic --repair` mechanical-structure only.
- Dist rebuilt + committed at each stage end (Tasks 3 and 6).

## File Structure (end state)

```
server/src/
  sessions/store.ts     # thread row in KIND_SPECS; SessionKind widens
  map/store.ts          # new — graph store
  index.ts              # +5 tools (55); registerSessionTools("thread", "cairn:thread")
  memory/banner.ts      # four-kind iteration
server/test/
  sessions-store.test.ts  # +thread describe block (existing cases unedited)
  map-store.test.ts       # new
  banner.test.ts mcp.test.ts  # extended
skills/cairn-trailhead/
  SKILL.md verbs/{map,thread,profile,medic,backtrack}.md   # new
  verbs/{audit,status,help}.md   # docs mode / --stats / profile note
scripts/check-surface.mjs
README.md server/README.md VERIFICATION.md
```

---

## Stage 1 — server

### Task 1: Thread kind in the sessions core

**Files:**
- Modify: `server/src/sessions/store.ts` (KIND_SPECS row, SessionKind union, KIND_ORDER, titlePrefix, listHint/closeHint/archiveHint entries)
- Test: `server/test/sessions-store.test.ts` (NEW describe block only)

**Interfaces:**
- Produces: `SessionKind = "trace" | "probe" | "draft" | "thread"`; `KIND_SPECS.thread = { kind: "thread", entryKinds: ["note", "link", "decision", "wrap"], closeGate: "wrap" }`; `KIND_ORDER = ["trace", "probe", "draft", "thread"]`; titlePrefix "Thread"; hints: list → `"list sessions with session_landscape"`, close → message `thread '<id>' has no wrap entry — close needs a wrap`, hint `thread_log a wrap (where this thread landed), then close`, archive → `start a new thread if the topic comes back`.

- [ ] **Step 1: Failing tests** — append to `sessions-store.test.ts` (touch nothing existing):

```ts
describe("sessions store — thread kind", () => {
  it("thread vocabulary, wrap gate, archive", () => {
    const dir = fresh();
    const { id } = startSession(dir, "thread", "payments refactor", "GH-60", "4");
    expect(id.startsWith("thread-")).toBe(true);
    appendSession(dir, "thread", id, "note", "stripe adapter first");
    appendSession(dir, "thread", id, "link", "probe-ab12cd34 — proved streaming holds");
    appendSession(dir, "thread", id, "decision", "webhooks over polling");
    expect(() => appendSession(dir, "thread", id, "evidence", "nope")).toThrow(/entry kind/);
    expect(() => closeSession(dir, "thread", id, "done")).toThrow(/wrap/);
    appendSession(dir, "thread", id, "wrap", "landed: adapter migrated, webhooks live");
    const out = closeSession(dir, "thread", id, "refactor thread wrapped — see wrap entry");
    expect(out.gateTexts).toEqual(["landed: adapter migrated, webhooks live"]);
    expect(listSessions(dir, "thread", "resolved")[0].phase).toBe("4");
  });

  it("landscape includes threads last in kind order", () => {
    const dir = fresh();
    startSession(dir, "thread", "t", "GH-61");
    startSession(dir, "trace", "b", "GH-62");
    expect(sessionLandscape(dir).sessions.map((s) => s.kind)).toEqual(["trace", "thread"]);
    expect(sessionLandscape(dir).openByKind).toEqual({ trace: 1, probe: 0, draft: 0, thread: 1 });
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run test/sessions-store.test.ts` → FAIL (thread not a kind).
- [ ] **Step 3: Implement** — add the row + widen the union + extend KIND_ORDER/titlePrefix/hint records. `openByKind` initializer gains `thread: 0`. No structural changes.
- [ ] **Step 4: Full green** — full suite; trace-store unedited; existing sessions/banner cases unedited.
- [ ] **Step 5: Commit** — `feat(server): thread — fourth session kind, wrap-gated`

### Task 2: Map store — `server/src/map/store.ts`

**Files:**
- Create: `server/src/map/store.ts`
- Test: `server/test/map-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NodeType = "module" | "phase" | "issue" | "decision" | "person";
  export type EdgeType = "depends-on" | "implements" | "decided-in" | "owns";
  export interface MapNode { type: NodeType; label: string; detail?: string; }
  export interface MapEdge { from: string; to: string; type: EdgeType; }
  export interface ProjectMap { nodes: Record<string, MapNode>; edges: MapEdge[]; }
  export function mapSet(projectDir: string, patch: {
    nodes?: Record<string, MapNode | null>; edges?: MapEdge[];
  }): { nodes: number; edges: number };
  export function mapGet(projectDir: string, filter?: {
    nodeType?: NodeType; edgeType?: EdgeType; node?: string;
  }): ProjectMap;
  ```
- Semantics (Global Constraints verbatim): nodes merge by id, `null` deletes (deleting a node with edges still attached → PRECONDITION_FAILED naming the edges); `edges` in the patch replaces the list wholesale; every edge endpoint must exist in the POST-merge node set else PRECONDITION_FAILED naming the missing id; zod-validate node/edge types; writes atomic (write temp + rename, the single-writer discipline); `mapGet` sorts nodes by id and edges by (from, to, type); `node` filter returns that node, every touching edge, and neighbor nodes; missing file → `{ nodes: {}, edges: [] }`.

- [ ] **Step 1: Failing tests** — `map-store.test.ts` covering: merge + null-delete, delete-with-attached-edges rejection, edges wholesale replace, dangling edge rejection (missing id in message), type validation rejection, node filter (self + touching edges + neighbors), nodeType/edgeType filters, deterministic byte-equal double read, empty-store read. Write each as a concrete `it` with real literals (follow `audit-record.test.ts` style).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** per semantics; ~120 lines; reuse `CairnError`; JSON.stringify with 2-space indent + trailing newline for the stored file.
- [ ] **Step 4: Full green.**
- [ ] **Step 5: Commit** — `feat(server): map store — single-writer knowledge graph, validated merge-patch`

### Task 3: Register five tools + banner four-kind + stage-end dist

**Files:**
- Modify: `server/src/index.ts` (`registerSessionTools("thread", "cairn:thread")` after the draft call; `map_set`/`map_get` after `audit_record`), `server/src/memory/banner.ts` (`["trace","probe","draft","thread"]`)
- Test: `server/test/mcp.test.ts` (55 pin + thread flow + map flow), `server/test/banner.test.ts` (NEW case: thread line renders last; existing cases unedited)

**Interfaces:**
- Consumes: Task 1's widened factory kinds; Task 2's `mapSet`/`mapGet`.
- Produces: tools `thread_start/log/close` (factory — schema comes free), `map_set` (`inputSchema: { patch: z.object({ nodes: z.record(z.union([NodeSchema, z.null()])).optional(), edges: z.array(EdgeSchema).optional() }) }` — define NodeSchema/EdgeSchema zod mirrors of the module types), `map_get` (`{ nodeType?, edgeType?, node? }` enums/string optional).

- [ ] **Step 1: Failing tests** — mcp: tool array 55; `thread_start` labels `cairn:thread` and wrap-gates close; `map_set` round-trips a two-node one-edge graph and rejects a dangling edge (isError); banner: open thread renders `- thread thread-<sha> — …` after the other kinds.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — one factory call + two registrations + one banner array literal.
- [ ] **Step 4: Full green + `npm run build`.**
- [ ] **Step 5: Commit** — `feat(server): thread_* + map_* tools — 55 total; banner four kinds; stage-end dist`

---

## Stage 2 — plugin surface

### Task 4: `map` + `thread` verbs + surface ratchet

**Files:**
- Create: `skills/cairn-trailhead/verbs/map.md`, `verbs/thread.md`
- Modify: `SKILL.md` (two live rows), `scripts/check-surface.mjs` (`TOOL_PREFIXES` + `map|thread`)

**Rows:**
```markdown
| `map` | Project knowledge graph — build, query, diff, status | `build` \| `"<question>"` \| `diff` \| `status` | verbs/map.md | live |
| `thread` | Persistent context threads that survive /clear | `"<name>"` \| (none = list open) \| `--wrap` | verbs/thread.md | live |
```

- [ ] **Step 1: Ratchet first** (prefixes + rows → FAIL on missing docs).
- [ ] **Step 2: Write both docs** — house voice (probe.md/trace.md register). map.md required content: four modes per spec §4; graph writes ONLY via `map_set`; queries answer with named nodes/edges; diff rebuilds current truth and compares; status reads staleness from stored graph vs `git log -1`. thread.md required content: start-or-resume via the already-open guard (resume IS the point); bare = list open threads via `session_landscape` + offer resume; entry logging discipline (note/link/decision as work happens; link = reference + one line of why); `--wrap` = wrap entry then `thread_close`; mirror comments (start + wrap) plain language; leak rules. Valid tool refs — map.md: `map_set`, `map_get`; thread.md: `thread_start`, `thread_log`, `thread_close`, `session_landscape`, `issue_comment`.
- [ ] **Step 3: Green** — check-surface 31 live, 1 reserved, 55 tools; suite; tsc.
- [ ] **Step 4: Commit** — `feat(plugin): map + thread verbs live`

### Task 5: `profile` + `medic` + `backtrack` verbs

**Files:**
- Create: `verbs/profile.md`, `verbs/medic.md`, `verbs/backtrack.md`
- Modify: `SKILL.md` (three rows), `verbs/help.md` (one line: verbs read `.cairn/profile.md` when present)

**Rows:**
```markdown
| `profile` | Developer profile — calibrates how cairn talks to you | (interview-lite) | verbs/profile.md | live |
| `medic` | Planning-dir health, repair, and workflow forensics | `[--repair]` \| `forensics [phase]` | verbs/medic.md | live |
| `backtrack` | Safe git undo by phase/plan manifest — reverts only | `<phase\|plan>` \| `--apply` | verbs/backtrack.md | live |
```

- [ ] **Step 1: Ratchet** (rows → FAIL ×3 → write docs → PASS).
- [ ] **Step 2: Write the three docs** — spec §4 content verbatim in substance. profile.md: infer-first interview, `.cairn/profile.md` sections (communication/expertise/conventions/cadence), written directly by the verb (no tool), advisory only. medic.md: health findings → `audit_record(scope: "medic")`; `--repair` mechanical-structure ONLY (`plan_phase_ensure`, `plan_scaffold_phase`, `plan_issues_set`), judgment-shaped repairs reported never executed; forensics = LEDGER.md + `git log` + tracker history narrative, record written, nothing mutated. backtrack.md: ledger commit ranges → revert set; overlap check against later commits file-by-file (overlap = manual review, named); `--apply` = `git revert` no-edit reverse order + suite run; NEVER-rules verbatim (no reset --hard, no force-push, nothing outside the manifest, remote untouched); tracker mirror comment on the phase's issues. Valid tool refs — medic.md: `plan_status`, `plan_drift`, `plan_check`, `plan_phase_ensure`, `plan_scaffold_phase`, `plan_issues_set`, `audit_record`; backtrack.md: `audit_record`, `issue_comment`; profile.md: none (state that explicitly).
- [ ] **Step 3: Green** — 34 live, 1 reserved, 55 tools.
- [ ] **Step 4: Commit** — `feat(plugin): profile + medic + backtrack verbs live — Tier E surface complete`

### Task 6: audit docs mode, status --stats, docs, verification, dist

**Files:**
- Modify: `verbs/audit.md` (ninth mode row: `docs [scope]` — sweep README/docs claims against the codebase, drifted claims are findings, `--fix` updates the docs), `verbs/status.md` (`--stats`: counts from `plan_status`, `issue_list`, `mem_stats`, `session_landscape` + audit records dir, live reads only), `README.md`, `server/README.md` (55 tools, thread kind row, map store section), `VERIFICATION.md`

- [ ] **Step 1: audit.md + status.md edits** (check-surface stays green — tools already valid there).
- [ ] **Step 2: READMEs** — verbs table +5 live, Tier E shipped; server/README 50 → 55 + sessions table thread row + map store section (spec §3 shapes).
- [ ] **Step 3: VERIFICATION.md** — Tier E section, house format; REAL totals; criteria 1–6 mapped; three drill procedures PENDING per spec §5 (thread / map / backtrack itemizations).
- [ ] **Step 4: Final green + dist** — full gate; commit dist if dirty.
- [ ] **Step 5: Commit** — `docs(cairn): Tier E verification record — drill procedures pending live run`

---

## Post-merge (tier convention)

PR to `main`, merge, author + run `server/drills/drill-{thread,map,backtrack}.mjs`, commit the drills-run record.
