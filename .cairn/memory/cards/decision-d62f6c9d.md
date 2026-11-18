---
type: decision
provenanceFiles: [harness/cursor/cursor-adapter.mjs, server/test/cursor-adapter.test.ts]
provenanceCommits: [fc33ed6, fc33ed6]
created: 2026-07-29
scopeIssue: CRN-71
confidence: medium
---
Harness config schemas get verified against current docs (Context7) at build time, never written from memory: Cursor's real hook contract (response {permission, user_message, agent_message}; sessionStart output {additional_context, env}; common input fields workspace_roots/hook_event_name/transcript_path) was not guessable from the Claude hook shape, and Zed/OpenCode config keys (context_servers, mcp.{type:local,command:[]}) differ per harness. A wrong guess ships a silently dead adapter.
