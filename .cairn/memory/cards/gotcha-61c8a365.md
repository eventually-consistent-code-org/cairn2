---
type: gotcha
provenanceFiles: [server/src/docs/sections.ts]
provenanceCommits: [737b947]
created: 2026-09-02
scopePhase: 14
confidence: low
---
writeSectionFile (docs: marked-section writer) drops the marker's date/meta on rewrite: passing opts {state: 'done', meta: '2026-09-01'} produced a bare "docs: done" marker in the output. Cosmetic, but it erases marker-date provenance each regeneration. Observed live during phase 14's ship-time distill; single observation, no regression test yet.
