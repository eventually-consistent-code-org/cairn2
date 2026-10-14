---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/04-git-dash-c-folder against main
  raised describes a real defect present in that diff -- wrong behaviour the
  code change actually causes -- not a style preference, a hypothetical, or a
  claim about code the diff does not touch. The one known defect is: the harness
  guard does not read a `git -C <folder>` as a directory change, so a protected
  path reached through -C is written past the guard (in
  hooks/scripts/pretooluse-harnessguard.mjs); raising it is correct. A review
  with one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
