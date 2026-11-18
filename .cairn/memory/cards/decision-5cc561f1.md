---
type: decision
provenanceFiles: [setup/cairn-setup.mjs, harness/cursor/cursor-adapter.mjs, scripts/gen-agents.mjs]
provenanceCommits: [fc33ed6, fc33ed6, bb35253]
created: 2026-07-29
scopeIssue: CRN-71
confidence: high
---
Multi-harness porting shape (locked across waves 1-3): exactly three thin layers per harness — (1) MCP config wiring, (2) the generated AGENTS.md verb-registry spine (scripts/gen-agents.mjs, drift-checked by check-surface), (3) a slash surface where the harness has one. Adapter trees are checked in under harness/, the installer (setup/cairn-setup.mjs) is dependency-free Node, additive, and byte-identical on re-run. Hooks cross harnesses via ONE payload-translating adapter (harness/cursor/cursor-adapter.mjs) — never fork the hook scripts per harness.
