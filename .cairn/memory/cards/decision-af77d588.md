---
type: decision
provenanceFiles: [.cairn/plans/SURVEY.md, hooks/scripts/stop-costtracker.mjs]
provenanceCommits: [6380d50, 6380d50]
created: 2026-10-17
scopePhase: 34.5
scopeIssue: 407
confidence: high
---
Subagent report compression is not worth building. Measured 2026-10-17 over the 14 cairn2 sessions carrying a context.residency block (latest row per session, summed, unit = token-turns i.e. share of context rent): tool_result 56.2%, tool_call 30.6%, user_text 9.3%, assistant_text 3.1%, thinking 0.8%; subagent report_bytes 0.07% of the same total (221 reports). This closes the question #176 left open ("measure coordinator context before compressing it"). The leverage is tool RESULTS at the moment they land — before they are re-sent on every later turn — not the reports subagents send back. Phase 34.5 (the-compressor) acts on it, measurement wave first. Source: SURVEY.md run 2026-10-17, section cairn-overlap-compress-route-measure; research issue 407.
