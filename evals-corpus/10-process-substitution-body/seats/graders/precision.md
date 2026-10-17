---
type: llm
focus: last_message
criteria: >-
  Judge only the findings the review of branch
  corpus/10-process-substitution-body against main presents as defects -- wrong
  behaviour the code change actually causes (a bug, a regression, broken
  handling). Each such finding must be a real defect present in that diff, not a
  style preference, a hypothetical, or a claim about code the diff does not
  touch. The one known defect is: the body of a process substitution (`<(...)` /
  `>(...)`) or an arithmetic expansion (`$((...))`) is no longer read as
  commands by the shared shell reader, so a guarded command or protected write
  inside one runs unseen by both guards (in hooks/scripts/shell-words.mjs);
  raising it is correct. Remarks the review itself labels as clarity, naming,
  comment, documentation, architecture, test-coverage or style notes are outside
  the correctness axis this corpus scores and are ignored, as is anything the
  review says about its own tooling or record-keeping. A review with one or more
  defect findings that are not real defects in this diff fails.
---
Every finding raised is a real defect in the diff; nothing invented.
