---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/07-computed-folder-cd against main
  raised describes a real defect present in that diff -- wrong behaviour the
  code change actually causes -- not a style preference, a hypothetical, or a
  claim about code the diff does not touch. The one known defect is: a folder
  computed by a substitution does not follow the cd candidates, so a write under
  it to a protected path is not seen (in
  hooks/scripts/pretooluse-harnessguard.mjs); raising it is correct. A review
  with one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
