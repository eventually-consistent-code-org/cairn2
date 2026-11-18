---
type: gotcha
provenanceFiles: [server/src/planning/ledger.ts]
provenanceCommits: [e412e57]
created: 2026-09-17
scopePhase: 23
confidence: high
---
A ledger gate introduced MID-PHASE cannot be satisfied by that phase's own earlier lines: LEDGER.md is append-only, so #198/#199's lines (written before #200 shipped the evidence requirement) can never gain the segment, and plugin lag meant even #200's own line was written by the pinned plugin that predates the field. Two rules that fell out: (1) put a gate-introducing issue FIRST in its wave, or in the wave before its consumers; (2) the phase that introduces a ledger gate is exempt for lines written before the gate was callable — say so in VERIFICATION.md so the gap never reads as a skipped check. Every phase after is held to it.
