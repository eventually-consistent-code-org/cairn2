---
type: decision
provenanceFiles: [server/src/audit/record.ts, server/src/audit/record.ts]
provenanceCommits: [00c5f4f, a0092e3]
created: 2026-09-17
scopePhase: 21
confidence: high
---
`audit_record` is the extension seam for finding-level mechanism — phase 21 rode three features on it (refutation panel, revision stamp, staged patch) with zero new tools (count held at 85). Quorum, computed in `judgePanel` and never model-asserted: REFUTED strict majority → refuted (kept in the record, never filed); CONFIRMED > REFUTED → confirmed; anything else (ties, lone PLAUSIBLE) → plausible, survives. `requiredVotes`: critical/important need ≥1 vote, ≥2 when the scope matches /^security(-|$)/, minors 0. `applyEligible` = survived ∧ all three verifier claims true. Survivors that went through a panel credit their `seats` in the yield store; unpanelled minors never do. Prefer extending this record over a new tool for the next finding-shaped feature.
