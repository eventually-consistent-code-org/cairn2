---
verb: auto
args: "[--batch [--budget <tokens|$usd>] [--phases <N,N,...>]]"
status: live
---

Chained hands-off execution of remaining phases. OPT-IN and explicit: show
exactly what will run before anything runs.

1. `plan_status()` — the run list is every phase with CONTEXT.md and
   without VERIFICATION.md, in order. Show it (phases, issue counts) with
   ONE confirmation question. No CONTEXT.md → that phase is excluded and
   listed as skipped — auto never invents context.
2. Per phase, in order: plan if PLAN.md has no tasks (the `plan` verb's
   steps, standard depth) → the `work` verb's steps → the `verify` verb's
   steps. The A0 handoff tools track progress automatically; a killed run
   resumes via `/cairn:waypoint resume`.
3. HARD STOPS — halt the run, report, hand back: failed verify;
   `plan_drift` flags; any tracker error; any security-relevant decision
   (auth, secrets, data exposure, dependency trust).
   On a failed-verify stop, the report includes the ready-made trace
   handoff: the exact `trace_start` description + first-evidence text.
   auto never starts the trace itself — no self-repair; that is the
   user's move next session.
   Engineer mode (`user.mode: engineer`) adds one more: a completed
   cairn-authored issue whose PR awaits human review is a natural stop —
   auto never merges its own work past a human gate. The run report
   lists the waiting PRs.
4. Unattended decisions resolve against these principles, in order: prefer
   completeness over shortcuts; match existing patterns; choose reversible
   options; mirror the user's past choices; defer ambiguity (pick the
   defer-able reading, note it); escalate security (that's a hard stop,
   not a principle call). Every such decision is logged in the run report
   with the principle that resolved it.
5. Genuinely subjective taste calls (naming, UX copy, structure with no
   pattern to match) do NOT stop the run: take the reversible option, add
   it to the taste batch, present the batch as ONE review at the end.
6. End of run (or stop): report — phases completed, decisions + principles,
   taste batch, stop reason if stopped, next step.

## Batch mode — `auto --batch [--budget <tokens|$usd>] [--phases <N,N,...>]`

Bare `auto` (everything above) is UNCHANGED. `--batch` is the budgeted,
interviewed, walk-away form: stage everything up front — phase selection,
estimates, research questions, push authority — write it into a run
manifest, then hand off to headless execution. The manifest is the
executor's SOLE source of authority: a phase outside it never runs, and
never pushes.

Staging sequence, in order:

