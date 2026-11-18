---
type: decision
provenanceFiles: [CHANGELOG.md, README.md, hooks/scripts/shell-words.mjs]
provenanceCommits: [4d1de8a, 524ad20, d7884d4]
created: 2026-10-12
scopePhase: 25.7
confidence: high
---
The no-stop-rule hardening loop, chosen by the owner at phase 25.7 verify: fix → re-audit the security surface → put every important finding to two independent votes → file the survivors as the next wave of the SAME phase → repeat until a pass has no surviving important finding. It took ten passes and thirteen waves to go from 20 planned issues to 48 closed; the 48 residual minors stayed in the audit record, not the tracker. Pass count, not wave count, is the progress signal, and the phase ends when the audit says so, not when the plan runs out. Scope growth of 2–3× under this rule is expected, not drift.
