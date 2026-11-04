---
verb: status
args: "[--stats]"
status: live
---

Show project status:

0. `plan_tracker_delta()` — peek. Anything in the delta → say so in one
   line ("tracker delta: 2 new, 1 edited — `/cairn:resync` to integrate")
   and continue; a non-empty delta never blocks this verb. First run:
   the tool initializes silently, don't mention it.
1. `plan_status()` — phase table: number, name, artifacts present
   (C/R/P/V), issue count.
2. For the active phase (`context_get`), `issue_get` each referenced issue and
   show id · title · state · assignee.
3. `plan_drift()` — append flagged items, each with its one-line remedy.
   `stale-issue` and `stale-branch` are ADVISORY: render them in their own
   short "gone quiet" group after the real drift, newest silence last, and
   never let them outweigh a missing or closed-unverified issue in the
   report's lead. Nothing to say when the group is empty — silence about
   silence.
   (missing → recreate + `plan_issues_set`; closed-unverified → verify or reopen).
4. `plan_unplanned()` — tracker issues no plan references. If any: list
   id · title · assignee and offer adoption (`/cairn:plan <N>` folds them in,
   or `/cairn:import` if they belong to a whole unmapped phase).
5. Marks: from the open-issue list, group `cairn:backlog` and `cairn:seed`
   labeled issues separately from phase work. For each open seed, read its
   `Trigger:` line and flag it when current project state reads as meeting
   the trigger — firing is your judgment call to surface, the user's to act.
- Open traces: `trace_list(status: "open")` — report id, description, age
  (from created), linked issue, and last entry kind. An open trace is
  unfinished debugging — surface it every time.
- Open sessions: `session_landscape()` — report `openByKind` in plain
  language beside the trace detail above (e.g. "open sessions: 1 trace, 2
  probes, 0 drafts"). An open probe or draft is unfinished spike/sketch
  work — surface it every time, same as an open trace.
- Dependency graph (trackers with `hasDependencies` — e.g. `local`):
  `graph_report()` — render "Ready now:" from `frontier` (the pick-next-work
  list, this is the headline), any `priorities` rows as
  "`<id>` effectively `<effective>` (inherits from `<inheritedFrom>`)", and
  when `dangling` is non-empty, one ⚠ line: "N broken issue links —
  `/cairn:medic --repair` removes them." Skip the whole block silently on
  `UNSUPPORTED` backends.
- Open audit/review findings: `issue_list` filtered by label `cairn:audit`
  and again by `cairn:review`, reported in plain language beside the
  session detail above (e.g. "open audit findings: 2 · open review
  findings: 0"). These are outstanding Critical/Important findings still
  waiting on a fix or a trace — surface them every time, same as an open
  trace.
6. Keep it to one screen; end with the obvious next `/cairn` step.

## `--stats`

Project stats fold in here — no new verb, no new tool, zero surface growth.
Every number is a LIVE read at the moment `--stats` runs, never a cached or
remembered count from an earlier session:

- `plan_status()` — phase count, artifacts present per phase.
- `issue_list()` — open/closed counts, grouped by label
  (`cairn:backlog`, `cairn:seed`, `cairn:audit`, `cairn:review`, `cairn:bug`,
  `cairn:spike`, `cairn:sketch`, `cairn:thread`, whatever the tracker
  actually carries).
- `mem_stats()` — memory index size (chunk count, approximate token usage,
  `bannerTokens`, `tokensSavedVsFullInjection`).
- `session_landscape()` — open/resolved counts by kind (trace, probe, draft,
  thread), phase groupings.
- `.cairn/audit/` records dir — count of audit/review/triage records on
  disk, most recent scope + date per mode.
- Agent spend: run the plugin's `hooks/scripts/cost-report.mjs` (Bash,
  `node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/cost-report.mjs"`) — approximate
  session-cost totals rolled up by phase and issue from the Stop-hook
  metrics log, plus a `task reports` line when a session fanned out — how
  much of the coordinator's peak context was subagent reports. Say
  "approximate" when rendering; no log yet → skip the line silently. On a
  pluginless harness the copied verb names the helper in the scripts folder
  cairn-setup installs beside it, not the plugin root (asserted by
  setup.test.ts, #474).
  `--reports` breaks the report bytes out per coordinator session.

Render as a compact table, one line per source above. State plainly that
these are live reads, not a cached snapshot — the whole point of folding
stats into `status` instead of a report file is that the numbers can never
go stale between runs.
