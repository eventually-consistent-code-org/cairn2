---
type: reference
provenanceFiles: [.cairn/plans/SURVEY.md]
provenanceCommits: [6380d50]
created: 2026-10-17
scopePhase: 34.5
scopeIssue: 415
confidence: high
---
Where cairn2's tool-result bytes come from (measured 2026-10-17 over the 45 session transcripts above 200 KB in ~/.claude/projects/<this-project>, 51,978 lines, 13.1 MB of tool_result content — bytes PRODUCED, not token-turns of rent): Bash 32.9% (2,272 calls, avg 1.9 KB); Read 21.5% (178 calls, avg 15.5 KB); context-mode ctx_batch_execute + ctx_search 15.4%; cairn's own MCP tools ≈20% (issue_list 3.1%, issue_update 3.0%, issue_create 2.8%, issue_close 2.3%, plan_unplanned 2.0%, research_sections 1.6%, ledger_append 1.0%, plan_drift 0.8%, …); Agent reports 1.3%. Read+Grep+Glob together 21.9%. Top Bash command heads: cd 594, git 294, echo 192, cat 163, python3 154, sed 151, grep 130, node 61, ls 47, gh 39. Method: walk each transcript's message.content, map tool_use id→name, sum utf8 length of each tool_result's content by name. Use: phase 34.5 (the-compressor) targets Bash + JSON (cairn/MCP) results; phase 34.7 (the-lookup) targets the Read/Grep/Glob share; cairn's own ~20% is fixable at the source (return ids + deltas, not bodies). Re-measure after each lands; the 34.5 wave-1 ledger makes this per-call and continuous. Source: SURVEY.md run 2026-10-17, rtk section; research issue 415.
