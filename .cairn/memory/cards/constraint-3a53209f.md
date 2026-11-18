---
type: constraint
provenanceFiles: [server/src/peers/state.ts, server/src/index.ts]
provenanceCommits: [00c5f4f, 00c5f4f]
created: 2026-09-17
scopePhase: 21
confidence: high
---
Every `audit_record` caller must supply `failure_scenario` on each finding and a `panel` on every critical/important one, or the write fails PRECONDITION_FAILED — the record enforces the bar, not the prose. Known callers: the review/audit verbs (panel step precedes the record, which precedes issue_create) and peers `runClose`, whose CloseSummary maps each peer verdict onto the panel (verified → CONFIRMED, dead → REFUTED, open-disagreement → PLAUSIBLE) with the peer's evidence as the scenario. Any new producer of findings (a future sweep, an eval harness, an import) needs the same mapping or its writes will be refused.
