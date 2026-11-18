---
type: gotcha
provenanceFiles: [CHANGELOG.md]
provenanceCommits: [5feb2a5]
created: 2026-09-08
scopePhase: 15
confidence: low
---
docs_drift mention needles also break across markdown LINE WRAPS, not just hyphens: a changelog attribution wrapped as "phase\n9.5" failed to match at the v5 summit until reworded to keep "phase 9.5" on one line. When writing changelog headings/attributions for the matcher, keep "phase N" unwrapped. Same root as the hyphen miss (issue 128) — the real fix should normalize whitespace AND hyphens before matching.
