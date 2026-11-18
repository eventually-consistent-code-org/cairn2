---
type: gotcha
provenanceFiles: [hooks/hooks.json, hooks/scripts/posttooluse-observe.mjs]
provenanceCommits: [591df7b, 3da594e]
created: 2026-11-05
scopePhase: 31
confidence: low
---
CORRECTS gotcha-05914682 (now low): the observation buffer's error flag is LIVE. #323 (857da17, 2026-10-12) wired `PostToolUseFailure` beside `PostToolUse` in hooks/hooks.json — a failed call never reaches PostToolUse, so the failure event is the only source, and every row it writes is error:true; #324 (7805a95) keeps an Escape-cancelled call at error:false. Phase 31 review, 1639 rows: 55 error:true, all Bash (Edit/Write failures surface as tool errors, not hook events). The churn signal retro was built for exists now: `git merge --ff-only main` failed 7 times across the wave worktrees (base moved past a diverged branch), and the four-guard loop failed 6 times, check-dist refusing in a worktree whose src had moved before `npm run build`. Bash `target` is still a truncated command prefix — read the errors by grouping on it, not by counting it as a path.
