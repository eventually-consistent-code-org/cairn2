# Cairn 2.0 — Tier E: Knowledge & Diagnostics

**Date:** 2026-07-22
**Status:** Approved design (owner-delegated decisions, "go for E" directive 2026-07-22; calls recorded below)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier E items 19-20
**Siblings:** Tiers 0/A0/A/B/C/D shipped. `extract-learnings` is NOT rebuilt here — merged into `retro`/`distill` per the roadmap's explicit note.

## Outcome

Five new live verbs and one new audit mode, on rails that already exist:

- **`map`** — project knowledge graph: build / query / diff / status over a
  single-writer graph store (`.cairn/map/map.json`), two new tools.
- **`thread`** — persistent context threads as a FOURTH session kind on the
  C2 sessions core: named long-running context that survives `/clear`,
  mirrored to the tracker like every other session.
- **`profile`** — developer profile at `.cairn/profile.md`, prompt-level;
  verbs that talk to the user read it and calibrate.
- **`medic`** — planning-dir health check and repair, workflow forensics.
- **`backtrack`** — safe git undo by phase/plan manifest: computes revert
  sets from ledger commit ranges; never destructive by default.
- **`audit docs`** — docs-update-verified-against-codebase as a ninth
  audit mode (GSD docs-update parity), not a new verb.
- **`status --stats`** — project stats fold into `status`, zero new verbs.

GSD parity covered: graphify, thread, profile-user/set-profile, stats,
health, forensics, undo, docs-update.

## Why (decision record)

- **Threads are a session kind, not a new subsystem (owner call,
  delegated).** The C2 sessions core (append-only file, typed entries,
  gated close, archive, handoff write-through, banner, landscape) is
  exactly what a persistent context thread needs. `thread` becomes the
  fourth kind: entries `note|link|decision|wrap`, close gate `wrap` (a
  thread closes by being wrapped up, never abandoned silently). Tracker
  mirror per the law: `thread_start` creates a `cairn:thread` issue —
  long-running context threads are precisely the invisible work management
  most wants to see. Rejected: a bespoke thread store (three stores was
  the reason C2 generalized in the first place).
- **Knowledge graph is a small deterministic store, not an index (owner
  call, delegated).** `map.json` holds typed nodes (`module|phase|issue|
  decision|person`) and edges (`depends-on|implements|decided-in|owns`),
  written only through `map_set` (merge-patch, validated, single-writer —
  the `config_set` discipline) and read through `map_get` (whole graph or
  filtered by node/edge/type). The VERB does the intelligence (building
  the graph from code/plans/tracker, answering questions); the server
  guarantees shape, atomicity, and determinism. Rejected: riding
  `mem_index` (search ≠ graph; edges are the point) and a full graph
  database (YAGNI at cairn scale).
- **Profile is prompt-level (owner call, delegated).** `.cairn/profile.md`
  written by the `profile` verb directly — no server tool. It is advisory
  calibration data (verbosity, expertise areas, preferred detail level),
  not workflow state; no tracker object (nothing to manage), no
  determinism requirement, no drill beyond existence + consumption.
- **`medic` and `backtrack` are prompt-level orchestration (owner call,
  delegated).** Every primitive they need already exists: `plan_status`,
  `plan_drift`, `plan_check`, `plan_resync`, `plan_phase_ensure`,
  `plan_scaffold_*` for health/repair; the per-phase LEDGER.md commit
  ranges + `git log` for forensics and revert-set computation. Zero new
  tools. `backtrack` NEVER runs `git reset --hard`/`push --force`; it
  computes and proposes `git revert` chains, executing only on `--apply`.
- **Stats fold into `status` (owner call, delegated).** A stats verb would
  be a report with no verbs of its own; `status --stats` renders counts
  from `plan_status`, `issue_list`, `mem_stats`, `session_landscape`,
  `listAuditRecords`-backed records. Zero surface growth.
- **docs-update is an audit mode (owner call, delegated).** "Verify docs
  against the codebase, fix what drifted" is exactly audit's shape:
  findings, record, tracker mirror, `--fix`. Ninth row in `audit`'s mode
  table.

## 1. Scope & surface

- New live verbs: `map`, `thread`, `profile`, `medic`, `backtrack`
  (29 → 34 live; reserved stays `basecamp`(F)).
- Server tools 50 → **55**: `thread_start`, `thread_log`, `thread_close`
  (the C2 session factory, fourth kind), `map_set`, `map_get`.
- `audit.md` gains the `docs` mode row; `status.md` gains `--stats`.
- check-surface: `TOOL_PREFIXES` gains `map|thread` (`session_` covered).
- Zero adapter/interface work.

## 2. Sessions core: the `thread` kind

| kind | dir | entry kinds | close gate |
|---|---|---|---|
| `thread` | `.cairn/thread/` | `note` `link` `decision` `wrap` | ≥1 `wrap` |

- `KIND_SPECS` gains the row; `SessionKind` widens. Trace/probe/draft
  specs and behavior byte-identical (their test files stay unedited — the
  standing compatibility gate).
- `thread_start` label EXACTLY `cairn:thread`; phase stamped from active
  context like probe/draft; handoff write-through identical.
- Banner + `session_landscape` + `status` open-sessions surfaces iterate
  all FOUR kinds (order: trace, probe, draft, thread — appended, so
  existing rendered bytes for the first three kinds are unchanged).
- A `link` entry's text is a reference (file path, issue id, session id,
  URL) plus one line of why-it-matters.

## 3. `map_set` / `map_get`

Store: `.cairn/map/map.json` —

```jsonc
{
  "nodes": { "<id>": { "type": "module|phase|issue|decision|person", "label": "...", "detail": "..." } },
  "edges": [ { "from": "<id>", "to": "<id>", "type": "depends-on|implements|decided-in|owns" } ]
}
```

