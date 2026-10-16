# 0019 — A check that cannot fail is worse than no check

Date: 2026-09-20. Status: accepted.

removeWhen: never — a guard that cannot fail is decoration whoever writes it. The open gap it names closes when the declared-verification gate resolves each command to real tests; the principle stays.
derives: axiom 4 (recorded-run)

## Context

This principle has now been arrived at independently three times in two
phases, from three different directions, which is what promotes it from a
preference to a rule.

The architecture tests refuse to run on an empty file match, because a
rule that inspected zero files and passed reads as coverage forever. The
diagram guard was found green while the rendered images a reader actually
opens carried a stale count, because it only ever read the source labels.
And the declared-verification gate — which requires every planned task to
name the command that will prove it — was satisfied by three declarations
that select no tests at all, two because their name filter matches
nothing and one because it names a file that does not exist.

The test runner ignores an unmatched file filter and an unmatched name
pattern silently. A declared check can report passing having executed
nothing.

## Decision

A check must be able to fail, and that capability is itself asserted
wherever it is cheap to assert.

Concretely, in the three places this has bitten: every architecture rule
fails when its file pattern matches nothing, and every named exception
fails when it stops being used; the timing assertions measure marginal
cost against a baseline rather than an absolute budget, and were proven by
injecting a slowdown and confirming the failure; and a declared check that
selects nothing is a finding about the plan, reported at verification with
both the declaration and what was actually run.

## Consequences

The gap this record does not yet close, stated so it is not mistaken for
solved: the declared-verification gate asserts that a declaration is
present. It does not assert that the declaration selects anything. Closing
that means the gate resolving the command far enough to know it matches a
real test, which is more than a string check and is not yet built.

What made the three vacuous declarations harmless this time was that the
workers noticed and substituted honest checks. That is diligence, not
enforcement, and the distinction is exactly what this record exists to
keep visible.

The generalisation worth carrying: whenever a guard is added, ask what
would have to be true for it to fail, and if the answer is "nothing
reachable", the guard is decoration. The corollary is that guards should
be tested by breaking the thing they guard, not by observing that they
are green.
