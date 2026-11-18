---
type: gotcha
provenanceFiles: [hooks/scripts/shell-words.mjs, hooks/scripts/shell-words.mjs, hooks/scripts/shell-words.mjs, hooks/scripts/pretooluse-harnessguard.mjs, hooks/scripts/pretooluse-runguard.mjs, hooks/scripts/pretooluse-runguard.mjs]
provenanceCommits: [f5ea9a4, a4361f2, 8f01877, 868140b, b55b9d7, caa4f2f]
created: 2026-10-12
scopePhase: 25.7
confidence: high
---
Tightening the shared shell reader regresses the neighbour it didn't test. Three of phase 25.7's ten re-audit passes found regressions the previous wave had introduced: #319 (an unquoted substitution is one word) left process-substitution and arithmetic bodies unread (#320) and over-refused nested lines at seconds of cost (#321); #311's off-table runner backstop put man and gh on the print-only list though both can run an argument (#315). Any change to hooks/scripts/shell-words.mjs or either PreToolUse guard runs the standing probe sets plus the differential/fuzz run (7112-command A/B, 520-case fuzz) before merge, not only the new issue's unit tests. The next audit pass is the backstop, not the gate.
