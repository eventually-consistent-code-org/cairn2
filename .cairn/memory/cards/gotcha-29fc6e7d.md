---
type: gotcha
provenanceFiles: [server/src/planning/mirror.ts]
provenanceCommits: [e412e57]
created: 2026-09-17
scopePhase: 23
confidence: high
---
Tracker phase-param COLLISION: `resolvePhaseParam` accepts either the tracker's phase-object id or the cairn phase number, and the id wins when both match — on GitHub the ids and numbers now overlap (tracker id "23" is "Phase 25: the-sweep"), so `issue_list(phase: "23")` silently returned phase 25's issue during phase 23's verify. Same path underlies issue_create/issue_update `phase`. When a cairn number could also be a live tracker id (check the `newPhases` map from `plan_tracker_delta` — ids are small integers on GitHub), pass the tracker id explicitly or verify the returned issues' `phase` field; drift's per-issue read is the collision-proof check for "is this phase's work closed".
