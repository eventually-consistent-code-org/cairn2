---
type: gotcha
provenanceFiles: [.github/workflows/ci.yml, scripts/release.mjs, server/test/runguard-guards.test.ts, CHANGELOG.md, README.md]
provenanceCommits: [c2da9e2, 5c46e2b, 5ea8e12, 4d1de8a, 524ad20]
created: 2026-10-12
scopePhase: 25.7
confidence: high
---
A release was tagged on a red CI. Phase 25.7's thirteen waves (~100 commits, 2026-10-08 → 10-11) were merged locally and pushed to main as one batch at 524ad20; ci.yml's first look at them failed (17:47), and v2.8.2 was tagged at 4d1de8a three minutes later while CI was still red, so publish.yml failed on the same test. Local runs had stayed green for six waves because the machine's global gitconfig supplied the identity the #306 clone fixture lacked. Rule: push main, wait for the ci.yml run on that exact sha (`gh run list --workflow=ci.yml --limit 1`), and tag only on success. Long local wave chains need a CI push per merge, not one per release — CI only tests what it sees.
