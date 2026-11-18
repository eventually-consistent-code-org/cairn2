---
type: constraint
provenanceFiles: [CHANGELOG.md, README.md, README.md]
provenanceCommits: [4d1de8a, f4bd306, 8e2e778]
created: 2026-10-12
scopePhase: 25.7
confidence: high
---
Ledger `wall` actuals tagged git_span under-read real wall time whenever worker commits are squashed close together: phase 25.7 waves 7–13 recorded git_span 0–9m while each wave took ~60–75m, because first-to-last commit span measures the squash, not the work. For economics and estimates use observed_claim or close-comment timings, and treat any git_span under ~10m on a multi-commit wave as unreliable rather than as a fast wave.
