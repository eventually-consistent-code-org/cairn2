---
verb: fast
args: "\"<change>\""
status: live
---

Trivial inline change. No plan artifacts, no phase — but still
tracker-first: every change is visible where the team looks.

1. Guardrail first: if the change plausibly touches >3 files or needs
   design judgment, STOP and suggest `/cairn:plan` — before creating
   anything.
2. `issue_create(title: <change>, labels: ["fast"], claim: { task: <one
   line> })` — one call creates the issue and picks it up: in_progress,
   claim comment composed and posted by the server, clock started, base
   commit read from HEAD; it returns `claimAt` and `baseCommit`.
3. Make the change. The moment it grows past 3 files: stop, report, leave
   the issue open with a note, suggest `/cairn:plan`.
4. Tests relevant to the touched files pass → ONE atomic commit
   (conventional message).
5. `issue_close(id)` — close note carries the commit sha. No ledger entry
   (no phase). Report: issue, files, sha.

## Paper trail

Every tracker state transition this verb makes carries a comment — claim
(the `claim` block on `issue_update`: pass `baseCommit` and a one-line
`task`; the server composes the comment and starts the clock from it, so
never post a claim by hand), close (what shipped, evidence;
`issue_close` measures the duration itself and posts it, so compute none),
or parked (why, what remains). Milestone progress
comments where the work is long enough to have milestones; batch small
steps into one comment. Leak-guard discipline applies to every comment.
