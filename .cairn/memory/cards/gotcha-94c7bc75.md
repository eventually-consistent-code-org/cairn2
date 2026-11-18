---
type: gotcha
provenanceFiles: [hooks/scripts/pretooluse-runguard.mjs, .claude-plugin/plugin.json]
provenanceCommits: [84055c2, 4d1de8a]
created: 2026-10-12
scopePhase: 25.7
confidence: high
---
The hardened guards never protect the session that builds them. A live Claude Code session runs the INSTALLED plugin copy under ~/.claude/plugins/cache/cairn-dev/cairn/<version>/, so every guard fix in phase 25.7 was inert in the session that wrote it until v2.8.2 published and `claude plugin update cairn@cairn-dev` plus a restart ran on 2026-10-12. Verify a guard change by piping stdin PreToolUse payloads into the repo's hooks/scripts in a throwaway repo (the probe sets do exactly this); trying the attack in the live session proves only what the old copy does.
