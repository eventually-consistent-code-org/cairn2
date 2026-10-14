---
verb: work
args: "<N> [--wave [N]]"
status: live
---

Execute the given phase per the `cairn-planning` skill.

**Mode check:** read `user.mode` from cairn.json (`config_get`). Absent or
`vibe` → the procedure below runs exactly as written. `engineer` → the
pairing overlay applies:

- After step 1's issue list, ask "mine or yours?" ONCE for the whole
  wave/phase — one AskUserQuestion listing the issues, the user marks
  which they're taking. Never per-issue friction.
- **cairn-claimed** issues run the unchanged lifecycle below, except the
  finished work lands as a branch/PR and does NOT merge — the close
  comment links the PR and names the human as reviewer (no-self-merge
  gate; `ship` enforces it).
- **human-claimed** issues: cairn scaffolds and steps back — create the
  branch, move the issue to in_progress with `assignee: <user.handle>`,
  and post the claim comment carrying the context: the PLAN.md task text,
  files likely touched, and (for `tdd:` issues) the failing test written
  first. Then wait — do not write further code for that issue.
- **Human says done** (or `resync`/`plan_tracker_delta` shows their
  commits landed): run the tests and the phase's verify posture against
  their work, then the standard close — close comment with evidence
  ("logged by cairn for <handle>"), `issue_close` (it measures the
  duration from the claim; pass no time of your own), ledger entry with
  their commit range. Offer `/cairn:review` on their diff — offer, not force; a
  decline is recorded in the close comment as "review declined".
- Wave ordering, TDD gates, and the failed-issue stop rule apply
  identically regardless of who holds an issue.

0. `plan_tracker_delta()` — peek. Anything in the delta → say so in one
   line ("tracker delta: 2 new, 1 edited — `/cairn:resync` to integrate")
   and continue; a non-empty delta never blocks this verb. First run:
   the tool initializes silently, don't mention it.
1. `plan_status()` → this phase's `issues` list. Empty → stop and point at
   `/cairn:plan <N>`.
