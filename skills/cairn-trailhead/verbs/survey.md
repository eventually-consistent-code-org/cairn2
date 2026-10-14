---
verb: survey
args: "[\"<topic>\"]"
status: live
---

Project-wide research, then roadmap changes — but only through a discussion
gate. `scout` researches one phase; survey researches the terrain: roadmap
gaps, cross-phase unknowns, assumptions gone stale since planning. Three
stages; NOTHING mutates before stage 2's gate, in any mode.

## Stage 1 — research (resumable, multi-agent)

1. `plan_status()` — project must exist (else stop: suggest `/cairn:new`).
2. Artifact is `.cairn/plans/SURVEY.md` (project level, next to
   roadmap.md). Every run is an epoch: a `# Survey — <YYYY-MM-DD>` header
   opens each run's block, newest first — a new run prepends its block at
   the top; if the top block's date is today, resume it instead. One file,
   not per-run archives: dedupe has to read prior runs anyway, so keeping
   them in one file makes that (and `mem_index`) a single read. Prior
   runs' blocks are read-only history — never edit their sections or
   re-flip their markers.
3. Same marker discipline as scout: each `## <topic>` section carries
   `<!-- survey: done -->` or `<!-- survey: pending -->` on the line after
   the heading. `done` sections are FINISHED — never re-research. No
   marker = legacy content, treat as done. The `survey:` namespace stays;
   markers are server-validated via `research_sections` (a typo'd marker
   throws instead of silently reading as done).
4. Topics: derive from roadmap.md phase table + each phase's CONTEXT.md
   unknowns + PROJECT.md goals — plus the user's topic argument when
   given, and map diff drift (stored graph vs. current truth) when a map
   exists. Dedupe against prior runs BEFORE spawning agents: skip any topic
   a prior run already answered unless it's stale — stale = the repo HEAD
   has moved significantly since that run's date (many commits or a phase
   completed since; when in doubt, it's fresh — skip it). Surviving new
   topics get `pending` sections in the current run's block.
5. Tracker mirror: `issue_create` ONE plain-language research issue at
   start ("Project survey: <one-line scope>"); `issue_comment` progress in
   manager language as sections finish. If the tracker is down, continue
   git-side and create the issue when it recovers — say so.
6. Fan-out is mandatory (not depth-gated): dispatch ONE subagent per
   `pending` section, in parallel. Route each agent's model by the WORK
   CLASS OF THE TOPIC per the cairn-planning rubric — enumerate/locate →
   haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit — and pass the rubric's `effort` for
   that class (low/medium/high) on the same dispatch. Subagents return
   section content ONLY;
   the main thread writes the section and flips its marker as EACH agent
   completes. A failed agent's section stays `pending` with a one-line
   failure note — the next run retries it.

## Stage 2 — discussion (the gate)

7. Distill findings into typed proposals and run the gate exactly as
   specified in `references/proposal-gate.md` — the shapes, the ONE
   batched AskUserQuestion (holds in vibe mode too), all of it. Before
   distilling, read prior runs' Dispositions footers: never re-raise a
   rejected proposal without new evidence.

## Stage 3 — apply (approved proposals only)

8. Apply each approved proposal per the spec's apply mechanics (new
   phase / rescope / new issues), then write the **Dispositions** footer
   into this run's block — one line per proposal, every proposal, in the
   spec's line shape.
9. Wrap: read the finished SURVEY.md yourself and pass its text as
   `mem_index(content, source: its path)` — the tool indexes the string
   you hand it, it never opens the file — then close the research issue
   (`issue_close`) with a plain summary of findings and applied changes,
   report sections done/remaining, and suggest `/cairn:plan <N>` for any
   new phase.
