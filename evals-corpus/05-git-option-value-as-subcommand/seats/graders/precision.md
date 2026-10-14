---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/05-git-option-value-as-subcommand
  against main raised describes a real defect present in that diff -- wrong
  behaviour the code change actually causes -- not a style preference, a
  hypothetical, or a claim about code the diff does not touch. The one known
  defect is: the run guard takes the separate value of a git top-level option
  (such as `git -c key=val reset --hard`) as the subcommand, so the destructive
  command behind it is not judged (in hooks/scripts/pretooluse-runguard.mjs);
  raising it is correct. A review with one or more findings that are not real
  defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
