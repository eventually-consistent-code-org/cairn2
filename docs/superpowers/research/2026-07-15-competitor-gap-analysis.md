# Cairn 2.0 — Competitor Gap Analysis

**Date:** 2026-07-15
**Status:** Approved addendum to the 2026-07-15 parity roadmap — all 11 gaps
adopted; §5 is the prioritized integration plan (owner call, 2026-07-15)
**Author(s):** John Reed (with Claude)

**North star:** cairn is positioned to lead the *converged work management*
space — the one tool where planning depth (GSD-class), durable memory
(context-mode-class), tracker truth (P1), and session continuity meet in a
single deterministic engine. Every competitor surveyed owns at most one of
those quadrants; the adoption plan below closes the remaining gaps in the
other three.
**Scope:** Five competitors deep-dived (repos + issues + discussions): Superpowers,
gstack, Buildomator (GSD-side); claude-mem, headroom (context-mode-side). Findings
deduped against the 2026-07-12 design spec and the 2026-07-15 parity roadmap —
everything below is *not already covered* by those two docs, or materially
sharpens something that is.

---

## 1. Competitor profiles (one paragraph each)

**Superpowers** (obra/superpowers, ~255K stars, v6.0.3) — prompts all the way
down: ~14 SKILL.md files, one SessionStart hook, no DB/CLI/MCP. Pipeline:
brainstorming → worktrees → writing-plans → subagent-driven-development (fresh
implementer per task, two-verdict reviewer, fix loop) → TDD "Iron Law" →
finishing-a-branch. State = git-committed specs/plans + a git-ignored
`.superpowers/sdd/` scratch dir with an append-only `progress.md` ledger.
No memory layer, no tracker integration, no plan lifecycle status — its issue
tracker is a list of things cairn already has.

**gstack** (garrytan/gstack, ~122K stars) — role governance: 23 persona skills
(CEO/eng-manager/designer/QA/CSO...) forming a decision chain
(office-hours → plan reviews → implement → QA → ship → retro). One hard gate
(eng review), everything else advisory, all runs logged to a per-branch
reviews.jsonl backing a "Review Readiness Dashboard." State lives in git via
structured `WIP:` checkpoint commits (squashed at ship) plus
`learnings.jsonl` (confidence scores, file-reference staleness) and a taste
profile with 5%/week decay. Optional GBrain (Postgres/PGLite) knowledge base
over MCP.

**Buildomator** (buildomator/buildomator, formerly gsd-plugin, by Jasper
Nuyens) — GSD repackaged as a plugin: 82 thin skills delegating to lazily
loaded workflow bodies (`context: fork`), claimed ~92% per-turn token cut vs
CLAUDE.md-injected GSD. State stays file-based `.planning/`, fronted by a
zero-dep MCP server (resources for reads, narrow tools for writes). Headline:
crash-proof auto-resume — PreCompact hook writes a JSON-Schema-validated
`HANDOFF.json`, PostToolUse refreshes it (throttled ≤1/60s, survives
microcompact/usage caps/kills), SessionStart auto-invokes resume, handoff
deleted on success. NOTE: this is the `gsd` plugin installed in our own
environment — inspectable first-hand.

