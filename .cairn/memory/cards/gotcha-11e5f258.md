---
type: gotcha
provenanceFiles: [server/src/planning/docs-drift.ts]
provenanceCommits: [737b947]
created: 2026-09-02
scopePhase: 14
confidence: low
---
docs_drift's mention matcher searches for "phase N" or the phase name with SPACES (parsePhaseDirName output) — a changelog heading naming the phase in hyphenated form ("auto-docs") does not match, producing a false "docs owe an entry" flag. Bit its own phase on the first ship-time run; workaround is naming "phase N" in the heading; real fix (normalize hyphens both sides) tracked as issue 128.
