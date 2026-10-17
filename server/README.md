# @eventually-consistent/cairn-server

The cairn 2.0 MCP server — tracker-first project management for AI coding
agents, speaking plain MCP over stdio.

Most people want one of these installs instead of this package directly:

- **Claude Code**: install the cairn plugin — it wires this server plus
  hooks, slash commands, and skills.
- **Grok Build, Copilot CLI, Codex, Gemini CLI, Cursor, OpenCode, Zed**:
  `npx @eventually-consistent/cairn cairn-setup <harness>` wires your
  project's MCP config at this server.

Running it directly: `npx -y @eventually-consistent/cairn-server` — expects
a `cairn.json` in the project directory (`CLAUDE_PROJECT_DIR` or cwd); see
the [quickstart](https://github.com/eventually-consistent-code-org/cairn2/blob/main/docs/00-quickstart.md).

Everything below is the developer reference. Design spec:
[`docs/superpowers/specs/2026-07-12-cairn-2-design.md`](https://github.com/eventually-consistent-code-org/cairn2/blob/evals-archive/docs/superpowers/specs/2026-07-12-cairn-2-design.md)
on the `evals-archive` branch (the planning history is not on `main`, #403).

87 tools total across planning, memory, continuity, collaboration, milestones, config, sessions (trace, probe, draft, thread), audits (plan_check, audit_record), the project knowledge graph (map_set, map_get, map_query), workspace/board (workspace_list, workspace_focus, workspace_status, board_get, board_update), peers (peer_list, peer_run, peer_state), tracker-delta ingest (plan_tracker_delta), issue links + dependency graph (issue_link, issue_unlink, issue_links, graph_report), local-tracker promotion (tracker_migrate), and docs publishing and drift (docs_publish, docs_status, docs_drift), issue attachments (issue_attach), active context (context_get, context_set, context_meter), issues and phases (issue_create, issue_get, issue_list, phase_create, phase_list), memory compaction (mem_compact), headless-run budgeting (budget_check, token_estimate, run_manifest), seat roster (seat_roster), config probe (config_probe), portfolio outlook (outlook_emit, outlook_get, outlook_refresh, outlook_forget), research checkpoints (research_sections), and distill (distill_manifest).

## Test rings

1. `npm test` — unit + contract-vs-FakeTracker (CI, no network)
2. `npm run test:live` — contract vs a real backend. Per spec, an adapter is
   NOT shipped until live-green.

Each `.live.test.ts` skips cleanly when `CAIRN_LIVE_TESTS` and its backend's
env vars aren't set, so `npm test` never touches the network.

## Adapter status

| type | unit | contract (fake) | contract (cached) | live status | live env vars |
|---|---|---|---|---|---|
| `github` | ✅ | ✅ | ✅ | 🟢 live-green (8/8, sandbox, 2026-07-13) | `CAIRN_TEST_GITHUB_REPO`, `GITHUB_TOKEN` (or `gh auth login`) |
| `gitlab` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_GITLAB_PROJECT`, `GITLAB_TOKEN` |
| `jira` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_JIRA_BASE_URL`, `CAIRN_TEST_JIRA_PROJECT_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `asana` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_ASANA_PROJECT_GID`, `ASANA_TOKEN` |
| `azure-boards` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_AZURE_ORG_URL`, `CAIRN_TEST_AZURE_PROJECT`, `AZURE_DEVOPS_PAT` |
| `clickup` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_CLICKUP_DEFAULT_LIST`, `CAIRN_TEST_CLICKUP_SPACE` (or `CAIRN_TEST_CLICKUP_FOLDER`), `CLICKUP_TOKEN` |
| `linear` | ✅ | ✅ | ✅ | ⏳ implemented, live pending credentials | `CAIRN_TEST_LINEAR_TEAM`, `LINEAR_API_KEY` |

"contract (fake)" is ONE shared run of `test/contract.ts` against `FakeTracker`
(and `CachedTracker(FakeTracker)` for "contract (cached)") — it is not a
per-adapter run; each adapter's own live-gate coverage is what "live status"
reports above.

"contract (fake)"/"contract (cached)" mean the adapter's behavior is exercised
indirectly — every adapter shares the same `trackerContract` suite
(`test/contract.ts`), which today runs directly against `FakeTracker` and
`CachedTracker(FakeTracker)`. The adapter-specific "contract" coverage lives
in each `<name>.live.test.ts`, gated as shown below; "unit" is each adapter's
own `<name>.unit.test.ts` against fixture HTTP responses.

## Planning tools

The `plan_*` tools manage project artifacts and phase tracking across cairn integrations:

| tool | purpose |
|---|---|
| `plan_scaffold_project` | Create `.cairn/plans/PROJECT.md` + `roadmap.md` (never overwrites) |
| `plan_scaffold_phase` | Create `phases/NN-slug/` with `CONTEXT.md` + `PLAN.md` (+ optional `RESEARCH.md`) |
| `plan_status` | Report phases, artifact presence (CONTEXT/RESEARCH/PLAN/VERIFICATION), and referenced tracker issues |
| `plan_phase_ensure` | Ensure the tracker has a phase named `Phase N: <name>` (idempotent by canonical name) |
| `plan_drift` | Flag plan-referenced issues that are missing or closed without a VERIFICATION.md |
| `plan_issues_set` | Set the tracker issue ids a phase's `PLAN.md` frontmatter advances |
| `plan_meta_set` | Set wave grouping (`wave_N` frontmatter) and/or the TDD-eligible task list on a phase's `PLAN.md` |
| `plan_resync` | Detect out-of-band commits (covered by no `LEDGER.md` range) since the last resync marker; advances the marker. First run initializes the marker and reports nothing |
| `plan_tracker_delta` | Diff the live tracker against the snapshot cursor (`.cairn/tracker-marker.json`): new issues/phases, per-field edits, external state changes. Peek by default; `ack: true` advances the cursor. First run initializes and reports nothing. Cairn's own mutations never echo — every issue-mutating tool writes through to the snapshot |

### Artifact layout

Plans live at `<projectDir>/.cairn/plans/`:

```
.cairn/plans/
  PROJECT.md       # project vision and scope
  roadmap.md       # phase roadmap
  phases/
    01-name/       # phase directories (zero-padded number + slug)
      CONTEXT.md   # phase requirements
      RESEARCH.md  # optional deep-mode research
      PLAN.md      # execution plan (frontmatter: issues: [<tracker-ids>])
      VERIFICATION.md  # (optional) drift guard — presence exempts a closed issue
```

Each phase directory name matches `NN-<slug>` where `NN` is 01..99 zero-padded
and `<slug>` is lowercase alphanumerics + hyphens (auto-slugified from phase name).

### Drift semantics

`plan_drift` scans all phase PLAN.md frontmatters for referenced tracker issues and flags:

- **missing**: issue id no longer exists in the tracker
- **closed**: issue is closed AND its phase has no VERIFICATION.md

The presence of a `VERIFICATION.md` file in a phase directory signals that the
phase has been verified complete, so closed issues are no longer considered drift.
This gate is the human-controlled contract between plan state and phase completion.

## Milestone tools

The `milestone_*` tools manage the project's milestone lifecycle, backed by the tracker's native milestone object when the backend supports one:

| tool | purpose |
|---|---|
| `milestone_create` | Start the next milestone — native tracker object when the backend supports it; stamps `milestone_id` into `roadmap.md` |
| `milestone_list` | Current milestone number, archived milestones, and the tracker's native list when supported |
| `milestone_complete` | Complete the current milestone: gate on all-phases-verified, close tracker phases, release the native milestone when supported, archive `phases/` to `milestones/vN/`, bump roadmap. Idempotent — safe to re-run after a partial tracker failure |

## Memory tools

The `mem_*` tools give agents a two-tier memory: a disposable full-text index for
reference material, and durable, git-committed cards for decisions/constraints/
gotchas/references:

| tool | purpose |
|---|---|
| `mem_index` | Index reference material into the searchable memory store (disposable, rebuildable) |
| `mem_search` | Full-text search the memory index, optionally scoped to a phase/issue |
| `mem_stats` | Memory index size — chunk count and approximate token usage (capacity guard signal), card-store health, and the observation backlog waiting on retro |
| `mem_card_create` | Write a durable memory card (decision/constraint/gotcha/reference) with provenance |
| `mem_card_list` | List memory cards, optionally filtered by phase/issue scope |
| `mem_card_recall` | List memory cards with staleness checked against their provenance (the anti-rot check) |
| `mem_card_update` | Adjust a memory card's confidence (frontmatter-only; body and id are immutable) |
| `mem_timeline` | Chronological neighbors (cards + index chunks) around an anchor, at index cost |

### Artifact layout

Two tiers, with different durability guarantees:

```
~/.cairn/index/<project>.db        # Tier 1 — FTS5 index, disposable, never git-tracked, safe to delete (rebuildable)
.cairn/memory/cards/*.md           # Tier 2 — durable memory cards, git-committed
```

Tier 1 is a `better-sqlite3` FTS5 virtual table keyed off `mem_index`/`mem_search`.
Tier 2 cards are frontmatter'd Markdown files (`type`, `scopePhase`, `scopeIssue`,
`provenanceFiles`, `provenanceCommits`, `created`) with a deterministic id
(`<type>-<sha256(body).slice(0,8)>`), so re-creating a card with identical content
never produces a duplicate file. `type` includes `note` (knowledge captured by
`/cairn:mark --note`, not work); every type may carry an optional
`confidence: high | medium | low` in frontmatter, surfaced by `mem_search`,
`mem_card_list`, `mem_card_recall`, and the SessionStart banner when present.
`mem_card_update({ id, confidence })` is the one mutation cards get — a
frontmatter-only patch (body and id, a content hash of the body, stay
immutable; a changed lesson is a new card, not an edit) that throws
`NOT_FOUND` on an unknown id and triggers a banner re-render. `/cairn:retro`
is the primary writer: it grades a card's confidence up when a later phase
proves it out, or down (plus a corrected card) when contradicted.

### Staleness

Every `mem_card_recall` call re-checks each card's provenance against `git diff`
at the recorded commit; `stale: true` means the underlying files have since
changed (or vanished, or couldn't be verified) — treat the card as a lead to
re-verify, not a fact to trust.

### Capacity guard

`cairn.json` carries `memory.tokenThreshold` (default `150000`) — read directly
from config by the skill (not returned by any tool) to decide when the memory
index is getting large enough to warrant summarizing or pruning.

### Timeline

`mem_timeline({ anchor, before?: 3, after?: 3 })` answers "what was happening
around this decision?" at index cost — `anchor` is a memory card id or an
index chunk source; the result merges chronologically adjacent cards
(`{ id, type, title, created, cost }`) and index chunks (`{ source,
createdAt }`) into one ordered list. Cards carry a day-precision `created`
date while index chunks carry a full ISO timestamp, so entries sort by
whatever precision they actually have (a same-day chunk sorts after a
same-day card); same-day cards tie-break by id.

## Session continuity

Kill a session mid-task — compaction, usage cap, `/clear`, a real crash —
and the next session resumes at the exact task with zero re-executed work.
The server is the primary writer: every state-changing tool (`context_set`,
`issue_update`, `issue_close`, `plan_issues_set`, `plan_import`,
`mem_card_create`, `ledger_append`) refreshes the handoff in-process,
write-through, on every call.

| tool | purpose |
|---|---|
| `continuity_checkpoint` | Write/refresh the session handoff (also called manually by `/cairn:waypoint`) |
| `continuity_get` | Read the current handoff; flags one older than 14 days as stale but never errors on staleness |
| `continuity_clear` | Delete the handoff — called on confirmed resume, `ship`, and `summit` |
| `ledger_append` | Append a verified-task line to a phase's git-committed `LEDGER.md` (append-only) |

### Artifact layout

```
~/.cairn/handoff/<project>-<hash>.json   # per-machine, ephemeral session handoff — never git-tracked
~/.cairn/banner/<project>-<hash>.md      # pre-rendered recall-index cache (see below)
.cairn/plans/phases/<NN-slug>/LEDGER.md  # per-phase, git-committed, append-only task ledger
```

`<hash>` is `sha256(resolve(projectDir)).slice(0, 16)` — the same per-machine
keying scheme the memory index uses, so handoff/banner state never collides
across projects that happen to share a basename.

### Resume flow

1. A `PostToolUse` hook (throttled to ≤1 write/60s) covers the gaps
   between tool calls; `SessionStart` cats the handoff and, per
   `continuity.resume`, offers (`prompt`), auto-runs (`auto`), or
   suppresses (`off`) the resume — on `startup` and `clear` only. A
   session the platform restores itself (`compact`, `resume`, `fork`)
   gets nothing (#328).
2. `/cairn:waypoint` is the manual path: no argument pauses (prompts for
   `next_action`/`notes`, optionally offers a `wip(cairn):` commit);
   `/cairn:waypoint resume` resumes.
3. **Trust order is never the handoff alone.** The tracker and `git log`
   outrank `LEDGER.md`, which outranks the handoff — a handoff that
   contradicts the tracker (an issue it names as open that's actually
   closed, a task the ledger already shows landed) is reported and
   corrected before it's followed. See
   `skills/cairn-trailhead/verbs/waypoint.md`.
4. On confirmed resume, `ship`, or `summit`: `continuity_clear()`.

### Guard rails

- **Skeleton guard.** A write can never replace a handoff with `task.current`
  or `next_action` populated with an empty one — richness is monotonic
  between clears.
- **Unregistered guard.** Every writer requires a loadable `cairn.json`;
  nothing is ever created outside `~/.cairn/` for a project cairn doesn't
  know.
- **Never trusted blind.** A handoff older than 14 days is surfaced as stale
  and never auto-resumed, even with `continuity.resume: "auto"`.
- Every hook is fire-and-forget (errors exit 0 silently) and targets <100ms —
  a hook failure is never visible to the session.

### Recall index (session-start memory banner)

On every card mutation or active-context scope change, the server
re-renders the banner cache above: a byte-stable, token-cost-annotated table
of memory cards scoped issue > phase > project (id tiebreak), capped at
`continuity.recallIndex.maxCards`. `SessionStart` just cats the file — no DB
access, no runtime spawn. Fetch cost is `ceil(card_chars / 4)`, computed
fresh at render time; `mem_stats` reports `bannerTokens` (the banner's own
cost) and `tokensSavedVsFullInjection` (sum of the scoped cards' costs minus
the banner cost, floored at 0) — honest accounting of what the pre-rendered
index actually saves versus injecting every card in full.

The banner also carries the observation buffer's state. Once
`.cairn/observations/observations.jsonl` holds at least
`memory.observationWarnThreshold` rows (default 25), a line directly under
the header reads `N unreviewed observations (oldest Xd) — run retro`, and a
backlog past that line renders the banner even with no cards and no open
sessions. `mem_stats` reports the same facts under `observations` (count,
`oldestAgeDays`, threshold). Both read the plain JSONL file — like the card
audit, independent of the index binding, so a broken index can't hide the
backlog. Capture stays passive; retro remains the only reader and the only
garbage collector.

### Configuration

`cairn.json`'s `continuity` block:

```json
"continuity": {
  "resume": "prompt",
  "checkpoint": true,
  "wipCommits": false,
  "recallIndex": { "enabled": true, "maxCards": 20 }
}
```

- `resume` — `prompt` (default) asks before resuming, `auto` proceeds
  without asking, `off` suppresses the `SessionStart` resume offer entirely.
- `checkpoint` — enables/disables the `PostToolUse` breadcrumb hook.
- `wipCommits` — `/cairn:waypoint` offers a `wip(cairn): waypoint —
  <next_action>` commit on pause when there's uncommitted work.
- `recallIndex.enabled` / `recallIndex.maxCards` — the recall banner above.

## Collaboration

The `plan_*` and `issue_*` tools coordinate team workflow when multiple agents (or humans + agents) work on the same project.

| tool | purpose |
|---|---|
| `plan_unplanned` | Tracker issues (non-closed) that no phase's PLAN.md references — work at risk of being missed |
| `plan_import` | Reverse-mirror a tracker phase (by id or name substring) into .cairn/plans/ artifacts |

On very large trackers the underlying issue list is capped (1000 items on GitHub/GitLab via pagination, 100 on Jira/Asana/Azure Boards/ClickUp), so `plan_unplanned`'s report may be incomplete beyond that cap; a truncation warning is logged to the server's stderr when it happens.

### Configuration

**User handle (optional).** Set `cairn.json`'s `user.handle` field to your identity (e.g., your GitHub username) to participate in ownership tracking:

```json
{
  "tracker": { "type": "github", "config": {} },
  "user": { "handle": "alice" }
}
```

When `user.handle` is set:
- **Claim & assign:** `/cairn:work <phase>` calls `issue_update(id, assignee: <handle>)` so teammates see who holds each issue. If an issue is assigned to someone else, the workflow skips it unless the user explicitly overrides.
- **Skip others' work:** By default, the work flow skips issues assigned to teammates, to avoid stepping on toes.

When `user.handle` is absent, cairn operates in single-user mode — no assignee tracking, no ownership checks.

**Collaboration mode (optional).** `user.mode` is `"vibe"` (default —
cairn drives end-to-end) or `"engineer"` (the human claims issues, writes
code, and makes the design calls; cairn pairs, scaffolds, verifies, and
keeps the tracker mirror honest for both parties' work — see the `work`
verb's pairing overlay and the `auto`/`ship` no-self-merge gate). Absent
key ≡ `"vibe"`. Engineer mode needs `user.handle` for assignment identity
— set both together via `tune mode engineer`.

Assignee **write** support today is GitHub and Azure Boards only. The other backends accept the `issue_update(..., assignee: ...)` call but don't propagate it: ClickUp explicitly defers it (needs numeric user-id resolution not yet implemented); Jira, Asana, and GitLab have no assignee mapping yet.

### Infrastructure (not new machinery)

Plans and memory cards collaborate via **ordinary git** — push your changes, open a PR, review and merge together. The server does not enforce locking or concurrency control.

Work-state concurrency (two agents starting the same issue at once) is **the tracker's responsibility** — its `issue_update()` call with `state: "in_progress"` is the atomic claim. Cairn reads the tracker's truth; the tracker enforces the constraint.

**Per-machine isolation.** Each machine holds its own `active-context` state (`.cairn/state/active-context.json`). Agents on different machines can work on different issues in the same phase without conflict — coordination happens via the tracker and git-committed plan artifacts.

## Config tools

`cairn.json` gets a validated single-writer, the same discipline `plan_meta_set`
and `patchRoadmapMeta` already apply to plan artifacts:

| tool | purpose |
|---|---|
| `config_get` | Read `cairn.json` as the parsed, validated, post-defaults effective config (what `/cairn:tune` displays) |
| `config_set` | Deep-merge-patch the raw `cairn.json`; `null` deletes a key |

`config_set` validates the *merged* result against `ConfigSchema` before
writing anything — an invalid patch throws `CONFIG_INVALID` and the file is
left untouched. Patches touching tracker credential/env-var-shaped fields are
refused outright: secrets live in env vars, never in `cairn.json`.
`ConfigSchema` carries the `leakGuard` block below (all fields defaulted), so
its toggles validate through the same gate as everything else.

## Sessions

Persistent, typed session files that survive `/clear` — git-side session
files paired with a tracker mirror that keeps management informed in plain
language, without diving into code. Four kinds share one core: `trace`
(persistent debugging, Tier C1), `probe` (risk-ordered throwaway spikes,
Tier C2, GSD spike parity), `draft` (multi-variant HTML mockups on a
shared theme, Tier C2, GSD sketch parity), and `thread` (persistent context
threads that outlive a single sitting, Tier E). The routing law for `trace`
(spec §726) is unchanged: a failed `verify` or a reported bug routes into
evidence → hypothesis → test → verdict, never an inline improvised fix (a
proven-obvious ≤3-line fix may still use the fast lane: one evidence entry,
one verdict, close).

### The store generalization

`server/src/sessions/store.ts` is the shared core, parameterized by a kind
descriptor (entry-kind vocabulary + close gate). `server/src/trace/store.ts`
is now a thin **compatibility re-export** binding the core to the `trace`
descriptor — the Tier C1 public API (`startTrace`, `appendTrace`,
`listTraces`, `closeTrace`, `lastEntryKind`, `traceId`) and its on-disk
format stay byte-identical; `test/trace-store.test.ts` passes unmodified
and IS the compatibility test.

| kind | dir | entry kinds | close gate |
|---|---|---|---|
| `trace` | `.cairn/trace/` | `evidence` `hypothesis` `test` `verdict` | ≥1 `verdict` |
| `probe` | `.cairn/probe/` | `experiment` `result` `requirement` `verdict` | ≥1 `verdict` |
| `draft` | `.cairn/draft/` | `variant` `decision` `note` | ≥1 `decision` |
| `thread` | `.cairn/thread/` | `note` `link` `decision` `wrap` | ≥1 `wrap` |

Session ids are description-derived (`<kind>-<sha256(description).slice(0,8)>`
— the same hashed-content convention memory cards use), with the same
already-open guard across all four kinds: starting the same description
twice while a session is open throws `PRECONDITION_FAILED` pointing at the
existing session instead of forking it. Archives are immutable at
`.cairn/<kind>/archive/<id>.md` — a resolved session is immutable by
construction, not by convention, and every kind mechanically refuses to
close without its gate entry logged first. Probe/draft frontmatter adds one
optional field over trace's: `phase: <n>`, stamped at `*_start` from the
active context when one is set — the `session_landscape` phase linkage
below; `thread_start` stamps `phase` the identical way. `thread` closes on
a `wrap` entry rather than a `verdict`/`decision` — a thread closes by
being wrapped up, never abandoned silently.

### Tools

| tool | purpose |
|---|---|
| `issue_comment` | Post a plain-language comment on a tracker issue (management-visible progress note) |
| `trace_start` | Open a trace session (`.cairn/trace/<id>.md`); creates the tracker bug issue (label `cairn:bug`) when no `issueId` is given; same-description open session → `PRECONDITION_FAILED` pointing at it |
| `trace_log` | Append a typed entry (`evidence`\|`hypothesis`\|`test`\|`verdict`) — append-only; unknown id → `NOT_FOUND`, resolved session → `PRECONDITION_FAILED` |
| `trace_list` | List open and/or resolved trace sessions with entry counts — the read surface for `status`, the SessionStart banner, and resume |
| `trace_close` | Resolve: requires ≥1 `verdict` entry (else `PRECONDITION_FAILED`: "close needs a verdict — log one first"), archives the session, comments the resolution on the bug issue and closes it |
| `probe_start` | Open a spike session (`.cairn/probe/<id>.md`); creates the tracker issue (label `cairn:spike`) when no `issueId` is given; stamps `phase` from the active context; same-description open session → `PRECONDITION_FAILED` |
| `probe_log` | Append a typed entry (`experiment`\|`result`\|`requirement`\|`verdict`) — same append-only/gate rules as `trace_log` |
| `probe_close` | Resolve: requires ≥1 `verdict` entry, archives the session, comments the resolution (`proceed`\|`pivot`\|`stop — <reason>`) and closes the issue |
| `draft_start` | Open a sketch session (`.cairn/draft/<id>.md`); creates the tracker issue (label `cairn:sketch`) when no `issueId` is given; stamps `phase`; same-description open session → `PRECONDITION_FAILED` |
| `draft_log` | Append a typed entry (`variant`\|`decision`\|`note`) — same append-only/gate rules as `trace_log` |
| `draft_close` | Resolve: requires ≥1 `decision` entry, archives the session, comments the chosen direction and closes the issue |
| `thread_start` | Open a persistent context thread (`.cairn/thread/<id>.md`); creates the tracker issue (label `cairn:thread`) when no `issueId` is given; stamps `phase`; same-description open session → resume, not a duplicate (`PRECONDITION_FAILED` pointing at it) |
| `thread_log` | Append a typed entry (`note`\|`link`\|`decision`\|`wrap`) — same append-only/gate rules as `trace_log` |
| `thread_close` | Resolve: requires ≥1 `wrap` entry, archives the session, comments the resolution on the issue and closes it |
| `session_landscape` | Read-only join over all four kinds: every session's kind/id/status/issue/description/entryCounts, `openByKind` totals, archived resolution text (read from the `## resolution` block), and phase groupings. Deterministic ordering (kind, then id — trace, probe, draft, thread) — same store state, same bytes |

Backed by the tracker interface's `commentIssue(id, text)` method +
`Capability.hasComments` (true on all eight adapters — Local, Linear, GitHub,
GitLab, Jira, Azure Boards, Asana, ClickUp — the flag exists so a future
backend can degrade to a recorded skip, same posture as `hasMilestones`).

**Time tracking.** `issue_close` accepts an optional `timeSpentMinutes`;
on backends with `Capability.hasWorklog` (Jira only today, via
`POST /rest/api/3/issue/<key>/worklog`) it writes a real worklog entry and
returns `worklogLogged: true`. A worklog failure never fails a close that
already succeeded — the result carries `worklogLogged: false` plus a
`worklogError` note, and the verb's close comment carries the time line as
the fallback on every backend.

### Artifact layout

```
.cairn/trace/<id>.md              # open trace session — single-writer through the trace_* tools
.cairn/trace/archive/<id>.md      # moved here on trace_close — immutable once archived
.cairn/probe/<id>.md              # open probe session
.cairn/probe/<id>/                # experiment code, runnable, throwaway
.cairn/probe/archive/<id>.md
.cairn/draft/<id>.md              # open draft session
.cairn/draft/<id>/NNN-<name>.html # one variant per file, links the shared theme
.cairn/draft/themes/default.css   # shared theme — CSS custom properties ONLY, one per project
.cairn/draft/archive/<id>.md
.cairn/thread/<id>.md             # open persistent context thread
.cairn/thread/archive/<id>.md     # moved here on thread_close — immutable once archived
```

Frontmatter: `status: open|resolved`, `issue: <tracker id>`, `created`,
`resolved` (close-time), plus probe/draft's optional `phase`. The body is
append-only typed blocks (e.g. `## evidence — <date>`, `## verdict`) —
`*_log` never rewrites a prior block, only appends a new one. `*_close`
appends a final `## resolution` block, stamps `status: resolved` +
`resolved`, then moves the file live → archive (rename, not
copy-and-delete). `*_close`-equivalent archiving moves the session `.md`
only; probe/draft artifact directories remain until the verb's `--wrap`
packages what is worth keeping (`.claude/skills/<name>/` with provenance),
after which they're deletable — the verb offers, never auto-deletes.

Tracker mirror touches are milestone-only, verb-driven (never per-entry
noise, never tool-implicit): comment #1 on `*_start` ("started"), a
key-finding/decision comment mid-session, and the resolution rides as the
`*_close` issue-close note — three touches per session, same story shape
across all four kinds (`thread` collapses the middle touch: two touches
only, start and wrap, per `verbs/thread.md`). `*_start`/`*_log` refresh the
session handoff (`source: "tool"`) the same write-through way every other
state-changing tool does, so a killed session resumes into it via the
continuity machinery above.

## Map store (project knowledge graph)

A single-writer knowledge graph backing the `map` verb (Tier E): typed
nodes and typed edges over one deterministic JSON store, the same
`config_set`-style merge-patch discipline `cairn.json` uses — validated
shape + atomic writes, never an index or a database.

```jsonc
// .cairn/map/map.json
{
  "nodes": { "<id>": { "type": "module|phase|issue|decision|person", "label": "...", "detail": "..." } },
  "edges": [ { "from": "<id>", "to": "<id>", "type": "depends-on|implements|decided-in|owns" } ]
}
```

| tool | purpose |
|---|---|
| `map_set` | Merge-patch the graph: `patch.nodes` merges by id (`null` deletes an unattached node; deleting one still edge-attached throws `PRECONDITION_FAILED` naming the edges), `patch.edges` — when present — REPLACES the edge list wholesale (edge-level merge has no stable identity). Every edge endpoint must exist in the post-merge node set, or the write throws `PRECONDITION_FAILED` naming the missing id. Invalid node/edge types throw `UNSUPPORTED`. Returns `{ nodes: <count>, edges: <count> }` |
| `map_get` | Read the graph, whole or filtered by `nodeType`, `edgeType`, or `node` (that node + every edge touching it + the neighbor nodes). Deterministic: nodes sorted by id, edges sorted by `(from, to, type)`. A missing store reads as `{ nodes: {}, edges: [] }`, never an error |

Writes are atomic (`.tmp` file + rename, never a partial `map.json` on
disk). The `map` verb is the only intended writer of graph *content*
(`map build` walks code/plans/tracker and proposes patches; `map diff`
reads and compares but never writes) — the server enforces shape and
atomicity, the verb owns the intelligence.

## Plan checks / Audit records

Two read-only/single-writer tools backing the `audit` and `review` verbs
(Tier C3, GSD's audit-uat/audit-milestone/ui-review/eval-review/
validate-phase/add-tests/code-review/code-review-fix folded into one
discipline). Deterministic, no tracker calls of their own — the verb
layer does the tracker mirroring on top.

### Tools

| tool | purpose |
|---|---|
| `plan_check` | Read-only scan of a phase's (or the whole project's) `PLAN.md` files for four detector classes: `contract-drift`, `unanchored-threshold`, `missing-verify` and `missing-approaches`. Returns `{ findings, scanned }`, deterministically ordered (plan path, then line) and byte-equal across calls on an unchanged tree |
| `audit_record` | Single-writer: `audit_record(scope, verdict, findings)` writes `.cairn/audit/<scope>-<YYYY-MM-DD>.md`. `verdict` must be `pass` (zero findings) or `findings` (one or more) — a mismatch throws. Re-running the same scope on the same day overwrites that file; prior dates are untouched. Returns `{ path, findings: <count> }` |

### `plan_check` detector rules

- **Contract drift** — collects every `- Produces:`/`- Consumes:` bullet
  (plus its continuation lines, including inside a code fence) across a
  phase's plans. A consumer whose contract text shares a named symbol with
  a producer's, but doesn't match it after whitespace normalization,
  is a `contract-drift` finding on the consumer's line, naming the
  producer's plan+line as `counterpart` — unless both plans reference the
  same path-like fixture token (e.g. `test/fixtures/export-contract.json`),
  which silences it.
- **Unanchored thresholds** — a quantitative threshold pattern
  (comparison/bound word + number + unit: `< 100ms`, `>= 500 rps`, `at
  least 99.9%`, …) with no anchor — a path-like token or one of
  `benchmark|fixture|measured|per spec|spec §|source:` — on its own line or
  an immediately adjacent line (that isn't itself a separate threshold
  statement) is an `unanchored-threshold` finding with the plan, line, and
  matched text.
- **Missing verify** — in a planned, non-quick, not-yet-verified phase, a
  task line in `PLAN.md` with no `verify: <command>` clause is a
  `missing-verify` finding on that line. Criteria written after the work
  are chosen to fit what happened.
- **Missing approaches** — a planned, non-quick, not-yet-verified phase
  whose `CONTEXT.md` lacks the `## Approaches considered` block (two or
  more candidates plus a chosen line) is a `missing-approaches` finding,
  anchored on `CONTEXT.md`.
- Findings are sorted by plan path, then line, then type, then
  counterpart, then detail — never filesystem/readdir order — so two calls
  against an unchanged tree are byte-equal JSON.

### Audit record file shape

```
.cairn/audit/<scope>-<YYYY-MM-DD>.md
```

Frontmatter: `scope`, `verdict: pass|findings`, `created`. Body: one
`## finding — <severity>` block per finding (`critical`|`important`|
`minor`), the plain-language title on the next line, an `issue: <id>` line
when the finding was mirrored to the tracker, and an optional detail
paragraph. A `pass` verdict carries zero finding blocks — the file itself
is still the evidence the audit ran. `review` verbs write the same shape
under `scope: review-<target>` (target slugged to
`[a-z0-9]`-plus-hyphens first).

## Workspace (multi-project) and the dispatch board

Tier F1's full workspace awareness: a `cairn-workspace.json` at a workspace
root names member projects, and `resolveProjectDir()` is the ONE function
every existing tool's `deps.projectDir` now resolves through. **The
compatibility guarantee, stated plainly: with no `cairn-workspace.json`
anywhere above the launch dir, resolution returns the launch dir and
NOTHING changes — every single-project cairn project today behaves
byte-identically.** All 55 pre-F1 tools keep their exact names and
schemas; workspace awareness is additive, never a rewire.

### Discovery

`findWorkspace(launchDir)` walks parent directories from the server's
launch dir looking for `cairn-workspace.json`, stopping at the filesystem
root (`.git` is NOT required — discovery is workspace-file-only):

```jsonc
// cairn-workspace.json at the workspace root
{
  "workspace": "acme-platform",
  "members": [
    { "name": "api",   "path": "services/api" },
    { "name": "web",   "path": "apps/web" },
    { "name": "infra", "path": "infra" }
  ]
}
```

No workspace file anywhere up the tree → `findWorkspace` returns `null` —
the compatibility path. A workspace file that exists but is malformed (bad
JSON, missing `workspace`/`members`) is never silently treated as "no
workspace" — it throws `CONFIG_INVALID` naming the file, so a typo can't
quietly fall back to single-project behavior. Each member path resolves
relative to the workspace root; a member directory without its own
`cairn.json` is listed as `configured: false` (`unconfigured`) and refuses
focus with a pointed hint rather than failing silently.

### Focus file

`.cairn/basecamp/focus.json` at the **workspace root** (never per-member),
single-writer, atomic (tmp + rename):

```json
{ "focus": "api" }
```

No workspace → no focus file → resolution is the launch dir. A workspace
that exists but has no focus set *also* resolves to the launch dir — a
session opened inside `services/api` works on `api` until it explicitly
switches. `workspace_focus(project: null)` clears focus back to the launch
dir. A focus naming a member that has since been removed or lost its
`cairn.json` (a stale focus) throws `CONFIG_INVALID` rather than silently
falling back — clear it or restore the member.

### Resolution rules

`resolveProjectDir(launchDir)` is the single choke point:

1. No workspace found → `launchDir` (compatibility path).
2. Workspace found, no focus set → `launchDir`.
3. Workspace found, focus set to a member that is still a configured
   member → that member's absolute path.
4. Workspace found, focus set to a member that is no longer a member or no
   longer configured → `CONFIG_INVALID` naming the stale focus and the fix
   (never a silent fallback to the launch dir).

Per-project state that already keyed off the resolved directory (the
`getTracker()` cache, the handoff/banner path-hash) needed zero changes —
`getTracker()` became `getTracker(resolvedDir)` memoized per dir, and the
handoff/banner scheme already hashes `resolve(projectDir)`, so a focused
member's state lands under its own hash automatically.

### Concurrency caveat

Focus is workspace-global shared state, one file, single-writer, last write
wins — it is not scoped per session. In the #3256 parallel-dispatch
topology, several sessions run against the same workspace root at once, and
one session calling `workspace_focus` redirects every other session's
*subsequent* `resolveProjectDir()` calls to the new member, silently, with
no error and no signal to the sessions that just got moved. Each individual
tool call still resolves against a single, consistent snapshot of the focus
file taken at the start of that handler — a flip mid-call can never cause
one tool call to operate on two different members. But a multi-call flow
(claim a workstream, create an issue, update the board) spans several
handler invocations, and nothing above `resolveProjectDir()` re-checks that
focus still points where the flow expects between those calls. Callers
driving multi-call flows must re-confirm focus themselves before each write
— see the focus-discipline rule in `skills/cairn-trailhead/verbs/basecamp.md`.

### Board shapes

`.cairn/basecamp/board.json` at the workspace root — a single-writer,
`config_set`-style merge-patch board for parallel workstreams (the #3256
dispatch pattern), one level up from any one session's own continuity:

```jsonc
{
  "workstreams": {
    "<id>": {
      "title": "migrate api auth",
      "project": "api",              // member name
      "status": "queued|active|blocked|done",
      "issue": "GH-12",              // once claimed — the member-project issue
      "session": "…",                // free-text claim tag (who/where)
      "note": "…",                   // one-liner, latest state
      "updated": "YYYY-MM-DD"
    }
  }
}
```

| tool | purpose |
|---|---|
| `workspace_list` | Workspace name, root, members (name/path/configured/focusable), current focus. No workspace → `{ workspace: null }` — not an error |
| `workspace_focus` | Validates the target is a configured member, writes the focus file, returns the resolution (`{ focus, projectDir }`). `project: null` clears focus |
| `workspace_status` | Curated cross-project read: per configured member, `{ name, phase, openIssues, openSessions }` pulled from that member's own stores/tracker — read-only, never switches focus. A member whose tracker errors reports `{ name, error }` rather than failing the whole call |
| `board_get` | Deterministic read: workstream ids sorted, plus derived counts by status. Missing board file reads as an empty board with zeroed counts, never an error |
| `board_update` | Single-writer merge-patch by workstream id (`null` deletes); validates `status` enum, `project` names a real workspace member, and `title`+`project` are required on create — all before any write, so a rejected patch leaves the file untouched. Requires a workspace; no workspace → `PRECONDITION_FAILED` ("run basecamp init") |

## Peers (external AI CLI reviewers)

Tier F2's peer runner (`server/src/peers/run.ts`) shells out to four
allow-listed external AI CLIs — codex, opencode, antigravity, grok — as
a transport layer only. It moves bytes in and out of a child process; the
`peers` verb (`skills/cairn-trailhead/verbs/peers.md`) is what judges
whatever comes back. Nothing here is guaranteed installed — none of the
four are assumed present anywhere in the server.

### Templates (fixed argv, never a shell)

Each provider has exactly one argv template, a constant, never built from
user input; input reaches the CLI per its verified prompt convention. A
contained run (the default, below) adds the CLI's own sandbox flags where
it documents any:

| provider | argv | input | sandbox args (scratch runs) |
|---|---|---|---|
| `codex` | `codex exec --skip-git-repo-check -` | stdin (documented `-` convention); the flag keeps codex from refusing directories the host hasn't marked trusted, the scratch dir included | `--sandbox read-only` |
| `opencode` | `opencode run <input>` | argv — `run [message..]` is positional | none documented — scratch cwd only |
| `antigravity` | `agy -p <input>` | argv — the binary is `agy`; headless `-p` takes the prompt as its value and ignores piped stdin (verified live) | `--sandbox`, placed before `-p` |
| `grok` | `grok -p <input>` | argv — grok's headless mode does not consume piped stdin (verified live, formerly CRN-76 on the retired Jira tracker) | none documented — scratch cwd only |
| `copilot` | `copilot -s --no-ask-user --no-auto-update --no-color --no-custom-instructions --disable-builtin-mcps --disable-mcp-server cairn --max-ai-credits 30 --model <id> -p <input>` | argv — `-p` takes the prompt as its value, placed last; `-s` prints only the reply so the fence parser reads it (JSONL would escape the fences). `<id>` is `peers.copilot.model` or `gpt-6.1-sol`; a `claude-*` pin is refused at load. 30 is the CLI's credit floor (1.0.96 refuses less) | `--available-tools=view --allow-tool=view --disallow-temp-dir` — the last one is load-bearing: the scratch dir lives under the OS temp dir, and without it `view` reaches every sibling there |

Input is NEVER shell-interpolated — `execFile` takes an argv array and
resolves the binary via PATH itself; no shell ever parses any of it. For
the stdin-mode peer (codex) caller-supplied content goes in via stdin;
for argv-mode peers (grok, opencode, antigravity, copilot — their CLIs don't read
piped stdin) the capped input is the single final argv element, which is data
to `execFile`, not command line to a shell. The child-process surface is
exactly these five templates; there is no path from any tool argument to
a shell command string. The 200k default cap keeps argv-mode input well
under ARG_MAX.

### Labs, not seats (#341)

`peer_list` reports a `lab` per seat — who trained the model it speaks
for: codex `openai`, grok `xai`, antigravity `google`, copilot from its
pinned model id (`gpt-*` → openai, `gemini-*` → google; a `claude-*` pin
is refused at load), opencode `unknown` because it picks its model from
its own config. The peers verb's convergence bar is three DISTINCT labs
raising a claim, not three seats: Copilot on a gpt pin plus codex is one
lab speaking twice. Five seats, four labs.

### Containment (a scratch dir by default)

A peer never runs inside the project unless you've said it may. By
default (`cwdMode: "scratch"`) every child runs from a fresh scratch dir
under the OS temp dir (`cairn-peer-*`) with the capped input staged
beside it as `packet.txt`, so the screened packet is all a peer can see.
That default exists because a live council run showed a peer with the
project as its cwd reading repo internals its packet never carried,
straight around the leak gate (#74). The dir is torn down when the child
exits, on every path. Peer results still never depend on where the MCP
server process happens to be sitting (#56): the cwd is always the same
kind of place.

`cwdMode: "project"` is the explicit way back to the project dir,
unsandboxed, for a peer that has to run the product during a
functionality review. That is a trust grant, and the grant lives in
`cairn.json`, never in the call: `peer_run` refuses project mode with
`PRECONDITION_FAILED` unless the provider's entry says
`execCapable: true` (#268). Which review dimension earns the grant stays
the `peers` verb's call — this layer can't tell what a send is for.

Containment covers the child's own process too (#340). Every seat is
spawned with the server's environment minus tracker credentials: the
default token variable of each tracker adapter (`GITHUB_TOKEN`, `GH_TOKEN`,
`GITLAB_TOKEN`, `JIRA_API_TOKEN`, `ASANA_TOKEN`, `AZURE_DEVOPS_PAT`,
`CLICKUP_TOKEN`, `LINEAR_API_KEY`), whatever `tokenEnv` / `patEnv` /
`apiKeyEnv` your `cairn.json` actually names for the tracker and the docs
connector, and the two Copilot trust-widening variables
(`COPILOT_ALLOW_ALL`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`). A reviewer with
shell tools and no sandbox (grok, opencode) would otherwise hold a
write-capable tracker token, and Copilot would read an inherited
`GH_TOKEN` as its own login. A seat's own credential (`COPILOT_GITHUB_TOKEN`)
is kept. The list is `PEER_ENV_DROP` in `src/peers/run.ts`; a parity test
fails if an adapter declares a credential default the list lacks.

### Outbound leak scan

Before any scratch dir or child process exists, `peer_run` scans the
capped input — the exact bytes that would leave the machine — with the
server's port of the commit-time leak-pattern set
(`src/peers/leak-scan.ts`, held to the hook's set by a parity test):
planning paths, phase refs, cairn labels, a Jira project's issue ids,
and anything in `leakGuard.extraPatterns`. A hit throws
`PRECONDITION_FAILED` naming the pattern kinds and line numbers — never
the matched text, because the error travels back through the agent and
can land in a tracker comment — and nothing is sent. `leakGuard.enabled:
false` turns this scan off along with the commit guard; the
`leakGuard.allow` path globs don't apply, since the input is text, not a
file. It is not a secret scanner.

### Caps (`cairn.json` → `peers` block)

```jsonc
"peers": {
  "codex":       { "enabled": true, "maxInputChars": 200000, "execCapable": true },
  "antigravity": { "maxInputChars": 900000 }
  // absent provider = enabled, default cap, not execCapable; unknown provider names rejected
}
```

Default cap is 200,000 chars per provider (`#997`'s constrained-model
knob) — a provider not named in `cairn.json` still gets this default.
Input longer than the configured cap is head-truncated with a marker line
appended verbatim (`[cairn: input truncated at N chars]`) and
`truncatedInput: true` in the result — the marker text is part of the
contract callers can depend on, not cosmetic.

`execCapable` is false when absent and never probed at runtime: it's your
declared trust that this CLI may run from the project dir. Unknown fields
inside a provider's entry are dropped without a word, so a misspelled
`execCapable` leaves the peer contained rather than trusted.

### Degradation (missing/disabled peers never block)

- Provider not on PATH → `peer_list` reports `onPath: false` (a DETECTED
  state, not an error); `peer_run` against it throws `PRECONDITION_FAILED`
  naming the provider and an install hint.
- Provider disabled (`peers.<name>.enabled: false`) → `peer_run` throws
  `PRECONDITION_FAILED` before ever touching PATH.
- `cwdMode: "project"` for a provider not marked `execCapable` →
  `PRECONDITION_FAILED`, also before PATH, naming the setting that grants
  it.
- A leak-pattern hit in the capped input → `PRECONDITION_FAILED` before
  anything spawns or touches disk.
- Timeout (default 120s) → the child is `SIGKILL`ed and `peer_run` throws
  `PRECONDITION_FAILED` naming the provider and elapsed time.
- Zero peers detected is a normal `peer_list` result, not a warning — the
  `peers` verb proceeds without them rather than stalling.

### Exit-code taxonomy (the one thing every caller needs to get right)

- **Non-zero exit from the peer CLI itself is an advisory RESULT, not an
  error.** Peers are advisory; the `peers` verb is the judge. `peer_run`
  resolves normally with `{ exitCode, output, ... }` whatever that peer's
  process returned, stderr folded into `output` when present.
- **A spawn/precondition failure THROWS** (`CairnError`, code
  `PRECONDITION_FAILED`): missing binary (`ENOENT`), disabled provider,
  project mode for a peer not marked `execCapable`, a leak-pattern hit in
  the outgoing input, timeout kill, or any other errno the child never
  turned into a real exit code (`EACCES`, `EMFILE`, a `maxBuffer`
  overrun). The process never really ran in these cases, so there's no
  advisory output to return — it's a tool error, handled the same way
  every other cairn tool reports a precondition failure.

| tool | purpose |
|---|---|
| `peer_list` | Detection/config snapshot: `{ peers: [{ provider, onPath, enabled, maxInputChars, execCapable }], maxConcurrent }`. `maxConcurrent` is the fan-out budget — `peerFanout.maxConcurrent` when set, otherwise min(cores − 1, free memory ÷ 750MB, 8), never below 1. Never throws — an absent CLI is data, not an error |
| `peer_run` | Runs one provider with capped input (stdin or argv, per its template) and a timeout — contained in a scratch dir unless `cwdMode: "project"` is granted by `execCapable`, and leak-scanned before spawn; resolves with the real exit code and output on any completed run (including non-zero exit), throws `PRECONDITION_FAILED` only when the process itself never ran |

## Hooks

Dependency-free, fire-and-forget Node scripts, registered in
`hooks/hooks.json` and run out of `hooks/scripts/`. Every hook targets
<100ms and fails open — an internal error exits 0 rather than blocking work:

| # | event | matcher | script | purpose |
|---|---|---|---|---|
| 1 | `PostToolUse` | `Edit\|Write\|Bash` | `posttooluse-breadcrumb.mjs` | Refresh the session handoff, throttled to ≤1 write/60s (see Session continuity above) |
| 2 | `SessionStart` | — | `sessionstart-continuity.mjs` | Cat the handoff + recall banner; offer/auto-run/suppress resume per `continuity.resume` — `startup` and `clear` only; restored sessions get nothing |
| 3 | `PreToolUse` | `Bash` | `pretooluse-leakguard.mjs` | Leak guard — scan a staged `git commit`'s diff for cairn-internal refs before it lands |
| 4 | `PostToolUse` + `PostToolUseFailure` | `Edit\|Write\|Bash` | `posttooluse-observe.mjs` | Passive observation capture (tool, target, error flag) to `.cairn/observations/` — cairn projects only, capped, reviewed and cleared by `retro`, with its depth surfaced by `mem_stats` and the banner. A failed call never reaches `PostToolUse`; the `PostToolUseFailure` wiring is what makes the error flag real |
| 5 | `Stop` | — | `stop-costtracker.mjs` | Cumulative session cost snapshot (tokens + approximate $ + report bytes) tagged with the active phase/issue, to `~/.cairn/metrics/`; `cost-report.mjs` rolls it up |

### Leak guard (hook #3)

Fires only on `git commit` Bash calls (anything else exits 0 instantly).
Scans `git diff --cached -U0` ADDED lines against the pattern set in
`hooks/scripts/leak-patterns.mjs` — the single source both this hook and
`distill`'s sanitization gate scrub with:

- `.cairn/` path strings
- phase-dir refs (`phases/NN-slug`, `milestones/vN/`)
- cairn label strings (`cairn:seed`, `cairn:backlog`)
- the configured backend's issue-id pattern read from `cairn.json` (e.g.
  `PROJ-\d+` for Jira) — for GitHub, bare `#N` is deliberately NOT matched,
  since "fixes #123" is legitimate

Allowlisted paths (`.cairn/**`, `docs/**`, `*.md`, LEDGER/VERIFICATION
artifacts) are skipped. A hit exits 2 with a `file:line: [pattern] match`
listing on stderr, computed from the diff's hunk headers (accurate to the
real file line, not just diff-relative position) — the tool call is blocked
and the agent sees exactly what leaked and where.

**Escape hatches**, per spec §3:
- `cairn.json` → `leakGuard: { enabled: true, allow: [globs], extraPatterns:
  [regex] }`, editable via `/cairn:tune leakguard off|on`.
- One-shot override: prefix the command with `CAIRN_LEAK_OK=1 `. The
  override must *prefix* the command — `CAIRN_LEAK_OK=1` merely mentioned
  elsewhere (e.g. quoted inside the commit message) does not bypass the
  guard.

Accepted limitation (spec §Why): commits made outside Claude Code are
unguarded — a git-hook installer is a possible later `tune` offering, out of
scope here.

### Report bytes (hook #5)

Fan-out is not free: every subagent's report lands in the coordinator's
context and stays there. Hook #6 measures how much, so the question "is
compressing reports worth building" has a number behind it instead of a
hunch. It counts both shapes a report arrives in — the `tool_result`
answering a `Task`/`Agent` call, and the `<task-notification>` an async
agent's result comes back on — and records three cumulative fields per
session: `report_bytes`, `report_count` (injections), and `report_tasks`
(distinct subagents; an async fan-out produces both shapes but is one
subagent, deduped by the tool-use id the notification names).

The share is taken against `context_peak_tokens` — the largest single
request a session made — never against the token sums. With prompt caching
those sums count the same replayed prefix over and over: one real session
here totalled 957M cache-read tokens against a window that never passed
~1M, so a share against them means nothing.

`cost-report.mjs` renders a `task reports` block in the summary, a
`reports` object in `--json`, and a per-coordinator breakdown under
`--reports`.

## Running the live gates

Only `github` is live-green today — it's been run against a real sandbox
repo. The other five adapters are fully implemented and pass unit +
contract-fake but have not yet been run against live credentials; run their
gate below before relying on them in production.

### github

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITHUB_REPO="<you>/cairn-sandbox"   # a throwaway repo you own
gh auth status || gh auth login                        # or export GITHUB_TOKEN
cd server && npm run test:live
```

### gitlab

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_GITLAB_PROJECT="<you>/cairn-sandbox"  # a throwaway project you own
export GITLAB_TOKEN="<personal access token, api scope>"
cd server && npx vitest run test/gitlab.live.test.ts
```

### jira

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_JIRA_BASE_URL="https://your-domain.atlassian.net"
export CAIRN_TEST_JIRA_PROJECT_KEY="SAND"                # a throwaway project you own
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="<token from https://id.atlassian.com/manage-profile/security/api-tokens>"
cd server && npx vitest run test/jira.live.test.ts
```

Known risk: this adapter posts search queries to `POST /rest/api/3/search`,
which Atlassian has deprecated on Jira Cloud in favor of `/search/jql`.
Migrating the adapter is expected to be needed by the time this gate runs
live against a real Jira Cloud instance.

### asana

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_ASANA_PROJECT_GID="<numeric project gid>"  # a throwaway project you own
export ASANA_TOKEN="<personal access token>"
cd server && npx vitest run test/asana.live.test.ts
```

### azure-boards

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_AZURE_ORG_URL="https://dev.azure.com/your-org"
export CAIRN_TEST_AZURE_PROJECT="<throwaway project you own>"
export AZURE_DEVOPS_PAT="<PAT with Work Items (Read & Write) scope>"
cd server && npx vitest run test/azure-boards.live.test.ts
```

Known risk: the classificationnodes/iterations response-shape handling (both
the `{ value: [...] }` wrapper and the root-node `children` shape, plus
`\Iteration\`-path normalization) was hardened speculatively based on known
API variance, not against a live org. This live gate is the definitive check
that the parsing matches what a real Azure DevOps org actually returns.

### clickup

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_CLICKUP_DEFAULT_LIST="<throwaway list id>"
export CAIRN_TEST_CLICKUP_SPACE="<throwaway space id>"   # or CAIRN_TEST_CLICKUP_FOLDER
export CLICKUP_TOKEN="<personal API token>"
cd server && npx vitest run test/clickup.live.test.ts
```

### linear

```bash
export CAIRN_LIVE_TESTS=1
export CAIRN_TEST_LINEAR_TEAM="<throwaway team UUID>"
export LINEAR_API_KEY="<personal API key>"
cd server && npx vitest run test/linear.live.test.ts
```

Known risk: phase close writes a `projectUpdate` with the organization's
`completed` project-status id — that status lookup and write path was built
against the documented schema, not a live workspace. This live gate is the
definitive check.

Every suite creates issues/milestones (or the backend's phase equivalent)
prefixed `contract:` in the sandbox project. Clean up by closing them or
deleting the sandbox; the suite never touches anything it did not create.

## Rebuilding `dist/`

The `server/dist/` directory is committed to the repository so that marketplace installations (via git clone or tarball) can run the MCP server without requiring a build step. When you modify files in `server/src/`, you must rebuild and commit the updated `dist/` directory:

```bash
cd server && npm run build && git add dist && git commit -m "…"
```

Contributors should always rebuild `dist/` alongside source changes; a CI check for drift is planned as future work.
