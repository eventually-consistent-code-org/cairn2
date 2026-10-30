# 0030 — A rate-limited peer seat is skipped and recorded, never a failed run

Date: 2026-10-29. Status: accepted.

removeWhen: every seated CLI exposes a typed, machine-readable usage-limit result (a distinct exit code or a structured error field) so no pattern over its wording is needed; or the harness meters peer quotas itself and tells cairn before dispatch.
derives: axiom 4 (recorded-run); axiom 3 (data-not-directive)

## Context

Running agents in parallel reaches usage limits faster. For the main
agent that is harness login state, out of cairn's reach, and the
project's position is that continuity — handoff, plans, tracker — lives
outside the vendor's configuration folder so a second login in the same
directory resumes. For the peer council the question was open: what the
run did when one external CLI answered with a quota error mid-run had
never been verified. A previous phase already made a failing CLI land as
an incomplete seat and let the run continue; what was missing was the
classification, the wording, the close, and the memory of when it
happened.

## Decision

Each provider's limit and quota shapes — a non-zero exit plus the
provider's own phrases, or a quoted limit code in a JSON error — are read
out of the installed CLI binaries and documented in the providers header
with the version observed and the date, as the third-party claim they
are. A match classifies to the typed `RATE_LIMITED` code. The run records
the seat as `skipped (rate limited)` with the next action and continues
with the seats that answered; a skipped seat never blocks the close. Zero
counted seats closes the run with verdict `no-quorum` and a plain reason,
never `pass`. The roster listing carries each seat's last limit time so
the owner sees how long ago before dispatching again. No retry loop lives
in cairn: the owner decides (commits a8444e3, 87060ad). No tool was added
and the footprint held.

## Consequences

One limited vendor no longer takes the council down, and a run that lost
every seat says so instead of passing on nothing.

The classification is a dated claim about five vendors' wording and will
expire; the header says what it rests on, and a test pins every phrase
the header names. One narrowing is filed from the phase's closing audit:
the marker cairn writes into a limited seat's record is matched as a
substring when no exit code was recorded, so a peer that merely quoted the
marker text in a clean answer would read as limited. The fix is to match
the refusal shape, not the phrase.
