# cairn 2.0 — tracker-mirror fidelity (inbound delta ingest + outbound paper trail)

**Date:** 2026-07-23
**Status:** approved design, pre-implementation
**Depends on:** P5″ per-verb command surface (shipped, uncommitted at time of writing)
**Feeds:** engineer-mode spec (2026-07-23-cairn-2-engineer-mode-design.md)

## Outcome

The tracker and cairn stop drifting apart in either direction. Inbound: work
a PM, manager, or teammate adds or edits on the tracker side is detected the
next time cairn looks, and folded into the plan artifacts with one
confirmation. Outbound: every issue cairn works carries a full paper trail —
claim comment, milestone comments, close comment with evidence and time
spent — so a manager reading the tracker alone can follow the work without
ever opening the repo.

The dogfood run exposed both gaps: tracker-side additions were invisible
until `status` stumbled on them, and Jira issues were claimed and closed
with zero comments in between.

## Design law this serves

Tracker mirrors all work — management visibility is a first-class output,
not a side effect. Mechanism lives in the server; verbs sequence tool calls;
policy lives in the policy skills.

---

## Part 1 — inbound: tracker delta ingest

### Trigger model (decided)

Session start + verb piggyback. No polling daemon, no background monitor.

- **SessionStart hook**: the existing resume-injection script additionally
  emits a one-line nudge when the delta cursor is stale (older than the
  last session) — "tracker delta unchecked since <ts>; next planning verb
  will scan." The hook itself never touches the network — it reads only the
  local cursor file. The actual fetch happens on the model's first
  planning-verb call.
- **Verb piggyback**: `status`, `plan`, and `work` call the delta tool as
  step 0. `resync` becomes the explicit two-directional verb: commits the
  plan never saw (existing, git side) + tracker changes the plan never saw
  (new, tracker side).

### New server tool: `plan_tracker_delta`

- **Cursor**: `.cairn/tracker-marker.json` — last-scan timestamp plus a
  snapshot of known issue ids with `updatedAt` and a state/field hash.
  Same first-run semantics as `plan_resync`: initialize the cursor, report
  clean, done.
- **Scan**: one `issue_list`-equivalent adapter call, diffed against the
  snapshot. Returns a categorized delta:
  - `new` — items the snapshot has never seen, grouped epic / story / task
    by the adapter's hierarchy mapping.
  - `edited` — known items whose field hash changed, with per-field diffs
    (title, body, priority, labels, assignee).
  - `stateChanged` — known items whose state changed tracker-side
    (closed, reopened) without a corresponding cairn action.
- **Cursor advance is explicit**: the tool takes an `ack` parameter.
  A bare call peeks without advancing, so rendering the delta never
  swallows it; the verb acks only after the adoption flow completes.
  Un-acked deltas re-surface on every scan until handled or declined.

### Integration flow (decided: report + one-tap adopt)

The verb renders the grouped delta, then batches the adoption into one
AskUserQuestion. Per category:

- **New epic** → `plan_import` (existing tool) — becomes a phase with the
  standard gap interview.
- **New story/task** → best-fit phase by judgment (file-path and topic
  match against each phase's PLAN.md, reasoning shown), folded in via
  `plan_issues_set` plus a PLAN.md task note. No confident fit → offer
  phase choice explicitly.
- **Edited item** → *integrates forward.* A cursor-detected edit is
  provenance-known newer human intent, so it wins over the plan docs:
  title/scope edits refresh PLAN.md task text, priority changes update
  wave/ordering notes, body rewrites refresh the phase CONTEXT.md. The
  static precedence rule ("git plan docs win") continues to govern only
  divergence of unknown origin found outside the delta flow. One
  exception: an edit that collides with a locked decision recorded in
  CONTEXT.md stops for the user — conflict, not adoption — with the
  collision spelled out.
- **State change** → flagged with its remedy: PM-closed-unverified points
  at `verify` (or reopen), PM-reopened points at the phase's plan.
- **Declined items** → labeled `cairn:backlog` so they keep surfacing in
  `status` marks; declined edits get a ⚠ reconcile comment on the issue so
  the editor sees why the plan didn't follow.

### Error handling

Typed errors per the shared rules — `TRACKER_DOWN` or `RATE_LIMITED`
reports the code and next action, never blocks git-side operations, and
leaves the cursor untouched (next successful scan sees the full delta).

---

## Part 2 — outbound: work paper trail + time tracking

### Comment lifecycle (every issue-claiming verb)

Applies to `work`, `fast`, `trace`, and `audit --fix` — any verb that
claims or closes a tracker issue. No silent state transition anywhere:
every transition carries its comment.

- **Claim comment** — posted with the `in_progress` transition: starting
  now, wave/task context, base commit reference.
- **Progress comments** — real milestones only: TDD RED/GREEN/REFACTOR
  landed, subtask complete, blocker hit, trace spun off. Judgment cadence;
  several small steps batch into one comment. Tracker noise is treated as
  a failure mode, not diligence.
- **Close comment** — posted before `issue_close`: what shipped in plain
  language, commit range, test evidence, time spent.
- **Early stop** — a parked issue gets a comment stating why and what
  remains, alongside the in_progress state it keeps.
- **Leak guard** — the existing comment discipline (plain language, no
  code blocks, no internal refs a non-engineer bounces off) applies to
  every comment above, same as `trace`/`audit`/`triage` today. Commit
  references appear as short refs on their own line, not code dumps.

### Time tracking

- `work` records `startedAt` at claim, next to the existing `baseCommit`
  capture. Close computes wall-clock elapsed.
- **Adapter capability flag `worklog`**: adapters declare support. Jira
  maps to a real worklog entry (`timeSpentSeconds` on the close). Backends
  without worklog (GitHub, others) fold a "time spent: ~Xm" line into the
  close comment. Capability-gated — never errors on unsupported backends.
- **Server change**: `issue_close` gains optional `timeSpentMinutes`; the
  adapter maps it or falls back to the comment line.
- **Stated honestly**: wall-clock between claim and close includes think
  time and review pauses; comments and worklogs label it approximate.

---

## Surface cost

- New server tool `plan_tracker_delta` (+ contract tests, per-adapter
  hierarchy mapping for epic/story/task grouping).
- `issue_close` schema gains `timeSpentMinutes`; adapters gain the
  `worklog` capability flag (Jira implements; others fall back).
- Verb doc edits: `resync` (two-directional), `status`/`plan`/`work`
  (step-0 piggyback), `work`/`fast`/`trace`/`audit` (comment lifecycle).
- One hook-script addition (cursor-staleness nudge, local-only).
- No new verb. No new command shim. No new config key.

## Testing

- Contract tests for `plan_tracker_delta`: first-run init, clean scan,
  each delta category, peek-vs-ack cursor semantics, `TRACKER_DOWN`
  leaves cursor untouched.
- Adapter tests: Jira worklog mapping; fallback comment line on a
  non-worklog backend.
- Drill addition to the dogfood script: PM-side add + edit mid-phase,
  verify the next `status` surfaces both and adoption lands them; one
  full `work` issue verifying claim/progress/close comments and a worklog
  entry exist tracker-side.