- `map_set(patch)` — merge-patch: nodes merged by id (`null` deletes),
  edges REPLACED as a whole when the patch carries an `edges` array
  (edge-level merge has no stable identity; whole-list replace is the
  honest contract). Validates: node/edge types from the enums above, edge
  endpoints must exist in the merged node set (dangling edges rejected,
  PRECONDITION_FAILED naming the missing id). Returns
  `{ nodes: <count>, edges: <count> }`.
- `map_get(filter?)` — whole graph, or filtered:
  `{ nodeType?, edgeType?, node? }` (`node` returns that node + every edge
  touching it + the neighbor nodes). Deterministic: nodes sorted by id,
  edges by (from, to, type). Missing store → empty graph, not an error.

## 4. Verbs

- **`verbs/map.md`** — `map build` (walk code/plans/tracker, propose the
  graph, write via `map_set` in validated chunks); `map "<question>"`
  (query: `map_get` + reasoning, answers name their nodes/edges);
  `map diff` (rebuild the CURRENT truth in memory, compare against the
  stored graph, report drift — moved/deleted modules, closed issues still
  edged, decisions superseded); `map status` (counts + staleness read
  from the stored graph vs `git log -1` dates). Graph writes only via
  `map_set` — the verb never edits `map.json` directly.
- **`verbs/thread.md`** — `thread "<name>"` (start or resume by the
  already-open guard — resume IS the point); `thread` bare (list open
  threads via `session_landscape`, offer resume); entries logged as work
  happens; `--wrap` logs a `wrap` entry summarizing where the thread
  landed, then `thread_close(resolution)` — close comments `Resolved:` and
  closes the `cairn:thread` issue (C2 factory behavior, free). Mirror
  discipline: start comment + wrap comment, plain language.
- **`verbs/profile.md`** — interview-lite: infer from the repo and recent
  sessions first, ask only what can't be inferred; write
  `.cairn/profile.md` (sections: communication, expertise, conventions,
  cadence). Other verbs read it when present — one line added to
  `help.md`'s shared-discipline note, nothing else changes.
- **`verbs/medic.md`** — `medic` (health: `plan_status` + `plan_drift` +
  `plan_check` + ledger/file cross-checks → findings ranked, report via
  `audit_record(scope: "medic")`); `medic --repair` (mechanical repairs
  only: missing phase dirs via `plan_phase_ensure`, missing scaffolds via
  `plan_scaffold_phase`, stale plan-issue links via `plan_issues_set`;
  anything judgment-shaped is reported, never auto-repaired);
  `medic forensics [phase]` (reconstruct what actually happened from
  LEDGER.md + `git log` + tracker history — narrative answer, record
  written, nothing mutated).
- **`verbs/backtrack.md`** — `backtrack <phase|plan>` (read the ledger's
  commit ranges for the target, compute the revert set, check for
  LATER commits touching the same files — overlap means manual review,
  named file by file); present the plan; `--apply` executes `git revert`
  (no-edit, in reverse order), runs the test suite, and reports; NEVER
  `reset --hard`, NEVER force-push, NEVER touches commits outside the
  manifest. Tracker mirror: revert commented on the phase's issues.

## 5. Testing (three rings)

- **Unit:** sessions-store thread kind (vocabulary, wrap gate, archive;
  existing three kinds' test files UNEDITED); map store (merge semantics,
  null-delete, edges-replace, dangling-edge rejection, filter shapes,
  deterministic ordering, empty-store read); banner four-kind iteration
  byte-stability.
- **MCP ring:** five new tools (55 pin), schemas, error paths.
- **Drills (mechanical, post-merge):**
  - `drill-thread.mjs` — real tracker: start (cairn:thread issue +
    mirror), entries incl. `link`, cold-kill + fresh-client resume, wrap
    gate refuses close without wrap, wrap + close (issue closed with
    resolution), banner/landscape surfacing, leak scan.
  - `drill-map.mjs` — server only: build via patches, dangling edge
    rejected, null-delete, edges-replace, filtered queries, byte-equal
    reads, diff-shaped re-read after a second patch.
  - `drill-backtrack.mjs` — local scratch git repo: seeded phase with
    ledgered commits + one overlapping later commit; assert the computed
    revert set matches the manifest, the overlap is flagged file-by-file,
    and the apply leg (run mechanically) reverts cleanly with tests green
    and NO history rewrite (git log shows revert commits, original shas
    intact).

## Non-goals

- No graph visualization, no auto-rebuild triggers (map build is a verb
  run), no cross-project graphs (basecamp, Tier F).
- No thread auto-creation from other verbs.
- No profile-driven behavior changes beyond tone/depth calibration.
- `medic --repair` never rewrites plan CONTENT, only structure.
- `backtrack` never touches remote state; pushing the reverts is the
  user's call.

## Success criteria

1. A thread survives cold kill and resumes by name with zero re-derived
   context; close requires a wrap entry; the `cairn:thread` issue tells
   the story (started → wrapped) in plain language, leak-clean.
2. The map store rejects dangling edges, merges deterministically, and
   answers filtered queries byte-stably; `map diff` names real drift.
3. `medic` findings land as a record; `--repair` fixes only mechanical
   structure and lists what it refused to touch.
4. `backtrack` computes the exact ledgered revert set, flags overlapping
   later commits file-by-file, and `--apply` leaves original shas intact
   (reverts only, suite green).
5. `status --stats` renders from live tool reads — no cached numbers.
6. C1-D surfaces bit-for-bit unaffected: trace/probe/draft store tests,
   banner three-kind bytes, and all 50 existing tools unchanged
   (`trace-store`/`sessions-store` pre-thread cases/`banner` C2 cases
   pass unedited).
