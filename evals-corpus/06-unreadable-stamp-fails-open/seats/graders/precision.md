---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/06-unreadable-stamp-fails-open
  against main raised describes a real defect present in that diff -- wrong
  behaviour the code change actually causes -- not a style preference, a
  hypothetical, or a claim about code the diff does not touch. The one known
  defect is: an unreadable drift stamp or run list makes the run guard allow the
  push (fail-open) instead of refusing it with the reason (in
  hooks/scripts/pretooluse-runguard.mjs); raising it is correct. A review with
  one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
