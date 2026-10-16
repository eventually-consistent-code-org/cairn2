# 0017 — Declared checks report a mismatch; they do not refuse it

Date: 2026-09-20. Status: accepted.

removeWhen: the model's own judgment of whether recorded evidence satisfies a declared check agrees with human verification across a milestone, so the side-by-side reading at verification can be delegated. Until then the mismatch is reported, not refused.
derives: axiom 4 (recorded-run); axiom 2 (mechanism-vs-judgment)

## Context

Closing evidence became typed data earlier in this milestone, so the
tracker records what was actually run. That left the other half open:
nothing said, before the work started, what running it was supposed to
prove. Criteria written afterwards get chosen to fit whatever happened.

Declaring the check at plan time is the easy part. The hard part is what
happens when the recorded evidence does not match the declaration. The
obvious design refuses the close until the two agree.

## Decision

Task lines declare the proving command when the plan is written. The plan
check reports a task that declares nothing, and a phase already verified
is exempt, because asking for intent after the proving is written up is
noise on every scan until the milestone closes.

At close, the ledger reports what was declared and whether the evidence
cites it. It does not refuse on a mismatch.

The reason is that declarations are shorthand and evidence is literal. A
plan says "the suite"; the evidence records the invocation someone really
typed, with its exclusions and flags. A string gate between those two
fails honest closes constantly, and the behaviour it trains is padding
the field until the gate goes quiet — which destroys the value of the
field. Whether a mismatch matters is a judgment, and verification, where a
human reads both strings side by side, is where that judgment belongs.

## Consequences

A declaration that turned out to be the wrong check surfaces as a finding
about the plan rather than as a blocked close. What is not acceptable is
the mismatch going unwritten, and the verification step is where it gets
written.

The first phase held to this gate produced exactly the case the design
anticipated: five of eight closes recorded a superset of their declared
command, because the declaration grammar shipped in the seventh task of
the wave and those five predated it. A refusing gate would have blocked
work that was demonstrably done. The reporting gate let verification
re-run every declared command standalone, confirm each passed, and record
the recording gap for future phases to avoid.

The same reasoning is why the architecture rules that shipped alongside
name their real exceptions explicitly rather than being weakened until
they pass, and why the context budget was pinned at the measured shape
rather than at an aspiration the tree already failed. A gate that cannot
fail teaches nothing; a gate that fails for the wrong reason teaches
people to route around it.
