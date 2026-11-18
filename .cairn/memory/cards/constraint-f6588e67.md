---
type: constraint
provenanceFiles: [server/src/seats/signals.ts, templates/seats/04-security.md]
provenanceCommits: [f0c518f, f0c518f]
created: 2026-09-13
scopePhase: 19
confidence: medium
---
Wave-agent briefs should state INVARIANTS alongside tasks, not tasks alone. Phase 19's dispatch brief stated "the auto dial must never gate the default panel" and "no new tools" as intent; the agent then made two correct deviations the task list alone would have forbidden — rewriting shipped seats' placeholder signals onto the derivable standard vocabulary (placeholders would have gated the whole default panel under auto, violating the invariant while matching the letter) and adding a dispatch field to the EXISTING seat_roster output instead of proposing a new tool. Both deviations were reported, both survived review unchanged. Briefing shape: tasks say what to build, invariants say what must stay true — agents given both self-correct spec bugs instead of shipping them.
