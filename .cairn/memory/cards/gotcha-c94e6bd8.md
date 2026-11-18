---
type: gotcha
provenanceFiles: [scripts/check-footprint.mjs, hooks/scripts/sessionstart-continuity.mjs]
provenanceCommits: [5cf1597, 786abb4]
created: 2026-10-14
scopePhase: 26
scopeIssue: 342
confidence: high
---
Never measure "string literals" in JS source with a quote-pairing regex. /"(...){40,}"/ has no notion of where a literal begins: a literal too short to match leaves its closing quote as the next span's opening quote, so the code between two short strings counts as prose, and adding any short "utf8" flips which spans are real. check-footprint's SessionStart measure did exactly this (1923 chars counted where the hook holds 596) and went over budget by 50 tokens on #328 with zero new prose. The fix is a character walk with string state — open quote, body, matching close, escapes folded — across double, single AND template quotes (the resume block's prose lives in template literals the regex never saw). Any future guard that reads "prose" out of source should reuse stringLiterals() in scripts/check-footprint.mjs rather than a regex.
