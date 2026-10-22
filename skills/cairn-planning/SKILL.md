---
name: cairn-planning
description: Use when a repo has cairn.json and the cairn MCP tools (plan_*, issue_*) are available — the cairn 2.0 planning lifecycle. Owns the depth dial (quick/standard/deep), the model-routing rubric for agent fan-out, artifact conventions under .cairn/plans/, and the precedence rule (git plan docs win over tracker issue text).
---

# cairn planning (lifecycle policy)

The server owns mechanism (scaffolding, frontmatter, mirroring, drift math).
This skill owns judgment: how deep to plan, which models to fan out, what goes
in which artifact, and what "verified" means.

## Activation gate

Apply when `cairn.json` exists in the repo AND the `plan_*` MCP tools are
available. The tracker named in `cairn.json` is the single source of truth for
work items; git owns plans and memory.

## Artifacts — what goes where

| File | Owns | Written by |
|---|---|---|
| PROJECT.md | vision, requirements | /cairn:new interview |
| roadmap.md | phase table + status | /cairn:new, updated at verify/ship |
| phases/NN/CONTEXT.md | locked decisions | planning discussion |
| phases/NN/RESEARCH.md | deep-mode research brief | research fan-out |
| SURVEY.md | project-wide research brief (survey markers) | /cairn:survey fan-out |
| phases/NN/PLAN.md | task breakdown + `issues:` frontmatter | /cairn:plan |
| phases/NN/VERIFICATION.md | goal-backward check results; its EXISTENCE marks the phase verified | /cairn:verify |

Frontmatter is the constrained flat form only (`key: value`, `key: [a, b]`).
Update `issues:` through `plan_issues_set`, not hand-editing, so validation runs.

## Depth dial

Resolution order: command flag > PLAN.md `depth:` frontmatter > `cairn.json`
default > `standard`.

| | quick | standard | deep |
|---|---|---|---|
| research | none | 1 research subagent | parallel fan-out, multi-angle |
| plan | draft tasks directly | PLAN.md + CONTEXT.md | + plan-checker agent pass + seat challenge round |
| verify | tests pass | + tracker cross-check (`plan_drift`) | + adversarial verification, VERIFICATION.md rigor |

At deep depth the plan column's challenge round joins the plan-checker
pass automatically: the roster's plan-stage seats convene over the draft
PLAN.md + CONTEXT.md and their challenges land as proposed amendments in
one batched question — advisory, never a gate. `plan <N> --challenge`
runs the same round at any depth; steps live in `verbs/plan.md`.

## MVP shaping (`plan --mvp`)

First tasks form ONE thin vertical slice exercising every layer end-to-end
(walking skeleton); depth and breadth come only after the slice stands.
A slice that can't demo is not a slice.

## TDD eligibility (`plan --tdd`)

Eligible: behavior-testable code — logic, APIs, parsers, state machines.
Not eligible: config, docs, scaffolding, pure styling, generated code.
Eligibility is per task, decided at plan time, stored in PLAN.md `tdd:`
frontmatter via `plan_meta_set`; work-time enforcement is the RED/GREEN
commit pair in the ledger, checked at verify.

## Model routing (research fan-out and work waves)

`cairn.json` → `agents.model`: `auto | inherit | haiku | sonnet | opus`.
`inherit` = session model everywhere; an explicit value pins everything,
absolutely — no annotation or rubric row overrides it; `auto` routes per
work class:

| work class | signals | routed model | effort |
|---|---|---|---|
| mechanical | enumerate/locate/scrape, regenerate, rename, a single-file change with a named test | `haiku` | low |
| routine synthesis | research briefs, pattern analysis, docs, a multi-file change along an existing pattern | `sonnet` | medium |
| complex synthesis | architecture trade-offs, a multi-file change that adds a mechanism or a seam | `opus` | high |
| judgment gates | plan-checker, adversarial verify, a spike verdict, anything whose output gates verify/ship | strongest available | high |

Every row names a tier, never "the session model": a session can run
above `opus` as easily as below it, so "session" is no tier at all.
Strongest available is, as of 2026-10, Fable, a tier above `opus` (a
claim about the platform's lineup — re-check it when the lineup moves).
Pass that model's id; when the session already runs it, omitting the
model inherits the same tier.

Blast radius rules: output that gates a lifecycle transition (verify/ship)
routes UP, never down — no `model:` annotation or seat preference takes
a judgment gate below the strongest tier. Downgrade only mechanical work:
`haiku` is the mechanical row's tier and no other's. Uncertain → inherit.

The effort column is the Agent tool's `effort` dial (Claude Code 2.1.292+),
passed on EVERY dispatch a verb makes — survey, scout, plan --deep, the
review seats, work --wave — alongside the routed model; a harness without
the dial ignores it. It moves with the work class, never with the model:
a judgment gate under a `sonnet` pin still runs at high. A headless run
records the dial it was staged under in its run manifest (`effort`), so
estimate-vs-actual can tell a cheap run from a thorough one.

Never set `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`. It pins every workflow
subagent to one model and flattens this rubric to a single row — the
routing above is the mechanism, the variable is its off switch.

The rubric governs ALL research fan-out — `scout`, `survey`, and
`plan --deep`, not only deep mode — and `work` wave dispatch. Research
verbs dispatch one subagent per pending topic, in parallel, classifying
each TOPIC by work class to pick its model; the main thread writes
results and flips markers as each agent completes. `work` classifies
each ISSUE the same way, after the pin and the task's PLAN.md `model:`
annotation have had their say, and prints the per-issue resolution in
its wave report (order and table in `verbs/work.md` step 2).

## Lifecycle

new → plan N → work N → verify N → ship. Each command's file defines its steps;
this skill's conventions bind them all:

- **Claim before work**: `issue_update(id, state: "in_progress")` +
  `context_set` before touching code for an issue.
- **Close only on verified done**: tests passing, behavior confirmed. Never
  close to make a gate pass.
- **Precedence**: on conflict between a phase's CONTEXT.md/PLAN.md and tracker
  issue text, the GIT DOC WINS — update the issue (`issue_update`) with a dated
  note; never silently follow the stale issue.
- **Drift is a stop signal**: `plan_drift` flags mean reconcile before
  proceeding (missing → recreate; closed-unverified → verify the phase or
  reopen the issue).
- **Assignee courtesy**: never claim an issue assigned to someone else without
  saying so.

## Failure honesty

Report gates truthfully: a failed verify is a failed verify. Never write
VERIFICATION.md for a phase that didn't pass — its existence is a machine-read
signal (drift treats closed issues in verified phases as normal).
