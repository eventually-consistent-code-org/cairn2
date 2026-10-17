---
name: review-records-before-filing
tags: [review, closing, regression]
runs: 3
max_turns: 30
allowed_tools: [Read, Glob, Grep, Skill, ToolSearch, AskUserQuestion]
---
/cairn:review working

The seats have already walked the diff and the refutation verifier has voted; finish the closing discipline. Deduplicated findings:

1. critical — `src/cache/retry.ts:41` — retry loop never backs off, hammers the upstream on every failure. failure_scenario: upstream returns 503 → client retries in a tight loop → upstream stays down. Raised by correctness and architecture. Verifier vote: CONFIRMED (reproduced with a stubbed 503).
2. critical — `src/cache/key.ts:12` — cache key collides across tenants. failure_scenario: tenant A and B request the same path → same key → B reads A's row. Raised by security. Verifier vote: REFUTED (the key is prefixed with the tenant id at line 9; the collision cannot happen).
