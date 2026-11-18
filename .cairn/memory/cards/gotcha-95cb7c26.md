---
type: gotcha
provenanceFiles: [skills/cairn-trailhead/verbs/ship.md]
provenanceCommits: [b18418d]
created: 2026-09-17
scopePhase: 21
confidence: high
---
Rejected `git push` at ship time: MERGE origin/main in (`git fetch && git merge --no-edit origin/main`), never rebase. LEDGER.md ranges, VERIFICATION.md, and every tracker close comment cite commit shas; a rebase renumbers every unpushed commit and dangles all of them (phase 21: six commits rebased over PR #193's workflow files → ledger correction line, VERIFICATION note, five correction comments). Rebase is safe only before the first `ledger_append` of the batch. Re-run check-dist + check-surface after the merge, then push.
