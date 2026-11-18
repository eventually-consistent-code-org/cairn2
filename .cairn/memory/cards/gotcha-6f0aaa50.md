---
type: gotcha
provenanceFiles: [server/src/planning/mirror.ts]
provenanceCommits: [00c5f4f]
created: 2026-09-17
scopePhase: 21
confidence: high
---
CORRECTS gotcha-2654c8ee: tracker phase params accept the cairn phase NUMBER, not only the tracker's phase-object id — `resolvePhaseParam` (#138) maps "21" through the "Phase N: <name>" convention before every issue_create/issue_update. Phase 21 passed `phase: "21"` on five creates against GitHub without a 422. The old card's advice (thread the ensure result's id) still works — id wins on collision — but is no longer required.
