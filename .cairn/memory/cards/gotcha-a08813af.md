---
type: gotcha
provenanceFiles: [server/src/planning/docs-drift.ts]
provenanceCommits: [2ab6ec3]
created: 2026-09-08
scopePhase: 16
confidence: medium
---
Wave agents can misreport git facts: one rehearsal agent reported its branch as "one commit on top of 140762f" when merge-base against main proved 5feb2a5 — the work was fine, the reported sha was not. Before merging any agent branch, verify with git merge-base (and let the merge diff + post-merge suite be the truth); never carry an agent-reported sha into ledgers, tracker comments, or reports without checking. Complements the standing verify-shas-before-citing rule.
