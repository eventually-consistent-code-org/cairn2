# 0005 — Docs drift is computed detection; generation is the remedy

Date: 2026-09-01. Status: accepted.

removeWhen: never for detection — a deterministic staleness signal stays cheap and useful at any model strength. The ship-time generation step can go once the model keeps changelog and docs current unprompted, shown by a milestone where the drift report flags nothing with generation switched off.
derives: axiom 2 (mechanism-vs-judgment); axiom 4 (recorded-run)

## Context

Documentation drifted silently between releases: counts froze, shipped
features went unmentioned, and nothing noticed until a manual audit swept
the claims. The generation and publishing machinery already existed — what
was missing was any signal that docs lagged shipped work, and any trigger
that fired without a human remembering.

## Decision

Model docs staleness on the plan-drift precedent: a deterministic,
LLM-free server report (`docs_drift`) that checks, for every verified
phase (live or archived), whether the changelog and docs carry its entry
and whether the documentation has moved since the phase's last recorded
work. Detection is the primitive; synthesis is its remedy, wired tiered
into the lifecycle — report-only at verification, generate-and-commit at
ship behind the existing single confirmation, full synthesis with an
explicit publish offer at milestone completion. Generation failures are
advisory everywhere: they never block a verification result or a good
push.

## Consequences

Docs debt is now visible the moment a phase verifies, and the mechanical
catch-up happens at ship time by default. The semantic half — do prose
claims still match behavior — deliberately stays with the audit sweep;
the drift report triggers it rather than reimplementing judgment as code.
On its first production run the report flagged four already-archived
phases whose entries had never landed — pre-existing debt the old
workflow had no way to see.
