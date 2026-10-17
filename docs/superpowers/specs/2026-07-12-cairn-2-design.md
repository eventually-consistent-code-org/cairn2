# Cairn 2.0 — Design Spec

**Date:** 2026-07-12
**Status:** Approved design, pre-implementation
**Author(s):** John Reed (with Claude)

## Outcome

Evolve cairn from thin prompt-glue over three third-party tools (GSD, beads,
context-mode) into a self-contained, published application: a Claude Code
plugin backed by a real MCP server. External work trackers become the single
source of truth for work items (beads removed), GSD-depth planning is rebuilt
on native Claude Code tooling, and context-mode's memory function is replaced
with a two-tier store engineered against context rot. Collaborative from v1:
teams work the same tracker + repo, and projects can start in either cairn or
the tracker and be picked up by the other.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Form factor | Claude Code plugin + TypeScript MCP server (one process) |
| 2 | Audience | Published product from day one |
| 3 | Trackers at v1 | Six: GitHub, GitLab, Jira, Asana, Azure Boards, ClickUp |
| 4 | Plan home | Repo markdown; tracker mirrors structure only |
| 5 | Planning depth | Configurable dial: quick / standard / deep |
| 6 | Memory | Two-tier: disposable search index + durable memory cards |
| 7 | Acceptance bar | Dogfood gate — cairn 2.0 plans/tracks/remembers its own build |
| 8 | Collaboration | Team-aware v1: assignee lifecycle, unplanned-work surfacing, tracker import |

## Architecture

```
┌────────────────────────── Claude Code ──────────────────────────┐
│  plugin layer (thin)                                            │
│  commands: /cairn:plan /work /verify /ship /status /recall …    │
│  skills:   lifecycle policy, depth selection, distill judgment  │
│  hooks:    SessionStart (active-project banner, staleness poke) │
└───────────────┬─────────────────────────────────────────────────┘
                │ typed MCP tools (no prose conventions)
┌───────────────▼──────────── cairn-server (TS, one process) ─────┐
│  tracker/    Tracker interface ── 6 adapters                    │
│  planning/   plan artifacts (.cairn/plans/) + tracker mirroring │
│  memory/     SQLite FTS index + memory cards (.cairn/memory/)   │
│  core/       config, auth (env-var names only), active-context  │
└───────────────┬─────────────────────────────────────────────────┘
                │
   tracker API (source of truth for work)  ·  git repo (source of
   truth for plans + memory cards)         ·  ~/.cairn/ (index db)
```

### Governing rules

- **Mechanism in server, policy in prompts.** Anything with a wrong answer
  (state transitions, mirroring, indexing, staleness math, drift detection)
  is typed, tested server code. Anything requiring judgment (plan depth,
  what deserves a memory card, interview quality) lives in skills.
- **Two sources of truth, never three.** The tracker owns work state. Git
  owns prose (plans, memory cards). The server's SQLite index is a
  rebuildable cache — losing it loses nothing durable.
- **`core/active-context`** is the shared spine: one component that knows
  current project → phase → issue. The tracker module writes it; planning
  and memory read it. This is what makes memory intent-aware without
  cross-module plumbing.
- **Auth model carried from cairn 1.x:** config stores environment-variable
  *names* only; secret values never touch disk. GitHub reuses `gh` CLI auth.
- **Repo layout:** monorepo — `server/` (TypeScript MCP server; adapters at
  `server/src/tracker/adapters/`), `plugin/` (commands, skills, hooks).

## Tracker module (source of truth)

Beads is removed, and with it the entire hub-and-spoke sync engine:
no last-writer-wins reconciliation, no `conflicts.json`, no `id-map.json`.
Reads hit the tracker; writes hit the tracker. The reconciliation bug class
(notes duplication, timestamp rot) is structurally eliminated.

### Normalized model

```ts
Issue      { id, title, body, state: open|in_progress|closed,
             labels[], phase?, assignee?, updated_at, url }
Phase      { id, name, number, state }        // milestone/epic/section/list
Capability { hasInProgress, hasPhases, hasDependencies, hasLabels }
```

