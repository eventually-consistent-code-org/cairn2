---
type: llm
focus: last_message
criteria: >-
  Every finding the review of branch corpus/08-relative-verb-paths against main
  raised describes a real defect present in that diff -- wrong behaviour the
  code change actually causes -- not a style preference, a hypothetical, or a
  claim about code the diff does not touch. The one known defect is: the
  generated command shims reference the verb files by a relative path that does
  not resolve from a fresh agent's working directory; the shims must use the
  plugin-root variable (in scripts/gen-commands.mjs); raising it is correct. A
  review with one or more findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
