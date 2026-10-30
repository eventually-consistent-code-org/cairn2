# 0028 — The phase ledger merges by union, with its precondition stated

Date: 2026-10-29. Status: accepted.

removeWhen: the tracker alone is the record of closures and no ledger file is ever merged between branches — the local ledger becomes a read-only projection of tracker state, or disappears.
derives: axiom 1 (tracker-truth); axiom 4 (recorded-run)

## Context

On the dispatch path where a coordinator keeps claim, close and ledger
append in its own thread, the phase ledger lands in one sequence. On the
fallback path — every harness without a workflow primitive, which is the
path two vendors on one repository actually take — each worker runs the
whole lifecycle in its own worktree and appends its closing line on its
own branch. Two branches appending to one file conflict on the second
merge, in a file whose entire contract is that lines are only ever added.

Git has a merge driver for exactly that shape.

## Decision

Project and phase scaffolds write `**/LEDGER.md merge=union` into the
planning root's git attributes, idempotently, and report whether the line
was added or already present. The plan-quality scan reports a phase whose
ledger exists without the attribute at a new `minor` severity with the
one-line fix, and the repair verb applies it. The ledger module's header
records that line order across branches is a merge artifact (commit
3bd4f0d). The work verb's fallback path says the same so a worker-appended
line is expected to survive the merge.

The claim rests on one precondition, written here rather than assumed: no
two branches append lines for the same task. Within one branch the reader
is deliberately order-dependent — an evidence line retracts only the
closures written before it, which is how a mistaken close is corrected
without rewriting history — so a closure on one branch and its retraction
on another read as closed or as retracted depending on which side was
merged into which. The one-issue-per-worker wave design satisfies the
precondition; a rejected-push merge during ship is where it is most likely
to be violated.

## Consequences

The fallback path merges without conflict, and a repository that ignores
its planning directory is unaffected (the attribute is harmless there).

The phrase "correct by construction" was written into the scaffold and
the ledger header and the phase's closing security audit reproduced the
case that falsifies it: the same two lines in the two merge orders gave
opposite closure states, and the test the header cites interleaves only
closures of different tasks, so it could not go red. The fix — resolve a
closure against its fix-up by the date and commit on the line rather than
by file position, or state the precondition beside the claim and extend
the test to the interleaving — is filed for the next hardening pass. Until
it lands, this record is the statement of the precondition.
