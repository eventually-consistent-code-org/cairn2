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

**Pauses (#380, 2026-11).** A usage-limit wait inside the span is dead
time, not work: up to five hours, longer when the machine slept across
the reset, and until now the first two rungs ate it and the worklog said
the task took that long. The pause recorder (the notification hook, #379)
appends one row per platform event to the machine's pauses log, per
repository. At close the server reads the rows back and forms windows: a
`rate_limit` stop opens one, the next `quota_auto_resume_fired` closes it;
a wait that went stale or disabled, or whose resume was never recorded,
closes at that session's next recorded event or at the close itself.
Overlapping windows from several sessions are one wait. The minutes inside
the span come off the measurement, and the receipt, the close comment and
the ledger's actuals segment carry the paused figure beside the measured
one. The rung label is unchanged, and so is the caller's claim. No pauses
log, no window in the span, or a malformed row leaves the measurement
byte-identical to the plain span (asserted: `server/test/measured-duration.test.ts`,
`server/test/close-receipt.test.ts`). The git rung measures commit dates
and knows nothing of pauses; a span computed there still includes any
wait (a claim as of 2026-11, by inspection of `gitSpan`).

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

## Amendment 2026-11-04 — the pauses log is guarded, and the measurement believes only the claiming session (#470)

The decision stands; this closes a gap the pauses clause above opened.
The pauses log was read by the measurement and written by a hook, and
nothing guarded it or asked who wrote a row. The agent — the party the
measurement exists to measure — could append one row saying a pause
began at claim time, from any session string, and the close then read an
honest two hours as zero minutes with two hours paused on a usage limit;
the worklog, the receipt and the ledger carried the same. The phase 30
security audit reproduced it twice against the committed build. "Measured,
never asked for" was a sentence: a measurement whose input the measured
party can write is a report.

Two changes, by the reasoning that already protected the refusals log
(ADR 0016, #358: a log the agent can empty is a breaker it can reset).
The pauses folder under every cairn home joins the harness guard's
protected zones, with the same refusal shape and the same escape — an
append, a truncation, a removal, a rename onto it, an MCP write, a new
log for a project that has none yet, from the project root or a nested
working directory, are refused and ask where the instruction came from;
reading the log passes. And the measurement believes only the claiming
session's rows: the claim stamp now carries the session the server runs
for (`CLAUDE_CODE_SESSION_ID`, which Claude Code hands its MCP servers —
a claim about the harness, dated 2026-11-04, measured on a live server's
environment), the same id the pause recorder writes into every row, and
at close a row any other session wrote, or one with no session, neither
opens nor closes a window. A claim that recorded no session (an older
stamp, or a harness that hands the server none) believes no row at all,
so the wait stays in the number: overstated work is the honest failure,
a stranger's row taking two hours off it is not.

Stated so it reads as a decision: a row's author cannot be proven from
its content, so the guard is the mechanism and the session match is the
narrowing — a forger past the guard (the shapes its dated Not-seen block
names) must also name the claiming session, which the agent can read
from its shell. The claim stamp itself lives in local state the agent
can write, as it did before this amendment; that is rung two's standing
trust boundary, not this issue's. Overlapping windows from several
sessions no longer arise at one close, since one session's rows are
read; the merge stays for a session that overlaps itself. Asserted in
`server/test/hooks.test.ts` ("the pauses log is the harness guard's: a
forged pause row is refused (#470)" and the #383 row "a pause row
appended to the pauses log", beside reading it) and in
`server/test/measured-duration.test.ts` ("the measurement believes only
the claiming session's pause rows (#470)", and under the tools: the
audit's forgery leaves 120 minutes at 120, a claim with no session
believes no row, and the stamp names the session).
