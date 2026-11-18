---
type: constraint
provenanceFiles: [server/test/mcp.test.ts, server/test/standalone.test.ts]
provenanceCommits: [ea3e102, ea3e102]
created: 2026-09-08
scopePhase: 15
confidence: high
---
Parallel wave branches that each add MCP tools will double-claim the tool-count pins (both set base+1). Pre-arrange the reconcile in each agent's brief: every branch counts ONLY base + its own additions and notes the collision; the merge coordinator sets the true total at merge (81→83 via two branches both claiming 82 worked exactly this way in phase 15 wave 1). Watch for stray count assertions beyond the two known pin sites — one hid at standalone.test.ts:41 and survived a first resolve pass; the post-merge full-suite run is the backstop that catches it.
