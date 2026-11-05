# 0038 — What a guard cannot see is written down, dated, and pinned by a test

Date: 2026-11-04. Status: accepted.

removeWhen: the harness classifies commands by their effect and reports what it could not read, so a guard has no unseen shapes left to name.
derives: axiom 4 (recorded-run); axiom 2 (mechanism-vs-judgment)

## Context

The guards match command text. Every audit of them finds the same thing:
a shape the guard was never shown — a glob spelling, an alias channel, a
nested shell — passes, and the guard's header either does not mention it
or mentions it in a sentence nothing checks. Two audits in a row (phases
28 and 29, then 30) filed the same class of gap, and the fix each time
was a regex plus a test, with the header rewritten by hand and left to
drift. The alternative the October backlog asked for was a hooks
document listing every shape, which would have been a second place for
the same sentences to go stale.

## Decision

There is no hooks document. Every guard's header carries a dated "Not
seen" block: one sentence per shape the guard does not read, with the
service-side or platform control that covers it where one exists, or the
plain statement that nothing does. A test pins each block phrase by
phrase and by line count, so a line deleted or reworded without the test
is red, and the same test sends each unseen shape through the guard and
asserts it passes — the header and the guard move together or not at all
(commits in the ranges 255a678..ceabd8e and 6d12931..b66705a). The
claims rule applies to the rest of the header: every sentence about what
the guard catches names the test that proves it. A shape found after the
block was written is a filed issue, not a half-guard.

## Consequences

An audit of a guard now has two columns to read, the table and the
block, and a finding is either a row the table lacks or a sentence the
block lacks; the closing security audit of the phase was written against
that shape and filed twenty-one siblings with the header line each one
contradicted or was missing from. The cost is that the block is prose a
test holds to its line count, so adding a shape means moving a pin,
which is deliberate: the pin is the mechanism that keeps the sentence
true. The decision does not make the guards see more; it makes what they
do not see a recorded fact instead of a surprise.