### Capability matrix (declare, don't flatten)

Each adapter declares what its backend natively supports; core degrades
per-feature rather than sinking to the lowest common denominator.

| concept | GitHub | GitLab | Jira | Asana | Azure | ClickUp |
|---|---|---|---|---|---|---|
| phase → | milestone | milestone | epic | section | iteration | List |
| in_progress → | label | label | transition | section/label | state `Active` | status map |
| dependencies → | task-list refs | linked issues | issue links | native | links | native |
| labels → | labels | labels | labels | tags | tags | tags |

ClickUp specifics: hierarchy Workspace → Space → Folder → List → Task; phase
maps to a List inside a configured Space/Folder; statuses are custom per-list
with a type (`open`/`custom`/`done`/`closed`), so config carries a status map
like Jira/Azure (`"statuses": { "in_progress": "in progress", "closed":
"complete" }`); auth via personal token env var (`CLICKUP_TOKEN`);
`date_updated` (unix ms) normalized to ISO-8601.

### Behavior

- **Write-through, read-cached.** Writes go straight to the API and fail
  loud. Reads cache ~60s in the server so `/cairn:status` doesn't burn rate
  limits. The cache is disposable.
- **Offline = degraded honestly.** No offline write queue in v1 — commands
  report "tracker unreachable" and stop rather than fake local state.
- **Shared HTTP core:** one client with retry/backoff/rate-limit handling;
  adapters only map models ↔ endpoints.
- **Plan linkage:** plan frontmatter references tracker issue IDs directly
  (`issues: [PROJ-101, PROJ-102]`) — no local ID indirection.

### Contract tests — the v1 centerpiece

One spec (`tracker-contract.test.ts`) every adapter must pass:
- **CI:** recorded HTTP fixtures (fast, deterministic).
- **Pre-release:** live sandbox accounts per backend. An adapter is not
  "shipped" until live-green. This is what makes six-at-launch honest.

## Planning engine (GSD depth, native muscles)

### Artifacts (git-owned, `.cairn/plans/`)

```
PROJECT.md                # vision, requirements (interview output)
roadmap.md                # phase list + status
phases/NN-slug/
  CONTEXT.md              # locked decisions for the phase
  RESEARCH.md             # deep-mode research brief (optional)
  PLAN.md                 # tasks + frontmatter: issues: [PROJ-101, …]
  VERIFICATION.md         # goal-backward check results
```

The planning module owns the mechanism: scaffold files, validate
frontmatter, mirror structure to the tracker (phase → milestone/epic/list,
requirement → issue), compute drift (plan references a closed/deleted
issue → flag). Skills own the prose.

### Depth dial

Per-project default in `cairn.json`; per-command override (`--quick`,
`--deep`).

| | quick | standard | deep |
|---|---|---|---|
| research | none | 1 research subagent | parallel Agent/Workflow fan-out |
| plan | native plan mode only | PLAN.md + CONTEXT.md | + plan-checker agent pass |
| verify | tests pass | + tracker cross-check | + goal-backward VERIFICATION.md, eval gates |

### Model routing for agent fan-out

Deep-mode fan-out picks a model per subagent — smart by default, user
overridable:

- **Config:** `cairn.json` → `"agents": { "model": "auto" }`
  (`auto | inherit | haiku | sonnet | opus`). Per-project default;
  per-command override (`--model opus`). `inherit` disables routing
  (session model everywhere); an explicit model pins everything.
- **Auto rubric** (skill-owned judgment; config schema server-validated):

  | work class | signals | routed model |
  |---|---|---|
  | mechanical | enumerate/locate/scrape (file discovery, doc collection) | small/fast (haiku-tier) |
  | synthesis | research briefs, pattern analysis, standard planning | session model (sonnet-tier) |
  | judgment gates | plan-checker, adversarial verify, architecture trade-offs | strongest available (opus-tier) |

  Signals: task verb (list vs synthesize vs judge), scope size, novelty,
  and blast radius — output that gates a lifecycle transition
  (`verify`/`ship`) always routes up, never down. Bias rule: downgrade only
  mechanical work; when uncertain, inherit.

