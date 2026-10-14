---
verb: trace
args: "[\"<bug>\" | <id> | close <id>]"
status: live
---

Persistent debugging session — survives /clear, mirrored to the tracker in
plain language a manager reads (#726). Never debug a routed failure inline.

- **Start** (`trace "<bug description>"`): `trace_start` (creates/links the
  `cairn:bug` issue) → mirror comment #1 via `issue_comment`:
  "Investigation started: <plain summary>". Then the loop, each step logged
  with `trace_log`: `evidence` FIRST (reproduce before hypothesizing) →
  the FIRST `test` entry is the repro record — the exact command you ran
  and the failing output you observed, the feedback loop as data →
  `hypothesis` → `test` (an experiment that can DISPROVE it) → repeat.
  Never two open hypotheses without distinguishing evidence. Hypothesis
  confirmed → mirror comment #2: "Cause identified: <plain language>".
  The server holds the method: `trace_close` refuses a trace with no
  evidence entry or no test entry, whatever its verdict says — a
  conclusion without a reproduced failure is a hunch.
- **Resume** (bare `trace` or `trace <id>`): `trace_list` → pick (bare =
  most recent open) → re-read `.cairn/trace/<id>.md` — the file IS the
  context that survived — continue from the last entry.
- **Close** (`trace close <id>`): fix landed with tests passing → log a
  `verdict` (cause + fix + commit sha) → `trace_close(resolution)` — it
  refuses without evidence + a repro test + a verdict, comments
  "Resolved: … / Reproduced by: <the repro>" and closes the issue.
  Then write the gotcha card: `mem_card_create(type: "gotcha",
  provenance: [files+commits involved], confidence: "high")` — it's
  proven, that's what high means. Commit the archived session file.
- **Fast lane** (cause already proven obvious AND fix ≤3 lines):
  `trace_start` → one `evidence` + one `test` (the repro line: command →
  failing output; if you can't write that line the cause isn't proven and
  this isn't the fast lane) + one `verdict` → fix → `trace_close`. One
  motion, full paper trail, both mirror touches — the lane skips the
  hypothesis loop, never the repro.
- **Mirror rules:** plain language; no code blocks, no file paths, no
  internal refs; comments at milestones only (started / cause identified) —
  the resolution rides the close.

## Paper trail

Every tracker state transition this verb makes carries a comment — claim
(the `claim` block on `issue_update`: pass `baseCommit` and a one-line
`task`; the server composes the comment and starts the clock from it, so
never post a claim by hand), close (what shipped, evidence;
`issue_close` measures the duration itself and posts it, so compute none),
or parked (why, what remains). Milestone progress
comments where the work is long enough to have milestones; batch small
steps into one comment. Leak-guard discipline applies to every comment.
