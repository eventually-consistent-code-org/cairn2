---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/09-model-prices-by-family against
  main raised describes a real defect present in that diff -- wrong behaviour
  the code change actually causes -- not a style preference, a hypothetical, or
  a claim about code the diff does not touch. The one known defect is: the price
  table keys on family name only, so every Opus is priced at the old $15/$75 and
  a model id the table cannot place is silently priced as Sonnet instead of
  being marked unpriced (in hooks/scripts/stop-costtracker.mjs); raising it is
  correct. A review with one or more findings that are not real defects in this
  diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
