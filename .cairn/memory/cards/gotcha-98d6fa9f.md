---
type: gotcha
provenanceFiles: [docs/01-runbook.md, server/README.md]
provenanceCommits: [867d9ea, 25653d8]
created: 2026-09-20
scopePhase: 24
confidence: high
---
Parallel agents editing adjacent prose produce a conflict shape that LOOKS trivially auto-resolvable and is not: each side improved a different part of the same region while leaving the other's part at its original text. Taking either side wholesale silently discards real work.

Both of phase 24's merge conflicts had exactly this shape.

In the server README's hooks table, #176 improved the cost-tracker row and left the observation row untouched; #173 improved the observation row and left the cost row untouched. Git presents one conflict spanning both rows. `--ours` loses the observation improvement, `--theirs` loses the cost one. The resolution is to take row 5 from one side and row 6 from the other.

In the runbook's native-binding entry, #187 rewrote the text back to an OLDER single-case version, because its worktree base predated #178's two-mode rewrite. Here the sides were not equal: one was an improvement and the other was a regression wearing the same clothes. The resolution kept #178's two-mode content and applied only #187's actual contribution, the menu-close instruction — then verified BOTH survived in the merged file by grepping for a phrase unique to each.

The rule: on any conflict between two agents of the same wave, assume both sides contain something real until proven otherwise, and resolve by composing rather than choosing. Then grep the merged file for a marker from each side. A conflict where one side is a stale-base revert is indistinguishable from an ordinary disagreement by inspection alone — [[gotcha-29fb499d]] is why it happens.
