---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/11-clean-control-help-suffix against
  main raised describes a real defect present in that diff -- wrong behaviour
  the code change actually causes -- not a style preference, a hypothetical, or
  a claim about code the diff does not touch. This diff contains no defect at
  all: a review that raises no finding and says so passes; any finding raised
  fails. A review with one or more findings that are not real defects in this
  diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
