---
type: gotcha
provenanceFiles: [hooks/scripts/shell-words.mjs, hooks/scripts/pretooluse-harnessguard.mjs]
provenanceCommits: [84055c2, 84055c2]
created: 2026-10-09
scopePhase: 25.7
confidence: high
---
Shell-command guards that take a segment's first word as the command are blind behind reserved words and grouping tokens (if/while/until/for…do/{/!/function/coproc): `if git reset --hard; then :; fi` passed the run guard in every release up to v2.8.1. The shared reader (hooks/scripts/shell-words.mjs) now skips them. Probe new guard rules with keyword/grouping wrappers, not just the bare form. And when a guard tracks cd, never let a cd remove a candidate folder: a cd can fail, be skipped, or run in a subshell or later, so `cd /nonexistent; echo x > hooks/x` would otherwise write the real path while the guard judges /nonexistent.
