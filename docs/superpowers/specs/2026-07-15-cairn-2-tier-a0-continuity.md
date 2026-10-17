# Cairn 2.0 — Tier A0: Continuity

**Date:** 2026-07-15
**Status:** Draft for review — implements G1 + G3 of the competitor gap
analysis (approved addendum); absorbs `waypoint` from Tier B
**Author(s):** John Reed (with Claude)
**Depends on:** Tier 0 (Trailhead — verbs land as `/cairn` subroutines),
P2 planning artifacts, P3 memory substrate

## Outcome

A cairn session survives anything — compaction, microcompact, usage cap,
crash, `/clear`, or a deliberate pause — and the next session resumes at the
exact task with zero re-executed work. Session start additionally surfaces a
token-cost-annotated index of relevant memory so the model fetches knowledge
on demand instead of receiving it wholesale. Together these make cairn the
only surveyed tool where planning state, work state, and memory all
reconnect automatically after a break — three competitors built partial
versions of this independently (Buildomator's HANDOFF loop, Superpowers'
progress ledger, gstack's WIP commits); cairn ships the converged form on
deterministic server machinery.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Handoff writer | Server-side, on every state-changing MCP tool call — cairn has an in-process server, so the primary writer needs no hooks (Buildomator needed hooks because it had no resident state engine) |
| 2 | Hook role | Gap coverage only: throttled PostToolUse breadcrumb (non-cairn activity), PreCompact full refresh, SessionStart detection — all fire-and-forget, <100ms budget |
| 3 | Handoff location | `~/.cairn/handoff/<project>.json` — per-machine ephemeral state, never in the repo, keyed by registered project (closes Buildomator #17's "wrote state into random dirs" bug class) |
| 4 | Ledger location | `.cairn/plans/phases/NN-slug/LEDGER.md` — git-committed, append-only; durable + teammate-visible, consistent with "git owns prose" |
| 5 | Resume mode | `prompt` by default; `auto` and `off` opt-in via `cairn.json` (manual-first philosophy, same as G11 model routing) |
| 6 | Trust order on resume | tracker + git log > LEDGER.md > HANDOFF.json — handoff is a hint, never authority |
| 7 | Recall index delivery | Server pre-renders a byte-stable banner cache at `~/.cairn/banner/<project>.md` on card/scope mutation; SessionStart hook just cats it (G7 cache stability by construction) |
| 8 | Timeline scope | `mem_timeline` walks chronologically adjacent index entries + cards within project scope, titles-only at index cost |

## Architecture

```
            state-changing MCP tool call (work/plan/verify/mark/…)
                              │
              ┌───────────────▼──────────────────┐
              │ core/continuity (new server mod) │
              │  write handoff · append ledger   │
              │  render banner cache             │
              └───────┬──────────────┬───────────┘
                      │              │
   ~/.cairn/handoff/<project>.json   .cairn/plans/phases/NN/LEDGER.md (git)
   ~/.cairn/banner/<project>.md      │
                      ▲              │
   hooks (thin, fire-and-forget):    │
     PostToolUse  → breadcrumb touch (≤1/60s, mtime-throttled)
     PreCompact   → full handoff refresh
     SessionStart → cat banner + handoff detection → resume offer
```

## 1. Handoff engine (G1)

### HANDOFF.json — versioned schema

`schema/handoff-v1.json` (JSON Schema draft-07, validated in CI per G9):

```json
{
  "version": 1,
  "created": "2026-07-15T00:00:00Z",
  "source": "tool | posttooluse | precompact | waypoint",
  "project": "cairn2",
  "phase": { "number": 3, "slug": "memory" },
  "issue": "PROJ-107",
  "plan": ".cairn/plans/phases/03-memory/PLAN.md",
  "task": { "current": "task-4", "title": "staleness check on recall" },
  "tasks_completed": ["task-1", "task-2", "task-3"],
  "tasks_remaining": ["task-4", "task-5"],
  "blockers": [],
  "decisions_in_flight": ["retry ceiling set to 3 — not yet carded"],
  "uncommitted_files": ["server/src/memory/staleness.ts"],
  "next_action": "finish staleness unit tests, then close PROJ-107",
  "notes": "provenance check needs the merge-base, not HEAD",
  "partial": false
}
```

### Writers, in priority order

1. **Server (primary).** Every state-changing tool (`work_*`, `plan_*`,
   `verify_*`, `mem_write`, task transitions) refreshes the handoff
   in-process — atomic write via temp-file rename. Zero hook latency,
   always schema-valid.
2. **PostToolUse hook (breadcrumb).** Covers long stretches of raw
   Edit/Bash between cairn tool calls: updates only `created`,
   `uncommitted_files` (from `git status --porcelain`), and `source`.
   Throttled to ≤1/60s via handoff mtime; exits 0 in <100ms; never spawns
   a runtime. Worst-case staleness on hard crash: 60 seconds.
3. **PreCompact hook.** Forces an unthrottled refresh so compaction never
   eats in-flight context.
4. **`waypoint` verb (manual).** Deliberate pause: full refresh with
   `source: waypoint`, prompts for `next_action`/`notes` (the human fields
   hooks can't know), offers a WIP commit of uncommitted work
   (`wip(cairn): waypoint — <next_action>`, gstack-style structured
   trailer, squashed at `ship`).

### Guard rails (lessons encoded from competitor bug history)

- **No unregistered writes:** every writer requires the project in
  active-context; nothing is ever created outside `~/.cairn/` for a repo
  cairn doesn't know (Buildomator #17).
- **Skeleton guard:** a writer may never replace a handoff that has
  `task`/`next_action` populated with one that doesn't — richness is
  monotonic between resumes (Buildomator #12/#17).
- **Stable keys:** handoff is keyed by registered project id, not branch
  name or directory basename (gstack #1851 — derived-name state breaks).
- **Lifecycle:** deleted on confirmed resume, on `ship`, and on `summit`.
  A handoff older than 14 days is surfaced as stale ("waypoint from
  2026-07-01 — resume, inspect, or discard?") and never auto-resumed even
  in `auto` mode.

### Progress ledger

`LEDGER.md`, append-only, one line per verified task, written by the server
at task close (mechanism, not prompt discipline — Superpowers' prompt-only
ledger provably gets skipped, their #463):

```markdown
- [x] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — PROJ-105 closed 2026-07-14
```

Git-committed with the work it records (rides the task's closing commit).
On resume the ledger + `git log` + tracker states are the authority; the
handoff only points at where to look.

### Resume flow

1. **SessionStart hook** detects a handoff for the cwd's project → injects
   a compact resume block (phase, issue, current task, next_action, age).
2. **`resume` config:** `prompt` (default) asks "resume task-4 on
   PROJ-107?"; `auto` proceeds; `off` suppresses injection entirely.
3. **Skill cross-checks before acting** (trust order, decision 6): tracker
   says which issues are actually closed; ledger + `git log` say which
   tasks landed; anything the handoff claims beyond that is verified, not
   trusted. A handoff that contradicts the tracker is reported, corrected,
   then followed.
4. **On confirmed resume:** `continuity_clear` deletes the handoff.
   `decisions_in_flight` are offered to `mem_write` as cards (the distill
   moment a crash would otherwise have destroyed).

### New MCP tools

| tool | role |
|---|---|
| `continuity_checkpoint` | write/refresh handoff (used by verbs + PreCompact path) |
| `continuity_get` | read + schema-validate + cross-check summary |
| `continuity_clear` | delete on resume/ship/summit |
| `ledger_append` | append verified-task line, stage into closing commit |

## 2. Recall index + timeline (G3)

### Session-start memory index

On every card mutation or active-context scope change, the server
re-renders `~/.cairn/banner/<project>.md`:

```
## cairn recall index — cairn2 / phase 3 / PROJ-107
| id | type | title | fetch cost |
|----|------|-------|-----------|
| c-041 | gotcha | GitHub 403 means throttle, not just auth | ~120 tok |
| c-038 | decision | retry ceiling is 3, per adapter contract | ~90 tok |
Fetch bodies on demand with mem_recall(id). Total if fetched: ~210 tok.
```

- Scoped by active-context (issue > phase > project), capped at
  `recallIndex.maxCards` (default 20), ordered by scope-tightness then id —
  **no timestamps, no volatile ordering**: bytes change only when memory
  changes (G7). A unit test renders twice against unchanged state and
  asserts byte equality.
- Fetch cost = `ceil(card_chars / 4)`, precomputed at card write.
- SessionStart hook cats the cache file — no DB access, no runtime spawn,
  well under the 100ms budget.
- Stats gain `tokens_saved_vs_full_injection` (index cost vs sum of card
  costs) — honest accounting, per the claude-mem credibility lesson.

### `mem_timeline` tool

`mem_timeline({ anchor, before: 3, after: 3 })` — anchor is a card or index
chunk id; returns chronologically adjacent entries (cards + index chunk
titles) within project scope at index cost, with per-item fetch costs.
Answers "what was happening around this decision?" — the retrieval layer
claude-mem users value most and nothing else in cairn currently provides.
Implementation: one indexed query on existing `created` columns.

## 3. Config schema (`cairn.json`)

```json
"continuity": {
  "resume": "prompt",          // prompt | auto | off
  "checkpoint": true,           // PostToolUse breadcrumb hook
  "wipCommits": false,          // waypoint offers WIP commits
  "recallIndex": { "enabled": true, "maxCards": 20 }
}
```

Server-validated like all config; every knob defaults to the
visible-but-not-autonomous posture (prompt, no WIP commits).

## 4. Error handling

Typed errors per house rule: `HANDOFF_INVALID` (schema failure → offer
inspect/discard, never crash resume), `HANDOFF_STALE`, `PROJECT_UNREGISTERED`
(hooks exit silently — never scaffold state). Hook failures are invisible to
the session (fire-and-forget); server writer failures fail loud like any
tool error. A corrupt banner cache is deleted and re-rendered on next
mutation — it's disposable tier-1 state.

## 5. Testing (three rings)

1. **Unit:** handoff schema round-trip; skeleton-guard rejection matrix;
   throttle math (mtime windows); banner byte-stability (render twice,
   assert identical); fetch-cost math; timeline ordering.
2. **Contract/CI (G9 ratchets):** `handoff-v1.json` schema validated
   against fixtures; hook scripts smoke-run under a 100ms timing assertion;
   dangling-reference scan covers hook → script paths.
3. **Dogfood — the kill drill:** during Tier A0's own build, kill the
   session mid-task (and once via forced compaction); the next session must
   resume to the exact task with zero re-executed work. Both drills logged
   in VERIFICATION.md. This is gap-analysis success criterion 1, retired in
   this tier rather than waiting for P5′.

## Non-goals

- Multi-machine handoff sync (handoff is per-machine by design; the
  tracker + ledger + git already carry cross-machine truth).
- Auto-resume of stale (>14d) or cross-project handoffs.
- Transcript parsing — the handoff is assembled from server state, never
  scraped from conversation logs (claude-mem's observer fragility lesson).
- Background daemons or sidecars — everything runs inside the existing
  server process or a <100ms hook script.

## Success criteria

1. Kill drill passes: mid-`work` kill and forced-compaction both resume to
   the exact task, zero re-executed work, demonstrated in dogfood.
2. Banner cache is byte-identical across two session starts with unchanged
   memory (unit-tested + observed).
3. A handoff contradicting tracker state is detected and corrected on
   resume — tracker wins, discrepancy reported.
4. `mem_timeline` returns correct chronological neighbors with accurate
   fetch costs against a seeded store.
5. All hooks measured <100ms; PostToolUse writes at most once per 60s under
   a rapid-tool-call storm test.
