---
verb: plan
args: "<N> [--quick|--deep] [--challenge] [--model <auto|haiku|sonnet|opus>] [--tdd] [--mvp] [--prd <file>] [--ingest <glob>] [--gaps]"
status: live
---

Plan the given phase per the `cairn-planning` skill's depth dial.

0. `plan_tracker_delta()` — peek. Anything in the delta → say so in one
   line ("tracker delta: 2 new, 1 edited — `/cairn:resync` to integrate")
   and continue; a non-empty delta never blocks this verb. First run:
   the tool initializes silently, don't mention it.
1. `plan_status()` — confirm the phase dir exists (else `plan_scaffold_phase` first;
   deep depth passes `research: true`).
2. Depth (flag > PLAN.md frontmatter `depth:` > cairn.json default > standard):
   - quick: no research; draft PLAN.md tasks directly.
   - standard: one research subagent for unknowns; write RESEARCH.md if material.
   - deep: parallel research fan-out per the skill's model-routing rubric, then a
     plan-checker pass over the draft (deep also convenes the challenge
     round — step 4 — alongside that pass).
   - When a map exists, research also consults `map_query` for the phase
     slice (`node: <phase-N id>` or a `label` match on the phase name,
     `depth: 2`) — dependencies and owners the graph already knows beat
     rediscovering them. Missing map: silently skip (rule in `map.md`).
3. Write the task breakdown into the phase's PLAN.md body. Keep decisions in
   CONTEXT.md (precedence per shared rules — the tracker gets updated, not
   followed).
   - **Approaches considered — BEFORE the task breakdown, at every depth
     but quick.** Name the phase's central design fork and write
     CONTEXT.md's `## Approaches considered` block: two-plus `### `
     candidates, each with a line of trade-offs, and one `chosen: <X> —
     because <why>` line. Vibe mode drafts the candidates itself; engineer
     mode folds them into this verb's single interview question (the
     user picks or adds). `plan_check` flags a planned, non-quick phase
     whose CONTEXT.md lacks the block (`missing-approaches`) — the
     divergent-design step is a data shape, not a habit. When the chosen
     approach rests on an assumption the repo can't settle (a library
     behavior, a platform limit, a performance guess), STOP before
     PLAN.md: hand the question to `probe "<question>"` (verbs/probe.md),
     write `chosen: pending probe <id>` in the block, and resume this
     verb when the probe wraps — a plan built on a hunch is the thing
     the block exists to prevent.
   - Estimate every issue this verb creates (`issue_create` here and in
     steps 5–6): `estimatePoints` from task complexity (quick/mechanical
     1–2, standard 3–5, deep/cross-cutting 8), `estimateMinutes` as an
     honest wall-clock guess. Backends without estimate fields ignore them
     silently — always pass both. Worklog on close records the actual;
     together they make burndown/velocity/estimate-vs-actual reports real.
   - **Every task declares how it will be proved.** End the task with a
     backticked `` `verify: <command>` `` — the suite file, the guard
     script, the eval case, the shell line someone will actually run. It is
     written NOW, before the work starts, because criteria written
     afterwards are chosen to fit whatever happened. `plan_check` flags a
     planned, non-quick, unverified phase whose task lacks one
     (`missing-verify`); a verified phase is exempt, its proving is already
     written up. The clause may sit anywhere in the task's own paragraph,
     so prose can still wrap. `work` quotes it when it claims the issue and
     runs it at close; `ledger_append` reports whether the evidence cites
     it. If a task genuinely cannot be proved by running anything, say so
     in the clause (`` `verify: none — docs only` ``) rather than omitting
     it: a written "nothing to run" is a decision, a blank is an oversight.
   - A task MAY name a roster seat for dispatch framing: end the task's
     first line with a backticked `` `seat: <name>` `` annotation, where
     `<name>` is a kebab-case seat name from `seat_roster` — at most one
     per task. `work` reads it when composing that issue's wave brief
     from `templates/wave-brief.md`; a name matching no valid roster
     seat is noted and the brief goes out seatless. No annotation = the
     plain templated brief — annotate only when a seat's lens genuinely
     fits the task, never by default.