### Native tooling replaces GSD machinery

- Researcher/planner/checker agent zoo → native **Agent fan-out / Workflow**
  (deep mode).
- Planning interview → native **plan mode** sessions.
- In-session task tracking → native **TaskCreate/TaskList**, mirrored 1:1 to
  tracker issues for the active phase. Session tasks are the ephemeral view;
  the tracker is durable truth; status changes flow through server tools.
- verify-work → verification skill + server drift check.

### Lifecycle verbs

```
/cairn:new        interview → PROJECT.md + roadmap → mirror phases + issues
/cairn:plan N     research (per depth) → PLAN.md → mirror
/cairn:work N     issue → in_progress, execute, close on verified done
/cairn:verify N   goal-backward: codebase delivers phase promise + tracker clean
/cairn:ship       gate: zero open issues on completed phases → push/release
/cairn:import URL reverse-mirror an existing epic/milestone/list (see below)
/cairn:migrate    one-time cairn 1.x conversion (see below)
```

Precedence rule carried from 1.x: on conflict, git plan docs win over
tracker issue text — the tracker gets updated, not followed.

## Memory module (anti-rot machinery)

### Tier 1 — index (disposable bulk)

SQLite FTS at `~/.cairn/index/<project>.db` — outside the repo, a
rebuildable cache. Holds tool outputs, fetched docs, research dumps,
chunked and labeled with a typed scope (`project/phase/issue` — cairn 1.x's
label convention promoted to a real field). `mem_search` returns matched
sections only; raw bulk never enters context.

### Tier 2 — memory cards (durable knowledge)

`.cairn/memory/cards/*.md`, git-committed, one fact per card:

```markdown
---
type: decision | constraint | gotcha | reference
scope: { phase: 3, issue: PROJ-107 }
provenance:
  - { file: server/src/tracker/github.ts, commit: a1b2c3d }
created: 2026-07-12
---
Rate limiter must use secondary-limit headers, not just 403 —
GitHub returns 403 for both auth failure and abuse throttling.
```

### Anti-rot mechanisms

1. **Provenance + staleness check** (headline). On recall, the server checks
   each provenance entry: file changed since that commit? The card is served
   with a `STALE` flag plus what changed. Memory can be wrong; it can never
   silently lie. The skill re-verifies and updates or retires the card.
2. **Durable/disposable split** — bulk noise physically cannot crowd out
   decisions; different stores, different lifetimes.
3. **Scoped recall** — issue/phase scoping; search the task's memory, not
   the session's sludge.
4. **Distill-then-drop lifecycle** — at issue close and phase transition,
   the skill asks "what here deserves a card?", writes cards, and the old
   scope simply stops being searched. Compression by promotion, not
   summarization-of-summaries.
5. **Capacity guard** — index stats watched; over threshold → advise
   splitting the issue. Purge stays manual-only; tier 1 being rebuildable
   makes purge safe.

### Lifecycle wiring (via `core/active-context`)

issue claimed → scope set · during work → index bulk, stream ephemera ·
issue closed → distill prompt · phase transition → checkpoint + scope
switch · session start → hook surfaces cards whose provenance files changed
since last session ("3 cards may be stale").

## Collaboration & tracker-origin work

Work-state collaboration comes free from the tracker (assignees, statuses —
real multi-user tools already). Cairn adds:

1. **Unplanned-work surfacing.** The server compares tracker state against
   plan frontmatter on each read. Issues no plan references are flagged as
   unplanned work in `/cairn:status`; `/cairn:plan` offers adoption into a
   phase. Work created tracker-side enters the lifecycle instead of being
   one-off'd.
