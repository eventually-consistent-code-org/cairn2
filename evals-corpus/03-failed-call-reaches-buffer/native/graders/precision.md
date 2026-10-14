---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/03-failed-call-reaches-buffer
  against main raised describes a real defect present in that diff -- wrong
  behaviour the code change actually causes -- not a style preference, a
  hypothetical, or a claim about code the diff does not touch. The one known
  defect is: a failed tool call never reaches the observation buffer because the
  observe hook listens on PostToolUse only and a failure arrives as
  PostToolUseFailure, so the error flag can never be true (in hooks/hooks.json);
  raising it is correct. A review with one or more findings that are not real
  defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
