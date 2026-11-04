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

The reader is order-dependent on purpose — an evidence line retracts the
closures it speaks after, which is how a mistaken close is corrected
without rewriting history — but "after" is not file position, which a
union merge decides. Two lines for one task rank by commit ancestry (the
line whose head commit descends from the other's speaks later), then by
the date written on the line, then by file order (#445, 2026-11-03). The
phase's commit range is read the same way: the base the other bases
descend from, to the head that descends from the other heads, never the
last line. Git is asked for the ancestry step and the rule falls through
when it cannot answer — no repository, a sha it cannot place, no git — so
a parse never fails on it. Within one branch, where every head descends
from the one before, the rule reads as file order did.

## Consequences

The fallback path merges without conflict, and a repository that ignores
its planning directory is unaffected (the attribute is harmless there).

The phrase "correct by construction" was written into the scaffold and
the ledger header before the phase's closing security audit reproduced the
case that falsified it: the same two lines in the two merge orders gave
opposite closure states, and the test the header cited interleaved only
closures of different tasks, so it could not go red. The ancestry rule
above is the fix (#445). The sentence now stands on a test that builds a
real union-merge repository, appends a closure on one branch and the
evidence fix-up for the same task on the other with the dates pointing the
wrong way, merges both directions, and reads the same closure state, the
same `closure-superseded` finding and the same commit range from each —
`test/ledger.test.ts`, "closure-plus-evidence across a union merge reads
the same answer in both directions". It was red against the file-order
parser before the rule landed.

## Amendment 2026-11-04

The 2026-11-03 rule met the locked decision and missed the goal (#472).
Its last step was file order, and its second step compared a day: when
two branches are independent — neither head descends from the other,
the shape a rejected ship push produces — and both lines carry the same
day, ancestry cannot answer, the dates tie, and file order decides, which
is merge order. The same two lines read closed one way and superseded the
other. The test above could not go red on it: it built only branches
where one head descended from the other and the dates differed.

The rule now ranks by commit ancestry, then by the stamp on the line,
then by the lexically greater head hash, and file order is never
consulted — the comparator's input type carries no line number, so it
cannot be. The close fold writes the full ISO timestamp as the stamp
(`Date.toISOString()`), so two same-day lines no longer tie on the day;
the parser accepts the bare day too, for lines written before this and
for a hand-called append, and both spellings compare lexically as time.
A closure stands only when it speaks strictly after every fix-up for its
task: a full tie — same stamp, same head, which the stamping writer never
produces for two lines — goes to the fix-up, the conservative read, in
both merge orders. The phase's commit range picks its head and base by
the same stamp-then-hash order.

Asserted by the same test block, which gains the independent same-day
case merged both ways three times over — the fix-up stamped later, the
close stamped later, and bare days that tie so the hash decides — and by
`test/plan-check.test.ts` "a same-day tie reads the same in either file
order". The tie case was red against the 2026-11-03 rule: the two merge
directions disagreed. The "correct by construction" sentence in the
scaffold now stands on this test.