2. **Import — start in tracker, pick up in cairn.** `/cairn:import <URL>`
   reverse-mirrors an existing epic/milestone/list: pulls the structure and
   children, scaffolds `PROJECT.md`/roadmap/phase docs, maps existing issues
   into plan frontmatter, then runs a gap interview ("tracker says *what*,
   tell me *why*") to backfill CONTEXT.md.
3. **Assignee-aware lifecycle.** `/cairn:work` claims to *you*;
   `/cairn:status` shows who holds what; cairn will not claim a teammate's
   issue without saying so.
4. **Plans + memory cards collaborate via git** — PRs, reviews, merges; a
   teammate's gotcha card recalls for you with the same staleness checks.
5. **Multi-instance safe.** Multiple people (or agents) on the same
   tracker + repo: active-context is per-machine; work-state concurrency is
   the tracker's job; doc conflicts are git's job.

**Explicitly not "prose sync":** plan *documents* are never mirrored into
tracker description fields and edited in both places — document-level
two-way merge is out of scope permanently unless revisited post-v1.

## Cross-cutting

### Error handling

Fail loud, never fake state. Typed tool errors (`AUTH_MISSING`,
`RATE_LIMITED`, `NOT_FOUND`, `TRACKER_DOWN`) so skills give the user a next
action, not a stack trace. Adapter failures name the backend and operation.
One backend down never blocks git-side operations (plans/memory keep
working).

### Testing (three rings)

1. **Unit** — model mapping, frontmatter parsing, staleness math, drift
   detection (vitest).
2. **Contract** — the six-adapter suite: fixtures in CI, live sandboxes
   pre-release.
3. **Dogfood** — the acceptance bar: cairn 2.0 runs its own remaining
   phases; friction found = issues filed in cairn itself.

### Packaging & distribution

Monorepo, two artifacts: `@eventually-consistent/cairn-server` (npm — the
MCP server) and the marketplace plugin (bundles `.mcp.json` launching the
server via `npx`). Marketplace is the one supported install path; npm mirror
continues for stats. MIT license.

### Migration from cairn 1.x

`/cairn:migrate` — reads `.beads/` + `.planning/`, creates tracker issues
for open beads (closed history optional), converts GSD phase docs to
`.cairn/plans/` layout, prints what moved. GSD, beads, and context-mode are
no longer dependencies; cairn 2.0 is self-contained.

### Privacy

Same posture and PRIVACY.md rigor as 1.x: local-first, env-var-name-only
secrets, data goes only to the tracker you configured, opt-in install
beacon unchanged. New disclosure: memory cards are git-committed — anyone
with repo access reads them (a feature, but stated plainly).

## Build sequencing

Each phase gets its own spec → plan → build cycle; this document is the
umbrella.

| Phase | Deliverable |
|---|---|
| P0 | Server skeleton, plugin shell, config, active-context |
| P1 | Tracker core: contract + GitHub adapter live-green, then remaining five against the contract |
| P2 | Planning engine: artifacts, mirroring, depth dial, lifecycle verbs |
| P3 | Memory: index, cards, staleness, distill lifecycle |
| P4 | Collaboration: unplanned-work, import, assignee awareness |
| P5 | Dogfood gate → migrate cairn's own work into cairn 2.0 → polish → publish |

## Non-goals (v1)

- Offline write queue (quietly reinvents sync)
- Multiple trackers per project
- Web/desktop UI
- Two-way **prose** sync (documents merged across git ↔ tracker)
- Real-time webhooks (v1 polls on read; webhooks are a v2 candidate)

## Success criteria

1. Six adapters live-green on the contract suite.
2. Full lifecycle (`new → plan → work → verify → ship`) drivable against
   any configured backend.
3. `import` bootstraps a working cairn project from a pre-existing tracker
   epic.
4. Recall serves a stale card with an accurate `STALE` flag after the
   referenced file changes.
5. The dogfood gate: cairn 2.0's own P2–P5 development is planned, tracked,
   and remembered in cairn 2.0 itself, against a real tracker.
