# Cairn 2.0 — Tier A: Planning Depth

**Date:** 2026-07-18
**Status:** Approved design
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier A

## Outcome

Six new live verbs — `scout route summit auto fast resync` — plus flag
richness on `plan`/`work` (`--tdd --mvp --prd --ingest --gaps`, `--wave`).
Tracker-native milestones land in the `Tracker` interface with a capability
fallback, so `summit` releases a real milestone object on backends that have
one and degrades cleanly on those that don't. Built mechanism-first: one
server sweep (5 new tools, 28 → 33), then the verbs as vertical slices on a
finished tool surface.

## Why (decision record)

- **`probe`/`draft` re-tier to C.** The parity roadmap put them in Tier C
  (item 16); the Tier 0 trailhead spec marked them `reserved-A`. The roadmap
  wins: spikes and mockup sessions are stateful-session machinery that
  belongs beside `trace`. This spec is the corrective — the routing table
  rows and `check-surface.mjs` `SPEC_RESERVED` move them to `reserved-C` in
  this tier's sweep.
- **Tracker-native milestones (owner call, 2026-07-18).** PMs and management
  live in the tracker, not the repo. Milestones must be visible there —
  progress bars, release views, tracker automations — not only as a git tag.
  Scope of work was explicitly not the constraint; feature set was.
- **Full `Milestone` entity + capability fallback** over (a) all-six-native
  (GitHub needs a Projects v2 GraphQL integration — deferred, not blocked
  on) and (b) hybrid-only (fails the PM-visibility requirement where a real
  primitive exists). Cairn phases already consume each backend's *first*
  grouping primitive (GitHub milestones, etc.); the milestone level above it
  exists natively only on some backends, so capability-flagged degradation
  is the honest shape.
- **`auto` hard-stops on gate failures** over retry-once or continue-past.
  Unattended fix loops on a wrong diagnosis are the failure mode #726 exists
  to prevent; `trace` (Tier C) is the structured answer, and until it ships,
  a failed gate halts the run.
- **TDD enforcement = commit evidence in the ledger** over prompt-policy-only
  (unenforceable — the #1872 complaint) and server-run test suites (server
  executing arbitrary project commands is a security/portability surface we
  refuse). Mechanical, after-the-fact, no new execution surface.