1. **Candidate set.** `--phases N,N,...` given → exactly those phases
   (each still needs CONTEXT.md, same exclusion rule as step 1 above).
   Otherwise `--budget` picks them: call `token_estimate` per remaining
   phase and fit phases into the budget on the HIGH end of each range —
   conservative on purpose, and the interview says so ("fit on worst-case
   estimates; a run that comes in under budget beats one that stops
   mid-phase"). `--budget` accepts raw tokens (`--budget 5000000`) or
   dollars (`--budget $300`). Neither flag → all remaining phases, budget
   uncapped (state that plainly too).
2. **Selection honesty.** Order/group the candidates: map present and
   fresh (`map_query` on phase dependencies) → dependency-smart grouping;
   no map, or stale → roadmap order. Either way the interview SAYS which
   one it used, in one plain line — e.g. "ordered by the project map's
   dependency edges" or "no fresh map — running in roadmap order". Never
   imply dependency intelligence that wasn't there.
3. **Research + question round.** Unplanned candidate phases get the
   `scout` verb's batch form (cross-phase pool, one dispatch). Its
   clarification questions surface HERE, at staging, while the user is
   still present — never mid-run. Answers are folded into RESEARCH.md as
   usual AND recorded in the manifest's `answers`, so the executor never
   has to ask.
4. **The staging gate — ONE AskUserQuestion.** Present, in one ask:
   - the phase list (numbers, names, issue counts, order/grouping);
   - per-phase estimate RANGES (never point claims) + the run total
     (low–high) vs the ceiling, with the fit-on-high caveat;
   - explicit push pre-authorization: "authorize pushes for THESE phases,
     for this run?" — scope-limited to the manifest's phases, recorded
     with a timestamp. This is REC-5's ship confirmation moved to run
     start, never silently bypassed:

     > Provenance: adopted from the 2026-08-12 product council (REC-5),
     > accepted by the project owner over cairn's no-action
     > recommendation. Vibe mode's silent-judgment rule explicitly does
     > NOT apply to this ask.

   Options: approve + authorize pushes / approve WITHOUT push authority /
   adjust / cancel. Declining push authority does NOT cancel the run — it
   downgrades it to verify-stop: phases run headless through work and
   verify, but nothing pushes; the report lists what's ready to ship by
   hand. "Adjust" loops back to step 1 with the user's changes.
5. **Write the run's authority.** On approval: `run_manifest(action:
   "create")` with the phases, estimates, ceiling, and staged answers;
   `run_manifest(action: "grant_push")` only if the user authorized
   pushes; then `budget_check` with the ceiling to open the spend ledger
   (hard at boundaries — no new phase/wave starts past the ceiling, an
   in-flight wave finishes; bounded overshoot ≤ one wave). Then
   `run_manifest(action: "set_status", status: "running")` and report
   "staged — run starts now."
6. **Execution.** The run starts — the sequence below consumes the
   manifest from here. Everything above this line happened with the user
   present; everything below runs without them.

### Execution sequence — the headless run

Bare auto's rules ride along unchanged: the hard stops (tracker error,
security-relevant decision, engineer-mode PR gate), the
unattended-decision principles, and the taste batch all apply inside
batch mode exactly as written in steps 3–5 above. What follows is the
batch-specific loop.

1. **Preconditions + run visibility.** Manifest status must be
   `running` (`run_manifest(action: "read")`) and the ledger open
   (`budget_check(runId)` with no phase — a read-only poll). A manifest
   reading `complete` or `stopped` is terminal: report, don't run —
   re-staging means a new runId, never a resurrected old one.

   **The run works in its own worktree, never the owner's checkout.**
   Before any phase starts: enter a dedicated worktree for the run
   (`EnterWorktree` where the harness has it, else `git worktree add
   <dir> <base branch>` under the machine's cairn home, never inside
   the repo). Every checkout, merge, commit and push for the whole run
   happens there. The owner keeps typing in their own directory while
   the run works — the two never share a working tree. Remove the
   worktree on EVERY exit path: normal completion, ceiling hit, hard
   stop, and error; a run that leaves its worktree behind is a run the
   next one trips over. While the manifest reads `running`, a
   PreToolUse guard refuses `git checkout` and `git switch` aimed at the
   owner's checkout (`git reset --hard` is refused in every session) — if that refusal ever fires,
   the run escaped its worktree and the fix is to re-enter it, never to
   override.

   First act: the run's umbrella tracker issue — `issue_create` (label
   `batch-run`, runId in the title), opening comment in plain language:
   the phase list as staged, the ceiling, push authority granted or
   declined. Then `continuity_checkpoint(source: "auto", notes:
   "batch run <runId> — phase <first>")` so a killed run leaves a trail.
   A usage limit is NOT a kill: the run pauses when it hits the ceiling
   and resumes itself when the window rolls over, so nothing is dropped
   and nothing needs restarting by hand. The checkpoint is for real
   deaths — a crash, a reboot, a closed session — and batch mode carries
   no defences against limit-time agent loss, because the platform no
   longer loses them.
   **Resume path — a killed run re-enters HERE.** The checkpoint notes
   hold the runId; `run_manifest(action: "read")` is the authority on
   what was approved (a resumed run never widens scope or push
   authority). "Where was I" resolves by trust order: tracker + git
   first (VERIFICATION.md present, issues closed, commits/pushes
   landed), then the ledger's boundary rows, then the handoff note.
   Manifest phases already verified/shipped by that evidence SKIP; the
   loop resumes at the first phase the evidence can't vouch for. The
   umbrella issue is found (runId search), never recreated.
2. **Per manifest phase, in manifest order:**
   - **Re-inject the constraint set.** FIRST act of every phase, before
     the budget check: `run_manifest(action: "read")`, then restate what
     it says in plain language before doing anything with it — the
     staged phase list (the run's whole scope, nothing wider), the
     `ceiling`, `pushAuth.granted` and its `manifest-phases` scope, the
     staged `answers` that stand in for the absent user, and the hard
     stops that end a run early. The manifest is the authority at every
     boundary, not just at run start: by phase three the staging
     statement is thousands of turns back, and a constraint that has
     fallen out of attention is a constraint the run will violate.
     Re-read it, don't remember it — it costs a couple hundred tokens
     per boundary and it is the cheapest correctness the run buys. A
     manifest that no longer reads `running` ends the run right here:
     report, don't continue.
   - **Boundary budget check.** `budget_check(runId, phase: <N>)` —
     records the boundary row. Verdict `stop` → no new phase starts:
     `run_manifest(action: "set_status", status: "stopped")`, one
     plain-language comment on the umbrella issue AND on the stopped
     phase's open issues ("budget ceiling reached — run stopped before
     phase N started; spent ~X of ~Y"), then wrap (step 4).
   - **Mark the phase in flight.** `run_manifest(action: "set_phase",
     phase: <N>)` once the budget lets phase N start (a resumed run
     re-marks its phase; that's a no-op). The run guard honours push
     authority only while this names a manifest phase, and it only moves
     forward.
   - **Plan if untasked.** PLAN.md has no tasks → the `plan` verb's
     steps, standard depth. Research already exists — staging's scout
     batch wrote RESEARCH.md and the manifest's `answers` carry the
     user's staging answers; planning consumes both, never re-asks.
   - **Work.** The `work` verb's `--wave` steps, per-issue lifecycle
     unchanged, with ONE addition: the wave's inner budget is the
     ledger's word — pass `budget_check`'s `innerBudgetSuggestion` down
     as the Workflow run's budget (the inner ceiling; this ledger stays
     the outer authority). BETWEEN waves: `budget_check(runId, phase:
     <N>, wave: <W>, agentTokens: <the completed wave's reported agent
     token total>)` — wave subagents write no metrics rows, so this is
     how their spend reaches the ledger (it accumulates as the ledger's
     agent-spend component, summed into spentTokens). Same stop
     semantics: the in-flight wave finishes, a `stop` verdict refuses
     the next wave, then the same stopped-marking, comments, and wrap
     as the phase boundary. A wave boundary is a boundary: re-inject
     the constraint set there too (same read, same restatement), so the
     next wave's briefs are composed against the manifest rather than
     against whatever the session still half-remembers of it.
   - **Verify.** The `verify` verb's steps; failure = auto's posture,
     unchanged: stop THIS phase, prepare the `trace_start` handoff
     (never start it), skip dependent phases, continue independent
     ones. "Dependent" = a later manifest phase whose CONTEXT.md or
     PLAN.md references this phase or its issues. No dependency data
     to consult → the conservative default: treat manifest order as a
     dependency chain and stop the whole run.
   - **Ship if authorized.** Manifest `pushAuth.granted` → the `ship`
     verb's steps, all gates intact (drift, open issues, the docs
     catch-up tier — a gate failure stops, it is never bypassed). The
     manifest pre-auth SUBSTITUTES for ship's step-5 AskUserQuestion:
     the push proceeds on the authority collected at the staging gate,
     scope-limited to the manifest's phases — REC-5's confirmation
     moved to run start, never silently skipped (record that line in
     the push summary). `pushAuth.granted: false` → the phase ends
     verified-not-pushed, recorded for the report; nothing pushes
     (enforced by the run guard, which refuses `git push` mid-run without
     the grant and a marked phase).
3. **Tracker-first visibility.** Per-issue claim/close comments already
   come from work's lifecycle — never duplicate them. ADD, on the
   umbrella issue, ONE comment per phase transition: phase N started /
   verified / shipped / stopped (with why). Small steps batch into that
   one comment — tracker noise is a failure mode, not diligence. At
   every phase boundary: `outlook_emit(tracker: {open, inProgress,
   blocked, nextVerb, asOf})` so the board tracks the run in real time
   — the final report is a summary, not the only visibility. The
   harness's own headless progress reporting is trustworthy again: watch
   it for liveness and let it be the running view. The tracker comments
   and board emits stay the durable record, and neither one is padded to
   cover for the other.
4. **Wrap — every exit lands here (complete or stopped).** In order:
   final `budget_check(runId, phase: "wrap")` boundary — the honest
   last spend row, overshoot included; `run_manifest(action:
   "set_status", status: "complete")` when the loop reached the
   manifest's end (even with failed/skipped phases — those are report
   lines), `"stopped"` when the run halted early (budget, dependency
   chain, hard stop); then the run report (next section) — it owns the
   umbrella issue's closing comment, the close itself, and the run's
   final board emit. Last, close continuity: `continuity_checkpoint(
   source: "auto", notes: "batch run <runId> ended <status> — next:
   <action>")`, then leave and remove the run's worktree (step 1) —
   after the status move, so a crash between the two leaves a manifest
   that is no longer `running` and a worktree the next run can clear.

### The run report — the artifact the dev reads when they're back

Every exit — complete or stopped — produces one report. It is assembled
from the run's own records, never from the session's memory of what
happened: the manifest (`run_manifest(action: "read")` — phases as
approved, estimate ranges, push authority, staged answers), the budget
ledger's append-only boundary rows (spend at every phase/wave boundary,
overshoot), each phase's VERIFICATION.md and LEDGER.md, and the umbrella
issue's comment trail. A phase none of those records can vouch for is
reported as unknown — the report never upgrades an outcome the evidence
doesn't support.