2. `--wave` (only when PLAN.md has `wave_N` frontmatter — else say so and
   point at `/cairn:plan <N>`): run waves in order (`--wave N` runs just
   that wave). Every issue still runs the full per-issue lifecycle below
   (claim → work → close → ledger) — the dispatch mechanism and who
   holds each step change; the lifecycle never does. Wave N+1 starts
   only when every wave-N issue is closed and merged. A failed issue:
   let the wave's others finish, then STOP before the next wave and
   report — never build on possibly-broken foundations.

   **Wave sizing — the platform's ten-agent guideline.** Count agents,
   not issues. The harness runs about ten subagents at a time and queues
   the rest, so a wave dispatched past that number doesn't run faster,
   it just runs deeper in the queue. Size the wave so the agents in
   flight stay around ten. A fan-out that is inference-bound rather than
   machine-bound — workers waiting on model time, not on a build — can
   raise that ceiling with the `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`
   environment dial; when a wave only fits under a raised dial, say so
   in the wave report, so nobody later reads it as a wave that fit by
   default.

   **Brief composition (both dispatch paths):** every worker's prompt
   composes from `templates/wave-brief.md` — read the template, fill its
   `{{issue}}` (id + title + body), `{{plan_excerpt}}` (this issue's
   PLAN.md task text plus any locked CONTEXT.md decisions that bind it),
   and `{{rules}}` (wave specifics: expected base sha, setup commands,
   this session's commit trailer block) slots; the standing rules
   (worktree/commit/leak-guard/report shape) already live in the
   template — never retype them. Fill the slots where they sit: the
   template renders the invariants LAST on purpose (recency end of the
   window) and keeps dated content out of the static prefix, so a
   hand-filled brief that "tidies" the order loses the point of it. When the issue's PLAN.md task line
   carries a `` `seat: <name>` `` annotation (grammar in `plan.md`),
   pull that seat from `seat_roster` and fill `{{seat_framing}}` at the
   seat's declared dose — minimal: lens only; standard: + categories +
   honesty line; full: + anchors + the lens body. A name matching no
   valid roster seat: note it in the wave report and dispatch seatless.
   No annotation → fill the slot empty: today's freehand brief, just
   templated. Internal seats are framing lenses — cheap, same-model;
   the `peers` council stays the genuinely adversarial external check.
   Seat framing changes the brief ONLY — the worker structured-output
   contract below is untouched. Two dispatch paths, checked in order:

   **Primary — the harness has the `Workflow` tool** (probe #86 validated
   every leg of this path): dispatch the wave as ONE `Workflow` run.
   Default script shape — ONE agent per issue: `pipeline(issues, work)`,
   with claim, close and ledger kept in the coordinator's own thread and
   run in wave order, so the paper trail lands in one predictable
   sequence and the wave's agent count is exactly its issue count.
   The per-stage pipeline — `pipeline(issues, claim, work, verify,
   close)`, one `agent()` call per stage per issue, so the run graph
   mirrors the lifecycle exactly and the platform owns retries,
   ordering, and fan-in — is the option for a wave small enough to
   afford it: it multiplies the issue count by four, so eight issues
   means thirty-two agents, well past the guideline above, where the
   same eight at one agent per issue sit comfortably under it.
   - Every stage declares a structured-output schema and returns
     machine-readable status (issue id, stage, ok, detail) — the schema
     IS the worker contract; a misbehaving worker degrades to a
     schema-valid failure result without harming its siblings.
   - Workers reach cairn MCP tools by loading them via `ToolSearch`
     (`select:mcp__plugin_cairn_cairn__...`) — say so in every agent
     prompt; workflow subagents don't inherit loaded schemas.
   - File-mutating work stages get `opts.isolation: "worktree"` — same
     isolation rule as the fallback path, enforced by the platform.
   - `.filter(Boolean)` on collected results — the documented contract
     resolves failed thunks to `null`; keep the filter even though
     schema'd failures usually arrive as values.
   - The moment dispatch returns, record the run id in BOTH places so it
     survives /clear: `continuity_checkpoint(source: "tool", notes:
     "wave <N> run <id>")` AND `outlook_emit(tracker: {open, inProgress,
     blocked, nextVerb: "work <N> --wave — resume run <id>", asOf})`.
     The checkpoint source enum is exactly `tool`, `posttooluse`,
     `precompact`, `waypoint` — a wave dispatch is a `tool` checkpoint,
     and the wave identity rides in `notes`, never in the source.
   - Re-entry on an interrupted wave: resume with `resumeFromRunId: <id>`
     instead of redispatching — unchanged agent-call prefixes replay from
     cache, so completed workers are free and only unfinished ones run.
   After the run: any issue whose result failed (or vanished in the
   filter) → the failed-issue stop rule above.

   **Fallback — no `Workflow` tool** (other harnesses): within the wave,
   dispatch one subagent per issue IN PARALLEL — worktree isolation for
   any file-mutating issue. Each subagent runs the full per-issue
   lifecycle below (claim → work → close → ledger).
3. For each issue id, in order: `issue_get(id)` — skip closed ones. If it's
   assigned to someone who is not you (compare against `user.handle` in
   cairn.json, only when it's set there — if unset, there are no ownership
   checks), say so and skip unless the user overrides.
4. Before starting an issue: record `git rev-parse HEAD` as this issue's
   `baseCommit` (it feeds the ledger in step 7). Then `issue_update(id, state: "in_progress")` —
   and when `user.handle` is set in cairn.json, also pass
   `assignee: <handle>` so teammates see who holds it. Then post the
   claim comment: `issue_comment(id, ...)` — its first line opens with
   exactly "Starting now." (the server reads that opening as the start of
   the clock — anything else and the measurement falls back a rung), then
   which wave and PLAN.md task this is, the task's declared `verify:` command quoted back
   (so the bar is visible before the work, not negotiated after it), and
   the base commit as a short ref on its own line.
   Plain language throughout (leak-guard discipline, same as `trace`).
   Then `context_set(phase: <N>, issueId: id)`.
5. Do the work the issue + PLAN.md describe. Track in-session with TaskCreate
   where the harness offers it (newer models ship the task tools default
   off — when TaskCreate isn't available, skip in-session tracking); the
   tracker stays the durable truth.
   When this issue's id is in PLAN.md `tdd:` frontmatter, the work is
   RED → GREEN → REFACTOR, each its own commit: (RED) write the failing
   test, run it, show the failure, commit; (GREEN) minimal code to pass,
   run, commit; (REFACTOR) clean up, tests stay green, commit. Record the
   RED and GREEN shas — `ledger_append` takes them as `redCommit` /
   `greenCommit` at close. Skipping RED on an eligible task: stop and
   restart the task; verify fails the phase on a missing pair regardless.
   A bug surfacing mid-issue that is NOT this issue's scope routes to
   `trace` (fast lane allowed — it still logs the repro line before it
   can close) — never an inline detour; the trace's tracker issue keeps
   the discovery visible.
   Progress comments as the work lands — real milestones only:
   RED/GREEN/REFACTOR committed, a subtask done, a blocker hit, a trace
   spun off. Several small steps batch into ONE `issue_comment`; tracker
   noise is a failure mode, not diligence. No silent state transitions,
   ever — if the tracker state changes, a comment says why.
6. On completion: run the task's declared `verify:` command — that run IS
   the close evidence. It disagreeing with the declaration is a finding,
   not a formality: either the declaration was wrong (say so and why) or
   the work is not done. `ledger_append` returns `declaredVerify` and
   `evidenceCitesDeclared` so the mismatch is visible; it never refuses,
   because a shorthand declaration and the real command line rarely match
   character for character. Then, **with tests passing**: post the close
   comment first —
   `issue_comment(id, ...)`: what shipped in plain language, the commit
   range as short refs on their own line, the test evidence (suite name +
   pass count). Do NOT compute a time spent: you have no reliable sense
   of elapsed time, and self-reports measured 6x-14x high. When the cost
   log has rows for this issue
   (`node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/cost-report.mjs" --issue <id>`
   returns > 0), add "agent cost: ~$X (approximate)".
   Then `issue_close(id, evidence: { command, result })` — `evidence` is
   the SAME run that justified the close, as data: `command` = the suite
   or shell line you ran, `result` = what it showed ("1408 passed"). The
   tool measures the duration itself (claim comment, else the claim it
   saw, else — at `ledger_append` — the commit range) and posts it with
   the evidence as one standard comment before the state change; quote
   its `measured` result when you report the close. `timeSpentMinutes`
   is optional and is stored only as a claim beside the measurement,
   never in place of it; backends with worklog support log the measured
   minutes. On stopping early: leave in_progress
   and post a parked comment — why it stopped, what remains.
7. On `issue_close`: `ledger_append(phaseDir: <NN-slug>, taskRef: id, summary:
   <one line — what shipped>, baseCommit: <HEAD when this issue started>,
   headCommit: <HEAD now>, issueId: id, closedDate: <today, YYYY-MM-DD>,
   redCommit: <RED sha — TDD tasks only>, greenCommit: <GREEN sha — TDD
   tasks only>, evidence: <the same { command, result }>)` — the durable,
   git-committed record that the task landed. The server REFUSES a line
   with no evidence: an issue that genuinely had nothing to run (docs
   only, plan text only) passes `evidenceWaived: "<why>"` instead — a
   written reason, never a silent skip. `verify` fails the phase on a
   ledger line carrying neither.
8. After the last issue: `context_set(issueId: null)` and suggest
   `/cairn:verify <N>`.
