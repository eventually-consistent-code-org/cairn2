# cairn 2.0

**Converged work management for AI coding agents** — one tool where deep
planning, durable memory, tracker truth, and session continuity meet in a
single deterministic engine. First-class as a Claude Code plugin; one-command
installers wire the same server and verbs into <!-- auto:harness-count -->seven<!-- /auto:harness-count --> other AI CLI harnesses
(<!-- auto:harness-list -->Grok Build, Copilot CLI, Codex, Gemini CLI, Cursor, OpenCode, Zed<!-- /auto:harness-list -->).

What makes it different — mechanism, not vocabulary:

| | |
|---|---|
| **Server-validated lifecycle** | Plan↔tracker drift is computed math, verify gates work goal-backward from the phase goal, and checkpoint markers are parsed by a real server — correctness is code, not prompt discipline. |
| **Tracker-first** | <!-- auto:trackers -->Eight write-through backends (GitHub, GitLab, Jira, Asana, Azure Boards, ClickUp, Linear, local files)<!-- /auto:trackers --> hold the single source of truth for work, mirrored in plain language a non-engineer can read. |
| **Cross-vendor adversarial review** | `peers` seats codex, grok, antigravity, and opencode as reviewers — and their claims are verified against source before they count. (Install the CLIs you want seated.) |
| **Memory with provenance** | Git-committed memory cards record their source commit; recall serves a `STALE` flag when the code moved — and the cards feed `plan`, `work`, and `verify`. |