1. **Per-phase outcome table.** One row per manifest phase, in manifest
   order. Outcome is exactly one of: `shipped` /
   `verified-not-pushed` / `stopped-budget` / `stopped-verify-failure` /
   `skipped-dependent` — each with ONE plain-language reason line
   ("verified and pushed", "verified; push authority was declined at
   staging", "never started — ceiling hit at this phase's boundary",
   "verify failed: 2 acceptance checks unmet", "skipped — depends on
   failed phase 7").
2. **Estimate vs actual — the calibration section.** Per phase: the
   staged range (low–high, tokens and ~$) vs actual spend — the delta
   between that phase's boundary row and the next (the wrap row closes
   out the last phase) — and the run total vs the ceiling, overshoot
   stated when the ledger recorded one. Call out, one line each, every
   phase that landed OUTSIDE its range, beat or blew — this is the
   estimate-vs-actual feedback the estimator promised, written so a
   non-engineer can read it ("phase 16 cost ~300k tokens (~$35)
   against an estimate of 400k–2.1M — well under"). There is NO
   write-back step, on purpose: the run's actual spend already lives in
   the metrics history the Stop hook wrote while the run executed, and
   `token_estimate` calibrates from exactly that history the moment a
   phase has its VERIFICATION.md — the next staging interview's ranges
   tighten automatically.
3. **Pushes made under pre-auth.** Per shipped phase: branch and short
   commit range (`abc1234..def5678`), each carrying the standing line —
   authority collected at the staging gate, scope-limited to the
   manifest's phases (REC-5 moved to run start, never silently
   bypassed).
