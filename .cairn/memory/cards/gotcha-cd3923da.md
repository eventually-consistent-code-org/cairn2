---
type: gotcha
provenanceFiles: [skills/cairn-trailhead/verbs/work.md, templates/wave-brief.md]
provenanceCommits: [b8ace40, 7693dd7]
created: 2026-11-05
scopePhase: 31
confidence: medium
---
Wave-brief generation: `String.prototype.replace` with a replacement STRING interprets `$&`, `$1`, `$'` and `$\`` patterns inside the substituted text. Issue bodies carry shell (`$PWD`, `${HK:1}`, `"$F"`) so phase 31's brief generator left lead E's slots unfilled and duplicated lead B's text. Fix that held: pass a FUNCTION as the replacer (its return value is inserted literally) and throw when any `{{slot}}` survives substitution, so a malformed brief never dispatches. Also measured: Workflow worktrees start at the SESSION's start commit, not the coordinator's HEAD, so brief rule one stays `git merge --ff-only main`; the ff-only failed 7 times across the five waves when main had moved past a diverged branch (observation review).
