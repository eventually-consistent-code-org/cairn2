---
type: decision
provenanceFiles: [server/src/planning/check.ts, server/src/sessions/store.ts, server/src/planning/ledger.ts]
provenanceCommits: [03c2b5e, fc50edc, e412e57]
created: 2026-09-17
scopePhase: 23
confidence: high
---
Phase 23's three method gates, and where each lives: (a) `## Approaches considered` — CONTEXT_TEMPLATE ships it as a COMMENT-ONLY skeleton so an unfilled scaffold can never satisfy `plan_check`'s `missing-approaches` (rule: a skeleton must not pass the gate it exists to prompt); the gate applies to live phases with `issues:` non-empty and depth ≠ quick (frontmatter, else standard — cairn.json has no depth key). (b) `KindSpec.requiredEntries` in sessions/store.ts, checked in closeSession BEFORE the close-gate; trace = {evidence:1, test:1}; the first `test` is the repro and rides trace_close's Resolved comment. (c) `ledger_append` requires `evidence {command,result}` or `evidenceWaived` (PRECONDITION_FAILED on neither, CONFIG_INVALID on both); the segment sits after `tdd` and before `<issueId> closed`, and evidence text loses em dashes because " — " is the line's field separator. All three are schema/behavior changes on existing tools — tool count stayed 85.
