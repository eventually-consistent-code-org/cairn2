---
type: note
provenanceFiles: [server/src/planning/token-estimate.ts]
provenanceCommits: [ea3e102]
created: 2026-09-08
scopePhase: 15
confidence: high
---
v5 wave economics, measured: 13 issues across 2 phases, ~46h human-estimated, landed in ~75 minutes wall across 10 worktree agents (7 waves total), zero test regressions at every merge, 1176→1215 tests, 79→84 tools. The token estimator's phase-15 range (113k–1.08M tokens) bracketed the phase's own real mid-build spend (~511k). This is the calibration baseline for auto --batch staging estimates and the reference point when sizing future wave-executed phases.
