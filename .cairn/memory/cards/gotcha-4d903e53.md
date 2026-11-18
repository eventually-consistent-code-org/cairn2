---
type: gotcha
provenanceFiles: [scripts/check-surface.mjs, scripts/gen-agents.mjs, harness/AGENTS-cairn.md]
provenanceCommits: [707768f, 707768f, a2dfab7]
created: 2026-09-13
scopePhase: 19
confidence: high
---
Generated-surface drift lands at MERGE time, not in the branch: a wave agent that renames or reorders files feeding a generated surface (seat template numeric prefixes → roster order → harness spine) can regenerate ITS spine correctly in isolation and still leave main stale after the merge coordinator combines branches. check-surface rule (i) caught exactly this on the review-fold merge — its first live catch. Discipline: after every merge touching generator inputs (templates/seats/, verb files, tool registrations), the merge coordinator re-runs gen-agents + all guards on merged main before closing the issue; branch-side green is not merge-side green.
