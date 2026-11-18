---
type: gotcha
provenanceFiles: [server/src/workspace/context.ts, server/test/workspace-context.test.ts]
provenanceCommits: [5deb040, 5deb040]
created: 2026-11-05
scopePhase: 31
confidence: medium
---
The machine-wide workspace focus (`~/repos/.cairn/basecamp/focus.json`) redirects EVERY tool call of the installed server to the focused member, silently. Phase 31 hit it three times: at verify (15:29 and ~17:40 CST, another session had set focus to a sibling) `plan_check(31)` scanned 0 files and `issue_list` returned NOT_FOUND; at `docs publish` (23:00 CST) `docs_status` answered `configured: false` for a repo with a docs block. #487 (5deb040) fixes the member-launch case on main — a session launched INSIDE a member keeps its own project and `workspace_focus` reports `focusApplied` — but the installed 2.9.3 plugin predates it, and a session launched in the main checkout (not a member) is still redirected; security-31 records that as #499. Rule until the release lands: call `workspace_status` and read `focus.json` before every cairn write batch; set focus to this project for the batch and restore it after.
