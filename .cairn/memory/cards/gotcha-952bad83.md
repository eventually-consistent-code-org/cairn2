---
type: gotcha
provenanceFiles: [hooks/scripts/posttooluse-observe.mjs]
provenanceCommits: [24a7d30]
created: 2026-09-20
scopePhase: 24
confidence: high
---
REFINES gotcha-8e003ebb, now medium rather than low: the observation buffer's hotspot data is genuinely useful for edit and write calls, and during wave dispatch it is better than expected.

Second review, 744 rows over phase 24, zero errors again. The split holds: 623 of 744 rows are shell calls whose `target` is a truncated command string and worthless for hotspot counting. But the 121 edit and write rows carry real absolute paths — and because wave agents work in isolated worktrees, the path prefix identifies WHICH AGENT made each edit.

That turns the buffer into a per-agent activity record for free. The phase-24 hotspots read straight off it: one agent touched the token estimator nine times, another the cost tracker and its report fifteen times between them, a third the runbook five times. That is a usable picture of where a wave's effort actually went, which nothing else in the system records — the ledger has summaries, not file-level effort.

Two consequences worth acting on. Hotspot analysis should filter to edit and write rows and ignore shell entirely, rather than trying to parse command strings. And the worktree prefix should be preserved rather than normalised away, because it is the only per-agent attribution available.

Still open from the original card: shell rows need either a parsed target or explicit exclusion from hotspot math. Counting raw command prefixes will produce confident nonsense.
