---
type: decision
provenanceFiles: [hooks/scripts/pretooluse-runguard.mjs, hooks/scripts/shell-words.mjs, hooks/scripts/pre-push.mjs]
provenanceCommits: [e4cf681, e4cf681, 690cb05]
created: 2026-11-05
scopePhase: 31
confidence: high
---
Security-31 (2cf8fd6, 21 findings #492–#512, 3 critical, 0 refuted by the panel) repeats security-30's shape: each phase-31 fix closed the issue's LITERAL spelling and left a sibling open (`:` closed, `?*`/`src/..` open; `$F` expanded in the harness guard, not the run guard). Decided at verify: the findings are the NEXT hardening phase's backlog, not a reopen of 31 — the phase's criteria hold at the letter. Two roots are structural, not spellings, and should lead that phase: (1) the shared shell reader decision never landed in the run guard (#494, #501, #509 — same-line variables, variable refspecs, parameter expansions pass it); (2) the git-layer backstop (#456 pre-push hook, #465 hooks-path) added surfaces the harness guard does not zone (#492 the hook folder, #497 global core.hooksPath, #508 agent-run `cairn-setup --git-hooks`). A spelling-by-spelling wave will produce security-32 with the same table.