> This repo is the cairn 2.0 rebuild; the earlier 1.x plugin lives in the
> [claude-plugins](https://github.com/eventually-consistent-code/claude-plugins)
> marketplace repo. Full docs index: **[docs/README.md](docs/README.md)**.

## What it is

Cairn 2.0 is a Claude Code plugin backed by a real TypeScript MCP server.
External work trackers are the single source of truth for work items, git
owns all prose (plans, memory cards), and the server owns every mechanism
with a wrong answer — state transitions, mirroring, drift math, staleness
checks — while skills own judgment. No prompt-glue, no sync engine, no
sidecar processes.

```
plugin (thin)     commands + skills + hooks — policy and judgment
      │ typed MCP tools
cairn-server      tracker/ · planning/ · memory/ · core/   (one process)
      │
tracker API (work truth) · git repo (prose truth) · ~/.cairn/ (disposable cache)
```

The full code relationship map — verb layer, MCP server, and the three
subsystems underneath (sources in [`docs/diagrams/`](docs/diagrams/)):

![cairn code relationships — verb layer to MCP server to tracker/memory/docs subsystems](docs/diagrams/cairn-code-map.png)

## Features (shipped — P0–P4)

**Tracker layer** — <!-- auto:tracker-count -->eight<!-- /auto:tracker-count --> adapters behind one normalized interface: GitHub,
GitLab, Jira, Asana, Azure Boards, ClickUp, Linear (native issue links +
dependency graph), and a zero-credential local backend that stores issues
as plain files in your repo (links and graph included). Capability matrix per backend
(declare, don't flatten), write-through with cached reads, shared HTTP core
with retry/backoff, and a single contract test suite every adapter must pass
— fixtures in CI, live sandboxes before release.

**Docs connectors** — publish repo documentation outward through the same
pluggable-adapter pattern: `/cairn:docs publish` mirrors README + `docs/`
into Confluence (per-project folder, landing page + child-page tree,
generated contents sections, space-wide title-conflict handling) or into a
local Docusaurus site checkout (markdown + `_category_.json`, native
sidebar, optional auto-commit — never push). Idempotent re-publish on both.
The SPI is product-neutral — <!-- auto:docs-connectors -->Confluence and Docusaurus<!-- /auto:docs-connectors --> ship today, and new
targets slot in behind the same contract suite on demand, not roadmapped
ahead of need.

**Planning engine** — GSD-depth planning on native Claude Code muscles.
Git-owned artifacts (`PROJECT.md`, `roadmap.md`, per-phase
`CONTEXT.md`/`RESEARCH.md`/`PLAN.md`/`VERIFICATION.md`), tracker mirroring
(phase → milestone/epic/list, requirement → issue), a quick/standard/deep
depth dial, model routing for agent fan-out, and drift detection when plans
reference missing or unverified-closed issues.

**Memory module** — two tiers engineered against context rot. Tier 1: a
disposable SQLite FTS5 index outside the repo (bulk tool output, research
dumps — searchable, rebuildable, never in context wholesale). Tier 2:
git-committed memory cards, one fact each, with **provenance + staleness
checking** — recall diffs each card's source files against the recorded
commit and serves a `STALE` flag when the code moved. Memory can be wrong;
it can never silently lie.

**Collaboration** — the tracker's multi-user machinery, made lifecycle-aware:
unplanned-work surfacing (tracker issues no plan references), `import`
(reverse-mirror an existing epic/milestone/list into a cairn project),
assignee-aware claiming, and plans/cards that collaborate through ordinary
git PRs.

<!-- auto:verbs -->**Verbs (39 live):** `audit` `auto` `backtrack` `basecamp` `brief` `distill`
`do` `docs` `draft` `fast` `help` `import` `map` `mark` `medic` `new`
`outlook` `peers` `plan` `probe` `profile` `recall` `remember` `resync`
`retro` `review` `route` `scout` `ship` `status` `summit` `survey` `thread`
`trace` `triage` `tune` `verify` `waypoint` `work`<!-- /auto:verbs --> — each a `/cairn:<verb>` command,
generated from the routing table.
The routing table is complete: the reserved verb set is now empty.

**Server:** <!-- auto:tool-count -->87<!-- /auto:tool-count --> typed MCP tools, <!-- auto:test-count -->1917<!-- /auto:test-count --> passing tests — counts move with each
tier and are measured in CI (env-gated live-backend
suites skip without creds) — <!-- auto:deps -->four dependencies
(`@modelcontextprotocol/client`, `@modelcontextprotocol/server`,
`better-sqlite3`, `zod`)<!-- /auto:deps -->. Fail loud, never
fake state.

**Agents (<!-- auto:agent-count -->2<!-- /auto:agent-count --> live):** the plugin's first `agents/` dir — specialist roles
dispatched by existing verbs, zero new tools or verbs.

| Agent | Role | Dispatched by |
|---|---|---|
| `cairn-designer` | Turns a design question into a decided direction with artifacts — wireframes, design tokens (`themes/default.css` + `tokens.json`, always both), coded prototypes — inside a `draft` session, recording `implements`/`decided-in` map edges as it goes | `draft` (non-trivial design questions) |
| `cairn-uat` | Proves shipped flows meet requirements, platform-aware — walks each flow as a user on a named viewport matrix, sweeps requirement traceability via map edges, hands fidelity divergence off to `audit ui` | `audit uat` (acceptance walks), `audit ui` (fidelity checks) |

## Beyond Claude Code

The server speaks plain MCP over stdio and the verbs are markdown — cairn
runs anywhere an MCP-capable harness does. One installer wires a project:

```bash
node setup/cairn-setup.mjs grok      # Grok Build — reads .mcp.json + AGENTS.md directly
node setup/cairn-setup.mjs copilot   # Copilot CLI — mcp-config.json, instructions, /cairn-* prompts
node setup/cairn-setup.mjs codex     # Codex — config.toml merged, ~/.codex/prompts/cairn-* installed
node setup/cairn-setup.mjs gemini    # Gemini CLI — settings.json + GEMINI.md + /cairn:* TOML commands
node setup/cairn-setup.mjs cursor    # Cursor — .cursor/mcp.json + AGENTS.md + hooks port
node setup/cairn-setup.mjs opencode  # OpenCode — opencode.json + /cairn-* commands
node setup/cairn-setup.mjs zed       # Zed — .zed/settings.json context server + AGENTS.md
```

Installs are stamped (`.cairn-manifest.json`: source version + date), and
`node setup/cairn-setup.mjs <harness> --check` compares every installed
surface against this clone's version — read-only, per-surface table,
non-zero exit when anything lags, so it can gate.

Every install gets the full <!-- auto:tool-count -->87<!-- /auto:tool-count -->-tool surface, the generated `AGENTS.md` verb
registry (from `scripts/gen-agents.mjs`, drift-checked in CI), and the verb
subroutines copied to `.cairn/harness/` so any harness can execute them by
name ("run cairn status"). Honest capability table:

| Harness | Tools (<!-- auto:tool-count -->87<!-- /auto:tool-count -->) | Verbs | Slash commands | Continuity/cost/observe hooks |
|---|---|---|---|---|
| Claude Code (plugin) | ✅ | ✅ | ✅ `/cairn:*` | ✅ |
| Grok Build | ✅ | ✅ by name | via its Claude-compat layer | untested — claims hook compat |
| Copilot CLI | ✅ | ✅ by name | ✅ `/cairn-*` prompt files | — |
| Codex | ✅ | ✅ by name | ✅ `/cairn-*` prompts | — |
| Gemini CLI | ✅ | ✅ by name | ✅ `/cairn:*` TOML commands | — |
| Cursor | ✅ | ✅ by name | — | ✅ continuity/leak-guard/observe (cost tracker Claude-only) |
| OpenCode | ✅ | ✅ by name | ✅ `/cairn-*` commands | — |
| Zed | ✅ | ✅ by name | — | — |

## How it compares

The nearest substitutes are GSD/Buildomator-class planning flows,
Superpowers, gstack, and claude-mem — file-based planning or memory layers
for a single harness. Cairn covers the same ground with a server holding the
mechanism and an external tracker holding work truth. Agent IDEs (Cursor,
Copilot Workspace, Devin) are adjacent but do a different job — they are the
coding environment; cairn is the work-management layer that rides along in
it.

The full mechanism-by-mechanism table — with a last-verified date on every
competitor claim — is maintained at [docs/comparison.md](docs/comparison.md).
The evidence behind the review claims lives in
[the council case study](docs/case-study-council.md).

## Roadmap

GSD-class planning depth behind a per-verb `/cairn:<verb>` surface with a
trail-themed vocabulary — plus tracker truth and provenance-checked memory
the file-based flows can't hold, and the highest-value ideas from GSD's
community backlog and a five-competitor gap
analysis. See the
[parity roadmap](docs/superpowers/specs/2026-07-15-cairn-2-parity-roadmap-design.md)
and [gap analysis](docs/superpowers/research/2026-07-15-competitor-gap-analysis.md).

| Stage | Scope | Status |
|---|---|---|
| P0–P4 | Server core: tracker, planning, memory, collaboration | ✅ shipped |
| Tier 0 | Trailhead — `/cairn` entrypoint + routing skill | ✅ shipped |
| Tier A0 | Continuity — crash-proof auto-resume + recall index/timeline | ✅ shipped |
| Tier A | Planning depth — `scout` `auto` `fast` `resync` `route` `summit`, TDD gates, stage-aware model routing | ✅ shipped |
| Tier B | `mark` `waypoint` `retro` `distill` `brief` `tune`, leak guard | ✅ shipped |
| Tier C1 | `trace` — persistent debugging sessions | ✅ shipped |
| Tier C2 | `probe` `draft` — spike/sketch sessions, `session_landscape` | ✅ shipped |
| Tier C3 | Audits & review governance — `audit` `review`, `plan_check`, `audit_record` | ✅ shipped |
| Tier D | `triage` — tracker-loop triage | ✅ shipped |
| Tier E | `map` `thread` `profile` `medic` `backtrack`, `audit docs`, `status --stats` | ✅ shipped |
| Tier F1 | `basecamp` — workspace awareness, focus switch, dispatch board | ✅ shipped |
| Tier F2 | `peers` — cross-AI review/plan convergence, adversarial judgment, outbound leak gate | ✅ shipped |
| Tier F3 | Frontend quality loop — `cairn-designer` + `cairn-uat` agents, design-token discipline, requirements traceability | ✅ shipped |
| P5′ | Dogfood gate → 1.x cutover → publish | ✅ shipped (`2.0.0` — live dogfood + community-marketplace submission) |
| P5″ | Per-verb surface — plugin `cairn`, 36 generated `/cairn:<verb>` shims, conformance check (f) | ✅ shipped (`2.0.0`) |
| Fidelity | Tracker-mirror fidelity — inbound PM-delta ingest (`plan_tracker_delta`), outbound paper trail + Jira worklog (classic and scoped `ATCTT` tokens both auth cleanly — scoped tokens auto-route through Atlassian's cloud gateway, #49) | ✅ shipped |
| Eng. mode | `user.mode` vibe/engineer — work pairing, no-self-merge gate, decision surfacing | ✅ shipped |

**P5′ status:** the seven transition shims are gone, P5″ replaced the
single `/cairn2:cairn` router with per-verb commands — the plugin is named
`cairn` and each live verb is a generated `/cairn:<verb>` shim
(`scripts/gen-commands.mjs`, enforced by check-surface) — and the
tracker-mirror fidelity + engineer-mode features are in (semi-live drill
records in VERIFICATION.md). Two gates remain, both owner actions:
(1) the **live dogfood pass** — a real session with the plugin installed,
running the Tier 0 drill (`/cairn:new → plan → work → verify → ship`,
`/cairn:do`, a typo'd verb, one waypoint resume) plus the fidelity and
engineer-mode checklists in VERIFICATION.md; (2) **publish** — swapping
cairn 1.x (and its `/cairn:gsd` passthrough) for cairn 2.0 in the plugin
marketplace. `2.0.0` follows both.

## Development

```bash
cd server
npm ci
npm test          # unit + contract (no network)
npm run test:live # live contract vs a real backend (env-gated)
npm run build
```

Adapter live-status, tool reference, and artifact layout:
[server/README.md](server/README.md). What the tests and guards
cannot check — what an agent actually does with a verb — lives in the
behavioral eval suite (`claude plugin eval .`, early access):
[docs/EVALS.md](docs/EVALS.md).

### Dev mode vs installed plugin (release integrity, #83)

Two ways to run cairn, deliberately different:

- **Installed (released).** The marketplace entry in
  `.claude-plugin/marketplace.json` is a **github source pinned to the
  release tag** (`"ref": "vX.Y.Z"`) — installs and `claude plugin update`
  fetch that released tree, never a mutable clone of `main`. The pin is the
  fourth surface `scripts/release.mjs` bumps, and
  `scripts/check-versions.mjs` fails CI when it disagrees with the version
  files. Consequence: an installed plugin only moves when a release tag
  exists — installed = released, by design.
- **Dev (this repo).** `.mcp.json` launches `server/dist/index.js` straight
  from the working tree with `server/node_modules` from `npm ci` — edits
  land on the next session restart, no release needed.

**Why a root lockfile, not a bundle.** Claude Code's plugin installer runs
`npm install` into the versioned plugin cache **only when the plugin root
has `package.json` plus a lockfile** — without one the cache gets no
`node_modules` and the MCP server dies at startup (`ERR_MODULE_NOT_FOUND`,
the 2026-08-13 incident). So the root `package.json` declares the server's
three runtime deps and `package-lock.json` pins them (~37 MB installed).
The bundle alternative was measured and rejected: esbuild collapses
`server/dist` (772 KB) to a single 881 KB file, but `better-sqlite3` is a
native addon (`better_sqlite3.node`, ~12 MB) that can't be inlined — npm
install is required either way, so bundling buys complexity, not
self-containment. If you add a server runtime dep, mirror it in the root
`package.json` and refresh the root lockfile
(`npm install --package-lock-only`) — CI enforces the mirror.

## Repository layout

```
server/     TypeScript MCP server (tracker adapters, planning, memory, core)
commands/   per-verb /cairn:<verb> shims — generated by scripts/gen-commands.mjs
skills/     cairn-planning, cairn-memory (policy; mechanism lives in the server)
templates/  cairn.json.example
docs/       specs, implementation plans, research — see docs/README.md
.mcp.json   launches cairn-server for the plugin
```

## Documentation

Everything is indexed at **[docs/README.md](docs/README.md)** — design specs
(umbrella design, parity roadmap, tier specs), per-phase implementation
plans, and competitive research.

## License

MIT — same posture as 1.x: local-first, env-var-name-only secrets, data goes
only to the tracker you configure.