4. Challenge round — runs ONLY when `--challenge` was passed OR the
   resolved depth is deep (where it joins the plan-checker pass);
   otherwise skip this step entirely — with no flag at standard depth,
   plan behaves byte-for-byte as today. Advisory, never a gate: the
   user's plan always wins.
   - `seat_roster` once — the valid plan-stage seats (`stage` plan or
     `any`, the `seatsForStage(roster, "plan")` filter) are the
     challenge panel, in roster order; with the shipped defaults that
     is exactly the interrogation seat. Internal seats are framing
     lenses — cheap, same-model; `peers` remains the genuinely
     adversarial external council. No plan-stage seats on the roster →
     say so in one line and move on.
   - Convene each seat over the draft PLAN.md + CONTEXT.md, framed at
     its declared dose via the wave-brief composition
     (`templates/wave-brief.md`: seat framing per dose in the seat
     slot, the challenge charge as the task, the draft artifacts as
     the plan excerpt) — composed agent-side from `seat_roster` and
     the template, exactly like `work`'s briefs: zero new tools, zero
     server changes.
   - Collect the seats' challenges as PROPOSED AMENDMENTS — each names
     the PLAN.md/CONTEXT.md line it targets and the question that line
     cannot answer — and put them to the user in ONE batched
     AskUserQuestion, never one-per-amendment.
   - Accepted amendments edit PLAN.md/CONTEXT.md; where task lists
     change, the edits flow through `plan_issues_set` / `plan_meta_set`,
     never hand-edits. Rejected amendments are recorded in CONTEXT.md
     with a one-line reason each — a written why, not a silent drop.
5. Flags (combinable; all task-list changes still flow through `plan_issues_set`
   / `plan_meta_set`, never hand-edits):
   - `--mvp`: shape tasks per the cairn-planning skill's vertical-slice-first
     policy before writing PLAN.md.
   - `--prd <file>`: read the file first; interview ONLY the gaps it leaves,
     batched into one AskUserQuestion.
   - `--ingest <glob>`: read matching docs; write their decisions into
     CONTEXT.md as locked decisions with source links. Conflicting docs →
     surface the conflict, never silently pick.
   - `--tdd`: per task, judge eligibility per the cairn-planning rubric;
     batch the proposed eligible/ineligible split into ONE AskUserQuestion
     for overrides; then `plan_meta_set(phaseDir, tdd: [<eligible ids>])`.
   - `--gaps`: read this phase's VERIFICATION.md failures + the latest
     `plan_resync` report — plus the phase's `map_query` slice when a map
     exists (depth 2 from the phase node): an edge into unfinished work is
     a gap candidate too. Propose new/amended tasks. Goal-breaking gaps →
     issues in this phase now (`issue_create` + `plan_issues_set`); minor →
     offer to backlog. Severity call is yours; say which and why.
   - Wave grouping (with or without flags): when tasks are independent,
     propose waves and write them with `plan_meta_set(phaseDir,
     waves: [[ids…], …])`. Waves must partition cleanly — an issue in two
     waves is a tool error.
6. Reconcile: `plan_drift()` — resolve anything flagged for this phase
   (recreate missing issues via `issue_create` + `plan_issues_set`; question
   closed-unverified ones with the user).
7. Adopt: `plan_unplanned()` — for any unplanned issue that belongs to this
   phase, add its id via `plan_issues_set` and re-phase it in the tracker
   with `issue_update(id, phase: <N>)` — phase takes the cairn phase number
   (#142, #271). A backend that can't re-parent says so
   via `phaseSkipped` in the result; relay that instead of assuming the
   move happened. Ask before adopting.
8. Report the plan summary and next step `/cairn:work <N>`.
