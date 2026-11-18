---
type: gotcha
provenanceFiles: [hooks/scripts/posttooluse-observe.mjs]
provenanceCommits: [dc4861d]
created: 2026-09-20
scopePhase: 24.5
confidence: high
---
From the first real observation review (phase 24.5 retro, 394 rows): the buffer's `target` field is only useful for Edit and Write, where it is a real absolute path. For Bash — 340 of the 394 rows, because agent work under bypass-permissions runs mostly through the shell — `target` is a truncated prefix of the command string, so entries read like "SCRATCH=/private/tmp/..." or the first two lines of a heredoc. Hotspot counting across those is close to meaningless.

What the review DID yield: the Edit/Write hotspots were real and matched what the plan predicted (the hooks test file touched 7 times and the hook config 4 times, by the three issues CONTEXT.md had already flagged as sharing those files). And the error flag was false on all 394 rows, so there was no retry churn to find.

Feeds phase 24's memory work (#171 audit memory, #173 observation-backlog surfacing): if the buffer is going to drive hotspot detection, Bash rows need either a parsed target (the file a command touches) or exclusion from hotspot math. Counting raw command prefixes will produce confident nonsense. Low confidence because this is one review on one phase; check it again at the next retro before acting on it.
