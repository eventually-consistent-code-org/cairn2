# 0011 — Signals pick the seats; yield evidence retires them; blast radius always wins

Date: 2026-09-11. Status: accepted.

removeWhen: running the full panel on every diff costs little enough in tokens and time that gating saves nothing worth the risk of muting a seat; then the dial stays at off and the yield gate can be retired.
derives: axiom 2 (mechanism-vs-judgment); axiom 4 (recorded-run)

## Context

A full panel on every diff wastes tokens on viewpoints with nothing to
say (a docs-only change does not need the security seat), but any
automatic gating mechanism risks two failure modes: silently muting a
seat that would have caught something, and letting a seat's cheap-model
preference quietly guard a lifecycle gate.

## Decision

Three-part dispatch. (1) Scope signals derived from the diff — a small
standard vocabulary of path-derived and size-derived names — select
which seats fire; a seat opts into gating by declaring signals, and a
seat declaring none always fires. The dial speaks auto | inherit | off,
with off (full panel) the default. (2) A persisted per-seat yield
statistic — dispatches, findings raised, findings surviving
verification — gates a seat only in the auto dial, only after ten or
more dispatches with under ten percent survival, and NEVER gates the
security seat or any full-dose seat. (3) The model-routing blast-radius
rule always beats a seat's model preference: output gating a lifecycle
transition routes to the strongest tier regardless, with the override
reported. Every gated seat is named in the report line; nothing is
silent.

## Consequences

- Cost scales with diff scope instead of roster size, off by default
  so nothing changes until a project opts in.
- Retirement requires evidence, not vibes — and structurally cannot
  touch the seats whose misses are unrecoverable.
- No cheap seat ever silently guards a gate.

Commits: 917f887 (dispatch, yield store, routing supremacy).
