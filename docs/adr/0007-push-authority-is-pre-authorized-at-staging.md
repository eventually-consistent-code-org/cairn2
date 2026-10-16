# 0007 — Push authority is pre-authorized at staging, never assumed

Date: 2026-09-04. Status: accepted.

removeWhen: never — the push confirmation is an owner-decided policy gate, not a workaround for a model limit. A more capable agent does not change who decides what leaves the machine.
derives: axiom 5 (owner-ground)

## Context

The ship step's push confirmation is a council-adopted, owner-decided
gate (ADR-era provenance: 2026-08-12 product council, accepted over the
tool's own no-action recommendation) — explicitly exempt from silent
judgment. Headless batch execution wants to ship without a human present,
which collides head-on with that gate.

## Decision

Move the confirmation, don't remove it. The staging interview — before
the user walks away — asks for push authorization explicitly, quoting the
original provenance, scope-limited to exactly the phases in the approved
run manifest. The manifest records the grant; authorization starts false
and can only be granted while the run is still staged; the executor
restates the provenance in every push summary. Declining is a first-class
path: the run still executes headless, phases end verified-not-pushed,
and pushes wait for an interactive ship.

## Consequences

Headless shipping exists without weakening the gate: a human still
explicitly authorizes every push, just at run start instead of mid-run.
The costs are accepted: authorization is coarser (per-run, not per-push),
which the scope limit and the run report's push accounting compensate;
and a run can never push anything the user didn't see in the staging
list, by construction.
