# 0008 — Budget enforcement at boundaries, with bounded overshoot

Date: 2026-09-04. Status: accepted.

removeWhen: the platform's in-run budget becomes a hard, cross-session spend ceiling that stops headless work at a clean checkpoint and reports what was spent, so the outer boundary ledger duplicates it.
derives: axiom 2 (mechanism-vs-judgment); axiom 4 (recorded-run)

## Context

A headless run needs a token/cost ceiling the user can trust, but agent
spend is only cleanly observable at turn and task boundaries — killing
work mid-flight to enforce a hard in-flight ceiling would tear worktrees,
strand half-done issues, and corrupt the tracker trail.

## Decision

Enforce at boundaries and say so. Actual spend (from the metrics history,
with correct per-session accounting) is re-read at every phase and wave
boundary; the verdict is binary — proceed or stop — and no new phase or
wave starts once spend meets the ceiling. In-flight work finishes. The
guarantee is stated identically everywhere it appears: overshoot is
bounded by at most one in-flight wave, and any overshoot is recorded in
the run's ledger rather than hidden. The platform's in-run budget, where
available, rides inside each wave as a second, inner ceiling.

## Consequences

The ceiling is honest instead of theatrical: users get a real bound with
a stated worst case, not a promise the observability can't back. Runs
never leave torn state behind for the sake of a tighter number. The
accepted cost — one wave of possible overshoot — is visible in the run
report next to the estimate that sized it, which is also what keeps the
estimator's feedback loop honest.
