---
type: constraint
provenanceFiles: [server/test/standalone.test.ts, scripts/refresh-readme.mjs]
provenanceCommits: [737b947, 737b947]
created: 2026-09-02
scopePhase: 14
confidence: high
---
Wave-agent playbook (proven across 3 waves / 6 issues in phase 14, ~25m wall for ~23h estimated): (1) fresh worktrees have no node_modules — agents must npm ci in server/ before tests; (2) tool-count pins live in server/test/mcp.test.ts (name list + count) and server/test/standalone.test.ts and must move with every registerTool; check-surface self-computes and needs no edit; (3) run scripts/refresh-readme.mjs after merges that change tool counts — README markers reconcile post-merge, not per-branch; (4) merge each agent branch --no-ff per issue, keep the tracker lifecycle (claim/close/ledger) in the main thread for consistent paper-trail ordering; (5) later-wave agents fast-forward their worktree onto main first when they depend on earlier waves.
