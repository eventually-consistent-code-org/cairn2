# Cairn 2.0 — Full-Parity Roadmap & Differentiation Design

**Date:** 2026-07-15
**Status:** Approved design — umbrella addendum to `2026-07-12-cairn-2-design.md`
**Author(s):** John Reed (with Claude)

## Outcome

Extend cairn 2.0 from its shipped core (P0–P3: tracker layer, planning engine,
memory module) to **full functional parity with GSD's ~60-command surface**,
while restructuring the command surface so cairn is structurally and verbally
distinct from GSD — one `/cairn` entrypoint with a trail-themed verb
vocabulary instead of a flat command flood. Fold in the highest-value ideas
from GSD's own community backlog (38 Ideas discussions evaluated,
benefit-vs-effort) so cairn ships things GSD users are asking for that GSD
doesn't have.

This supersedes the original spec's "thin depth-dial over command breadth"
scope stance and its P5 plan to remove the `/cairn:gsd` passthrough early —
the passthrough now survives until every tier below lands.

## Why (decision record)

- The original design deliberately kept cairn's surface thin. Reviewing GSD's
  `/gsd:help` showed ~54 commands across ~13 subsystems with no cairn
  equivalent; cutting the GSD passthrough at the old P5 point would have been
  a regression, not a cutover. Decision: **full parity is the goal** (owner
  call, 2026-07-15).
- GSD's community Ideas board was evaluated discussion-by-discussion via the
  GitHub API (38 total). Fourteen ideas fold into this roadmap (traceability
  table below); the board's top *structural* complaint (#3235: command
  flooding) directly motivates the entrypoint restructure.
- Differentiation requirement: cairn must not read as a `/gsd:*` reskin.
  Answer is structural (one entrypoint vs. sixty commands) plus verbal (trail
  vocabulary, not renamed GSD verbs).

## Section 1 — The Trailhead: one entrypoint, trail vocabulary

### Structure

**One command: `/cairn <verb> [args]`.** A single routing skill (the Oracle
`/db` pattern: one system-prompt entry, rich SKILL.md routing table,
subroutine files per verb) replaces the per-verb command files. Benefits:
lighter context footprint, one discoverable surface (`/cairn help`), and a
shape no one confuses with GSD's flat namespace.

- Existing verbs migrate: `plan work verify ship status init new import
  remember recall` (P2/P3/P4 surfaces) become subroutines.
- `/cairn do "<freeform text>"` is the smart router — natural under a single
  entrypoint (GSD needed `progress --do` bolted onto a status command).
- Old `/cairn:<verb>` forms keep working through the transition (thin shims),
  removed at the final cutover phase.

### Verb vocabulary (locked system; per-tier designs finalize flags)

