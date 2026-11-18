---
type: note
provenanceFiles: [hooks/scripts/pretooluse-harnessguard.mjs, server/test/hooks.test.ts]
provenanceCommits: [6388ce4, 6388ce4]
created: 2026-11-05
scopePhase: 31
confidence: low
---
Phase 31 (the guard gaps) economics, measured 2026-11-04: 32 issues in 5 waves, 70 commits 255a678..561b25e (19 fix, 14 feat, 10 docs, 5 test, 5 chore, 17 merge commits), one calendar day from first wave to distill. Suite 2653 → 2924 passed; resident footprint 13141 → 13138 of the 13145 pin (two new hooks, zero new tools; tool count flat at 87). Observations: 1639 rows (1109 Bash, 432 Edit, 98 Write), 55 errors. Edit hotspots read per worktree: pretooluse-harnessguard.mjs 63 edits across four waves' worktrees, pretooluse-runguard.mjs 36, git-effects.mjs 29, hooks.test.ts 29 — the three guard files took half the phase's edits, matching the 12/8/5 commits git shows against them. Verify failed its first run on stale-audit, as phases 27–30 did; the security audit is now a standing verify prerequisite, not a surprise. Security-31 filed 21 findings (#492–#512, 3 critical).
