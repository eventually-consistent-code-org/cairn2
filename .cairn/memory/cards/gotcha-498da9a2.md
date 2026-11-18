---
type: gotcha
provenanceFiles: [server/test/dedup.test.ts]
provenanceCommits: [96a5968]
created: 2026-09-13
scopePhase: 19
confidence: low
---
Quote suite baselines in agent briefs as PASSED COUNT ONLY. A brief stating "baseline 1316 passed | 8 skipped" sent two parallel wave agents chasing a skip-count discrepancy that was pure environment noise — the 8 skips are env-conditional (live/CLI-gated) tests that simply never trigger in fresh worktrees, so both agents saw 0 skipped, investigated, and spent report space explaining it. Skip counts vary by machine; passed count is the stable contract. Say "baseline N passed, zero regressions expected" and nothing else.
