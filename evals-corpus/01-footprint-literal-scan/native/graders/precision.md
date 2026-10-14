---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/01-footprint-literal-scan against
  main raised describes a real defect present in that diff -- wrong behaviour
  the code change actually causes -- not a style preference, a hypothetical, or
  a claim about code the diff does not touch. The one known defect is: the
  string-literal measure pairs one literal's closing quote with the next
  literal's opening quote, so the code between two short strings is counted as
  injected prose (in scripts/check-footprint.mjs); raising it is correct. A
  review with one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
