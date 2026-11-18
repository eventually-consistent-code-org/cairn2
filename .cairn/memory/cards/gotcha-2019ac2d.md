---
type: gotcha
provenanceFiles: [server/src/tracker/cached.ts, server/src/tracker/adapters/github.ts]
provenanceCommits: [9360ed4, 2e95ebb]
created: 2026-11-05
scopePhase: 31
confidence: high
---
`CachedTracker` (server/src/tracker/cached.ts) wraps ONLY the SPI methods (issues, phases, milestones, comments). An adapter method added outside the SPI is invisible through it: #485 added `branchProtection()` to the GitHub adapter and `config_probe` calls it, but production wraps every tracker in CachedTracker, which has no such method — so the probe never reports protection and ship's "the push gate is the guard alone" line cannot print (security-31 #495). Grep on 2026-11-04: `branchProtection` appears in adapters/github.ts, not in cached.ts. Rule: a new adapter method lands in the SPI type, the adapter, AND cached.ts in one commit, with a test that calls it THROUGH the cache.
