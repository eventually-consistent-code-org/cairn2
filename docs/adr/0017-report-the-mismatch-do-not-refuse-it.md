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

## Amendment 2026-10-21

The check above compares two strings the worker wrote; nothing in it is
something the server saw. With `verify.rerun: true` in cairn.json (off by
default), a close's ledger append re-runs the task's declared `verify:`
line itself when the evidence command equals that line character for
character, in the project root under a timeout (`verify.timeoutSeconds`,
600 by default), and records `observed { exit, tail, at }` beside the
claimed evidence: an `observed exit=<n> at=<when>` segment on the ledger
line, the tail in the tool result. A non-zero exit or a timeout marks the
line `observed-mismatch`, which `plan_check` reports at `important` and
`distill_manifest` lists. The decision stands: the close is never refused
over what the re-run saw. The observation is added, not a new gate.

The trust boundary is the tracked plan file. Server-side execution
bypasses every PreToolUse hook, so the server runs only the owner-authored
line it read out of PLAN.md, never the worker-supplied string, and only
when that PLAN.md is tracked by git and the task's declared line is the
same at the claim's base commit as it is now (a content comparison, which
also catches an uncommitted edit). An untracked plan has no provenance and
a changed line may be a hostile edit, so both are reported as named skips
(`plan-untracked`, `declared-changed`) and never run; so are a waived
close, a missing declaration, a differing command and a declaration that
is not a plain shell line. Within that boundary the trust is the same as
the model running the line through its own Bash tool. A project that keeps
its planning directory out of git, as this repository does, gets the skip
on every close until it tracks the plan.

The base commit the comparison keys on is the one the server stamped when
the issue was claimed (#369), never the `baseCommit` on the append call:
a caller who could name the base could name a commit carrying its own
edit of the plan. No stamp, no run (`no-claim-record`). The line runs
under a minimal environment (PATH, HOME, TMPDIR, locale, TERM, user), so
the tracker tokens the server holds never reach it. What this boundary
does not close, stated so it can be read as a decision and not an
oversight: the claim is the agent's act, so an agent that commits a plan
edit and then claims passes the comparison, and the line itself is not
classified before it runs. Enabling `verify.rerun` therefore grants
whoever can commit PLAN.md a shell line outside the PreToolUse hooks;
keep it off unless plans are owner-reviewed before they are claimed. An
owner-approval stamp on the plan and the run guard's effect classifier
(`git-effects.mjs`, #359) applied to the declared line before it runs
are the follow-up filed at #357's close, phase 30.
