# 0041 — The git layer is opt-in and carries no rule of its own

Date: 2026-11-04. Status: accepted.

removeWhen: the harness runs its hooks for every process that pushes from the checkout, or the service's ruleset can name the agent (ADR 0037), at which point a local pre-push hook adds nothing.
derives: axiom 5 (owner-ground); axiom 1 (tracker-truth)

## Context

The run guard sees a push only when it goes through the shell tool of a
harness that runs hooks. A human's own terminal, a harness wired for
skills but not hooks, and a script that shells out to git all push past
it, and the ship gate's stamp — the record that drift was checked before
the default branch moved — is never consulted. The phase 25.7 and 30
audits named this reach as a stated gap; the November reads asked for
the git layer as the backstop.

## Decision

`cairn-setup <harness> --git-hooks` installs a `pre-push` hook that
refuses an unshipped push to the default branch from any process in the
checkout. It is opt-in and never the default, because it writes
`core.hooksPath` into the repository's configuration, which is the
owner's ground, so the flag is the consent. The hook is a thin caller:
the effect comes from the shared effect table, the stamp and the
default-branch names from the shared hook library, the refusal text is
the run guard's own, and the same escape is honoured and said aloud on
stderr. An existing hooks path is respected, live hooks that would go
silent refuse the install in one line, a project's own pre-push survives
below the cairn markers, and the check flag reports whether git still
reaches the hook. The drift report measures the layer as a field, never
a flag, so it cannot dirty the ship gate (#456, range 6d12931..b66705a).
A remote ruleset is the only layer that survives a push made with hooks
disabled, and the runbook says so, dated.

## Consequences

Pushes from plain shells and hook-less harnesses meet the stamp rule for
the first time, at the cost of a git configuration write the owner must
ask for. Because the hook carries no rule of its own, a change to the
effect table reaches it with no second edit. The closing audit found the
shape of the cost: the script folder the hook runs from is not in the
harness guard's zones, so an agent edit there runs under the owner at
their next push; the install is a command an agent may run; a shared
hooks folder receives the hook for every repository on the machine; and
a force push onto a stamped commit passes, since the hook applies the
stamp rule and not the force rule (#492, #497, #503, #508). All four are
filed; the first is the next phase's critical.
