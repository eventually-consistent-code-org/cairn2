---
type: llm
focus: last_message
criteria: >-
  Judge only the findings the review of branch
  corpus/03-failed-call-reaches-buffer against main presents as defects -- wrong
  behaviour the code change actually causes (a bug, a regression, broken
  handling). Each such finding must be a real defect present in that diff, not a
  style preference, a hypothetical, or a claim about code the diff does not
  touch. The one known defect is: a failed tool call never reaches the
  observation buffer because the observe hook listens on PostToolUse only and a
  failure arrives as PostToolUseFailure, so the error flag can never be true (in
  hooks/hooks.json); raising it is correct. Remarks the review itself labels as
  clarity, naming, comment, documentation, architecture, test-coverage or style
  notes are outside the correctness axis this corpus scores and are ignored, as
  is anything the review says about its own tooling or record-keeping. A review
  with one or more defect findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
