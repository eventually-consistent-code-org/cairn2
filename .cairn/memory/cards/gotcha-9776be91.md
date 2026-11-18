---
type: gotcha
provenanceFiles: [skills/cairn-trailhead/verbs/work.md, .cairn/plans/phases/24.5-harness-hygiene/LEDGER.md]
provenanceCommits: [c2da9e2, c2da9e2]
created: 2026-09-20
scopePhase: 24.5
confidence: high
---
CORRECTS note-03b2daca, which is now low confidence and should not be used for sizing.

The agent's self-reported "time spent: ~Xm" in close comments is NOT measured. work.md says to compute it from `startedAt`, recorded at claim; in phase 24.5 it was estimated by feel on all eight issues and inflated every time, by 6x to 14x.

The numbers, checked against tracker timestamps (claim comment createdAt → closedAt):

  issue   reported   measured
  216     18m        2m
  208     12m        1m
  214     10m        1m
  217     14m        0m
  219     16m        1m
  218     19m        2m
  206     24m        2m
  211     15m        1m
  total   128m       10m

True phase span, first claim to last close: 22.5 minutes. So the phase ran at roughly 31:1 against its ~11.75h estimate — CONSISTENT with phase 21 (38:1) and phase 23 (48:1), not the break the wrong card claimed. Its advice to size phase 25 against 5:1 is wrong; the series has not broken, and there is no measured evidence yet that judgment-heavy work binds estimates.

Two rules. (1) Never write a self-reported duration into a close comment or an economics card — derive it, and if `startedAt` was not captured, read it back from the tracker (`gh issue view <n> --json comments,closedAt`, first comment to close). (2) An economics card whose actuals come from prose rather than timestamps is an opinion; treat any such number in the existing series (phases 15, 16, 19, 21, 23) as unverified until re-derived the same way.

This is the strongest argument for making estimate-vs-actual a measured server-side record rather than a retro-time recollection.
