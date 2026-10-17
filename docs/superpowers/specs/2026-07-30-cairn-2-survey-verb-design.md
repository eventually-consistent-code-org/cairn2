# Survey verb — project-wide research → discussion → roadmap apply

**Date:** 2026-07-30 · **Status:** approved

## Problem

`scout` researches exactly one phase. Nothing researches the project as a
whole — roadmap gaps, cross-phase unknowns, assumptions gone stale since
planning — and then reshapes the roadmap from what it learned. Today that
loop is manual: ad-hoc research, then hand-run `route` / `plan` calls.

## Approach (chosen)

Thin composition verb — `verbs/survey.md` sequences existing primitives
only: research fan-out (cairn-planning model routing) → project-level
`SURVEY.md` with scout's done/pending markers → batched discussion gate →
apply via route mechanics (`plan_scaffold_phase` decimal insert,
`plan_phase_ensure`, locked-decision CONTEXT.md edits, `issue_create` +
`plan_issues_set`). Zero server code, zero new MCP tools.

Rejected: server-backed `survey_*` session tools (state that markdown
markers already handle in scout — YAGNI) and `scout --project` (scout's
contract is `<N>` + research-only; survey's discuss-then-mutate lifecycle
is a different animal).

## Contract

```
/cairn:survey ["<topic>"]
```

- Bare: whole-project sweep — roadmap gaps, cross-phase unknowns, stale
  assumptions, ecosystem shifts since planning.
- With topic: one cross-cutting question steers the sweep.

Registry row (trailhead SKILL.md):

| verb | purpose | args | subroutine | status |
|---|---|---|---|---|
| `survey` | Project-wide research — findings, then discussed roadmap changes | `["<topic>"]` | verbs/survey.md | live |

## Stages

Three stages; hard gate between 2 and 3.

### 1. Research (resumable, multi-agent)

- Artifact: `.cairn/plans/SURVEY.md` (project level, next to roadmap.md).
- Section shape identical to scout: one `## <topic>` per research thread,
  `<!-- survey: done -->` / `<!-- survey: pending -->` marker on the line
  after the heading. No marker = legacy content, treat as done. Sections
  marked done are FINISHED — never re-researched.
- Topics derived from roadmap.md + phase CONTEXT.md unknowns + PROJECT.md
  goals, plus the user topic when given. New topics append as `pending`.
- Tracker mirror (tracker-first): `issue_create` one plain-language
  research issue at survey start; `issue_comment` progress in manager
  language; `issue_close` on wrap with a summary. No new server tools.
- **Fan-out is mandatory, not depth-gated** (see "Model routing" change
  below): each pending section dispatches ONE subagent; agents run in
  parallel; the model per agent is routed by the work class of the topic
  itself (enumerate/locate → haiku-tier, synthesis brief → sonnet-tier,
  architecture trade-off → opus-tier; uncertain → inherit).
- Kill-safety: subagents return section content only — the main thread
  writes the section and flips its marker as EACH agent completes. A kill
  mid-run loses at most the in-flight sections, never finished ones.

### 2. Discussion (the gate)

- Findings distill into concrete proposals, each one of: **new phase N.5**,
  **rescope phase N**, **new issues in phase N**, **no action**.
- One batched AskUserQuestion — multiSelect per proposal, cairn's
  recommendation stated first with trade-offs.
- Nothing mutates before this gate — ever, including vibe mode. Roadmap
  surgery from research is exactly the "would a peer have wanted a say"
  case.

### 3. Apply (approved proposals only)

- New phases: `plan_scaffold_phase` with decimal number (route's rule:
  never renumber) + `plan_phase_ensure` for the tracker object + roadmap.md
  row between neighbors.
- Rescopes: CONTEXT.md edits recorded as locked decisions with SURVEY.md
  source links (what changed and why).
- New work: `issue_create` + `plan_issues_set`, estimates per the plan
  verb's convention (points + minutes, always both).
- Wrap: `mem_index` the finished SURVEY.md, close the research issue with
  a plain summary, suggest `/cairn:plan <N>` for any new phase.

## Scout change (same amendment)

`verbs/scout.md` step 4 currently says "fan out per the model-routing
rubric" — vague. Rewrite to the explicit contract above: one subagent per
pending section, parallel dispatch, model per work class of the topic,
subagent returns content, main thread writes + flips marker per
completion. Scout's kill-safety rule (lose at most one section) is
unchanged and now mechanically guaranteed by the same write-on-completion
loop.

## New-project handoff (`new` verb change)

`verbs/new.md` step 6 currently reports next step `/cairn:plan 1`. It
changes to recommend `/cairn:survey` first: a fresh roadmap is exactly
when a whole-project sweep pays most — unknowns are at their peak and
nothing is planned yet, so findings reshape phases cheaply. Report line
becomes: next step `/cairn:survey` (project-wide research), then
`/cairn:plan 1`. Recommendation only — `new` never auto-runs survey.

## cairn-planning skill change

"Model routing (deep-mode fan-out)" section retitles to "Model routing
(research fan-out)": the rubric applies to ALL research fan-out — scout,
survey, and `plan --deep` — not only deep mode. Rubric table and blast
radius rules unchanged.

## Surfaces touched

| Surface | Change |
|---|---|
| skills/cairn-trailhead/SKILL.md | registry row |
| skills/cairn-trailhead/verbs/survey.md | new subroutine |
| skills/cairn-trailhead/verbs/scout.md | explicit multi-agent fan-out step |
| skills/cairn-trailhead/verbs/new.md | next-step handoff → survey, then plan 1 |
| skills/cairn-planning/SKILL.md | rubric scope reground + SURVEY.md artifact row |
| commands/survey.md | generated by `scripts/gen-commands.mjs` |
| CI | `check-surface.mjs` passes with regenerated shim |
| docs | README verb list, help renders from table automatically |

## Error handling

Inherits shared rules: typed server errors surface with next action;
tracker down never blocks the git-side research or SURVEY.md writes (the
mirror issue is created late/on-recovery in that case, noted to the user).
A subagent failure marks its section `pending` with a one-line failure
note — next run retries it.

## Testing

- Drill: survey on a fixture project — verify SURVEY.md markers, resume
  behavior (kill between sections → finished sections untouched), gate
  (no mutation before approval), apply (decimal insert, no renumber).
- `check-surface.mjs` green after shim regen.
- No server test changes (no server code changes).
