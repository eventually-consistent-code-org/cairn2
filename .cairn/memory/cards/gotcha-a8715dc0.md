---
type: gotcha
provenanceFiles: [hooks/hooks.json, hooks/scripts/posttooluse-observe.mjs, server/src/workspace/context.ts]
provenanceCommits: [591df7b, 3da594e, 5deb040]
created: 2026-11-06
scopePhase: 31
confidence: high
---
CORRECTS gotcha-0f438fa8, gotcha-cd3923da, note-1578abfa and gotcha-1abedcd3, written by the agent in the phase 31 retro on 2026-11-04. Wrong: 'Edit/Write failures surface as tool errors, not hook events' has no evidence, and the failure hook's matcher is Edit|Write|Bash. Guessed: the causes given for failed `git merge --ff-only main` and guard-loop commands. Observation rows keep no error text, so the log shows those commands failed, not why, and at least 8 failed, not 7. Wrong: the three guard files took 128 of 530 edit and write calls, about 24%, not half. Outdated: server/dist/workspace/context.js in the 2.9.3 plugin cache was replaced with main's copy at 23:31 CST on 2026-11-04, so a server launched in a member now reports focusApplied:false. Unproved provenance: gotcha-cd3923da cites template commits, but the brief generator was a scratch script and its evidence is the phase 31 verification record. Still true: the error flag is live since #323, 55 of 1639 rows errored, all Bash; string replacers expand $ patterns; CachedTracker has no branchProtection.
