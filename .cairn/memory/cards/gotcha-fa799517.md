---
type: gotcha
provenanceFiles: [server/src/planning/check.ts, .cairn/plans/phases/24-memory-hygiene/PLAN.md]
provenanceCommits: [24a7d30, 24a7d30]
created: 2026-09-20
scopePhase: 24
confidence: high
---
A declared check can report PASSING having executed nothing, and the gate that requires declarations does not catch it.

Three of phase 24's seventeen declared checks were vacuous. Two named a `-t` filter matching no test (`-t medic` against the MCP suite, `-t native` against the memory suite — both select zero). One named a test file that does not exist at all. Vitest ignores an unmatched FILE filter and an unmatched NAME pattern silently, exiting zero either way, so the command looks green while running nothing.

All three were written by the coordinator during a plan reconciliation, by someone who had not yet done the work and was guessing at test-file names. That is the normal condition for writing a declaration — the whole point is that it is written BEFORE the work — so this is not a one-off slip, it is the failure mode the practice invites.

What saved it: all three agents noticed their own bad declaration and substituted an honest check. That is diligence, not enforcement, and the distinction matters.

Two rules until the gap is closed.
1. At VERIFY, RUN each declared command rather than trusting the ledger's evidence line, and treat "selects zero tests" as a finding about the plan. Phase 24's verification did this and is where all three were caught.
2. When WRITING a declaration for work not yet done, prefer a command that cannot be vacuous — a whole test file, or a guard script — over a `-t` filter whose pattern is a guess. Name the narrower filter only after the test exists.

The mechanism gap, stated precisely: `plan_check`'s `missing-verify` asserts a declaration is PRESENT. It does not assert the declaration SELECTS anything. Closing it means resolving the command far enough to know it matches a real test, which is more than a string check. ADR 0019 records the principle; this card records the operating rule.
