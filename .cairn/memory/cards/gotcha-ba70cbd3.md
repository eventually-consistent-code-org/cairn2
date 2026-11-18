---
type: gotcha
provenanceFiles: [server/src/planning/resync.ts, scripts/refresh-readme.mjs]
provenanceCommits: [e9ad31c, e9ad31c]
created: 2026-10-08
scopePhase: 25
confidence: high
---
Any commit outside docs/ after the latest security audit, including a root README.md edit, fails verify with stale-audit, because codeCommitsSince excludes only docs/ (#279). The sweep's own tests leg makes README's generated test count stale, so the refresh-readme --write commit lands after the security legs and trips it. Run the generated-surface refreshes (refresh-readme --write, refresh-comparison --write) before the security legs, or re-record the surface audit after reviewing the diff. Also: both refresh scripts only propose a diff by default; without --write, "git status clean" proves nothing.
