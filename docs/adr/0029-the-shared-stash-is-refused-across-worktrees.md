# 0029 — The shared stash is refused, not advised, across linked worktrees

Date: 2026-10-29. Status: accepted.

removeWhen: git gives each worktree its own stash namespace, so an entry stashed in one worktree is not visible to, and cannot be popped by, another.
derives: axiom 5 (owner-ground); axiom 2 (mechanism-vs-judgment)

## Context

One `.git` means one stash. A stash made in worker A's worktree appears in
worker B's `git stash list`, and B's `git stash pop` applies A's
half-finished work onto B's branch and drops it from the shared list.
Agents reach for stash more than people expect, and until this phase the
run guard refused only `stash clear`; the effect table's header kept
`stash drop` off the list as an everyday recoverable command, which it is
with one worktree and is not with two.

The brief that every wave worker reads had no rule about stashing at all.

## Decision

Stash is the destructive half, not the push half. The run guard's effect
table gains three discards-work rows — `stash pop`, `stash apply`,
`stash drop` — that hold only under a new probe, linked worktrees, which
reads `git worktree list --porcelain` once per invocation beside the
existing mirror and default-branch probes. With more than one worktree the
three are refused in one plain line naming the shared stash, the worktree
that may own the entry and the alternative (park work in progress as a
commit on your own branch). `stash push`, `save` and a bare `stash` are
advised and proceed, since stashing is recoverable and popping is what
destroys. `stash list` and `show` stay reads. With a single worktree the
guard is byte-identical to before, and the two tests that pinned the old
shape flipped in the same commit (commit 237f9e6). The wave brief gains
the standing rule: never stash (commit feae7a9).

No fourth effect was named. The three effects and the amendment that
classifies git by effect stand; this is three rows under a probe.

## Consequences

Two workers on one repository no longer lose work to each other's stash
through the two most common spellings, with the guard present and
visible rather than a sentence in a brief.

The phase's closing security audit found the spelling the table missed:
`git stash branch` is pop plus a checkout, takes another worktree's entry
the same way, and matches no row, so it passes silently. The row is filed
for the next hardening pass. A sibling decision in the following phase
asks for stash rows under the owner-checkout effect as well; it adds its
condition on top of these rows rather than a second set. A probe that
cannot run — a non-repository folder, a failing git — answers no linked
worktrees and the guard fails open, which the header states.
