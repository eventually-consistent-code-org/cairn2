# 0020 — Durations are measured, never reported

Date: 2026-10-02. Status: accepted.

removeWhen: the harness hands the model trustworthy wall-clock timestamps per turn and self-reported durations land within measured error across a milestone. Even then the server's measurement is cheaper, so expect this to stay.
derives: axiom 4 (recorded-run)

## Context

Every closed task recorded how long it took, and that number came from
the agent. Checked against tracker timestamps, eight consecutive
self-reports ran six to fourteen times over; one claimed 128 minutes
against 10 measured. The instruction to compute the time from a recorded
start already existed and was ignored every time.

That makes it the wrong problem for prose to solve. Published work across
four model families finds duration estimates overshooting by four to
seven times, and explains why: a model has no introspective access to its
own elapsed generation time. Asking more firmly asks for something that
isn't available.

Three directions were weighed. Tightening the instruction costs nothing
and had already failed. Reading wall-clock bounds out of the session
transcript would give attended time, but the transcript has no
agent-independent start and end markers, and it ties the result to one
harness. Deriving the duration from timestamps the server already
controls is how every surveyed issue tracker computes cycle time.

## Decision

The server measures duration down a declared ladder and records which
rung produced the number:

1. the claim comment's tracker timestamp to the close;
2. the moment this server moved the issue to in progress;
3. the first author date to the last committer date across the task's
   commits, computed where the commit range is known;
4. none, recorded as such.

The rung travels with the number everywhere it is written. These are
different measurements of different spans, and pooling them unlabelled
makes up a signal that isn't there.

A claim comment is matched strictly, by a first line that opens with a
fixed phrase. The failure modes are asymmetric. A missed claim drops the
measurement one rung and stays honest. A false match, such as a progress
note that happens to say "starting now" mid-sentence, starts the clock
early and inflates the exact number this decision exists to correct. On
both of the first two rungs the earliest claim wins.

The caller's number survives as a claim, stored beside the measurement
and never in place of it. Worklogs receive the measured minutes.

## Consequences

Durations stop being invented, and the claimed-to-measured ratio becomes
a recorded fact about the reporter instead of being lost in an
overwrite. Any later calibration can filter on the rung instead of
guessing which records are comparable.

The ladder is uneven across backends. Where the adapter can't list
comments, closes measure from the server's own observation instead of
the tracker's. That number is still trustworthy, but it is local to the
machine that saw the claim. Adding comment enumeration to an adapter
moves it up a rung without any change here.

A measurement that can't be taken is written as none. Instrumentation
never fails a close, and a missing number never turns into a zero.
