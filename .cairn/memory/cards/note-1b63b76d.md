---
type: note
provenanceFiles: [server/src/memory/compaction.ts, hooks/scripts/stop-costtracker.mjs]
provenanceCommits: [24a7d30, 24a7d30]
created: 2026-09-20
scopePhase: 24
confidence: high
---
Phase 24 (memory-hygiene) economics, measured from commit timestamps rather than self-report: 17 issues / 32 points / ~24h estimated, landed in ~39 minutes of wall time (first commit 06:28, last merge 07:07 local). That is roughly 36:1.

The series now reads 38:1 (phase 21, inline), 48:1 (phase 23, inline), 31:1 (phase 24.5, inline), 36:1 (phase 24, mostly wave-dispatched). The ratio is stable across both execution shapes and across a fivefold difference in issue count. It did NOT break — see [[gotcha-9776be91]], which corrects an earlier card that claimed a break using fabricated durations.

Dispatch shape: three waves, 8 + 4 + 3, fifteen of seventeen issues executed by worktree agents and two inline. Roughly 1.73M agent tokens across eleven dispatches. The two inline issues were the first two, done before the phase was understood well enough to partition; everything after went to agents.

Sizing guidance this supports for phase 25, the remaining capstone: at 17 points the arithmetic says well under an hour, and the honest caveat is that phase 25 is the judgment-heavy one — a sweep whose whole output is decisions about what matters. The four data points above are all mechanical-to-moderate work. Treat 36:1 as the floor of the estimate range for 25, not the centre, and note that no measured data point yet exists for genuinely judgment-heavy work. The claim that such work binds estimates remains a prediction, not a measurement.

Method note, because the last economics card in this series was wrong: durations here come from git commit timestamps. Tracker claim-to-close was attempted first and returned garbage for sixteen of seventeen issues — see [[gotcha-0212b254]] for why.
