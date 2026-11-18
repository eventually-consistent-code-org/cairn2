---
type: gotcha
provenanceFiles: [setup/cairn-setup.mjs]
provenanceCommits: [fc33ed6]
created: 2026-07-29
scopeIssue: CRN-71
confidence: medium
---
Idempotent JSON config merges break on key-order churn: rebuilding with `{version: 1, ...existing}` reorders keys when the existing file had a different key order, so JSON.stringify output differs and the "byte-identical re-run" guarantee silently fails. Spread the existing object FIRST, then override individual keys (`{...existing, version: existing.version ?? 1}`).
