# cairn evals archive

Orphan branch of [cairn2](https://github.com/eventually-consistent-code-org/cairn2).
Holds the material that is useful to the project but must not ship with
the plugin: the behavioral eval suite, the review corpus, and the
spec/plan/research history. It shares no commits with `main`.

**Outcome:** the marketplace ref ships the plugin and nothing else (issue
#403 — the portal held the plugin for review because the tree carried
~1,100 files, half of them fixtures and planning history).

## What is here

```
evals/              behavioral eval suite — `claude plugin eval` cases, graders, mocks
evals-corpus/       ADR 0012's review corpus (#334) — eleven recorded defects, two arms each
docs/superpowers/   design specs, implementation plans, research (2026-07 → 2026-10)
```

Split from `main` at commit `1f33cf6` (2026-10-17); every file is
byte-identical to that commit. Later edits land here, on this branch —
`main` no longer carries these paths.

## How it is consumed

**CI.** `.github/workflows/evals.yml` on `main` checks this branch out
beside the plugin (`actions/checkout` with `ref: evals-archive`,
`path: evals-archive`), copies `evals-archive/evals` into place as
`evals/`, and runs the suite exactly as before. Results and verdicts are
unchanged: `evals/results/ci/` → `scripts/eval-verdicts.mjs` → job
summary → 14-day artifact.

**Local.** From a `main` checkout:

```bash
git worktree add evals-archive evals-archive          # gitignored on main
env -u ANTHROPIC_API_KEY claude plugin eval . --eval-dir evals-archive/evals --json --no-publish --max-cost-usd 3
env -u ANTHROPIC_API_KEY claude plugin eval . --eval-dir evals-archive/evals-corpus --scaffold --trust-plugin --ablation none ...
node scripts/eval-corpus-cases.mjs                    # regenerates evals-archive/evals-corpus from main's git history
```

`scripts/eval-corpus-cases.mjs` and `server/test/eval-verdicts.test.ts`
on `main` look for the archive at `evals-archive/` (or
`$CAIRN_EVALS_ARCHIVE`); the live-suite test skips cleanly when it is
absent, and the generator fails loud with the worktree command above.

## Editing

Commit here as on `main` — conventional commits, same author identity.
`docs/superpowers/` is history: read it, link it, do not rewrite it.
Eval cases and the corpus are live and move with the plugin's verbs;
when a verb's behaviour changes, the case changes on this branch and the
pointer in `docs/EVALS.md` on `main` says what the suite grades.

More to come...
