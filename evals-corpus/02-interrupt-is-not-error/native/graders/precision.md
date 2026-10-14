---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/02-interrupt-is-not-error against
  main raised describes a real defect present in that diff -- wrong behaviour
  the code change actually causes -- not a style preference, a hypothetical, or
  a claim about code the diff does not touch. The one known defect is: an
  interrupted (cancelled) tool call is recorded as an error row in the
  observation buffer instead of a cancellation (in
  hooks/scripts/posttooluse-observe.mjs); raising it is correct. A review with
  one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