| cairn verb | replaces (GSD) | theme rationale |
|---|---|---|
| `plan` `work` `verify` `ship` `status` | plan-phase / execute-phase / verify-work / ship / progress | generic verbs, already cairn's |
| `mark` | capture, add-todo, --note, --seed, --backlog | marking the trail |
| `waypoint` | pause-work, resume-work | checkpoint on the route |
| `trace` | debug | tracing steps back |
| `scout` | plan-phase --research-phase | scouting ahead |
| `probe` | spike | |
| `draft` | sketch | |
| `route` | phase --insert/--remove/--edit | re-routing the path |
| `summit` | complete-milestone (+ new-milestone flow) | |
| `retro` | (no GSD equivalent) | |
| `distill` | pr-branch, evolved (see #3519) | |
| `brief` | (no GSD equivalent; see #1219) | |
| `resync` | map-codebase as periodic resync | |
| `triage` | inbox | |
| `tune` | settings, config, surface | |
| `auto` | autonomous | |
| `fast` | fast | |
| `basecamp` | workspace, workstreams, manager | multi-project home |
| `do` | progress --do | |

Naming rule for future verbs: short, imperative, trail-flavored where natural,
never a hyphenated GSD name with the hyphen moved.

## Section 2 — Tier structure

Each tier is an independent spec → plan → build → review cycle (the process
that shipped P0–P3). Tiers are ordered by dependency and infrastructure
novelty. Community-idea traceability is inline as `(#NNNN)`.

### Tier 0 — Trailhead restructure

Single `/cairn` entrypoint + routing table + subroutine layout; migrate the
existing verbs; compatibility shims for old command forms; vocabulary locked
per Section 1. Must precede all other tiers — it defines the surface they
conform to.

### Tier A — Planning depth (extends P2's planning module)

1. Flag richness on `plan`/`work`: `--tdd` with enforced RED → GREEN →
   REFACTOR gates and per-task eligibility (design per #1872), `--mvp`
   vertical-slice mode, `--prd <file>` and `--ingest <adr-glob>` express
   paths, `--wave N` grouped parallel execution, `--gaps` re-planning.
2. `scout` — research-only mode with **resumable checkpointing**: parses
   partial RESEARCH.md on restart, researches only the gaps (#1961).
3. Milestone lifecycle: `summit` (complete/archive/tag + next-milestone
   interview), milestone summaries; `route` — insert (decimal phases),
   remove (renumber), edit.
4. `auto` — chained hands-off execution of all remaining phases once their
   contexts exist; explicit opt-in (#753 — highest-upvoted community idea).
5. `fast` — trivial inline changes, no artifacts, ≤3 file edits, atomic
   commit.
6. `resync` — codebase↔plan drift as a second axis on P2's drift engine:
   detect out-of-band code changes, refresh planning context (#944).
7. Design rule for every interactive flow in this tier and after: batch
   related questions; never one-checkbox-at-a-time friction (#1010).

### Tier B — Lightweight subsystems (reuse P2 artifacts + P3 memory substrate)

8. `mark` — zero-friction capture: frontmatter + 1–2 sentences, NO forced
   problem/solution structure at capture time; analysis happens at pickup
   (#1309). Subsumes notes, seeds (trigger-conditioned ideas), backlog.
9. `waypoint` — session continuity: pause handoff files, resume with context
   restoration.
10. `retro` — post-phase/milestone retrospective that writes **memory cards
    with provenance** (P3 substrate) so lessons are recalled by later
    sessions, not just written once (#1003). Subsumes GSD's
    extract-learnings.
11. `distill` — ship-time knowledge synthesis: planning artifacts + memory
    cards → `docs/` (ARCHITECTURE.md, ADRs, CHANGELOG entries), with link
    sanitization; evolution of GSD's filter-only pr-branch (#3519).
12. `brief` — onboarding briefing for people who weren't there during the
    build, synthesized from cards + plans (#1219).
13. `tune` — config UI over `cairn.json` (model profiles, workflow toggles,
    surface control).
14. Leak guard — pre-commit hook blocking tracker ids, phase references, and
    `.cairn/` paths from leaking into committed source/comments (#2221).

### Tier C — Stateful subsystems

15. `trace` — persistent debugging sessions surviving `/clear`
    (evidence → hypothesis → test), archived on resolution. **Checkpoint
    routing baked in from day one:** a failed `verify` or a user-reported
    issue at a checkpoint routes into `trace`'s structured flow — never an
    inline improvised fix (#726).
16. `probe` (spike: risk-ordered throwaway experiments with verdicts) and
    `draft` (sketch: multi-variant HTML mockups, shared theme system), each
    with wrap-up-to-skill packaging.
17. Audits & quality suite: cross-phase UAT audit, milestone audit,
    security/validation/UI/eval retro-audits, code review, test generation.
    Plan-checker upgrades fold in here: **cross-plan contract-drift
    detection** (producer/consumer I/O contracts require a shared fixture)
    and **unanchored-quantitative-threshold warnings** (#2891).

### Tier D — Tracker-adjacent

18. `triage` — open issue/PR triage against project templates, powered by
    P1's six tracker adapters. (Community asked GSD for exactly this
    tracker-loop integration in #907; cairn's P1 already built the
    foundation — positioning point, minimal new work.)

### Tier E — Knowledge & diagnostics

19. Knowledge: project knowledge graph (build/query/status/diff), persistent
    context threads, developer profile, project stats.
20. Diagnostics: planning-dir health/repair, workflow forensics, safe git
    undo by phase/plan manifest, docs-update verified against codebase.
    (extract-learnings is NOT rebuilt — merged into `retro`/`distill`.)

### Tier F — Frontier (largest scope, last)

21. `basecamp` — multi-project workspaces and parallel workstreams. Forces
    revisiting the single-project assumption in `active-context`,
    `cairn.json`, and every module: its own design phase. The
    dispatch-board pattern (N parallel sessions over ≥10 homogeneous heavy
    tasks, file-convention status tracking — production-validated in #3256)
    informs the workstream model.
22. Cross-AI integration: external-CLI peer review (gemini/codex/coderabbit/
    opencode/qwen/cursor), plan-review convergence loops, provider support
    incl. configurable context buffer for constrained models (#697, #997).
23. Frontend quality loop: UI/UX Designer agent (wireframes, design tokens,
    coded prototypes as first-class planning context) + UAT agent
    (autonomous platform-aware acceptance testing, design-fidelity
    validation, requirements traceability) per the detailed community
    proposal (#2290).

## Section 3 — Placement & sequencing

```
P4 (collaboration — already specced, unchanged)     ← next
Tier 0  Trailhead restructure                        ← sweeps all commands incl. P4's import
Tier A  Planning depth
Tier B  Lightweight subsystems
Tier C  Stateful subsystems
Tier D  Tracker-adjacent
Tier E  Knowledge & diagnostics
Tier F  Frontier
P5′     Dogfood gate + 1.x cutover + publish         ← moved to the very end
```

- P4 first: small, fully specced, and Tier 0's restructure is cheaper as one
  sweep over a complete surface than as a moving target.
- The `/cairn:gsd` passthrough (1.x) survives until P5′ — it is the parity
  safety net; removing it before its replacements exist is a regression.
- P5′'s dogfood gate gets materially stronger: cairn tracks 8+ real tiers of
  its own development through its own full-breadth engine before publish.

## Community-idea traceability

| # | Idea | Disposition |
|---|---|---|
| 753 | Hands-off chained phase execution (9👍) | Tier A `auto` |
| 3235 | Single command w/ subroutines (4👍) | Tier 0 (structural motivation) |
| 944 | map-codebase as periodic resync (4👍) | Tier A `resync` |
| 1010 | `--all` / batch question friction (5👍) | Design rule, Tier A+ |
| 1961 | Resumable checkpointed research (3👍) | Tier A `scout` |
| 1872 | Enforced TDD gates (2👍) | Tier A `--tdd` design |
| 1003 | Review + retro proposal (2👍) | Tier B `retro` (memory-card backed) |
| 3519 | Knowledge distillation on ship (2👍) | Tier B `distill` |
| 2221 | Planning-detail leak prevention (2👍) | Tier B leak guard |
| 1219 | Post-implementation onboarding (1👍) | Tier B `brief` |
| 1309 | Zero-friction capture (1👍) | Tier B `mark` design |
| 726 | Checkpoint-failure routing (2👍) | Tier C `trace` design |
| 2891 | Contract drift + unanchored thresholds (1👍) | Tier C plan-checker |
| 3256 | Multi-session dispatch board (1👍) | Tier F `basecamp` design input |
| 2290 | UAT + Designer agents (1👍) | Tier F frontend quality loop |
| 907 | Tracker integration ask (1👍) | Already shipped (P1) — positioning |
| 697/997 | Codex/DeepSeek provider support (3👍/1👍) | Tier F cross-AI |

Skipped as not applicable: #2518 (status-line segment — harness concern),
#711 (GSD-specific MCP reference swapping), #1198 (philosophical), #2428
(spam), plus low-signal integration one-liners.

## Non-goals

- Two-way prose sync (unchanged from the original spec).
- Rebuilding GSD's namespace-router meta-skills (`/gsd:context` etc.) —
  Tier 0's single entrypoint makes them structurally unnecessary.
- Verbatim GSD flag-for-flag compatibility: parity is *functional*, and the
  surface is cairn's own.

## Success criteria

1. Every GSD `/gsd:help` capability maps to a cairn verb/flag or a documented
   deliberate merge (e.g. extract-learnings → retro) — a parity matrix ships
   with P5′.
2. `/cairn` is the only top-level command; `/cairn help` renders the full
   verb reference; old forms shim until P5′.
3. The 14 folded community ideas each land in their stated tier and are
   traceable in that tier's spec.
4. P5′ dogfood: the remaining tiers of cairn's own development are planned,
   tracked, and remembered through cairn itself before publish.
