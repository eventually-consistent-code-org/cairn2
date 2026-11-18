---
type: gotcha
provenanceFiles: [server/src/tracker/adapters/github.ts]
provenanceCommits: [737b947]
created: 2026-09-02
scopePhase: 14
confidence: low
---
Tracker phase params take the TRACKER phase object id, not the cairn phase number. issue_create(phase: 14) got HTTP 422 from GitHub ("milestone invalid") — the correct value was the id plan_phase_ensure returned ("10" for "Phase 14: auto-docs"). Always thread the ensure result's id into issue_create/issue_update phase fields; the cairn phase number is a planning-side concept only.
