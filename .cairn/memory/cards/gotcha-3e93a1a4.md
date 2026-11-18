---
type: gotcha
provenanceFiles: [server/src/planning/budget-ledger.ts]
provenanceCommits: [1ab0834]
created: 2026-09-08
scopePhase: 16
confidence: high
---
Spend-visibility gap (batch runs): the budget ledger reads ZERO for in-session batch work — its session scoping excludes the driving session (whose first metrics row predates run-open) and wave subagents write no metrics rows of their own, so an ENFORCED ceiling is currently impossible; boundary mechanics run correctly on a blind number. Until wave-agent spend reaches the metrics history: reconstruct actual spend from the agents' reported transcript token counts (the rehearsal's ~561k vs a 500k ceiling was assembled this way). Fix is phase-17 intake — the one real blocker between the batch mode and a trustworthy ceiling.
