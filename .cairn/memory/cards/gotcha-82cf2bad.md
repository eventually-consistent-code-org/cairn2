---
type: gotcha
provenanceFiles: [hooks/scripts/pretooluse-leakguard.mjs, server/test/mirror.test.ts]
provenanceCommits: [2e43a2a, 2e43a2a]
created: 2026-09-17
scopePhase: 21
confidence: high
---
The leak guard is a PreToolUse Bash hook: when it blocks a compound command (`git add A B C && git commit …`), NOTHING in that command ran — no files were staged. A retry that fixes the flagged line and re-adds only that file lands a partial commit (phase 21's #195 commit landed with the test file alone and needed `--amend` to pick up src, dist, and prose). After any leak-guard block, re-run the FULL add list, then confirm with `git show --stat HEAD` before closing the issue.
