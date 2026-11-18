---
type: constraint
provenanceFiles: [harness/cursor/cursor-adapter.mjs, hooks/scripts/stop-costtracker.mjs]
provenanceCommits: [fc33ed6, c99b9e9]
created: 2026-07-29
scopeIssue: CRN-71
confidence: high
---
The cost tracker is structurally Claude Code-only: stop-costtracker.mjs parses Claude's transcript JSONL for token usage. Cursor's hooks expose a transcript_path but the format is not Claude's, and other harnesses expose nothing. Porting cost attribution to any harness requires a per-harness usage source (API, different transcript parser) — do not wire the existing script to another harness's stop event and hope.
