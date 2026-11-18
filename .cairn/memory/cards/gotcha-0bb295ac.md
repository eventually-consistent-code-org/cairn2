---
type: gotcha
provenanceFiles: [server/test/runguard-guards.test.ts]
provenanceCommits: [5ea8e12]
created: 2026-10-12
scopePhase: 25.7
scopeIssue: 306
confidence: high
---
Any test that commits inside a temp repo must set GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL in the child process env (the shared git() helper in runguard-guards.test.ts does since 5ea8e12). A fresh `git init` or clone inherits only the global gitconfig; a CI runner has none, so `git commit` there dies with "Committer identity unknown" — and only there, which is why the gap survived six local wave runs. Reproduce CI locally with GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm test.