4. **Bare auto's report conventions, unchanged.** Every unattended
   decision with the principle that resolved it; the taste batch as ONE
   review list — the dev's first interactive act next session; the stop
   reason when stopped; engineer mode's waiting-PR list; and on a
   failed verify, the ready-made trace handoff — the exact
   `trace_start` description + first-evidence text, never started.
5. **Write the file — beside the manifest, never in the repo.** The
   `path` field on `run_manifest(action: "read")` names the manifest's
   real location under `~/.cairn/runs/`; the report is that same
   filename with `.json` replaced by `-report.md`, so the runId rides
   along in the name. Run artifacts live under `~/.cairn`: never
   committed, never referenced from repo docs.
6. **Tracker mirror, then close.** ONE closing comment on the umbrella
   issue carrying the full report in plain language — outcome table,
   estimate-vs-actual lines, pushes, decisions, stop reason. Leak-guard
   discipline applies: no file paths, no internal doc references; short
   commit refs (`abc1234..def5678`) are fine, house precedent. Then
   `issue_close` on the umbrella. LAST, one final `outlook_emit(
   tracker: {open, inProgress, blocked, nextVerb, asOf})` AFTER the
   comment — the board outlives the run, and its final state should
   show the run's true ending, not its second-to-last boundary.

### Plugin state — installs, updates, and the release pin

A batch run has no TTY, so any command that stops to ask a question
hangs the run instead of failing it. Plugin operations are the ones that
ask: `claude plugin install`, `update` and `uninstall` confirm the
marketplace-declared command before running it, and that confirmation is
**required** to be pre-answered when stdin or stdout isn't a terminal.
`-y` is that answer (`claude plugin install <plugin>@<marketplace> -y`).
Read state with `claude plugin list --json` — never by scraping human
output — and check `--help` for which other subcommands emit JSON, since
that moves with the Claude Code version.

Two standing rules for the run itself:

- **A run never updates its own plugin mid-flight.** Swapping the tools
  out from under a running executor is not a decision a headless run
  gets to make; it is a hard stop with the reason named, same as any
  other. Installing a *different* plugin the work needs is fine on the
  `-y` path, logged as an unattended decision with its principle.
- **Shipping a release moves the pin, not the run.** If a manifest phase
  cuts a release, `scripts/release.mjs` bumps the marketplace pin along
  with the version files — but installed copies, this run's included,
  stay on the tag they were installed from until somebody updates them.
  The report says so in one line rather than implying the release is
  live for anyone. Adopting it is the human's first act next session:
  `/plugin` → update → close the menu, since plugin changes apply on
  menu close.
