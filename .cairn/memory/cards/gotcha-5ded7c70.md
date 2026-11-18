---
type: gotcha
provenanceFiles: [server/dist/docs/sections.js]
provenanceCommits: [4230b6f]
created: 2026-09-02
scopePhase: 14
confidence: high
---
server/dist is committed and can silently lag src: a change that lands without `npm run build` ships a stale dist that installed plugins actually run. Wave-2 of phase 14 found dist/docs/sections.js missing even though src/docs/sections.ts had merged in wave 1, and caught it up in its own rebuild. Any commit touching server/src must rebuild and commit dist in the same logical unit — the release-integrity gates check versions, not per-file dist freshness.
