---
type: llm
focus: last_message
criteria: >-
  Judge only the findings the review of branch corpus/09-model-prices-by-family
  against main presents as defects -- wrong behaviour the code change actually
  causes (a bug, a regression, broken handling). Each such finding must be a
  real defect present in that diff, not a style preference, a hypothetical, or a
  claim about code the diff does not touch. The one known defect is: the price
  table keys on family name only, so every Opus is priced at the old $15/$75 and
  a model id the table cannot place is silently priced as Sonnet instead of
  being marked unpriced (in hooks/scripts/stop-costtracker.mjs); raising it is
  correct. Remarks the review itself labels as clarity, naming, comment,
  documentation, architecture, test-coverage or style notes are outside the
  correctness axis this corpus scores and are ignored, as is anything the review
  says about its own tooling or record-keeping. A review with one or more defect
  findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
