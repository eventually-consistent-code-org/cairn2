---
type: note
provenanceFiles: [hooks/scripts/pretooluse-harnessguard.mjs, server/test/architecture.test.ts, scripts/check-footprint.mjs]
provenanceCommits: [40aee62, 7554b52, c2da9e2]
created: 2026-09-20
scopePhase: 24.5
confidence: low
---
Phase 24.5 (harness-hygiene) economics, measured — and the first phase to BREAK the ~40:1 ratio. 8 issues / 15 points / ~11.75h estimated landed in ~128 minutes of wall time (18+12+10+14+16+19+24+15 per close comment), executed inline and sequentially. That is roughly 5.5:1, against 38:1 for phase 21 and 48:1 for phase 23.

This confirms the prediction in note-df935945 exactly: "point estimates for mechanical server/prose work are conservative by roughly an order of magnitude; judgment-heavy work is where the estimate may actually bind." Phase 24.5 was judgment-heavy in a way the earlier phases were not — three issues were decided AGAINST their own issue text (report-not-refuse on close evidence, named exceptions instead of a watered-down architecture rule, budget pinned at measured shape rather than an unmet aspiration), the architecture rules were proven by deliberately breaking them three times and reverting, and two eval runs had to be paid for and read.

Sizing consequence for phases 24 and 25: phase 24 is mechanical cargo with file:line targets, so expect the old ratio. Phase 25 (the sweep) is the judgment-heavy capstone — size it against 5:1, not 40:1, and treat its 17 points as roughly a full working session rather than half an hour.

Suite 1412→1465, 79→80 files, tools held at 85, six guards (check-footprint is new). Two issues filed from findings the work produced (#225 misplaced shared transport, #226 repeated help suffix) and one from the docs build (#227).