- **Waves = parallel subagents in one session** over ordering-only (parallel
  in name only) and multi-session dispatch (that is `basecamp`, Tier F,
  per the #3256 pattern).
- **Mechanism-first, two stages** over verb-by-verb slices: the six-adapter
  milestone sweep is cheapest as one pass (P1 precedent), and verbs never
  build against a moving tool registry. Cost accepted: no dogfoodable verb
  until stage 2.

## 1. Scope & surface

**Live verbs 12 → 18:** `scout route summit auto fast resync`.
**Re-tier:** `probe`, `draft` → `reserved-C` (routing table + check-surface).

**Flags:**

| verb | new args |
|---|---|
| `plan <N>` | `--tdd --mvp --prd <file> --ingest <glob> --gaps` (existing `--quick\|--deep --model` unchanged) |
| `work <N>` | `--wave [N]` — absent: sequential as today; bare: all waves in order; `N`: that wave only |

**New server tools (28 → 33):** `milestone_create`, `milestone_list`,
`milestone_complete`, `plan_resync`, `plan_meta_set`.
**Non-breaking extensions:** `ledger_append` gains optional
`redCommit`/`greenCommit`; `Tracker` gains the `Milestone` methods and
`Capability.hasMilestones`.

**Out of scope:** GitHub Projects v2, GitLab Epics, Asana Portfolios native
mappings (follow-up adapter upgrades; those three ship
`hasMilestones: false`); multi-session dispatch (Tier F); trace-routing from
failed verify (Tier C).

## 2. Milestone mechanism (server stage)

### Tracker interface

```ts
interface Milestone { id: string; name: string;
                      state: "open" | "released"; url?: string }
createMilestone(name: string): Promise<Milestone>
listMilestones(): Promise<Milestone[]>
completeMilestone(id: string): Promise<Milestone>
```

`Capability.hasMilestones: boolean`. Native mappings this tier:

| backend | milestone maps to | complete = |
|---|---|---|
| Jira | fixVersion | release the version |
| Azure Boards | Epic work item | close the epic |
| GitHub / GitLab / Asana / ClickUp | — (`hasMilestones: false`) | fallback path |

*(ClickUp amended 2026-07-18 at plan time: phases are Lists under a fixed
configured folder/space and the public API has no move-list endpoint, so a
milestone Folder can't adopt existing phase lists — ClickUp joins the
fallback set until an adapter upgrade.)*

### State lives in git

`roadmap.md` frontmatter gains `milestone: <N>` and, when native,
`milestone_id: <tracker id>`. Artifacts own plan state — never `cairn.json`.

### `milestone_complete(projectDir, { summary })`

Ordered, idempotent orchestration:

1. **Gate:** every live phase dir has VERIFICATION.md — else
   `PRECONDITION_FAILED` listing the unverified phases. Nothing moves.
2. Close every tracker phase object via a new `closePhase(id)` interface
   method + `Capability.hasPhaseClose` (amended at plan time: GitHub
   milestones, GitLab milestones, and Jira epics close natively; Azure
   iteration nodes, Asana sections, and ClickUp lists have no closed
   state — those record a per-phase skip in the report instead of lying).
   Already-closed phases skip — this is what makes re-runs safe.
3. `hasMilestones` → release/complete the native milestone object.
4. Archive: move `phases/NN-*/` → `milestones/v<N>/`; reset `roadmap.md`
   (frontmatter bumps `milestone` to N+1; archive section links `v<N>` with
   the passed summary).
5. Return a report of everything done.

Partial-failure posture: steps 2–3 collect per-object errors into the
report; step 4 runs only when the tracker steps fully succeeded — a
half-archived plans dir is worse than re-running the (idempotent) tool.

### `milestone_create(name)` / `milestone_list()`

`milestone_create` starts the next milestone: native tracker object when
capable; stamps `milestone_id` into roadmap frontmatter. `milestone_list`
merges the git-side view (roadmap frontmatter + `milestones/v*/` archive
dirs) with the tracker's native list when `hasMilestones` — the read
surface for `summit` and `status`. `summit` bootstraps the current
milestone's native object through this tool when the backend is capable
and none is stamped yet (first-milestone case).

### Server stays off git writes

Tagging `v<N>` and committing the archive is the agent's job in the
`summit` verb — consistent with every existing verb (server does files +
tracker; agent does git).

## 3. Remaining server mechanism

### `plan_resync(projectDir, { phase? })`

Out-of-band commit detection by ledger coverage math: every closed issue's
ledger entry records `baseCommit..headCommit`; resync walks `git log` since
the `last_resync: <sha>` marker (roadmap frontmatter, advanced on each run)
and returns commits covered by no ledger range:
`{ outOfBand: [{ sha, subject, files }], sinceSha }`. Mapping commits to
affected phases is judgment — the verb's job, not the server's.

**Note:** first read-only git use in the server (a `git log` subprocess).
Read-only is fine; the no-git rule was always about writes.

### `plan_meta_set(phaseDir, { waves?, tdd? })`

One validated writer for the new PLAN.md frontmatter (same rule as
`plan_issues_set`: never hand-edit):

- Waves as flat keys per the constrained frontmatter form:
  `wave_1: [ids]`, `wave_2: [ids]`. Validation: every id exists in
  `issues:`; no id in two waves; no empty wave.
- `tdd: [ids]` — TDD-eligible tasks, decided at plan time. Validation:
  ids exist in `issues:`.

### TDD evidence

`ledger_append` gains optional `redCommit`/`greenCommit`. `verify` gains a
step: every id in `tdd:` must have a ledger entry carrying the pair —
a missing pair on a TDD task is a verify failure, same honesty rule as
everything else. Enforcement is after-the-fact and mechanical; the
RED → GREEN → REFACTOR procedure itself is prompt-policy in `work.md`.

## 4. `plan`/`work` flag behavior (prompt stage)

- **`plan --tdd`** — during breakdown, each task gets an eligibility call
  (behavior-testable code → eligible; config/docs/scaffolding → not),
  batched into ONE AskUserQuestion for overrides, written via
  `plan_meta_set({ tdd })`.
- **`plan --mvp`** — task-shaping policy: first tasks form one thin
  vertical slice exercising every layer end-to-end; depth after the walking
  skeleton. Policy text lives in `cairn-planning` (it owns artifact
  judgment); the flag selects it.
- **`plan --prd <file>` / `--ingest <glob>`** — express paths: the PRD
  answers interview questions (only gaps get asked — batched); ingested
  ADRs land in CONTEXT.md as locked decisions with source links. Conflicts
  between ingested docs surface to the user — never silently picked.
- **`plan --gaps`** — re-planning: reads VERIFICATION.md failures + the
  latest `plan_resync` report, proposes new/amended tasks, severity-routed
  (G5): goal-breaking → tasks in this phase now; minor → offered to
  backlog. New issues via existing `issue_create` + `plan_issues_set`.
- **`work --wave`** — per wave: one subagent per issue, dispatched in
  parallel; file-mutating issues get worktree isolation; each subagent runs
  the same lifecycle as sequential work (claim `in_progress` + assignee →
  work → close → `ledger_append`). Wave N+1 starts only when wave N is
  fully closed and merged. A failed issue: finish the wave's others, then
  stop before the next wave and report — no cascading onto possibly-broken
  foundations. `--wave` with no `wave_N` keys → say so, point at `plan`.
- **`work` TDD procedure** (issue id ∈ `tdd:`) — RED: failing test, run,
  show failure, commit. GREEN: minimal pass, commit. REFACTOR: clean,
  commit. Red/green shas → `ledger_append`. Skipping red on an eligible
  task: the verb instructs stop-and-restart, and verify catches the missing
  pair regardless.

## 5. The six new verbs

- **`scout <N>`** — research-only, resumable (#1961). Runs `plan`'s
  research stage alone; writes RESEARCH.md incrementally with a per-section
  status marker (`<!-- scout: done|pending -->`). Re-invoked with an
  existing RESEARCH.md: parse markers, research only `pending`, never redo
  `done`. No new tools — the markers are the checkpoint.
- **`route insert|remove|edit`** — roadmap surgery. Insert: decimal phase
  (`03.5-slug`) via existing `plan_scaffold_phase` — no renumbering, no
  tracker churn. Remove: confirm → close/annotate the phase's tracker
  object; per open issue ask close-or-reassign; move dir to
  `milestones/removed/`; strike the roadmap row. Edit: retitle/rescope —
  dir slug, roadmap row, tracker phase name via existing tools. **No
  renumber operation at all this tier** — decimals make it unnecessary and
  renumbering is where GSD's version broke things.
- **`summit`** — §2's flow: verify-gate → interview for the milestone
  summary → `milestone_complete` → agent commits archive + tags `v<N>` →
  `continuity_clear` → optional next-milestone interview
  (`milestone_create` + first-phase scaffolding, batched questions).
- **`auto`** — explicit opt-in confirmation showing exactly what will run
  (remaining phases with contexts, in order). Loop per phase:
  plan-if-needed → work → verify. Hard-stops: failed verify, `plan_drift`
  flags, tracker error, security-flagged decision. Decision policy encoded
  in the verb doc — the six G5 principles: prefer completeness, match
  existing patterns, choose reversible options, mirror the user's past
  choices, defer ambiguity, escalate security. Genuinely subjective taste
  decisions accumulate into ONE batched approval at the end. Handoff
  refresh at every phase boundary — a killed `auto` run resumes via
  `waypoint` like anything else (A0 inheritance).
- **`fast "<change>"`** — guardrails: ≤3 files, no plan artifacts, no
  phase. Still tracker-first: creates one issue (label `fast`), makes the
  change, atomic commit, closes the issue with the commit sha in the close
  note. No ledger (no phase dir). Growing past 3 files → stop, suggest
  `plan`.
- **`resync`** — runs `plan_resync`, presents out-of-band commits grouped
  by likely phase (file-path heuristic, agent judgment), then: refresh
  affected CONTEXT.md/PLAN.md, offer `plan --gaps` for phases whose
  assumptions broke, advance the marker.

## 6. Testing (three rings)

1. **Unit:** milestone mappings per adapter against recorded HTTP fixtures
   (P1 pattern) including the `hasMilestones: false` fallback;
   `milestone_complete` gate/ordering/idempotency (re-run after a partial
   tracker failure); `plan_meta_set` validation matrix; `plan_resync`
   coverage math against a seeded git-repo fixture; ledger red/green fields
   round-trip.
2. **Contract/CI:** `check-surface.mjs` ratchets to 18 live / 10 reserved
   (probe/draft at `reserved-C`); tool-reference validation covers the 5
   new tools; dangling-reference scan over the six new verb docs.
3. **Dogfood drills** (logged in VERIFICATION.md, run live like Tier 0/A0):
   - **Summit drill:** scratch project, 2 verified phases → `summit` on a
     `hasMilestones` backend (Jira or Azure Boards) AND on GitHub (fallback).
     Tracker objects closed/released, archive + tag correct, re-run
     idempotent.
   - **Auto drill:** 2-phase scratch project runs hands-off; a rigged
     failing verify → hard-stop with a usable report; SIGKILL mid-run →
     `waypoint resume` continues.
   - **Wave drill:** 4-issue phase in 2 waves → parallel subagents, all
     claimed/closed/ledgered, wave 2 waits on wave 1.

## Non-goals

- GitHub Projects v2, GitLab Epics, Asana Portfolios native milestone
  mappings — follow-up adapter upgrades, not Tier A blockers.
- Phase renumbering (decimals cover insertion; renumbering is where GSD
  broke).
- Multi-session wave dispatch (Tier F `basecamp`).
- `auto` self-repair/retry loops (Tier C `trace` is the structured answer).
- Trace-routing from failed verify (Tier C).

## Success criteria

1. Summit drill passes on both a native and a fallback backend.
2. Auto drill: zero un-principled unattended decisions — every non-taste
   decision in the run report traces to an encoded principle; the taste
   batch is delivered at the end.
3. A `tdd:` task missing its red/green pair fails verify.
4. Scout killed mid-research re-invokes and researches only `pending`
   sections.
5. `fast` refuses a 4-file change.
6. CI surface check green at 18 live / 10 reserved with the 5 new tools
   referenced correctly.