**claude-mem** (thedotmack/claude-mem, v13.11.0) — continuous LLM-observer
memory: hooks POST to a local Bun/Express worker that runs an observer model
compressing activity into typed observations (SQLite FTS5 + optional Chroma
sidecar). Injects a token-cost-annotated index at SessionStart; 3-layer MCP
retrieval (search → timeline → get-by-ID). Chronic reliability pain: Chroma
process leaks (48GB RAM incidents), Windows spawn hell, observer
poison/respawn loops, fabricated data, 1–2.4s synchronous hook latency,
volatile timestamps defeating prompt caching, self-healing behavior that
spooked users (trust complaint #3076). Commercializing via cmem.ai cloud sync.

**headroom** (headroomlabs-ai/headroom, ~59K stars) — compression proxy
between agent and provider: JSON crusher, AST-aware code compressor, prose
model, reversible compression with a `headroom_retrieve` tool, cache-aligned
"live-zone-only" compression. Different layer than cairn's memory — but its
discussions are a goldmine: unresolved ToS anxiety for subscription users
(proxying OAuth traffic), an arms race with Claude Code itself (custom
`ANTHROPIC_BASE_URL` now disables Remote Control), per-agent wrap treadmill,
and an explicit admission (#2170) that upstream *context selection* — which
content should enter the prompt at all — is not their layer. That layer is
cairn's memory module.

---

## 2. New feature candidates (not in the 2.0 spec or parity roadmap)

Ordered by value. Tier placement suggestions assume the parity-roadmap tiers.

### G1 — Crash-proof auto-resume loop (upgrade `waypoint`) · Tier B
The single biggest gap. Roadmap's `waypoint` is *manual* pause/resume;
three competitors independently converged on *automatic* session-survival:

- Buildomator: PreCompact → versioned `HANDOFF.json` (19-field JSON Schema) →
  SessionStart auto-resume → delete-on-success; PostToolUse throttled refresh
  (mtime, ≤1/min) so the handoff is never >60s stale on crash/usage-cap.
- Superpowers: append-only `progress.md` ledger with per-task commit ranges;
  doctrine "after compaction, trust the ledger and git log over your own
  recollection" — re-executing completed tasks is their "single most
  expensive failure observed." Users still beg for handoff commands (#931,
  RFC #1725).
- gstack: structured `WIP:` checkpoint commits with `[gstack-context]`
  trailers (decisions, remaining work, failed approaches), squash at ship —
  state in git itself, zero extra infra.

Cairn shape: server tool writes `.cairn/HANDOFF.json` (versioned schema,
schema-validated in CI); PreCompact + throttled PostToolUse hooks refresh it;
SessionStart hook detects and offers/auto-runs resume; delete on successful
resume. During `work`, maintain a per-phase progress ledger with commit
ranges (mechanism in server, so it can't be "forgotten" like Superpowers'
prompt-only ledger — their #463-class failures prove prompt-only enforcement
skips steps). Guard rails from Buildomator #17: never write handoffs outside
an initialized project, never clobber a rich handoff with an empty skeleton.

### G2 — Subagent I/O contract for deep-mode fan-out · Tier A (plan template) + deep mode
Superpowers' file-handoff discipline, formalized:
- Task briefs extracted to files — the subagent never reads the whole plan.
- Thin return contract: status enum `DONE | DONE_WITH_CONCERNS |
  NEEDS_CONTEXT | BLOCKED` + commits + one-line summary; full report goes to
  a file. Defined escalation ladder (more context → stronger model → split
  task → human).
- PLAN.md template gains a **Global Constraints** header (inherited by every
  task) and per-task **Interfaces (Consumes/Produces)** blocks — the
  mechanism that lets task-isolated subagents compose. Complements the
  planned contract-drift checker (#2891): the checker verifies what this
  template makes explicit.
- Review packages diffed from a recorded BASE (never `HEAD~1`).

### G3 — Token-cost-annotated recall index + timeline layer · Tier B/P3 extension
claude-mem's two genuinely good ideas, minus its architecture:
- SessionStart injects a cheap *index* of relevant memory cards (id, type
  icon, title, **per-card token cost**) with progressive-disclosure
  instructions — not card bodies. Model fetches what it needs.
- New `mem_timeline` tool: chronological context *around* a search hit
  (what happened before/after that decision). Rare, useful, trivial on our
  SQLite store.
- Track `tokens_saved_vs_naive` in stats — observable value is the retention
  driver (headroom's community demanded savings dashboards; claude-mem's
  disputed claims show why the numbers must be honest).

### G4 — Review governance: readiness dashboard + one hard gate + two-verdict reviews · Tier C
Sharpen the planned audits/quality suite with two proven patterns:
- gstack: every review run logs to a per-branch record; a readiness dashboard
  renders at review end; **exactly one hard gate** (configurable), the rest
  advisory. Legible governance beats all-or-nothing.
- Superpowers: reviewer must return **two separate verdicts** — spec
  compliance AND code quality — because "code is fine" hides "built the
  wrong thing."
- gstack's "boil the ocean" heuristic as a review check: flag 80%
  implementations where the complete version costs <30 min.
- Community counterweight (Superpowers #1120, 12👍): review overhead on small
  tasks is a real complaint — gate strictness must scale with task size.

### G5 — Auto-resolve principles + batched taste gate for `auto` · Tier A sharpening
gstack `/autoplan`: unattended runs resolve decisions against six encoded
principles (prefer completeness, match existing patterns, choose reversible
options, mirror user's past choices, defer ambiguity, escalate security);
genuinely subjective "taste decisions" accumulate into ONE final approval
batch. Roadmap's `auto` (#753) says "hands-off" but doesn't specify the
decision policy — adopt this shape. Also Buildomator's severity-based gap
auto-routing (goal-breaking → follow-up phase; minor → backlog) for `--gaps`.

### G6 — Confidence + decay on memory cards; taste profile · Tier B/E
gstack's `learnings.jsonl`: each entry carries a confidence score and prunes
when referenced files are deleted. Cairn cards have provenance staleness
(stronger) but no confidence dimension — add optional `confidence` frontmatter
that recall surfaces and `retro` adjusts. Separately: a per-project taste
profile learned from approve/reject events with time decay (gstack uses
5%/week) would feed `draft` (sketch variants) and plan-review defaults.

### G7 — Cache-stability rule for all injected context · cross-cutting, cheap, do now
claude-mem #2872: minute-granularity timestamps in SessionStart injection
defeat Anthropic prompt caching every session. headroom's whole CacheAligner
exists because of this class of bug. Cairn rule: SessionStart banner and any
recurring injected block must be byte-stable across turns — no volatile
timestamps, no reordered lists; date-granularity only, stable sort keys.

### G8 — Edge privacy: `<private>` stripping · P3 polish
claude-mem strips `<private>...</private>` spans at the hook edge before
anything is stored (with a tag cap for ReDoS safety). One afternoon of work,
meaningful for the PRIVACY.md story: nothing marked private ever reaches the
index, cards, or tracker.

### G9 — CI drift ratchets (internal dev practice)
Buildomator's answer to shipping a plugin whose pieces drift: committed
baselines + hard-fail-on-regression CI for (a) dangling file references from
skills, (b) hook-output schema validation (HANDOFF.json), (c) command
namespace form. Their launch bug #1 (68/82 skills referencing missing files)
is exactly the class this catches. gstack's variant: SKILL.md generated from
templates so docs can't drift from code. Adopt for cairn's own repo.

### G11 — Stage-aware model routing (second axis on P2 routing) · Tier A + `tune`
The shipped spec routes by *work class* within a fan-out (mechanical /
synthesis / judgment). Add a *lifecycle stage* axis: research and planning
run premium models (fable/opus-tier), build fans out on economical models
(sonnet/haiku-tier), verify/review/ship route back up. Owner call
(2026-07-15): **never automatic by default** — two modes:

- `manual` (default): cairn uses only explicitly configured stage models
  (`cairn.json` → `models.stages.{research,plan,work,verify,review}`) or
  per-command `--model`; unset stages inherit the session model.
- `auto` (opt-in): the rubric fills unset stages.

Resolution: `(stage, work-class) → model`, stage sets the baseline,
work-class routes within it; the existing blast-radius rule is unchanged
(lifecycle-gating output routes up, never down — even inside `work`).
Model ids are strings with tier aliases (`premium`/`standard`/`fast`), not a
hardcoded enum — fable and future models must not require a plugin update.
Constraint stated honestly: cairn controls *subagent* models only; main-loop
switches surface as an advisory at stage transitions ("/model opus
recommended for verify"). Superpowers' written policy validates the shape
and contributes the rubric caveat: "turn count beats token price" — a
too-cheap model can cost more by taking 2–3× the turns, so reviewers get a
mid-tier floor. Placement: schema + resolution in Tier A (extends P2
routing); interactive config surface in Tier B `tune`.

### G10 — Composition & trust docs (positioning, near-zero code)
- headroom #767 (7👍, unanswered): "what do I do with rtk, caveman, serena,
  context-mode and beads together?" Nobody documents how context tools
  compose. Ship a short "cairn alongside X" doc — instant differentiation.
- Trust story: headroom's biggest recurring discussion theme is ToS anxiety
  (proxying subscription OAuth traffic, #969/#867/#1814) and Anthropic
  actively degrading proxy setups (#1734). claude-mem's worst trust moment
  was self-healing re-enable (#3076). Cairn is hooks/MCP-native, local-first,
  no interception, no self-persistence — say so explicitly.
- Superpowers #429 (113👍 — their biggest ask): rebuild orchestration on
  native Agent-Teams primitives. Cairn's deep mode already rides native
  Agent/Workflow; keep `basecamp` on native primitives and advertise it.

---

## 3. Anti-patterns confirmed (what NOT to build)

1. **LLM-observer-per-tool-call memory** (claude-mem): poison/respawn loops,
   fabricated commit hashes, per-call cost. Cairn's deterministic
   index + judgment-at-distill-time is the right split.
2. **Runtime sidecars** (claude-mem's Chroma/uv/Bun): process leaks measured
   in tens of GB, Windows spawn hell. Keep cairn zero-sidecar (better-sqlite3
   in-process).
3. **Synchronous hooks on the hot path** (claude-mem #3206/#3209: 1–2.4s per
   tool call). Any cairn hook must be fire-and-forget or <100ms.
4. **Proxy-level interception** (headroom): arms race with the harness,
   unresolvable ToS questions. Never route provider traffic.
5. **Prompt-only workflow enforcement** (Superpowers #463, #1701, #1888):
   steps get skipped, scratch state collides and rots. Cairn's
   mechanism-in-server rule already answers this — hold the line.
6. **Per-agent wrap/host treadmill** (headroom + gstack + Superpowers issue
   volume): multi-harness support is the #1 maintenance tax everywhere.
   Claude-Code-first is a feature.
7. **State keyed on fragile naming conventions** (gstack #1851: branch-slug
   mismatch breaks recovery). Key state on stable IDs, not derived names.

## 4. Coverage confirmations (already ours, validated by demand elsewhere)

- Tracker integration: Superpowers has none; GSD community asked (#907);
  gstack round-trips GitHub issues. Cairn's P1 six-adapter layer is ahead of
  every framework surveyed.
- Memory: Superpowers users beg for it (#601, RFC #1812); claude-mem users
  ask for project-dir storage (#3097), team-shared memory (D#2421), machine
  migration (D#3051), curation (D#3115) — cairn's git-committed,
  repo-scoped, PR-reviewable cards answer all four by construction.
- Plan lifecycle status (Superpowers #1075): cairn's tracker mirroring +
  roadmap state is the answer.
- ADRs as artifacts (Superpowers #754): covered by `distill`.
- Roadmap layer above single plans (Superpowers #1192): cairn phases +
  `summit` + `basecamp`.
- Token overhead complaints (Superpowers #743 et al.): Tier 0 single
  entrypoint + Buildomator-style thin-skill delegation validate the design.

## 5. Prioritized integration plan (amends parity-roadmap sequencing)

All 10 gaps are adopted. The top 4 (G1–G4) are **headline features**, and the
tier sequence changes to pull the two that don't depend on Tier A forward.

### Priority 0 — immediate, before Tier 0 ships
- **G7 cache-stability rule** — design rule binding on every tier: injected
  context (SessionStart banner, recall index) must be byte-stable across
  turns. Enforced by a unit test on banner/index rendering.
- **G9 CI drift ratchets** — committed baselines, hard-fail on regression:
  dangling skill file references, HANDOFF/hook-output schema validation,
  command namespace form. Protects everything built after it.

### Priority 1 — the top 4 (headline features)

| Gap | Placement | Why headline |
|---|---|---|
| **G1 crash-proof auto-resume** | **New Tier A0 "Continuity" — immediately after Tier 0**, absorbing `waypoint` from Tier B | Three competitors converged on it independently; no dependency on Tier A; the loudest unmet demand on Superpowers' board (#931, #1725) |
| **G3 recall index + timeline** | **Tier A0**, same tier — both are session-continuity surface on shipped P3 substrate | Cheap on our SQLite; makes memory visibly valuable every session start |
| **G2 subagent I/O contract** | Tier A — PLAN.md template (Global Constraints, Consumes/Produces) + deep-mode execution rules (briefs-as-files, status enum, escalation ladder, recorded-BASE diffs) | Makes deep-mode fan-out composable and reviewable; complements #2891 checker |
| **G4 review governance** | Tier C audits suite — run log + readiness dashboard, exactly one configurable hard gate, two-verdict reviews, gate strictness scaled to task size | Legible governance is gstack's entire pitch; we get it as one feature |

Revised sequence:

```
P4 → Tier 0 (Trailhead) → Tier A0 (Continuity: G1 + G3, absorbs waypoint)
   → Tier A (Planning depth + G2, G5) → Tier B (lightweight subsystems + G6, G8)
   → Tier C (stateful + G4) → Tier D → Tier E → Tier F → P5′ (+ G10)
```

### Priority 2 — folded into host tiers
- **G11 stage-aware model routing** → Tier A (config schema + resolution,
  extends P2's work-class routing) + Tier B `tune` (interactive surface).
  Manual by default; `auto` is opt-in.
- **G5 auto-resolve principles + batched taste gate** → Tier A `auto` spec;
  severity-based gap auto-routing → `--gaps`.
- **G6 confidence scores on cards + taste profile w/ decay** → Tier B
  (`retro` adjusts confidence) and Tier C (`draft` consumes taste profile).
- **G8 `<private>` tag stripping** → Tier B alongside the leak guard
  (both are "nothing sensitive escapes" features).

### Priority 3 — publish material
- **G10 composition & trust docs** → P5′: "cairn alongside X" composition
  guide, hooks/MCP-native trust story, native-primitives orchestration
  positioning. Zero code, high differentiation at launch.

### Success criteria added by this addendum
1. Kill a session mid-`work` (or hit a compaction); next session resumes to
   the exact task with zero re-executed work — demoed in P5′ dogfood.
2. Session start injects a recall index whose rendered bytes are identical
   across two consecutive sessions with unchanged memory (cache-stable).
3. A deep-mode plan executes with every subagent seeing only its brief, and
   the run is reconstructable from report files alone.
4. Review dashboard renders for a full phase with exactly one hard gate
   firing; parity matrix at P5′ maps all 11 gaps to shipped features.
5. A phase run with stage routing configured shows premium models on
   plan/verify and economical models on `work` fan-out, verifiable from run
   logs; with `models.mode: manual` and nothing configured, every agent
   inherits the session model (cairn never picks silently).
