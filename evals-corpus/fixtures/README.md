# Scorer fixtures

Hand-written `aggregate-result.json` files that exercise
`scripts/eval-corpus-score.mjs` without an eval run. Not corpus items; the
harness discovers cases by `prompt.md`, and there is none here.

- `graderless-run/` -- one seats case with one graded run and one run that
  ended on an API error (no grader results), one native case with one graded
  run. The scorer must report `errored: 1`, say "1 of 2 run(s) graded" for
  the seats arm, keep recall/precision at 100% over the graded run only, and
  exit 1 (#377).
