---
verb: retro
args: "[<N> | --milestone]"
status: live
---

Write the lessons a future session needs (#1003). Default scope: the last
phase with VERIFICATION.md; `--milestone` spans every phase of the current
milestone (including just-archived `milestones/v<N>/`).

1. Gather evidence: the scope's LEDGER.md lines (what shipped, commit
   ranges), VERIFICATION.md (what passed/failed and how), `git log` over
   the ledger ranges, closed issues (`issue_get` per ledger issue id).
2. Extract lessons — what surprised, what broke, what a future session
   must know. Draft each as a card: `type` decision/constraint/gotcha,
   provenance = the files+commits from the ledger range that prove it,
   confidence: `high` = verified by this scope's events, `medium` =
   plausible inference, `low` = hunch worth recording.
   - **Observation review:** the log is the live file `mem_stats` names in
     `observations.path` (one per repository in the cairn home, shared by
     every worktree, #362) plus its closed segments `<stem>.<stamp>.jsonl`
     beside it (passive capture from the PostToolUse hook — tool, target,
     error flag per call). First close the live file: rename it to a segment
     in the same `<stem>.<yyyymmdd-hhmmss>-NN.jsonl` shape (the hook starts
     a fresh one on its next append), then read every closed segment. Look
     for candidate patterns the ledger can't show: repeated
     error→retry churn on one file or command (a gotcha hiding there),
     hotspot files edited far more than their diff size explains. A pattern
     worth keeping becomes a draft card like any other — confidence `low`
     unless the ledger corroborates it, provenance pointing at the real
     files. Observations NEVER become cards without this review, and after
     the batch is approved, delete exactly the segments you reviewed —
     never truncate or rewrite the live file, hooks may be appending to it.
     Retro is the gate and the single consumer (#351). How deep the pile is
     comes from `mem_stats`' `observations` block (count, oldest-entry
     age); past `memory.observationWarnThreshold` the session banner has
     already been asking for this run.
3. Re-grade prior knowledge: `mem_card_recall` scoped to this phase — for
   each card, did this scope's events confirm or contradict it? Confirmed
   → `mem_card_update` confidence up one step. Contradicted → down to
   `low`, and draft the corrected lesson as a NEW card (bodies are
   immutable — corrections are new cards, not edits).
4. Compaction check (#172) — the capacity guard's only action. Call
   `mem_compact(mode: 'propose')`. It reports the card store's token size
   against its threshold plus the aged low-confidence cards that would be
   retired, taken from the same `aged` list `mem_stats`' `cards` block
   reports — never re-derive "aged low-confidence" yourself, the copy that
   drifts is the one that deletes cards. `triggered: false` → say the
   one-line `reason` in the report and propose nothing. `triggered: true` →
   fold the batch into the step 5 question as a third item: these N cards
   retire into ONE dated archive card, ~X tok reclaimed, the archive
   carrying the union of their provenance commits. Show the card ids and
   the `archiveBody` it would write — the human approves real text, not a
   count.
5. ONE AskUserQuestion approving the whole batch (new cards + re-grades +
   any retirements), then write via `mem_card_create` / `mem_card_update`,
   and `mem_compact(mode: 'apply', ids: [...])` with exactly the ids that
   were approved. No second question — a retirement the human did not see
   in that one gate does not happen.
6. Report: cards written, cards re-graded (old → new confidence), the
   one-line reason each, and — when a compaction ran — the archive card id,
   what it retired, and the tokens reclaimed.

Compaction is rotation, not decay. Age only *selects* candidates; nothing
leaves the store on a timer, no confidence rots on its own, and bodies stay
immutable — the archive is a NEW card and the retired ones are deleted, never
edited into a tombstone. The archive's provenance is the whole point: the
bodies go, the commits that proved them stay.
