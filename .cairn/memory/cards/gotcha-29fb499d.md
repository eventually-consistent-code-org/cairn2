---
type: gotcha
provenanceFiles: [skills/cairn-trailhead/verbs/work.md, templates/wave-brief.md]
provenanceCommits: [24a7d30, 24a7d30]
created: 2026-09-20
scopePhase: 24
confidence: high
---
Worktrees are provisioned from a STALE base, and telling the agent to check is a proven fix.

Across three waves and eleven dispatches in phase 24, six worktrees came up roughly ten commits behind the tree they were dispatched from — in every case behind the merges of the PREVIOUS wave. The provisioning does not track the coordinator's current HEAD.

The damage is not hypothetical. In wave 2 only one agent of four noticed; the other three ran their whole task against a tree missing the entire previous wave, so the suite counts they reported described nothing real. Worse, one of them (#187) rewrote a runbook entry back to its older wording because the newer version — landed hours earlier by #178 — did not exist on its base. That is a silent revert, and it reached the merge looking like an ordinary conflict.

THE FIX, measured: wave 3's brief opened with an explicit instruction to run `git log --oneline -1`, check whether HEAD is an ancestor of main, fast-forward with `--ff-only` if so, and report whether it had to — with the expected base commit NAMED in the brief so the agent can compare. Three of three agents detected the staleness and corrected themselves before doing any work. Wave 2, without that instruction, got one of four.

Put the base check at the TOP of every wave brief, name the expected commit, and collect the answer in the worker's structured result so the coordinator sees which worktrees were stale rather than inferring it from suspicious numbers. Never let an agent rebase — `--ff-only` only, because a rebase renumbers shas the ledger and tracker already cite.
