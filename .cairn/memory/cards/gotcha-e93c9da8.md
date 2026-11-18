---
type: gotcha
provenanceFiles: [server/test/peers-run.test.ts]
provenanceCommits: [167c2b7]
created: 2026-07-29
scopeIssue: CRN-73
confidence: high
---
execvp skips non-executable PATH entries and keeps searching: prepending a non-exec stub to the real PATH does not force EACCES — a real binary later on PATH gets executed instead (test hung 5s running the actual grok CLI). Test PATH isolation must be full replacement (stub dir + known-clean system dirs like /usr/bin:/bin). The trap is self-correlated: machines set up for multi-harness work have the very CLIs the tests stub, so CI green (no CLIs) masks local breakage.
