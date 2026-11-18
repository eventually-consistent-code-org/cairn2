---
type: gotcha
provenanceFiles: [server/src/planning/check.ts, server/src/planning/ledger.ts, .cairn/plans/phases/24.5-harness-hygiene/LEDGER.md]
provenanceCommits: [6fd074a, 6fd074a, c2da9e2]
created: 2026-09-20
scopePhase: 24.5
confidence: high
---
EXTENDS gotcha-71c2d7c6 to gates that REPORT rather than refuse. Phase 24.5 put the declared-verification issue (#206) seventh in an eight-issue wave, so five ledger lines were written before the grammar it introduces existed. Those five record the full suite where PLAN.md declares a targeted run; the two written after it both cite correctly.

The difference from the refusing-gate case: nothing was blocked, so nothing forced the problem into the open at close time. The phase passed. Verify caught it only because gate 2b reads the declaration and compares — and the fix was to re-run every declared command standalone during verification to prove the coverage was real rather than argue that a superset implies it (all eight passed).

Rule, now independent of gate kind: a gate-introducing issue goes FIRST in its wave, or in the wave before its consumers. A refusing gate makes its own phase's records refuse; a reporting gate makes its own phase's records the worst examples of the practice it teaches, which is quieter and therefore easier to ship without noticing. Say so in VERIFICATION.md either way, with the cause (ordering) named, so the gap never reads as sloppiness.
