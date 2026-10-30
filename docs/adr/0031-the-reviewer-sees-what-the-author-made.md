# 0031 — The reviewer sees what the author made: untracked files are part of the default review target

Date: 2026-10-29. Status: accepted.

removeWhen: the harness hands reviewers the working tree — tracked changes and untracked files alike — as the default review input, so the verb no longer has to compose that target from two git commands.
derives: axiom 4 (recorded-run); axiom 2 (mechanism-vs-judgment)

## Context

The review verb's default target was the working diff plus whatever was
staged. A file an agent created and never added is in neither. A new
module, a new test file or a new configuration file could land without
cairn's own panel or the peer council ever seeing it, and it bites hardest
when two agents each create files in their own worktrees and the merge is
the first time anyone reads them. A review of the tracked diff alone is a
review of a claim about the change, not of the change.

## Decision

The default target is the working diff, the staged changes, and every
path git reports as untracked and not ignored, each untracked file
rendered as a new-file diff against an empty file so the panel reads one
shape for tracked and untracked changes. A binary or oversized untracked
file is listed by name and size rather than inlined; the existing
large-diff handling decides the cutoff. The review record states how many
untracked files the pass included. Peer review and the simplify audit
inherit the target by reference, no second table (commit e8ce6dc).

Target resolution is verb prose, not a server module — no server code
resolves a review target today — so the change is the verb text and a
surface test that pins the row and the record line.

## Consequences

A file that exists only in the working tree is reviewed before it is
committed, by the internal seats and the external council alike.

The sentence is pinned by a test on the verb text, not asserted by a
mechanism that resolves the target; if a server module ever takes over
target resolution, the test moves with it. Ignored files stay invisible
on purpose: a reviewer who sees build output reviews noise.
