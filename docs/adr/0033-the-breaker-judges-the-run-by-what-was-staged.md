# 0033 — The circuit breaker judges a batch run by what was staged with it: one session, one limit

Date: 2026-11-03. Status: accepted.

removeWhen: the harness gives a batch run a session identity of its own and a kill switch the run cannot reach, so the breaker no longer has to carry either.
derives: axiom 5 (owner's-ground); axiom 4 (recorded-run)

## Context

The breaker freezes a headless batch run after a number of guard
refusals and refuses the frozen run's pushes and closes. Two things it
read were wrong for the job. It attributed every refusal on the project
to the newest live run, so an interactive session working in the main
checkout beside a batch run could be refused three branch switches and
freeze a run it never touched — and then lose its own push rights as
"the run's session". And it read its limit from the project
configuration file on every refusal; that file is the agent's own
configuration surface, left unprotected on purpose so the owner can tune
it, so a run that kept being refused could write the limit to zero and
never freeze. A freeze authority the frozen party can disable is not one.

## Decision

Both facts are staged into the run manifest when the run is created,
where the runs folder is already a protected zone, and the hooks read
them from there and nowhere else.

The manifest records the run's session: the id the staging shell carried
(`CLAUDE_CODE_SESSION_ID`, present in the agent's shell on Claude Code
as of 2026-11-03 — a dated claim about the harness) and the resolved
staging folder. The breaker counts a refusal toward the run only when it
comes from that session; any other session's refusal is logged with no
run id and never counted; a manifest with no id yet counts nothing. The
frozen-session rule compares against the recorded id alone. Where the
staging shell had no id, the run guard stamps one from the first hook
event of a session whose working directory is exactly the run's
checkout — that folder, never one under it, so a sibling worktree never
becomes the run's (commit e1167e3).

The manifest also snapshots the configured breaker limit at staging as
`breakerLimit`, and the breaker reads it from there; the configuration
value is the owner's default for the next run, never the live one. A
manifest from before the field reads as the default (commit 8814916).
No new tool and no new guard row; one new parameter, paid for by a
shorter tool description so the resident footprint moved down, not up.

The server refuses a frozen run's state changes by the category the
requested state resolves to — in progress or closed — not by its
spelling, through an optional adapter question; today the local adapter
answers it (commit 9360ed4).

## Consequences

An interactive session is never frozen by a run it never touched, and a
running batch cannot switch its own breaker off by editing a file. Both
are asserted by hook tests that were red against the previous code: a
bystander's refusals leave the run running and that session pushing; a
mid-run change to the configured limit leaves the staged limit in force.

What stays open is stated. A run staged without an id belongs to the
first session seen in its exact checkout, which on a harness without a
session id lets the wrong session claim it (recorded as a residual). The
breaker judges the newest running manifest, and the tool that creates a
manifest is agent-callable, so a running batch can stage a second run
and move the count — the closing audit reproduced this and it is filed
(#466). The category question is unanswered by the four adapters that
accept custom state names, so on those backends the freeze still keys on
the literal name (#471). The staged session id is taken on trust from
the staging caller.
