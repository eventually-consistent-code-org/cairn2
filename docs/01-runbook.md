# cairn Runbook — the complete operating manual

Ever wonder what it would take to run a real engineering workflow — planning,
tracking, memory, review, shipping — without the workflow itself becoming the
job? That's the question cairn exists to answer. This runbook is the full
operating manual: every verb, every flag, every gate, every config key, and
every error code, written so you can run any workflow end to end without
reading source.

---

## 1. Orientation

Cairn is a Claude Code plugin backed by a TypeScript MCP server. The plugin
layer (commands, skills, hooks) owns *policy and judgment*; the server owns
every mechanism with a wrong answer — state transitions, tracker mirroring,
drift math, staleness checks. You talk to it through 39 `/cairn:<verb>`
commands, all generated from one routing table.

### The three truths

Everything in cairn hangs off a simple division of authority. Learn it once
and the rest of the system makes sense:

| Truth | Lives in | What it owns |
|---|---|---|
| **Work truth** | Your external tracker (GitHub, GitLab, Jira, Asana, Azure Boards, ClickUp, Linear, or the local backend) | Issues, states, assignees, milestones — the single source of truth for *work items* |
| **Prose truth** | Git, inside your repo | Plans, phase context, verification records, memory cards, session files — everything written down |
| **Disposable cache** | `~/.cairn/` on your machine | The full-text memory index, the session handoff, the recall banner — rebuildable, never git-tracked, safe to delete |

On conflict, git plan docs (CONTEXT.md, PLAN.md) win over tracker issue text —
cairn updates the issue rather than silently following it. One exception:
a tracker edit detected by the delta cursor is provenance-known *newer* human
intent, and integrates forward into the plan (unless it collides with a locked
decision, which stops for you).

### Quick reference — if you want to X, run /cairn:Y

| If you want to… | Run |
|---|---|
| Start a brand-new project (interview → plan artifacts → tracker issues) | `/cairn:new` |
| Plan a phase (research, PLAN.md, tracker reconcile) | `/cairn:plan <N>` |
| Execute a phase (claim issues, do the work, close on verified done) | `/cairn:work <N>` |
| Check a phase actually delivered what it promised | `/cairn:verify <N>` |
| Push, gated on drift-clean + no open issues in verified phases | `/cairn:ship` |
| Complete the milestone — close, release, archive, tag | `/cairn:summit` |
| See everything — phases, issues, drift, open sessions — in one screen | `/cairn:status` |
| Pull an existing tracker epic/milestone/list into cairn | `/cairn:import <ref>` |
| Research a phase without planning it yet | `/cairn:scout <N>` |
| Research the whole project, then change the roadmap through a gate | `/cairn:survey` |
| Insert/remove/rename a phase without renumbering anything | `/cairn:route …` |
| Run all remaining phases hands-off (opt-in, with hard stops) | `/cairn:auto` |
| Stage a budgeted walk-away batch run — interview up front, headless after | `/cairn:auto --batch` |
| Make a trivial ≤3-file change with a full tracker paper trail | `/cairn:fast "<change>"` |
| Reconcile out-of-band commits and tracker edits with the plan | `/cairn:resync` |
| Capture an idea in one tool call, zero questions | `/cairn:mark "<text>"` |
| Store a durable fact as a memory card | `/cairn:remember "<fact>"` |
| Search memory, scoped, with staleness flags | `/cairn:recall "<query>"` |
| Extract lessons after a phase/milestone, re-grade old knowledge | `/cairn:retro` |
| Synthesize plans + memory into public-safe `docs/` | `/cairn:distill` |
| Generate an onboarding briefing for a newcomer | `/cairn:brief` |
| Pause or resume session continuity by hand | `/cairn:waypoint [resume]` |
| Debug persistently — evidence → hypothesis → test, tracker-mirrored | `/cairn:trace "<bug>"` |
| Spike a risky assumption with a throwaway experiment | `/cairn:probe "<question>"` |
| Compare design variants on a shared theme | `/cairn:draft "<question>"` |
| Keep long-running context alive across `/clear` | `/cairn:thread "<name>"` |
| Run a cross-phase quality audit (uat/security/tests/docs/…) | `/cairn:audit <mode>` |
| Rescan the whole project and diff it against the last rescan | `/cairn:audit sweep` |
| Five-axis code review of a diff, branch, or phase | `/cairn:review [target]` |
| Sweep open issues for hygiene problems | `/cairn:triage` |
| Build/query the project knowledge graph | `/cairn:map build` |
| Check the planning directory's own health (and plugin state), repair, or forensics | `/cairn:medic` |
| Safely revert a phase's shipped commits (reverts only) | `/cairn:backtrack <phase>` |
| Manage multi-project workspaces and the dispatch board | `/cairn:basecamp` |
| See every cairn project on this machine on one board | `/cairn:outlook` |
| Convene external AI CLIs as reviewers | `/cairn:peers review` |
| Publish README + docs/ to the docs connector | `/cairn:docs publish` |
| Edit cairn.json safely | `/cairn:tune` |
| Teach cairn how you like to be talked to | `/cairn:profile` |
| Say what you want in plain English and let cairn route it | `/cairn:do "<request>"` |
| See the verb reference | `/cairn:help` |

### Shared rules every verb inherits

- **Errors surface, never stack-trace.** Server tools fail with typed codes
  (section 11); the verb reports the code and your next action. One backend
  being down never blocks git-side operations.
- **Batch questions.** Related questions arrive as one question set, never
  one checkbox at a time.
- **Active context.** Verbs operate on the active project/phase/issue unless
  arguments override; verbs that change focus record it.
- **Continuity.** State-changing verbs refresh the session handoff
  automatically; `ship` and `summit` clear it.
- **Decision surfacing (engineer mode).** With `user.mode: engineer`, a
  genuine design fork — multiple defensible shapes with real trade-offs —
  stops and asks you, cairn's recommendation first. The bar is "would a peer
  have wanted a say," not "is this a decision." Vibe mode (the default)
  resolves judgment calls silently.
- Every verb reads `.cairn/profile.md` when present and calibrates tone and
  depth to it — advisory only, never a change to what a verb decides.

---

## 2. The core lifecycle

The spine of cairn is six verbs: `new → plan → work → verify → ship →
summit`. Everything else supports this loop.

### `/cairn:new [project name]`

Start here. From an empty repo to a routed plan in one verb.

1. Confirms `cairn.json` exists. Missing → asks which tracker (local
   first — zero credentials — then the hosted backends) and which docs
   platform (none / Confluence / Docusaurus) back the project, then writes
   `cairn.json` itself from the shipped template — auto-detecting what git
   already knows (e.g. the GitHub repo from `origin`) and prompting for
   the rest. You never copy the template by hand; credentials stay env
   vars.
2. A brief interview: vision, 3–10 requirements, phase breakdown. It also
   asks your collaboration mode once (skipped if `cairn.json` already sets
   `user.mode`): **vibe** — cairn drives end-to-end (default) — or
   **engineer** — you claim issues, write code, and make the design calls
   while cairn pairs, verifies, and keeps the tracker honest. Choosing
   engineer collects your tracker handle too, and sets both in one config
   patch.
3. Scaffolds `.cairn/plans/PROJECT.md` (vision + requirements) and
   `roadmap.md` (the phase table).
4. For each phase: creates the phase directory and ensures the tracker has a
   matching phase object (milestone, epic, or list, depending on backend).
5. For each requirement: creates a tracker issue and records the ids in the
   phase's PLAN.md frontmatter.
6. Reports what was created and points at `/cairn:plan 1`.

Have an existing codebase with tracker history instead? That's
`/cairn:import`.

### `/cairn:plan <N> [flags]`

Plan a phase. Depth resolves in this order: command flag > PLAN.md `depth:`
frontmatter > `cairn.json` default > `standard`.

| Depth | Research | Plan | Verify posture later |
|---|---|---|---|
| `--quick` | none | draft tasks directly | tests pass |
| standard | one research subagent for unknowns | PLAN.md + CONTEXT.md | + tracker cross-check (drift) |
| `--deep` | parallel fan-out, multi-angle | + a plan-checker agent pass | + adversarial verification |

Steps: it first peeks at the tracker delta (new/edited issues since last
sync — mentioned in one line, never blocking), confirms the phase directory
exists, researches per depth, writes the task breakdown into PLAN.md (locked
decisions go in CONTEXT.md), reconciles drift, and offers to adopt any
unplanned tracker issues that belong to this phase (always asking first).

The flags, all combinable:

- `--mvp` — shape the first tasks as ONE thin vertical slice exercising every
  layer end to end (a walking skeleton). Depth and breadth come only after
  the slice stands. A slice that can't demo is not a slice.
- `--tdd` — per task, judge TDD eligibility (behavior-testable code — logic,
  APIs, parsers, state machines — yes; config, docs, scaffolding, styling,
  generated code — no). The proposed split arrives as ONE question for your
  overrides, then lands in PLAN.md `tdd:` frontmatter. Enforcement happens at
  work time (RED/GREEN commit pairs) and verify time (the ledger check).
- `--prd <file>` — read the product requirements doc first; interview ONLY
  the gaps it leaves, batched into one question.
- `--ingest <glob>` — read matching docs; write their decisions into
  CONTEXT.md as locked decisions with source links. Conflicting docs surface
  the conflict — never a silent pick.
- `--gaps` — read this phase's verification failures and the latest resync
  report; propose new or amended tasks. Goal-breaking gaps become issues in
  this phase now; minor ones get offered to the backlog.
- `--model <auto|haiku|sonnet|opus>` — override the agent model routing for
  this run (see the routing rubric under section 8).
- Wave grouping (with or without flags): when tasks are independent, cairn
  proposes waves and records them in PLAN.md frontmatter. Waves must
  partition cleanly — an issue in two waves is a tool error.

All task-list changes flow through validated server tools, never hand-edits
of frontmatter — that's how validation stays honest.

### `/cairn:work <N> [--wave [N]]`

Execute the phase. The per-issue lifecycle, in vibe mode:

1. Tracker-delta peek (one line, non-blocking), then read the phase's issue
   list. Empty list → stop and point at `/cairn:plan <N>`.
2. For each issue in order: fetch it, skip closed ones. If it's assigned to
   someone who isn't you (checked against `user.handle` when set), say so and
   skip unless you override.
3. Before starting: record the current commit as the issue's base. One
   `issue_update` call with a `claim` block (base commit, wave, task, the
   declared verify command) moves the issue to `in_progress` (with your
   handle as assignee when configured), posts the claim comment the
   duration ladder reads, and starts the clock. Then set the active
   context.
4. Do the work. Progress comments land at real milestones only — a subtask
   done, a blocker hit, a trace spun off; several small steps batch into one
   comment. Tracker noise is a failure mode, not diligence. No silent state
   transitions, ever — if the tracker state changes, a comment says why.
5. **TDD tasks** (ids in PLAN.md `tdd:` frontmatter) run RED → GREEN →
   REFACTOR, each its own commit: write the failing test, run it, show the
   failure, commit (RED); minimal code to pass, commit (GREEN); clean up with
   tests green, commit (REFACTOR). The RED and GREEN shas go into the ledger
   at close. Skipping RED on an eligible task means stop and restart —
   verify fails the phase on a missing pair regardless.
6. **A bug surfacing mid-issue that is not this issue's scope routes to
   `trace`** — never an inline detour. The trace's tracker issue keeps the
   discovery visible.
7. On completion with tests passing: close comment first (what shipped in
   plain language, commit range, test evidence, approximate time spent), then
   close the issue — backends with worklog support get a real worklog entry.
   Stopping early: leave it in progress with a parked comment (why, what
   remains).
8. Every close appends a line to the phase's git-committed `LEDGER.md` — the
   durable record that the task landed, with base/head commits and (for TDD
   tasks) the RED/GREEN pair.
9. After the last issue: clear the issue context and suggest
   `/cairn:verify <N>`.

`--wave` (only when PLAN.md has wave frontmatter): waves run in order;
`--wave N` runs just that wave. Within a wave, one subagent per issue runs in
parallel, with worktree isolation for anything file-mutating. Wave N+1 starts
only when every wave-N issue is closed and merged. A failed issue: the wave's
others finish, then the run STOPS before the next wave — never build on
possibly-broken foundations.

**Engineer mode overlay** (`user.mode: engineer`): after the issue list, one
"mine or yours?" question for the whole wave/phase. Cairn-claimed issues run
the normal lifecycle except the work lands as a branch/PR that does NOT
merge — the close comment links the PR and names you as reviewer.
Human-claimed issues: cairn scaffolds (branch, in-progress state, a claim
comment carrying the task text, likely files, and for TDD issues the failing
test written first) and then steps back. When you say done (or your commits
show up in resync), cairn runs the tests and verify posture against your
work, closes with evidence and time logged on your behalf, and *offers*
`/cairn:review` — a decline is recorded, not overridden.

### `/cairn:verify <N>`

Goal-backward verification — the phase must deliver what it *promised*, not
merely have its tasks closed.

1. Re-read the phase's CONTEXT.md and PLAN.md; check the codebase against the
   promise. Run the test suite. Deep depth adds an adversarial verification
   subagent.
2. Drift check — this phase must contribute nothing flagged.
3. Open-issue check — the phase's tracker issue list must be empty of open
   issues; stragglers get reported, never closed unexamined.
4. TDD evidence — every id in PLAN.md `tdd:` frontmatter must have a ledger
   line carrying a `tdd <red>..<green>` segment. Any missing pair → the phase
   FAILS, and no VERIFICATION.md is written.
5. On pass: write the phase's `VERIFICATION.md` — what was checked, what
   passed, deviations. **Its existence is the machine-read signal that the
   phase is verified** — drift treats closed issues in verified phases as
   normal from then on.
6. A passing verify also runs the docs-drift report and tells you what the
   public docs owe — "docs owe entries for phases X, Y —
   `/cairn:distill <N>` generates them". Report only: verify never
   generates docs, and a drift-report error never fails the verification.
   It also confirms the phase's row in `roadmap.md` reads `verified`, and
   repairs the row if it still reads `planned` — the roadmap is the table
   people actually read, so it is not allowed to disagree with the
   VERIFICATION.md sitting next to it. A failed verify leaves the row alone.
7. **A failed verification routes to `trace` — mandatory.** Open a trace with
   the failure as the description, log the failing output as the first
   evidence entry, and continue there. Never patch-and-rerun inline.
   Proven-obvious ≤3-line causes may use trace's fast lane — still traced,
   still mirrored, and since phase 23 still closed on a logged repro: a
   trace cannot close without an evidence entry and a test entry (the
   command + failing output), whatever its verdict says.

Failure honesty is policy: never write VERIFICATION.md for a phase that
didn't pass. A failed verify is a failed verify.

### `/cairn:ship`

The pre-push gate:

1. Drift check — anything flagged: stop and report. Do not push.
2. Every phase with a VERIFICATION.md must show all its issues closed
   (spot-checked live) — any still open: stop. A stale `planned` roadmap
   row on one of those phases is repaired with the plan-doc commit, not
   treated as a failed gate. Ship never writes `shipped (v<N>)` into a
   row — that flip is `summit`'s, at the milestone archive.
3. Engineer mode only: no cairn-authored PR may still be awaiting human
   review. Human review is the merge gate; ship never overrides it.
4. Docs catch-up: any verified phase the docs-drift report still flags
   gets a per-phase distill pass — CHANGELOG entry, phase ADRs, marked
   ARCHITECTURE sections — committed before the push. Advisory: a docs
   failure is reported and skipped; it never blocks a good push.
5. Clean gate → commit outstanding plan-doc changes, then STOP and ask:
   push or hold. The push summary includes the generated-docs diff, so
   it's still exactly one question. Nothing leaves the machine until you
   say push (on by default; `ship.confirm: false` in cairn.json restores
   the old no-questions behavior). On push: emit the outlook snapshot,
   push the branch, clear the session handoff (shipping ends the
   session), and offer a PR if the project uses them.

Never pushes with flagged drift or open issues on a verified phase. That's
the whole point of the gate.

The drift half is also enforced below the verb, by the run guard hook.
Every `plan_drift` run leaves a stamp: the commit it checked, and whether
it flagged anything ship stops on. An agent push that would land on the
default branch is refused unless that stamp is clean and names the exact
commit being pushed — so a push that skips ship, or one made after new
commits landed, is refused with a pointer back to `/cairn:ship`. The
open-issues half stays ship's own check; a hook can't ask the tracker.
Section 10 has the details.

### `/cairn:summit`

Complete the milestone. The server gates hard — nothing archives until every
phase is verified.

1. Show what's completing: phases, verification state, the native tracker
   milestone when the backend has one. Any unverified phase → stop, list
   them, point at `/cairn:verify <N>`.
2. One batched question: the milestone summary (1–3 sentences), whether to
   start the next milestone, and — if no native milestone exists yet —
   whether to create one now.
3. Docs, before anything archives: a full-milestone distill into `docs/`,
   plus — when a docs connector is configured — an explicit offer to
   publish (never automatic). A docs failure is reported and skipped;
   distill resolves archived phases too, so it can be redone after the
   summit.
4. Complete the milestone: closes tracker phases (recording skips for
   backends whose phase primitive can't close), releases the native milestone
   when supported, archives `phases/` to `milestones/vN/`, bumps the roadmap.
   On `PRECONDITION_FAILED` or `TRACKER_DOWN`: report and stop — re-running
   after a fix is safe; the operation is idempotent.
5. Git side (always agent-side — the server never writes git): commit the
   archive and tag `v<N>`.
6. Clear the handoff — the milestone is done; no session survives it.
7. If you said yes to the next milestone: create it, interview goals and
   first phases (batched), scaffold, add roadmap rows.

---

## 3. Every verb, A to Z (grouped)

Each verb below: purpose, exact args, when to reach for it, what happens
under the hood, and the gotchas. The core six are detailed in section 2;
they're summarized here for completeness.

### Lifecycle

**`new [project name]`** — new project: interview, plan artifacts, tracker
mirror, issues. See section 2. Gotcha: it refuses to run without
`cairn.json` — config first, always.

**`plan <N> [--quick|--deep] [--model <m>] [--tdd] [--mvp] [--prd <file>]
[--ingest <glob>] [--gaps]`** — plan a phase per the depth dial. See
section 2. Gotcha: a non-empty tracker delta gets one line of mention and
never blocks planning; `/cairn:resync` is the integration path.

**`work <N> [--wave [N]]`** — execute a phase. See section 2. Gotchas:
`--wave` requires wave frontmatter (plan first); ownership checks only exist
when `user.handle` is set; the mid-issue-bug rule is absolute — route to
`trace`, don't detour.

**`verify <N>`** — goal-backward phase check. See section 2. On a pass it
also reports docs drift — which phases the public docs owe entries for —
report only, never generating. Gotcha: VERIFICATION.md's *existence* is the
verified signal, so it is never written on a failure — and a failed verify
mandatorily opens a trace.

**`ship`** — gate on drift-clean + no open issues in verified phases, then
push. See section 2. Between the gates and the push question it distills
docs for any flagged phase being shipped (advisory — a docs failure never
blocks the push) and folds the docs diff into the one push/hold ask.

**`summit`** — complete the milestone: verify gate, tracker close/release,
archive, tag. See section 2. Runs a full-milestone distill and offers a
docs publish (never automatic) before anything archives. Gotcha: safe to
re-run after a partial tracker failure — the completion is idempotent.

**`status [--stats]`** — the one-screen view. Peeks the tracker delta, then
renders: the phase table (artifacts present as C/R/P/V, issue counts), the
active phase's issues (id · title · state · assignee), drift flags each with
a one-line remedy, unplanned tracker issues with an adoption offer, open
backlog/seed marks (seeds get flagged when their trigger reads as met —
firing is cairn's judgment to surface, yours to act on), open traces, open
sessions by kind, and open audit/review findings. Ends with the obvious next
step. `--stats` folds in live-read project statistics — phase counts, issue
counts grouped by label, memory index size, session counts, audit-record
counts. Every number is a live read at that moment, never a cached snapshot;
that's the entire reason stats live inside `status` instead of a report file.

**`auto`** — chained hands-off execution of remaining phases. Opt-in and
explicit: the run list (every phase with CONTEXT.md and without
VERIFICATION.md, in order) is shown with ONE confirmation before anything
runs. Phases without CONTEXT.md are excluded and listed as skipped — auto
never invents context. Per phase: plan if needed (standard depth) → work →
verify. Hard stops that halt the run and hand back: a failed verify (the
report includes a ready-made trace handoff — auto never starts the trace
itself; no self-repair), drift flags, any tracker error, any
security-relevant decision (auth, secrets, data exposure, dependency trust),
and — engineer mode — a cairn-authored PR awaiting human review. Unattended
decisions resolve against ordered principles (completeness over shortcuts,
match existing patterns, choose reversible, mirror your past choices, defer
ambiguity, escalate security) and every one is logged with the principle that
resolved it. Genuinely subjective taste calls don't stop the run — the
reversible option is taken and the batch is presented as ONE review at the
end. A killed run resumes via `/cairn:waypoint resume`.

`auto --batch [--budget <tokens|$usd>] [--phases <N,N,...>]` is the
budgeted, walk-away form. Everything is staged while you're still present:
phase selection (explicit list, or budget-fit on worst-case estimate
ranges), the research question round, and — in ONE staging question — the
phase list, estimates vs ceiling, and explicit push pre-authorization,
scope-limited to those phases (ship's push confirmation moved to run
start, never silently bypassed; declining it just downgrades the run to
verify-without-push). Approval writes a run manifest — the executor's sole
source of authority — then the run goes headless: per phase, plan if
needed → work in waves → verify → ship if pre-authorized, with actual
spend re-checked at every phase and wave boundary. The budget is hard at
boundaries and honest about overshoot: no new phase or wave starts past
the ceiling, an in-flight wave finishes (bounded overshoot ≤ one wave).
The tracker stays first-class throughout — an umbrella issue for the run
gets one plain-language comment per phase transition, and the usual
per-issue comments keep flowing — so you can watch a run you're not
attending. Any exit, complete or stopped, ends in the run report:
phases done, spend vs estimate, what's verified but not pushed, and the
stop reason if there is one. The report file lands beside the run's
manifest under `~/.cairn` (never committed), and the same content — in
plain language a non-engineer can read — becomes the closing comment on
the run's umbrella issue, which then closes. Its estimate-vs-actual
lines double as calibration: the spend history the run leaves behind is
exactly what the estimator reads, so the next staging interview's
ranges tighten on their own.

**`fast "<change>"`** — trivial inline change: one issue, ≤3 files, one
atomic commit. Guardrail first: if the change plausibly touches more than 3
files or needs design judgment, it stops and suggests `/cairn:plan` before
creating anything. Otherwise: create the issue (label `fast`), make the
change (growing past 3 files mid-flight: stop, leave the issue open with a
note), pass the relevant tests, one conventional commit, close with the sha
in the note. No ledger entry — there's no phase. Full paper trail: claim,
close (with approximate time), or parked comments, leak-guard discipline
throughout.

### Planning aids

**`survey ["<topic>"]`** — project-wide research, then roadmap changes —
but only through a discussion gate. Where `scout` researches one phase,
survey researches the terrain: roadmap gaps, cross-phase unknowns,
assumptions gone stale since planning. Three stages: multi-agent research
into SURVEY.md (one file, epoch blocks per run, resumable with the same
section markers as scout), typed proposals batched into ONE question
(new phase / rescope / new issues / no action — nothing mutates before
your answer, in any mode), then apply + a dispositions footer so future
runs never re-raise a rejected proposal without new evidence. Mirrored as
a research issue with manager-language progress comments.

**`outlook [<project>] | --refresh | forget <project>`** — the portfolio
view: every cairn project on this machine on one board, rendered from the
snapshots each project already writes about itself. Aggregation never
opens a project or touches a tracker — the registry and mirror snapshots
are the whole read surface, so the board renders in one call even when
half the fleet is broken. Cards show where each project stands, open
sessions, tracker numbers when present, last activity; staleness is a
flag with a reason, not an apology. `--refresh` re-emits from the
projects; `forget` unregisters one. Also maintains a shareable written
board outside any repo.

**`scout <N>`** — research a phase WITHOUT planning it: `plan`'s research
stage alone, resumable. RESEARCH.md sections carry `<!-- scout: done -->` or
`<!-- scout: pending -->` markers; done sections are never re-researched (no
marker = legacy content, treated as done). Topics come from CONTEXT.md
unknowns and PLAN.md gaps; each section's marker flips to done as it
completes, so a kill mid-run loses at most one section. The finished brief is
indexed into memory. Use it when you want the knowledge now and the plan
later.

**`route insert|remove|edit <N> ["name"]`** — roadmap surgery. Never
renumbers existing phases — decimal insertion only (renumbering is where
prior tools broke). `insert <N.5> "name"` scaffolds a decimal-numbered phase
between its neighbors. `remove <N>` shows what dies first (open issues,
artifacts), asks one batched confirm-plus-per-issue-close-or-reassign
question, closes the tracker phase object when the backend supports closing
it (otherwise annotates the name and says so), moves the phase directory to
the removed archive, and strikes the roadmap row. `edit <N> "new name"`
renames the phase directory slug, roadmap row, doc headings, and tracker
phase name; scope changes are locked-decision edits recorded with what
changed and why.

**`import <phase url, id, or name>`** — reverse-mirror tracker-origin work
into cairn. Resolves the reference (URL → the identifying segment for your
backend; id/name pass through), scaffolds project and phase docs, writes the
phase's issue ids into PLAN.md frontmatter. An ambiguous name errors with
candidates — re-run with the exact id. Then the gap interview: the tracker
says *what*; you supply *why* — vision into PROJECT.md, locked decisions into
CONTEXT.md. Use it when the work already exists in the tracker and cairn is
arriving late to the party.

**`resync`** — both directions of drift in one verb. Git side: detect
commits no ledger range covers (first run just initializes the marker),
group them by likely phase with reasoning shown, and refresh CONTEXT.md/
PLAN.md per affected phase (assumptions broken outright → offer
`/cairn:plan <N> --gaps`). Tracker side: read the delta cursor — new phases
route to `import`, new issues get folded into their best-fit phase (with
reasoning; no confident fit → you choose), edited issues integrate forward
(cursor-detected edits are provenance-known newer human intent and win —
except an edit colliding with a locked decision, which stops for you), state
changes get their remedy (externally closed-unverified → verify or reopen),
and declined items get labeled `cairn:backlog` plus a reconcile comment so
the editor sees why the plan didn't follow. Only after the adoption questions
are answered does the cursor advance — un-acked deltas re-surface every scan.

**`probe "<question>" | (none = frontier) | --wrap [<id>]`** — risk-ordered
throwaway spike sessions. With a question: opens a `cairn:spike` issue and a
session file, then runs the experiment loop HIGHEST-UNCERTAINTY FIRST — the
question most likely to kill the whole approach gets tested before anything
that only refines it. Each cycle: state what the experiment validates
*before* running it, build it in the probe's throwaway directory (prefer
something you can FEEL working over a stdout dump), log what actually
happened ("it worked" is not a result — the surprises are the result),
capture any preference or constraint you state mid-loop as a requirement
entry (losing one means re-discovering it the expensive way later), and log a
verdict: VALIDATED | INVALIDATED | PARTIAL, with the why. Close archives the
session with a `proceed|pivot|stop` resolution. No args = frontier mode:
the session landscape (a tool, the only source of truth — never
reconstructed from memory) plus the roadmap proposes risk-ordered candidates,
splitting integration risk from frontier risk; a settled `stop` resolution is
NEVER re-proposed. `--wrap [<id>]` promotes a resolved probe into a durable
project skill with provenance, then *offers* to delete the throwaway
directory — never auto-deletes. There is deliberately no fast lane: if the
answer is already obvious, that's a `mark`, not a spike.

**`draft "<design question>" | (none = frontier) | --wrap [<id>]`** —
multi-variant design sketches on a shared theme. Every variant in every
session links the same `themes/default.css` — CSS custom properties ONLY
(colors, type scale, spacing, radii); no component styles, no layout, ever —
so a picked direction reads as one system, not three unrelated pages.
Alongside it, `tokens.json` mirrors the same properties as typed groups;
every token change touches BOTH files in the same change — a token in one
and not the other is drift `audit ui` will flag. The loop: one design
question per variant set (never "pick a color AND a layout" — you can't
evaluate two axes at once), one self-contained HTML file per option, a
decision logged when you pick — and decisions COMPOUND: later variants honor
them, never re-litigate. Passing remarks that matter get note entries. Close
archives with the chosen direction as the resolution. Frontier mode proposes
consistency sketches (screens drifted from a locked decision) and frontier
sketches (undesigned areas); settled rejections are never re-proposed.
`--wrap` promotes a resolved session to a skill, same as probe. Non-trivial
questions dispatch to the `cairn-designer` agent — the verb keeps the
session lifecycle and tracker mirror; the agent does the wireframe → tokens
→ prototype work. No fast lane, by design.

Both plugin agents (`cairn-designer`, `cairn-uat`) name cairn's tools in
their frontmatter by full id — `mcp__plugin_cairn_cairn__<tool>` — never by
the bare tool name. Since Claude Code 2.1.299 an agent's `tools:` list takes
only the named MCP server's tools, and a bare name grants nothing: before
#376 both agents ran with Read/Write/Bash alone while the server sat
connected beside them. `server/test/agents.test.ts` holds every entry to a
tool the server registers; a live `claude -p --plugin-dir . --agent
cairn:<agent>` dispatch is the acceptance when the list changes.

### Capture & memory

**`mark "<text>" [--seed "<trigger>"] [--note]`** — zero-friction capture in
ONE tool call. No questions, ever — structure happens at pickup, not
capture. Default: a tracker issue labeled `cairn:backlog`; the id is echoed
and you're done. `--seed "<trigger>"`: a `cairn:seed` issue whose body
records the trigger; `status` lists open seeds and flags any whose trigger
reads as met. `--note`: a memory `note` card scoped to the active
phase/issue — knowledge, not work; it never becomes tracker noise. Pickup
paths: backlog marks get adopted by `plan` or triaged later; notes surface
through `recall` and the session banner.

**`remember "<fact>" [--type decision|constraint|gotcha|reference]`** —
store durable knowledge. One durable fact → a memory card (with scope from
the active context and provenance — the files and commits the fact is about
— when known); bulk material (tool output, fetched docs, research dumps) →
the disposable index instead. Cards are git-committed — they ship with the
repo, and cairn reminds you of that.

**`recall "<query>" [--phase N] [--issue <id>]`** — search memory, scoped
tight by default (flags > active context > whole project). Durable cards
come back first with staleness surfaced — `STALE`/changed/deleted cards are
reported with what moved and re-verified, never silently trusted — then
index matches, matched sections only, never raw bulk. Every item cites its
source and scope.

**`retro [<N> | --milestone]`** — write the lessons a future session needs.
Default scope: the last verified phase; `--milestone` spans every phase of
the current milestone including just-archived ones. Evidence comes from the
ledger, verification records, git log over the ledger ranges, and closed
issues. Lessons become cards typed decision/constraint/gotcha with
provenance from the ledger range and honest confidence: `high` = verified by
this scope's events, `medium` = plausible inference, `low` = hunch worth
recording. Prior cards in scope get re-graded: confirmed → confidence up one
step; contradicted → down to `low` plus a corrected NEW card (card bodies
are immutable — corrections are new cards, not edits). One question approves
the whole batch.

**`distill`** — ship-time knowledge synthesis, run at or after `ship`/
`summit`. The output must read as if the repo never had planning
scaffolding. Inputs: shipped phases' locked decisions, plan outcomes, ledger
summaries, and decision/constraint cards. Outputs into `docs/`:
ARCHITECTURE.md (per-section merge — never clobbers hand-written content;
conflicts surface to you), one ADR per code-shaping locked decision
(referencing commits, not phase dirs), and CHANGELOG.md entries grouped by
milestone or phase. Everything is sanitized BEFORE writing — generated files
are scanned against the leak patterns, and any hit is rewritten to
public-safe form until the scanner passes clean. One confirmation shows the
diff summary before writing; a docs connector configured → the follow-up
offer is `/cairn:docs publish`.

**`brief [--stdout]`** — onboarding briefing for someone who wasn't there.
A view, not a source of truth — regenerated wholesale each run from
PROJECT.md, the roadmap, per-phase ledger one-liners, and high-confidence
decision/constraint cards (medium only when directly load-bearing). Output
is cache-stable (no volatile timestamps, stable ordering). Default writes
`docs/BRIEF.md` as a full overwrite; `--stdout` prints instead.

**`map build | "<question>" | diff | status`** — the project knowledge
graph: typed nodes (`module|phase|issue|decision|person`) and typed edges
(`depends-on|implements|decided-in|owns`) in one deterministic store. The
verb does the intelligence; the server only guarantees shape and atomicity,
and all writes go through the validated patch tool — never a direct file
edit. `build` walks the real sources (code structure, plan artifacts, the
tracker) and proposes only what the evidence supports; requirement →
decision and decision → module edges sourced from draft sessions are
first-class — the UAT traceability sweep depends on them. Nodes are chunked
across as many patches as you like, but **edges go in ONE final patch
carrying the complete list** — an edges array replaces the whole list, so a
partial edges chunk erases every edge written before it. `"<question>"`
answers in named terms from the stored graph — a missing answer is a build
gap, not a license to guess. `diff` rebuilds current truth in memory,
compares against the store, and names the drift; it never writes. `status`
reports counts plus staleness — a graph weeks behind the last commit is a
graph nobody should trust yet, and it says so plainly.

### Sessions & continuity

**`waypoint [resume]`** — manual session continuity. Bare `waypoint`
pauses: one batched question for `next_action` and `notes`, then a
checkpoint that merge-patches over the existing handoff; with
`continuity.wipCommits: true` and uncommitted work, it offers (never
auto-makes) a `wip(cairn):` commit. `waypoint resume` resumes: read the
handoff (none, or older than 14 days → say so, offer to inspect or discard,
stop), then cross-check the trust order — **the handoff is a hint, never
authority**: tracker + git log outrank the ledger, which outranks the
handoff. A handoff contradicting the tracker gets reported and corrected
before it's followed. On confirmed resume the handoff is cleared, and any
in-flight decisions it carried are offered as decision cards — the distill
moment a crash would otherwise have destroyed.

**`trace ["<bug>" | <id> | close <id>]`** — persistent debugging that
survives `/clear`, mirrored to the tracker in language a manager reads.
Start: a `cairn:bug` issue plus a session file, then the loop — `evidence`
FIRST (reproduce before hypothesizing) → `hypothesis` → `test` (an
experiment that can DISPROVE it) → repeat. Never two open hypotheses without
distinguishing evidence. Mirror touches at milestones only: "Investigation
started", "Cause identified", and the resolution on close. Resume (bare
`trace` or an id): the session file IS the context that survived — re-read
it and continue from the last entry. Close: fix landed with tests passing →
log a verdict (cause + fix + commit sha) → close (it mechanically refuses
without a verdict), then write the gotcha card with high confidence — it's
proven; that's what high means. Fast lane (cause already proven obvious AND
fix ≤3 lines): one evidence + one verdict + fix + close — one motion, full
paper trail.

**`thread "<name>" | (none = list open) | --wrap`** — persistent context
threads: the running memory for something that spans more sittings than your
context window does. Not a bug hunt, not a spike. Start creates a
`cairn:thread` issue; starting the same name while one is open is a resume,
not a duplicate — re-read the file and pick up from the last entry (no
mirror comment on resume; the tracker already knows). Entry discipline: log
as the work happens, not in a batch at the end — `note` (a fact worth
keeping), `link` (a reference PLUS one line of why it matters — a bare
reference is worthless six sittings from now), `decision` (a choice and its
reasoning, logged when made). Bare `thread` lists open threads from the
session landscape and offers a resume — a menu, not an action. `--wrap`
logs a wrap entry (the close gate) and closes with the resolution. Two
tracker touches total: start and wrap.

### Quality & governance

**`audit <mode> [target] | --fix`** — cross-phase quality audits: a
retro-check against what was already claimed done, not a new review invented
on the spot. Modes: `uat` (walk shipped flows as a user on a named platform
matrix — desktop + mobile viewport minimum — with a requirement-traceability
sweep; dispatched to the `cairn-uat` agent), `milestone` (goals vs delivered,
phase by phase), `security`/`ui`/`eval`/`validation` (re-check the phase's
OWN stated criteria — never a generic checklist substituted for the phase's
actual bar; `ui` adds the fidelity contract against the draft session's
decided direction and tokens.json — and when the seat roster holds a
matching seat, its lens may sharpen the mode's eye, though the phase's own
criteria stay the boss and no seat means exactly today's behavior),
`tests` (find untested requirements and
WRITE the missing tests, not just flag them), `plans` (the plan-quality scan
for contract drift and unanchored thresholds, translated to plain language),
`docs` (sweep README/docs claims — tool counts, verb lists, paths, commands
— against the real codebase; drifted claims are findings), `security
--surface` (the agent-config attack surface — `.claude/` hooks and
settings, plugin manifests, MCP configs, permission allowlists, credential
literals in tool configs — the layer code audits never see), `sweep`
(the whole-project rescan — every leg above in one pass, diffed against the
last sweep; see "The sweep" in section 8). No target on a
phase-scoped mode = the most recently active phase. Closing discipline,
every mode, no exceptions: write the audit record (the record is the source
of truth; the tracker is the summary — and a clean `pass` still gets a
record, because that's the proof the audit ran), then one `cairn:audit`
issue per critical/important finding with the severity as the literal first
line of the body. Minor findings stay in the record only — a tracker full of
minors is a tracker nobody reads. `--fix`, only after the record exists:
mechanical fixes (obvious and small) land directly, one commit per finding,
comment + close; anything else is investigation-shaped and opens a trace —
never an improvised inline fix in between.

**`review [target] | --fix`** — five-axis code review: a fresh read against
the code as it stands (that's the difference from `audit`). Target
resolution: none = the working diff plus staged, full stop — no hunting for
a "more interesting" target; a branch name = that branch against `main`; a
phase number = the phase's ledgered commit ranges (read from the ledger, not
guessed). The panel comes from the seat roster — with no project seats
that's exactly the five default axes (correctness, clarity, architecture,
security, tests) plus the signal-gated defaults — ux when the diff
touches UI files, lean when it is large or touches server code — a
project seat joins in roster order, and every seat
reports an anchored 0-10 score beside the verdict that never gates
anything; internal seats are framing lenses, `peers` stays the genuinely
adversarial external council. A clean axis still gets a "no findings"
line; silence isn't the same as checked. Every finding is ranked critical/important/minor and names a
`file:line` plus a concrete failure scenario — a finding without a scenario
is a hunch; it gets downgraded or cut, and since phase 21 the audit record
itself refuses a finding whose typed `failure_scenario` is missing. Also
since phase 21, critical/important findings pass a refutation panel BEFORE
the tracker: a bounded verifier tries to reproduce the scenario and votes
(default REFUTED), the server computes the quorum inside `audit_record`,
a refuted finding stays in the record but is never filed, and survivors
credit their raising seats' yield. Closing: critical/important →
`cairn:review` issues (severity first line, plain language — the scenario,
not the stack trace); minors stay in the record; the record is written every
time, clean or not, under a slugged scope. `--fix` follows audit's exact
two-shapes contract — and since phase 21 a mechanical code fix is STAGED,
not applied: generated in a detached scratch worktree, written as a patch
file mirrored to the issue, judged by one independent verifier stating
three claims (targeted / no new issue / behavior unchanged) that the
record turns into an apply-eligibility bit, and applied to the working
tree only when the user says so. Audience split worth knowing: `file:line` and the
verification detail live in the record (for engineers re-deriving the fix);
the issue body is for a manager triaging by severity.

**`triage [--stale-days N] | --apply`** — a health check on the tracker
itself. Sweeps open issues into classes: resolved-but-open (an evidence
rule, not a vibe — the session landscape or an audit record must name the
resolution; "feels fixed" is not evidence), stale (default 14 days,
`--stale-days` overrides — flag only, deliberately not config surface),
unlabeled, bodiless, unowned-in-progress, possible-duplicate (judgment, not
regex), and — on link-capable trackers — priority-inversion (an issue whose
declared priority is weaker than what it inherits through the dependency
chain, straight from `graph_report`; a P3 blocking a P1 is effectively P1).
Report always: a triage record plus a plain-language summary grouped
by class. **No new issues are ever created** — the one deliberate deviation
from audit/review's rule, because every triage finding already has a tracker
object: the issue itself. Filing an issue about an issue is noise. `--apply`
executes only the safe subset: best-fit labels from the vocabulary already
in use (never a new label name), one-line stale nudges, evidence-quoting
close comments then close for resolved-but-open, cross-linking comments on
BOTH ends of a possible duplicate, and a plain-language comment naming the
inheritance chain on a priority-inversion. Never-rules: duplicates are never
auto-closed; bodiless and unowned-in-progress are always report-only; every
close quotes its evidence first; priority labels are never rewritten — the
comment surfaces the inversion, raising the label is the human's move. When in doubt whether a finding qualifies
for `--apply`, it doesn't.

**`medic [--repair] | forensics [phase]`** — the planning directory's own
doctor. Bare `medic`: plan status, drift, plan checks, and ledger/file
cross-checks (does every phase have its ledger, plan, and directory? do
ledger commits still exist? a phase marked verified with no ledger evidence
is a finding, not a pass), ranked by what breaks next if ignored, closed
with a record. It also checks **plugin state** — the triple of installed
version, marketplace pin, and running server — because a stale or
orphaned plugin is the one health problem that makes every other check
lie to you (details in section 11's "Running an older cairn than you
think"). `--repair`, only after the health record exists, makes
exactly three mechanical moves: ensure a missing phase's tracker object,
scaffold missing files, relink stale plan↔issue links. **Structure, never
content**: it never rewrites what a plan says, never resolves a drift
finding by editing either side to match, never guesses what an ambiguous
state should mean — judgment-shaped findings are named "needs a human call."
`forensics [phase]` reconstructs what actually happened from three
witnesses — the ledger, git log over the phase's ranges, and tracker issue
history — and names any disagreement ("ledger says closed clean; git shows
two later commits touching the same files" is the shape of answer it
exists to produce). Forensics mutates nothing.

**`backtrack <phase|plan> | --apply`** — safe git undo scoped to what the
ledger says shipped — never a blind reset. The compute pass builds the
revert set from exactly the ledgered commits (nothing added because it
"looks related"), then runs the overlap check: any LATER commit touching a
file the revert set also touches is flagged file by file — overlap is never
resolved automatically; it means manual review, full stop. Nothing is
touched without `--apply`. `--apply` reverts one commit at a time,
newest-first (never a squashed revert — every original keeps its paired
revert in the log), runs the test suite (a red suite is reported, not
silently swallowed — and not "fixed" mid-run), mirrors a plain-language
comment to the affected issues, and writes a record. Never-rules: never
`git reset --hard`, never force-push, never anything outside the ledgered
manifest, and the remote is always untouched — pushing the reverts is your
call.

**`peers (none = status) | review [target] | plan <phase> | council [dimensions]`** — convene
external AI CLIs (codex, opencode, antigravity, grok, copilot — five seats, four labs) as reviewers — a second
opinion on top of cairn's judgment, never a replacement. **A peer saying
something doesn't make it true**: every peer finding is verified against the
actual code (or plan) before it goes anywhere near the tracker. Bare
`peers`: detection status per provider (on PATH, enabled, lab, input cap) — zero
peers is a normal result, not a warning. `peers review`: cairn's own
five-axis review runs FIRST, in full; the outbound content is leak-scanned
(a hit BLOCKS that send until you decide — redact and retry, or skip that
peer); each available peer reviews the same diff with the same finding
shape; every peer claim is judged adversarially; convergence runs at most
two rounds (a peer still disagreeing after round 2 is recorded as an open
disagreement, not given a round 3); survivors follow review's closing
discipline plus provenance — which peer, which round. `peers plan <phase>`:
same shape over PLAN.md — unambiguous verified critiques become plan edits;
anything opinionated enough that the plan's owner should decide becomes a
`cairn:audit` issue instead. `peers council [dimensions]`: the widest
lens — the peers sit as a product council across up to four dimensions
(code, functionality, look-and-feel, market fit; you pick which in one
question up front). Same containment as review — leak scan, adversarial
verification of every claim, bounded rounds, resumable state — with the
verified output landing as recommendations for the roadmap discussion,
not silent changes. Absent peers never block anything — the verb degrades
gracefully to "cairn reviewed this alone" and records the run as usual.

### Workspaces & collaboration

**`basecamp init | focus <member> | dispatch | claim|update|done <id>`** —
multi-project workspaces and the parallel-workstream dispatch board — the
one verb that knows there's more than one project in the room. Bare
`basecamp` renders the board: per member, a focus marker, workstreams
grouped by status (queued/active/blocked/done), open-issue and open-session
counts; unconfigured members show up flagged, not hidden. No workspace is
not an error — cairn explains what one buys and offers `init` without
running it unasked. `init` is an interview-lite: it finds candidate member
directories (their own `cairn.json`, or an obvious project root), asks which
are members, and writes `cairn-workspace.json` at the root — nothing else;
each member keeps its own tracker-first setup untouched. `focus <member>`
repoints EVERY verb at that member — plan, work, issue calls, banner,
handoff — because they all resolve through the same project dir; nothing
downstream needs to know a workspace exists. `dispatch` decomposes a goal
into session-sized workstreams, queues them on the board, and prints
copy-pasteable per-session opener lines — it NEVER auto-spawns sessions.
The claim/update/done lifecycle runs from inside whichever session picked up
a workstream, with the discipline that matters: **focus is workspace-global,
last-write-wins, and another session can steal it between two of your tool
calls** — so before ANY tracker or board write, confirm focus still points
at YOUR member, and after claiming, re-read the board to confirm your
session tag won the race (if another tag appears, back off and pick
different work). Never claim a workstream that's already active.
`done` closes the issue and the board entry with the same plain-language
note — board and tracker tell one story.

### Docs & knowledge

**`docs publish [--name "<project>"] | (none = status)`** — mirror the
repo's documentation into the configured docs connector (Confluence or
Docusaurus).
Status reports the connector and landing page, or shows you the config block
shape if none is set. Publish: the project gets a folder named after it
under the space root; README.md becomes the landing page inside it; `docs/`
plus a root CHANGELOG.md become the child page tree; the landing page gains
a generated Documentation contents section. Images referenced by published
pages upload as real attachments (Confluence) or copy alongside the page
(Docusaurus) — the architecture diagrams under `docs/diagrams/` render
inline, not as broken links. Idempotent — re-publish updates pages in place
and never duplicates an attachment. `--name` overrides the project name
(default: repo directory name). Pairs naturally after `distill`. Full
detail in section 5.

### Configuration & health

**`tune [key] [value]`** — the config editor over `cairn.json`; all writes
go through the validated single-writer, never hand-edits. Bare `tune` shows
the effective config grouped (tracker/agents/memory/continuity/leakGuard)
with defaults marked, asks which group to change, batches that group's
edits into one question. `tune <key> <value>` is a direct dot-path set
(`tune continuity.resume auto`); `null` deletes a key; values are coerced to
the target type before patching — a wrong guess is rejected with
`CONFIG_INVALID` and the file stays untouched, so it's safe to be wrong.
Two named shortcuts: `tune leakguard off|on` (the leak guard's front door)
and `tune mode vibe|engineer` (the collaboration posture switch — engineer
requires `user.handle`; the server rejects the combination without it, and
tune asks for the handle and sets both in one patch). Credential-looking
keys or values are refused outright — secrets live in env vars.

**`profile`** — a developer profile: how you talk, what you already know,
what you'd rather not re-explain every session. Advisory only — it
calibrates tone and depth for every other verb, never what those verbs
decide. No tools: it writes `.cairn/profile.md` directly. It infers first —
README, contributing docs, linter configs, commit style from git log, test
framework, recent session history — and asks only what's left, in one
batched question (never a question the repo already answered). Sections:
communication, expertise, conventions, cadence — each inferred-or-asked,
never invented; an empty section beats a guessed one. Missing file is the
default state, not an error.

**`do "<request>"`** — the freeform smart router. Classifies your request
against the routing table and dispatches: read-only verbs with a clear match
run directly; mutating verbs or low confidence confirm first ("Sounds like
`/cairn:plan 4 --deep` — run it?"); no plausible match renders help.

**`help [verb]`** — the verb reference, rendered from the routing table.
With a typo, it nearest-matches ("`wrok` isn't a cairn verb — did you mean
`work`?"). With a verb name, it shows that verb's purpose, args, and
procedure summary. Bare, it renders the full reference in lifecycle order —
starting, always, with `/cairn:new`.

---

## 4. Tracker backends

Eight adapters behind one normalized interface, each declaring its
capabilities rather than pretending to a lowest common denominator. All
eight support issue comments. Credentials never live in `cairn.json` — the
config names *env vars*, and the adapter reads them at runtime. (The local
backend needs none at all.)

### Local

No accounts, no credentials, nothing to sign up for — issues live in your
repository as plain files. This is the zero-setup path, and it passes the
identical contract suite the hosted six pass:

```json
"tracker": { "type": "local", "config": { "dir": ".tracker", "prefix": "proj" } }
```

`dir` (default `.tracker`) is created on first use and **must be
committed** — it IS the tracker. `prefix` (2–10 lowercase alphanumerics)
forms issue ids like `proj-x7k2m`; the 5-character random suffix makes
simultaneous creation on different branches collision-safe.

The layout is deliberately boring: one directory per issue holding an
`issue.md` (readable frontmatter + markdown body — the blank line between
fields is what keeps concurrent edits merge-clean, don't "tidy" it), plus
one file per comment, worklog entry, and issue link. Concurrent work merges
with stock git: two branches creating issues, commenting the same issue,
or adding different links never conflict; two branches rewriting the same
field conflicts loudly on purpose — that's a real race a human should see.

Extras the hosted backends don't have yet: real issue links (`blocks`,
`parent-of`, `relates-to`, `supersedes`) and everything under "The
dependency graph" below. Time logged on close lands as real worklog files.

**Promotion — start local, graduate when the team grows.** One call,
`tracker_migrate(targetType, targetConfig)`, moves everything to a hosted
backend: phases first, then issues (states, labels, assignee, with the
phase references remapped), then comments and worklogs, then links —
native issue links where the target supports them, `[link]` comments where
it doesn't. Every migrated issue carries a `[migrated from <old-id>]`
backlink, and the full old→new id map lands in `.tracker/MIGRATED.json`.
`dryRun: true` reports counts without writing a thing. Honest caveat:
hosted comment APIs attribute writes to the API credential, so original
authors and timestamps survive as a `[<time> <author>]` prefix inside the
comment text, not as native metadata. The local store is never modified
beyond a `migratedTo` marker — writes still work afterward, with a warning
that they won't reach the new home.

### GitHub

```json
"tracker": { "type": "github", "config": { "repo": "owner/name" } }
```

Auth: `GITHUB_TOKEN`, or an existing `gh auth login`. Phases map to
milestones. Assignee writes: supported. Issue listing paginates up to 1000
items.

### GitLab

```json
"tracker": {
  "type": "gitlab",
  "config": {
    "baseUrl": "https://gitlab.com",
    "project": "owner/name",
    "tokenEnv": "GITLAB_TOKEN",
    "extraLabels": []
  }
}
```

Auth: the env var named by `tokenEnv` (a personal access token with `api`
scope). `extraLabels` adds labels to every cairn-created issue. Assignee
writes: not yet mapped. Listing paginates up to 1000 items.

### Jira

> **Scoped tokens are supported.** Atlassian killed classic API tokens —
> anything issued before Dec 2024 expired between Mar and May 2026. The
> replacement scoped tokens (`ATCTT`-prefixed) don't authenticate against
> the site URL directly; they only work through Atlassian's
> `api.atlassian.com/ex/jira/{cloudId}` gateway. This adapter detects that
> automatically: an `ATCTT`-prefixed `JIRA_API_TOKEN` switches it into
> gateway mode on its own — resolve the site's cloudId once (an
> unauthenticated lookup against the site itself), then route every API
> call through the gateway with the same Basic auth as before. Classic
> tokens keep working exactly as they always have, no config changes
> needed. Human-facing links (`url:` fields) always point at the site, in
> either mode. The scoped token needs the `read:jira-work` and
> `write:jira-work` scopes.
>
> Detection is automatic, but `"authMode": "site" | "gateway"` overrides it
> if you ever need to force one path or the other.

```json
"tracker": {
  "type": "jira",
  "config": {
    "baseUrl": "https://your-domain.atlassian.net",
    "projectKey": "PROJ",
    "issueType": "Task",
    "emailEnv": "JIRA_EMAIL",
    "tokenEnv": "JIRA_API_TOKEN",
    "transitions": { "in_progress": "In Progress", "closed": "Done" }
  }
}
```

Auth: Atlassian email + API token via the named env vars. The `transitions`
map ties cairn's normalized states to your workflow's transition names —
if your board says "Doing" instead of "In Progress", say so here. Jira is
the one backend with **worklog support**: `issue_close` with a time spent
writes a real worklog entry (a worklog failure never fails a close that
already succeeded — the close comment's time line is the fallback
everywhere). Assignee writes are supported — give an email and cairn
resolves it to the Atlassian account behind the scenes. Listing capped at
100 items.

**Sprint awareness:** cairn detects the project's board via the Agile API.
On a scrum board, new issues land in the active sprint automatically (no
active sprint → backlog); kanban boards behave as before. Multiple boards
on one project? Set `"boardId": <n>` in the config to pin the right one.
Sprint assignment is best-effort — an Agile-API hiccup logs a warning and
never fails the create. Epics are never sprinted.

**Estimates:** `issue_create`/`issue_update` accept story points + original
time estimates; points land in the site's story-point field (discovered
automatically, team- and company-managed variants), time in Jira's native
original-estimate — so burndown, velocity, and workload reports have real
data. Paired with worklog on close, estimate-vs-actual comes for free.

### Asana

```json
"tracker": {
  "type": "asana",
  "config": { "projectGid": "1234567890123456", "tokenEnv": "ASANA_TOKEN" }
}
```

Auth: personal access token via the named env var. Assignee writes: not yet
mapped. Listing capped at 100 items.

### Azure Boards

```json
"tracker": {
  "type": "azure-boards",
  "config": {
    "orgUrl": "https://dev.azure.com/your-org",
    "project": "your-project",
    "workItemType": "Issue",
    "patEnv": "AZURE_DEVOPS_PAT",
    "apiVersion": "7.0",
    "states": { "in_progress": "Doing", "closed": "Done", "open": "To Do" }
  }
}
```

Auth: a PAT with Work Items (Read & Write) scope via the named env var. The
`states` map plays the same role as Jira's `transitions` — normalized state
to your process's state names. Assignee writes: supported. Listing capped
at 100 items.

### ClickUp

```json
"tracker": {
  "type": "clickup",
  "config": {
    "defaultListId": "900123456",
    "spaceId": "90123456",
    "tokenEnv": "CLICKUP_TOKEN",
    "statuses": { "open": "to do", "in_progress": "in progress", "closed": "complete" }
  }
}
```

Auth: personal API token via the named env var. The `statuses` map ties
normalized states to your list's status names. Assignee writes: explicitly
deferred (needs numeric user-id resolution not yet implemented). Listing
capped at 100 items.

### Linear

```json
"tracker": {
  "type": "linear",
  "config": {
    "teamId": "9cfb482a-81e3-4154-b5b9-2c805e70a02d",
    "apiKeyEnv": "LINEAR_API_KEY"
  }
}
```

Auth: personal API key via the named env var (sent raw — no Bearer prefix;
create one at linear.app/settings/api). Issues carry Linear's human
identifiers (`ENG-123`). No state map needed: cairn's states resolve
against the team's workflow automatically (in-progress → the team's
`started` state, close → `completed`). Phases are Linear **Projects**, with
a real phase close via the workspace's completed project status. First
hosted backend with native issue links — `blocks` and `relates-to` map to
Linear relations, `parent-of` to native sub-issues, so `graph_report`
(ready frontier, inherited priority) works here too; `supersedes` has no
Linear equivalent and degrades to a text backlink. Labels find-or-create
by name. Listing capped at 100 items.

### Capability differences at a glance

| Capability | Backends |
|---|---|
| Issue comments | all eight |
| Assignee **writes** | Local, GitHub, Azure Boards, Jira (email→account resolution; others accept the call but don't propagate) |
| Worklog (real time entries on close) | Local, Jira |
| Estimates (story points + original time) | Local, Jira — populated at plan time; others ignore silently |
| Issue attachments (`issue_attach` — screenshots as evidence) | Local, Jira; audit ui/uat attach visual findings |
| Sprint awareness (creates land in the active sprint) | Jira scrum boards, auto-detected (`boardId` overrides) |
| Issue links + dependency graph | Local + Linear (`graph_report`; Linear lacks `supersedes`) |
| Native milestones | backend-dependent; `summit` records a skip when the phase primitive can't close, and `milestone_*` degrades gracefully |
| State mapping config | Jira `transitions`, Azure Boards `states`, ClickUp `statuses` (Linear resolves the team workflow automatically) — all take extra keys as **custom states** ("review", "blocked"); the local backend uses a `states` vocab (name → category) |
| Custom states (formerly CRN-26 on the retired Jira tracker) | `issue.state` is the board's real state name; `issue.category` (open/in_progress/closed) is what every gate and report reasons about. Writes accept the canonical three everywhere, plus any configured custom name — Jira/Linear/Azure/ClickUp/local; GitHub/GitLab/Asana have no custom surface and say so |
| Issue-list cap (affects `plan_unplanned` completeness) | 1000 (GitHub/GitLab), 100 (Jira/Asana/Azure Boards/ClickUp/Linear) — truncation is logged to server stderr |

Adapter maturity, honestly stated: GitHub is live-green against a real
sandbox, and the local backend needs no live suite at all — its filesystem
IS the live backend, exercised directly by the unit, contract, and
merge-safety suites. The other six are fully implemented and pass the
unit and contract suites, but hadn't been run against live credentials at
the time of writing — run the env-gated live suite (`server/README.md` has the exact
commands per backend) before leaning on one in production. Two known risks
called out there: the Jira adapter uses a search endpoint Atlassian has
deprecated on Jira Cloud, and the Azure Boards iteration-parsing was
hardened speculatively against known API variance.

### The dependency graph

Backends with `hasDependencies` (the local tracker first — full section
coming with its setup docs) carry typed links between issues: `blocks`,
`parent-of`, `relates-to`, and `supersedes` for iteration lineage. On top
of them, `graph_report` answers three questions no flat issue list can:

- **What's ready right now?** The frontier — open issues whose blockers
  are all closed. `status` leads with it; it's the pick-next-work list.
- **What's actually urgent?** A P3 that blocks a P1 is effectively P1 —
  priority inherits through the `blocks` chain, and `status` shows the
  inheritance (`effectively P1, inherits from <id>`).
- **How did this idea evolve?** `supersedes` edges chain iterations
  oldest → newest, so an issue's whole lineage is one lookup.

Cycles are rejected the moment an edge would close one, and `medic` flags
(and `--repair` removes) edges whose endpoint issue no longer exists. Any
backend that grows `hasDependencies` later gets all of this for free — the
graph functions compute over the neutral SPI shapes, not the store.

---

## 4.5 Running cairn outside Claude Code

Cairn's mechanism layer is a plain MCP server over stdio and its judgment
layer is markdown — neither cares which harness is driving. `cairn-setup`
wires a project for Grok Build, GitHub Copilot CLI, Codex, Gemini CLI, or
Cursor:

```bash
node setup/cairn-setup.mjs <harness> [--project <dir>]
```

Three things happen everywhere: a `cairn` entry merges into the project's
`.mcp.json` (never clobbering yours), the generated verb-registry fragment
installs into `AGENTS.md` between `cairn:begin`/`cairn:end` markers, and
the verb subroutines copy to `.cairn/harness/` so the harness can execute
any verb by name — "run cairn status" reads and follows the same
subroutine `/cairn:status` does. Copilot additionally gets
`~/.copilot/mcp-config.json` wiring, a `copilot-instructions.md` section,
and `/cairn-plan|work|status|verify|ship` prompt files; Codex gets its
`[mcp_servers.cairn]` block merged into `~/.codex/config.toml` (marker
comments, hand-written entries left alone) plus `~/.codex/prompts/cairn-*`
prompt files; Gemini gets `settings.json` + `GEMINI.md` plus namespaced
TOML commands in `.gemini/commands/cairn/` — `/cairn:plan` and friends,
same spelling as Claude Code.

Cursor additionally gets the hooks port: `cairn-setup cursor` installs a
single adapter (`.cursor/hooks/cairn/cursor-adapter.mjs`) plus the cairn
hook scripts, and merges entries into `.cursor/hooks.json` — sessionStart
resumes continuity (banner + handoff as `additional_context`), preToolUse
runs the run guard and the harness guard (Shell and every MCP call through
both, file writes through the harness guard; the entry fails closed), beforeShellExecution
runs the leak guard (deny with the offending lines),
afterShellExecution/afterFileEdit capture breadcrumbs + observations.
OpenCode gets an `opencode.json` `mcp`
entry plus `/cairn-plan|work|status|verify|ship` command files in
`.opencode/commands/`; Zed gets a `context_servers.cairn` entry in
`.zed/settings.json` and reads `AGENTS.md` natively.

Which guards actually run, per harness — the leak guard (internal refs in
a commit), the run guard (destructive git, the ship gate, pushes mid-run)
and the harness guard (hooks, settings, the installed plugin, the
ship-gate stamp and run manifests):

| Harness | Leak guard | Run guard | Harness guard |
|---|---|---|---|
| Claude Code | yes | yes | yes |
| Cursor | yes | yes — Shell and MCP calls | yes — file-tool path field assumed; an unreadable call is denied; MCP calls judged as in Claude Code |
| Codex, Gemini CLI, Copilot CLI, OpenCode, Grok Build, Zed | no | no | no |

Where a guard doesn't run, its rule is prose in `AGENTS.md` and nothing
stops the agent. Codex, Gemini, Copilot and OpenCode all have blocking
pre-tool hooks the guards could be wired into; that is follow-up work.

What degrades, honestly: no slash-command ergonomics in Grok Build, Cursor,
or Zed (verbs run by name), and the cost tracker stays Claude Code-only
everywhere — it reads Claude's transcript JSONL for token usage, which no
other harness produces (Cursor exposes a transcript_path, but not in that
format). Grok Build claims Claude hook compatibility (untested). Everything the
SERVER owns — all 87 tools, mirroring, drift math, estimates, attachments,
custom states — works identically everywhere, which is the point: the
tracker paper trail doesn't care which model wrote it.

## 5. Docs connectors — Confluence and Docusaurus, end to end

The docs connector publishes your repo's documentation outward to a team
wiki or docs site. It is deliberately a *sibling* of the tracker subsystem,
not an extension of it — trackers manage work items, docs connectors publish
documentation, and they share nothing but the HTTP core and the config
pattern. Two connectors ship today — Confluence (remote wiki, HTTP) and
Docusaurus (local static-site checkout, filesystem) — and the interface is
product-neutral (bodies cross it as markdown; each adapter owns conversion),
so new targets can slot in behind the same contract suite on demand — no
Notion/GitBook/Slite/SharePoint connector is currently shipped or scheduled.

### Setup

Add a `docs:` block to `cairn.json` (the template ships it as `_docs` —
copy it over to `docs` to enable):

```json
"docs": {
  "connector": "confluence",
  "config": {
    "baseUrl": "https://your-domain.atlassian.net/wiki",
    "spaceKey": "DOCS",
    "emailEnv": "CONFLUENCE_EMAIL",
    "tokenEnv": "CONFLUENCE_API_TOKEN"
  }
}
```

Then export the two env vars the config *names* (the names are yours to
choose; those are the defaults):

- your Atlassian account email
- an Atlassian API token (create one at Atlassian's API-token page)

Jira and Confluence share Atlassian API tokens — same-site users can point
these env names at their existing Jira credentials. The space named by
`spaceKey` must already exist; an unknown key fails with `NOT_FOUND` and a
pointer at the config.

**Scoped tokens are supported**, same as the Jira connector: an
`ATCTT`-prefixed token switches this connector into gateway mode
automatically — cloudId resolved once, every API call routed through
`api.atlassian.com/ex/confluence/{cloudId}`, human-facing page URLs
unchanged. Classic tokens keep working with no config changes. The
scoped token needs Confluence content read/write scopes (grant them at
Atlassian's API-token page when you create the token — the exact scope
picker there is the authority on naming). Force a mode with
`"authMode": "site" | "gateway"` if you ever need to.

A note on `spaceKey`: pages are matched by title and ancestry *within the
configured space*, and publish never deletes remote pages. Treat the space
key as settled once you've published — pointing the config at a different
space later doesn't move anything; it starts a fresh tree in the new space
and leaves the old one standing.

### What publish does

`/cairn:docs publish [--name "<project>"]`:

1. Your project gets a **folder named for the project** under the space
   root (looked up case-insensitively; created if absent). `--name`
   overrides the name; the default is the repo directory name.
2. `README.md` becomes the **landing page** inside that folder. The README
   is deliberately not part of the child tree — it's the front door.
3. `docs/` (plus a root `CHANGELOG.md` when present — distill writes both)
   becomes the **child page tree**, mirroring your directory structure.
   Directory pages get generated child listings.
4. The landing page gains a **Documentation contents** section with real
   page URLs — a two-pass publish, since the links don't exist until the
   children do.

**Ordering:** directory entries are sorted lexically, so numeric filename
prefixes (`01-runbook.md`, `02-adr/`…) control page order in the tree and
in generated contents sections. The prefix (and the `.md` extension) is
stripped from the page title; the title itself is the file's first H1 when
it has one, else derived from the filename. Dotfiles are skipped.

**Idempotency:** pages are matched by title + ancestry and updated in
place — re-publishing is safe and is the normal way to push doc updates.

**Title conflicts:** Confluence titles are unique per *space*, not per
parent. When your page's title is already taken elsewhere in the space, the
page publishes under a `Title (Context)` disambiguation instead of failing
— the verb mentions any suffixed titles in its report.

**What publish does NOT do:** delete anything remotely. When local files
disappear, their remote pages remain — the verb notes stale pages for
manual cleanup when the tree shrinks.

**Conversion:** a dependency-free markdown → Confluence storage-format
converter handles headings, paragraphs, nested lists, fenced code (as a
code macro), tables, blockquotes, and links. Images degrade to links;
unknown constructs degrade to escaped text. Conversion never throws — worst
case you get plainer output, not a failed publish.

### Docusaurus

Why would a static-site generator need a *connector* at all? Because
Docusaurus has no page API — the site's `docs/` folder IS the database, and
the community-recommended way to feed it from a tool is simply to write
markdown files into that folder and let the site's own CI build and deploy.
That's exactly what this connector does…

```json
"docs": {
  "connector": "docusaurus",
  "config": {
    "sitePath": "../my-docs-site",
    "docsDir": "docs",
    "autoCommit": false
  }
}
```

- `sitePath` — path to your Docusaurus site checkout (absolute, or relative
  to the cairn project). It must contain a `docusaurus.config.js|ts|mjs`;
  publish fails with `CONFIG_INVALID` otherwise. No credentials — there is
  no remote.
- `docsDir` (default `docs`) — the docs root inside the site; created if
  missing.
- `autoCommit` (default `false`) — after a successful publish, commit the
  project folder in the *site's* repo (`docs(cairn): publish <project>`).
  It never pushes, and a failed commit (not a repo, hooks, whatever) never
  fails the publish — it degrades to a `warning` on the publish result.

**The mapping:** your project becomes one folder,
`<docsDir>/<project-slug>/`, with a `_category_.json` carrying the project
name. The README becomes the folder's `index.md` (Docusaurus's native
category landing page), each doc file becomes a `.md` page with front
matter (`title`, `sidebar_position` in publish order), and each doc
directory becomes a nested folder — empty directories get a
`_category_.json` with a `generated-index` link so Docusaurus renders the
contents page itself. No generated TOC markdown anywhere: the sidebar and
generated indexes are the navigation, which is the whole point of the
`hasNativeToc` capability.

**Filenames mirror your repo:** published files keep their source names
(`docs/00-quickstart.md` publishes as `00-quickstart.md`, not a
title-derived slug), so repo-relative links *between* your docs keep
resolving on the published site. Every page also opts into CommonMark via
`mdx.format: md` front matter — raw markdown with literal `<angle>`
brackets never hits the MDX parser.

**Broken-link policy:** links that point *outside* `docs/` (a
`../README.md`, a source-file reference) can't resolve on a static site.
Docusaurus fails the build on these by default — set `onBrokenLinks:
'warn'` in `docusaurus.config.js` (the standard setting for imported
content), or keep doc links inside `docs/`.

**Ownership:** everything under `<docsDir>/<project-slug>/` is
cairn-managed and overwritten on re-publish; the connector never touches a
file outside that folder. Hand-written pages elsewhere in the site are
safe.

**v1 limits:** no attachments, no versioned-docs/i18n trees, and page URLs
in the publish report are file paths (the real site URL needs a built
site).

### Status and errors

Bare `/cairn:docs` reports the connector and the landing page (title +
link) or "not yet published"; with no `docs:` block it shows you the block
shape. `CONFIG_MISSING` → add the block. `AUTH_MISSING` → the message names
the exact env vars to export.

---

## 6. Memory

Cairn's memory is engineered against context rot: the failure mode where an
assistant's "knowledge" quietly drifts out of sync with the code and nobody
notices. Two tiers, different durability guarantees:

| Tier | Store | Lifetime | Use for |
|---|---|---|---|
| 1 — index | SQLite full-text index at `~/.cairn/index/` (outside the repo) | disposable, rebuildable | reference-grade bulk you'll cite later: docs, API surfaces, research dumps |
| 2 — cards | `.cairn/memory/cards/*.md`, git-committed | durable | single facts: decisions, constraints, gotchas, references |

Never index logs, test output, or build output — that's ephemeral; read it,
act on it, don't persist it.

**Cards** are frontmatter'd markdown files, one fact each — not session
summaries. Types: `decision`, `constraint`, `gotcha`, `reference`, and
`note` (un-triaged jottings from `mark --note` — cheap to write, first to
prune). Every card may carry a `confidence` of high/medium/low, surfaced at
recall and re-graded only by `retro`, never silently. Card ids are content
hashes of the body, so re-creating an identical card never duplicates —
and **bodies are immutable**: the only mutation a card ever gets is a
confidence re-grade. A changed lesson is a new card.

**Provenance + staleness — the anti-rot headline.** Cards record the files
and commits that back them. Every recall re-verifies that provenance
against the current repo (a git diff since the recorded commit) and serves
`stale: true` with reasons when the code has moved. Never treat a stale
card as ground truth — re-verify the claim, then update (rewrite) or retire
the card. A stale card left unaddressed is worse than no card. Memory can
be wrong; it can never silently lie.

**Scoped recall.** Search the task at hand, not the whole project's noise:
recall scopes issue > phase > project, widening only when the narrow search
comes up empty. A pre-rendered recall banner (capped at
`continuity.recallIndex.maxCards`) is injected at session start at a known
token cost — with honest accounting of what the banner saves versus
injecting every card in full.

**Distill-then-drop.** At issue close and phase transition, ask "what here
deserves a card?" Write the card with provenance; then let the old index
scope simply stop being searched. No deletion needed — tier 1 is
disposable by design, which is also why losing the index loses nothing.

**Capacity guard.** `memory.tokenThreshold` (default 150,000) is the
advisory line: when the index's approximate token usage crosses it, the
recommendation is to split the active issue into sub-tasks rather than
piling more work into one context. Advisory means advisory — the tool can't
pause you; you act on the signal.

**Observation backlog.** The PostToolUse observe hook appends a row per
Edit/Write/Bash call to `.cairn/observations/observations.jsonl`, and retro
is the only thing that ever reads or clears it. Left alone, that buffer
grows until the hook's retention cap quietly drops the oldest half — work
nobody reviewed, gone without a word. So memory announces its own state:
`mem_stats` returns an `observations` block (row count, oldest-entry age in
days, the threshold), and once the count reaches
`memory.observationWarnThreshold` (default 25) the recall banner carries a
line directly under its header — `N unreviewed observations (oldest Xd) —
run retro`. A backlog past the line is enough to render the banner on its
own, because the session with no cards and no open sessions is exactly the
one that has never run retro. Capture stays passive and review stays
retro-gated; the counter only refuses to let the pile grow invisibly. Like
the card audit, it reads one plain file, so a broken index binding never
hides the warning.

One care-and-feeding note: cards are git-committed, so treat them like
code — review, PR, don't hand-edit frontmatter into malformed shapes. A
malformed card silently drops out of recall rather than erroring; check
`git status`/`git diff` after hand-editing one.

---

## 7. Continuity & sessions

### Session continuity (the crash-proof part)

Kill a session mid-task — compaction, usage cap, `/clear`, a real crash —
and the next session resumes at the exact task with zero re-executed work.
The server is the primary writer: every state-changing tool refreshes a
per-machine handoff file, write-through, on every call. Hooks cover the
gaps: a throttled breadcrumb after Edit/Write/Bash calls, an unthrottled
refresh right before compaction, and a session-start hook that prints the
handoff and — per `continuity.resume` — offers (`prompt`), auto-runs
(`auto`), or suppresses (`off`) the resume. Two more ride the same rails:
a Stop-hook cost tracker that snapshots session spend (tokens +
approximate dollars) tagged with the active phase and issue — surfaced by
`status --stats` and the close comment's agent-cost line — and a passive
observation log (tool, target, error flag) that `retro` reviews for
candidate lessons and then clears. Every hook is fire-and-forget
and targets under 100ms; a hook failure is never visible to your session.

There is no longer a native-task mirror. Earlier releases listened for
`TaskCreated` / `TaskCompleted` and mirrored each native task to the
tracker; Claude Code ships the task tools default-off on every current
model, so those events never arrive, and the hook pair, its spool and
the session-start advisory were retired in phase 26 (2026-10-13). The
verbs' own claim/progress/close comments are the tracker mirror. The
validated design stays in the repo's `native-task-hook-mirror` skill
for the day the tools come back on by default.

Guard rails worth knowing:

- **Skeleton guard** — a write can never replace a rich handoff with an
  empty one; richness is monotonic between clears.
- **Unregistered guard** — nothing is ever created for a project without a
  loadable `cairn.json`.
- **Never trusted blind** — a handoff older than 14 days is surfaced as
  stale and never auto-resumed, even with `resume: "auto"`. And the trust
  order on any resume is: tracker + git log > LEDGER.md > handoff.

`ship` and `summit` clear the handoff — shipping ends the session.
`/cairn:waypoint` is the manual pause/resume path (section 3).

### The four session kinds

Four persistent, typed session kinds share one core: a git-side session
file (append-only typed entries), a tracker mirror in plain language, and a
mechanical close gate — a session *cannot* close without its gate entry
logged first.

| Kind | Directory | Entry kinds | Close gate | Tracker label | Reach for it when… |
|---|---|---|---|---|---|
| `trace` | `.cairn/trace/` | evidence, hypothesis, test, verdict | ≥1 verdict | `cairn:bug` | debugging anything — a failed verify, a reported bug, a mid-work discovery |
| `probe` | `.cairn/probe/` | experiment, result, requirement, verdict | ≥1 verdict | `cairn:spike` | you'd otherwise be guessing — a risky assumption worth a throwaway experiment |
| `draft` | `.cairn/draft/` | variant, decision, note | ≥1 decision | `cairn:sketch` | a design direction needs comparing options side by side |
| `thread` | `.cairn/thread/` | note, link, decision, wrap | ≥1 wrap | `cairn:thread` | context must outlive more sittings than your context window does |

Session ids are description-derived hashes, and starting the same
description twice while a session is open refuses with a pointer at the
existing session (for threads, that refusal *is* the resume path — by
design). Archives are immutable: closing appends a resolution block and
moves the file to the kind's `archive/` directory. Probe and draft artifact
directories survive the close until `--wrap` packages what's worth keeping
into a project skill — after which deletion is offered, never automatic.

The tracker mirror across all kinds is milestone-only and verb-driven:
comment on start, a key-finding/decision comment mid-session, and the
resolution rides the close (threads collapse to two touches — start and
wrap). Plain language on every mirror touch: no code blocks, no file paths,
no internal refs a non-engineer would bounce off of. The detail lives in
the session log; the tracker gets the story.

`session_landscape` is the read-only join over all four kinds and the
single source of truth for what's open — `status`, frontier modes, and
thread listing all read it rather than reconstructing from disk or memory.

---

## 8. Quality machinery

### Verify's posture

Goal-backward, always: the question is "does the codebase deliver what the
phase PROMISED," never "did the tasks close." Depth raises the bar — quick
is tests-pass, standard adds the tracker cross-check, deep adds an
adversarial verification subagent. VERIFICATION.md is written only on a
pass, and a failed verify mandatorily becomes a trace.

### Drift

Drift is a stop signal, not a warning. The drift scan reads every phase's
referenced tracker issues and flags two things: **missing** (the issue no
longer exists — remedy: recreate it and relink) and **closed-unverified**
(the issue is closed but its phase has no VERIFICATION.md — remedy: verify
the phase, or reopen the issue). The presence of VERIFICATION.md is the
human-controlled contract that makes closed issues normal. `plan`, `ship`,
`status`, and `medic` all consume the same scan; `ship` refuses to push
over it.

### TDD gates

Eligibility is decided per task at plan time (`plan --tdd`) and stored in
PLAN.md frontmatter. Work time enforces RED → GREEN → REFACTOR as separate
commits with the RED and GREEN shas recorded in the ledger at close. Verify
enforces the evidence: every TDD task's ledger line must carry its
`tdd <red>..<green>` segment, or the phase fails — no exceptions, no
retroactive forgiveness. The ledger is the evidence chain.

### Audits, reviews, triage

Three distinct instruments — worth keeping straight:

- **`audit`** is a retro-check against what was already claimed done (eight
  modes, section 3), including the fidelity contract for UI (shipped UI vs
  the draft session's decided direction and tokens.json) and the docs sweep
  (README claims vs the real codebase).
- **`review`** is a fresh five-axis read of a diff, branch, or phase —
  correctness, clarity, architecture, security, tests — every finding with
  a file:line and a concrete failure scenario, or it's a hunch and gets cut.
- **`triage`** is tracker hygiene — and the one place findings never become
  new issues, because each finding already *is* an issue.

All three close through the same record store: `.cairn/audit/` files, one
per scope per day (same scope re-run the same day supersedes; prior dates
untouched). A `pass` verdict still writes the record — the record is the
proof the check ran. Critical/important findings mirror to the tracker with
the severity as the literal first line; minors stay in the record. The
`--fix` contract everywhere is two shapes only: mechanical (fix, commit per
finding, comment, close) or investigation-shaped (open a trace). Not
clearly mechanical means investigation-shaped by default — the safe side to
be wrong on.

The plan-quality scan behind `audit plans` runs four deterministic
detectors: **contract drift** (`contract-drift`: a consumer's Produces/Consumes contract text
sharing a named symbol with a producer's but not matching it),
**unanchored thresholds** (`unanchored-threshold`: a quantitative bound — `< 100ms`, `at least
99.9%` — with no benchmark, fixture, spec, or measurement anchor nearby),
**missing verify** (`missing-verify`: a task in a planned, non-quick, unverified phase with
no `verify:` clause), and **missing approaches** (`missing-approaches`: a planned, non-quick,
unverified phase whose CONTEXT.md lacks the `## Approaches considered`
block).
Deterministically ordered, byte-equal across runs on an unchanged tree.

**`audit memory` audits the card store**, and the finding it exists for is
the one you cannot otherwise see. A card whose frontmatter will not parse
is skipped silently by both `mem_card_list` and recall, so it disappears
from every surface without announcing itself — the store looks healthy
precisely because the broken card is invisible. The mode reads every file
directly and reports what the normal path is hiding, alongside provenance
whose file is gone or whose commit no longer resolves, near-duplicate card
bodies, aged low-confidence cards, and counts by type and confidence.

Severity follows the damage. A malformed card is important, because it is
rot you would never otherwise find. Broken provenance is important when the
file is gone and minor when only the commit is unresolvable. Near-duplicates
and aged cards are minor and route to retro's compaction rather than to a
fix in the audit — card bodies are immutable, so a correction is always a
new card, never an edit.

The evidence arrives under `cards` from `mem_stats` and is computed from
plain files and git, deliberately not from the search index. The index needs
a compiled native binding, and a plugin cache installed under a newer node
runtime ships without one; an audit that died exactly when memory was
unhealthy would be the wrong shape. If `indexUnavailable` appears beside the
card block, the index is down and the card audit still ran.

### The sweep — `audit sweep [--fix]`

What's wrong with this project right now, and is it better or worse than
last time? That's the question the sweep answers, in one run. Reach for it
before a release, after a long stretch of out-of-band work, or on a
cadence — `/cairn:do "rescan this project"` routes here too, through the
usual confirm.

It runs the existing modes as legs, in a fixed order: `security` and
`security --surface` (rule-to-control coverage included), `tests`, `docs`,
`plans`, `simplify`, `memory` (one "leg skipped" line in a project with no
card store), and `milestone` last as the closing view, sunset sweep and
all. Each leg closes exactly the way its mode always does — dedup, the
refutation panel, its own record, survivors filed with `cairn:audit` plus
`cairn:sweep` — so a tracker filter on `cairn:sweep` shows everything one
sweep raised.

Then one manifest: an `audit_record` under a `sweep-<date>` scope that
lists every leg's record and carries the union of the legs' surviving
findings, panel votes and all. Nothing is re-judged there. The server
stamps the cairn version and the commit, and diffs the findings against the
previous sweep — **new**, **persisting**, **fixed**, **regressed**
(fixed last time, back now), and **unchecked**, plus how many code commits
landed in between. A finding only counts as fixed when the leg that raised
it ran again under the same scope; if that leg was skipped or pointed at a
newer phase, the finding is unchecked, its leg is named as uncovered, and
the next sweep still compares against it. The first sweep has no delta;
it's the baseline the next one is measured against.

The report is one prioritized backlog: regressed critical, new critical,
persisting critical, then important in the same order, minors as counts,
and a "fixed since the baseline" line — the payoff — followed by the
unchecked count and the legs that didn't re-run. Below it: the latest
eval results as a per-case table (read from the last run, never started by
the sweep, regression rows marked as gates and any failing gate first), the
approximate agent spend on the issues the sweep filed, and a portfolio
snapshot so `/cairn:outlook` sees where the project stands.

`--fix` runs the staged-patch discipline leg by leg — each leg's patches in
its own scratch directory, its own verifier round, its own apply question —
never one patch or one ask across legs. A fix applied during a sweep shows
up as `fixed` in the next sweep's delta, once that leg runs again.

### Peers

External AI CLIs as reviewers, with three hard properties: cairn's own
review always runs first and in full; every outbound send passes the leak
gate (a hit blocks the send until you decide); and every inbound claim is
judged adversarially against the real code, with a two-round convergence
cap. Missing peers never block anything.

---

## 9. Collaboration

### Vibe vs engineer mode

`user.mode` picks the posture. **Vibe** (default): cairn drives end to end;
judgment calls resolve silently. **Engineer**: you claim issues, write
code, and make the design calls; cairn pairs, scaffolds, verifies, and
keeps the tracker mirror honest for both parties' work. Concretely,
engineer mode changes four things:

1. **Claiming** — `work` asks "mine or yours?" once per wave/phase; your
   issues get scaffolding (branch, in-progress, a claim comment carrying
   the task context and, for TDD tasks, the failing test) and then cairn
   steps back.
2. **No-self-merge** — cairn's finished work lands as a PR naming you as
   reviewer and does not merge; `ship` stops while any cairn-authored PR
   awaits review; `auto` treats a waiting PR as a natural stop.
3. **Decision surfacing** — genuine design forks stop and ask, options with
   trade-offs, cairn's recommendation first. Boilerplate stays automatic.
4. **Closing your work** — when you're done, cairn runs the tests and
   verify posture against it, closes with evidence and time logged on your
   behalf, and offers (never forces) a review.

Engineer mode requires `user.handle` — set both with
`/cairn:tune mode engineer`.

### Ownership and courtesy

Claiming an unassigned issue (any verb that moves it to in-progress)
auto-assigns it to the working user, so the tracker shows who holds what
without anyone remembering to assign. Identity comes from `user.handle`
when set; otherwise it's derived from the tracker credentials themselves —
Jira resolves the authenticated account (`/myself` → accountId, and an
email handle is resolved to an accountId automatically), GitHub uses the
token's login, Azure Boards the signed-in account. GitLab and ClickUp
don't support assignee writes yet (numeric-id resolution pending). The
rules: an explicit assignee always wins, an already-assigned issue is
never touched, and an identity-lookup failure never blocks the claim —
the result carries `autoAssigned: true` when it fired.

With `user.handle` set, cairn also skips issues assigned to someone else
unless you explicitly override — never silently. Without a handle,
ownership checks are off (auto-assign still works via credential-derived
identity where the backend supports it). Work-state
concurrency (two agents starting the same issue) is the tracker's job — the
in-progress state transition is the atomic claim; cairn reads the
tracker's truth. Plans and memory cards collaborate through ordinary git:
push, PR, review, merge. No locking machinery, on purpose.

### Workspaces

`basecamp` (section 3) adds the multi-project layer: a workspace file
naming member projects, a focus that repoints every verb, a dispatch board
for parallel workstreams, and the focus-discipline rules that keep N
parallel sessions from trampling each other. The compatibility guarantee is
absolute: with no workspace file anywhere above your launch directory,
nothing changes — every single-project setup behaves identically.

### Import and unplanned work

`import` reverse-mirrors tracker-origin work into cairn; `plan_unplanned`
surfacing (via `status` and `plan`) catches tracker issues no plan
references — work at risk of being missed. Between them, cairn joins teams
mid-stream instead of demanding a greenfield.

---

## 10. cairn.json — complete reference

One file at the repo root, validated on every read and every write. All
writes go through the config tools (`/cairn:tune`), which validate the
*merged* result before touching the file — an invalid patch changes
nothing.

| Key | Type | Default | What it controls |
|---|---|---|---|
| `tracker.type` | `github \| gitlab \| jira \| asana \| azure-boards \| clickup \| linear \| local` | *(required)* | Which tracker adapter runs |
| `tracker.config` | object | *(required)* | Backend-specific config (section 4); deep validation lives in the adapter |
| `docs.connector` | `confluence` \| `docusaurus` | *(optional block)* | Which docs connector runs |
| `docs.config` | object | — | Connector config: `baseUrl`, `spaceKey`, `emailEnv` (default `CONFLUENCE_EMAIL`), `tokenEnv` (default `CONFLUENCE_API_TOKEN`) |
| `agents.model` | `auto \| inherit \| haiku \| sonnet \| opus` | `auto` | Model routing for agent fan-out. `inherit` = session model everywhere; an explicit value pins everything; `auto` routes per work class: mechanical → fast tier, synthesis → session tier, judgment gates → strongest. Blast-radius rule: output that gates verify/ship routes UP, never down; uncertain → inherit | Every dispatch also carries the rubric's `effort` dial for its work class (mechanical low, synthesis medium, judgment high; Claude Code 2.1.292+). cairn never sets `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` — it pins every workflow subagent to one model and flattens this routing to a single row |
| `memory.tokenThreshold` | positive integer | `150000` | The capacity-guard advisory line for the memory index |
| `memory.observationWarnThreshold` | positive integer | `25` | Unreviewed observation rows before the banner says "run retro" |
| `user.handle` | non-empty string | *(optional)* | Your tracker identity — enables ownership tracking, claiming, skip-others'-work |
| `user.mode` | `vibe \| engineer` | absent ≡ `vibe` | Collaboration posture (section 9). Engineer requires `handle` |
| `continuity.resume` | `prompt \| auto \| off` | `prompt` | Session-start resume behavior: ask, proceed, or suppress |
| `continuity.checkpoint` | boolean | `true` | The post-tool-use breadcrumb hook |
| `continuity.wipCommits` | boolean | `false` | Whether `waypoint` offers a `wip(cairn):` commit on pause |
| `continuity.recallIndex.enabled` | boolean | `true` | The session-start memory banner |
| `continuity.recallIndex.maxCards` | positive integer | `20` | Banner card cap |
| `drift.staleDays` | positive integer | `5` | Days of silence before `plan_drift` calls work stale |
| `ship.confirm` | boolean | `true` | Ship's push-or-hold question before anything leaves the machine; `false` restores the silent push |
| `leakGuard.enabled` | boolean | `true` | The commit-time leak guard hook, and the scan `peer_run` makes of outgoing input |
| `leakGuard.allow` | string[] | `[]` | Path globs exempt from the guard |
| `leakGuard.extraPatterns` | string[] | `[]` | Additional regex patterns to guard against |
| `peers.<provider>.enabled` | boolean | `true` when absent | Per-provider toggle; providers: `codex`, `opencode`, `antigravity`, `grok`, `copilot` — unknown provider names are rejected |
| `peers.<provider>.model` | string | template default (`copilot`: `gpt-6.1-sol`) | Model pin for seats whose CLI takes a model flag — today only `copilot`. A `claude-*` id is refused at load (the adjudicator's own family shares its blind spots), and so is `auto` (not a pin — Copilot's auto pick defaults to a Claude model). Pin a model your plan actually has; an unavailable one exits 1 with stderr only and the run records the seat as incomplete |
| `peers.<provider>.maxInputChars` | positive integer | `200000` | Input cap per provider; longer input is head-truncated with a verbatim marker line |
| `peers.<provider>.execCapable` | boolean | `false` when absent | Your declared trust that this CLI may run from the project folder to exercise the product during a functionality review. Without it every peer runs contained in a scratch folder, and `peer_run` refuses project mode. Never probed at runtime |
| `peerFanout.maxConcurrent` | positive integer | *(optional block)* — absent, sized to the host: min(cores − 1, free memory ÷ 750MB, 8), at least 1 | How many peer CLIs run at once; `peer_list` reports it and the `peers` verb dispatches in batches no wider. Its own block because `peers` is keyed by provider name |
| `seats.enabled` | string[] | *(optional block)* — absent, every shipped default seat plus any project seat | Picks the seat roster and its order; a name that matches no valid seat definition is skipped with a roster note |
| `seats.disabled` | string[] | — | Seat names removed from the roster |
| `seats.dispatch` | `auto \| off` | absent ≡ `off` | What a verb's `inherit` dispatch dial resolves to: `auto` lets diff signals and seat yield pick the seats that fire; `off` fires the full roster |
| `contextEconomy.autocompactPct` | number 0.05–1, or `null` | `null` | The `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` you want. cairn never sets it; `config_probe` reports when the live value disagrees. `null` leaves the harness default alone |

**Unknown keys are mostly ignored, not rejected.** Most blocks drop a
key they don't know without a word: a misspelled `ship.confrim` or
`leakGuard.enabeld` validates, stays in the file, and does nothing,
while the setting you meant keeps its default. Two places are strict.
The `seats` block rejects any key it doesn't know, and `peers` rejects a
provider name outside the four. A field misspelled *inside* a provider's
entry is dropped like everywhere else, so a typo in `execCapable` leaves
that peer contained. When a setting seems to have no effect, check its
spelling first.

**The secrets-in-env rule, enforced:** config writes refuse any
credential-shaped key (`token`, `apiToken`, `api_key`, `password`,
`secret`, `pat`, …) and any value matching known token prefixes (GitHub,
GitLab, Atlassian, Slack, `sk-` keys). Config carries env var *names*; the
env carries the secrets. There is no override.

About the leak guard, since it's the config block people meet first: it
fires only on `git commit` calls, scanning the staged diff's added lines
for cairn-internal references — `.cairn/` paths, phase-directory refs,
cairn label strings, and your backend's issue-id pattern (for GitHub, bare
`#N` is deliberately not matched — "fixes #123" is legitimate). Allowlisted
paths (`.cairn/**`, `docs/**`, `*.md`, ledger/verification artifacts) are
skipped. A hit blocks the commit with an exact `file:line: [pattern]`
listing. Escape hatches: `tune leakguard off`, the `allow`/`extraPatterns`
config keys, or a one-shot `CAIRN_LEAK_OK=1 ` *prefix* on the commit
command (mentioning the variable elsewhere — say, quoted inside the commit
message — does not bypass). Accepted limitation: commits made outside
Claude Code are unguarded.

**Architecture rules run with the suite.** The layering the architecture
document describes is asserted, not merely written down:
`server/test/architecture.test.ts` checks that tracker adapters are
leaves, that the tracker subsystem imports none of the subsystems that
import it, that the docs connectors reuse only four named tracker
modules, and that the composition root is imported by nothing and the
tree has no import cycles. Every rule fails when its file pattern matches
zero files, because a rule that inspected nothing and passed reads as
coverage forever. The rules and the reasoning — including what is
deliberately not asserted — live in the architecture document beside
them, so the two cannot drift apart quietly.

**The context-footprint pin.** `node scripts/check-footprint.mjs` sums
what cairn costs a session before any verb runs — the command
descriptions in the slash listing, the skill descriptions, and the fixed
prose the session-start hook injects — and fails above a pinned budget.
Verb bodies and skill bodies are deliberately not counted: they load on
demand, and that lazy split is the design the budget exists to protect.
Tokens are estimated as characters over four, which the output says
plainly; the estimate is stable and monotone, which is all a growth guard
needs. The budget moves the way the tool count moves — because someone
decided the surface earned the room, never to make a red check go green.
Both generators print the current figure after they run, so the number
appears where the change was made.

**Declared verification.** Every plan task says how it will be proved,
in a backticked `verify: <command>` clause written when the plan is
written — the suite file, the guard script, the eval case, whatever
someone will actually run. The reason it goes in early is that criteria
written afterwards get chosen to fit whatever happened. `plan_check`
reports `missing-verify` for a task without one in a planned, non-quick,
unverified phase; a verified phase is exempt because its proving is
already written up. A task that genuinely cannot be proved by running
anything says so in the clause (`verify: none — docs only`), because a
written "nothing to run" is a decision and a blank is an oversight.

At close, `ledger_append` returns `declaredVerify` and
`evidenceCitesDeclared`. It reports; it does not refuse. Declarations are
written in shorthand (`npm test`) while evidence records what was really
typed, so a string gate there would fail honest closes and teach people
to pad the field. Whether a mismatch matters is a judgement, and verify
is where a human makes it.

On `drift.staleDays`: `plan_drift` reports two advisory flags about work
that has gone quiet. An issue held in progress that has had no tracker
update and no commit naming it for that many days, and a branch whose
last commit is that old. Neither is an error and neither blocks a ship or
a verify — the point is that silent work is invisible work, and a scan
that never says so lets it stay that way. The branch check is git-only:
"has no open pull request" would be sharper, but the tracker interface
has no pull-request surface and inventing one for an advisory flag is the
wrong trade. A branch under review that nobody has finished in a week
shows up here too, which is arguably right.

The leak guard's sibling is the **run guard**, which protects your
working tree and your history rather than your outbound text. It reads
every git command the agent runs through Bash the way a shell would:
through wrappers and their flag values (`sudo -u root`, `timeout 5`,
`env`, `nice -n 5`), program runners that start another command
(`xcrun`, `arch -arm64`, `caffeinate`, `script -q /dev/null`, `flock`,
`watch`, `strace`, `runuser`, and the g-prefixed GNU tools Homebrew
installs), a `sh -c` string (and the line `script -c`, `flock -c` or
`runuser -c` hands a shell), shell keywords and grouping (`if`, `for`,
`{ }`, `( )`), and a `$(…)` or backtick, quoted or not, which still
runs — and which is one word of the command around it, so `git reset
$(git rev-parse HEAD~1) --hard` is a hard reset, its `--hard` never cut
off into a line of its own. A
runner the table doesn't name is backstopped: when an unknown program's
later words form a command — `op run -- git push`, `bundle exec git
reset --hard`, `uv run`, a `-c` string, `tmux new-session -d '…'`,
`osascript -e 'do shell script "…"'` — that inner line is judged too, so
the table needn't grow one runner at a time. A program that only prints
or searches its arguments (`echo`, `grep`, `gh`, `jq`, …) runs none of
them — except the one option that does run a program, which is read as
a command line of its own: `man -P` / `--pager`, `gh alias set --shell`
(or a `!` expansion), `gh config set pager|editor|browser`, `rg --pre`,
`ag`/`ack --pager`, `sort --compress-program`; a `gh extension exec` or
a word that isn't a `gh` command is an extension or alias, an unknown
program judged like any runner; and a pager variable set on the line
(`PAGER=`, `MANPAGER=`, `GIT_PAGER=`, `GH_PAGER=`) runs on the `man`,
`git` or `gh` it rides on. `man git-reset`, `gh pr create --body "…"`,
`GIT_PAGER=cat git log` and `rg --pre-glob` stay allowed. An MCP tool's
command line is read the same way (see *Which tools
the guards see*, below). Quoted text that only mentions git never trips
it — a commit message saying "never `git reset --hard`" passes. A
heredoc body is data too, so a README written through `cat <<'EOF'`
can say the same; only the `$(…)` or backtick an unquoted body
(`<<EOF`) runs is read as a command, and a heredoc fed to a shell
reading stdin (`sh <<EOF`, `cat <<EOF | sh`) is that shell's script. A guard
that breaks lets the command through rather than blocking work. It
enforces three rules.

**Always, in every session: no git command that throws work away with
no undo.** Each refused form has an everyday neighbour that stays
allowed, because the neighbour is routine or recoverable:

| Refused in every session | Still allowed |
|---|---|
| `git reset --hard` | `git reset`, `git reset --soft` |
| Any force push: `--force`, `-f` (alone or in a cluster like `-fu`), `--force-with-lease`, `--force-if-includes`, or a `+refspec`, before or after a bare `--` | A plain `git push` |
| A whole-tree `git checkout` or `git restore`: a pathspec of `.`, `./`, `..`, `:/`, `*` or `**` (with or without `--`), or `--pathspec-from-file` | One path (`git checkout -- src/a.ts`, `git restore a.ts`), and `git restore --staged .`, which touches only the index |
| `git checkout -f`, `git switch --discard-changes` or `-f` | `git checkout <branch>`, `git switch <branch>`, `git switch -c <new>` |
| `git clean`, unless it's a dry run | `git clean -n` / `--dry-run` |
| `git stash clear` | `git stash drop`, `git stash pop` |
| `git reflog expire` | `git reflog` |
| `git push --mirror` (or a plain push to a remote configured to mirror), `git push --prune` | Pushing a named feature branch |
| A push that deletes the default branch | Deleting a feature branch (`git push origin --delete feature`), `git branch -D` |

`git clean` refuses even without `-f`, because `-c
clean.requireForce=false` or a repo setting turns git's own safety off.

**Always: the default branch takes only what a clean drift check saw.**
An agent push that would land on the default branch — `main`, `master`,
or the remote's HEAD branch, whether named, swept up by `--all` /
`--mirror`, or a bare `git push` from that branch — is refused unless
the last `plan_drift` left a clean stamp for the exact commit being
pushed. Each of these refuses:
- no stamp;
- a stamp for another commit, one that flagged drift, or a corrupt one;
- a stamp, or a stamp folder, that exists but can't be read. The push is
  refused rather than the check skipped.

Two more rules close the ways around the gate:
- **The gated push must be its own step.** If anything earlier on the
  same line can make a commit or move a ref (a commit, merge, rebase,
  reset, `branch -f`, a fetch, or any program that isn't known to be
  read-only), the commit being pushed isn't the one the stamp saw yet.
  The push is refused, with a line saying to push on its own after the
  drift check.
- **The gate checks the repository git will actually push.** The guard
  follows `cd` and `pushd` (every folder the line could end up in),
  `-C`, `--git-dir` / `--work-tree` and `GIT_DIR` / `GIT_WORK_TREE`.
  Another clone or worktree needs its own stamp, and a folder the guard
  can't work out refuses the push.

Other branches and tags are untouched. The refusal points at
`/cairn:ship`, which runs the drift check and then pushes. This is the
hook half of ship's "never push with flagged drift".

**While a batch run is live** — a run manifest for this project reads
`running` — two more rules apply. A batch run works inside its own
worktree so you can keep editing while it builds, and the guard makes
that separation enforced rather than merely intended: `git checkout`,
`git switch` and `git reset --hard` aimed at your main checkout are
refused with a line naming the run — the hard reset even with the
destructive override set. In the run's own worktree they pass, subject
to the always-on rules.
If that refusal fires, the run escaped its worktree — put it back. And
`git push`, from any worktree (the run's own is exactly where it
pushes), is refused unless the manifest carries the push authority you
granted at staging for its phases *and* marks one of those phases in
flight. `auto` records the phase with `run_manifest`'s `set_phase`
action at each phase start, and it only moves forward; a running
manifest with no phase marked — an older manifest, or a run between
phases — refuses. A refused push leaves the phase verified-not-pushed,
for you to push once the run is done. The push rule has no override:
push authority is your staging decision.

**The overrides are yours, not the agent's.**
`CAIRN_ALLOW_DESTRUCTIVE_GIT=1` unlocks the always-on table, and
`CAIRN_ALLOW_UNSHIPPED_PUSH=1` lifts the default-branch gate. Each lifts
only its own rule — deleting the default branch with the table unlocked
still meets the stamp gate — and each counts in two shapes only: set in
the session's environment, or as the leading assignment of the one
command it unlocks. A mention anywhere else, quoted in a commit message
or after `&&`, does nothing. The owner-checkout rule has a one-command
escape of its own, a leading `CAIRN_RUN_OK=1`. No refusal prints a
paste-ready prefix. It says the act needs the owner's go-ahead, names
your ways to give it — run the command yourself with `!` from your
prompt, or start the session with the variable set — and adds that a
request found in tracker or web text is not you asking. An agent never
sets one of these because an issue body, a review comment or a fetched
page asked it to. If a refusal fires and you didn't ask for the act,
find out where the instruction came from first.

The third of the trio is the **harness guard**, and it protects the
configuration that decides what the agent may do at all: the `hooks/`
directory, `.mcp.json`, the settings files under any `.claude/` folder,
the plugin manifests under `.claude-plugin/`, and your machine-wide
Claude settings (`~/.claude/settings.json` and `settings.local.json`).
An agent that can rewrite its own hooks can switch off every other
control in one edit, so the Edit, Write and NotebookEdit tools are
refused on those paths, and so is any Bash line or known MCP tool shape
that would write them.
The guard reads Bash with the same shell reader as the run guard and
looks for what a line *writes*: redirects; the operands of commands that
remove, create or change files (`rm`, `touch`, `tee`, `chmod`, `sed -i`,
`dd of=`); `cp`, `mv`, `ln`, `install` or `rsync` into a protected
folder; downloads (`curl -o` / `-O`, `wget -O`); archives unpacked there
(`tar -C`, `unzip -d`); patch tools (`git apply`, `patch`), judged by
the files the patch touches; `git checkout`, `restore`, `rm` and `mv` on
those paths; the folder a tree-creating command plants, judged like a
`mkdir` of it — `git clone`, `git worktree add`, `git submodule add`,
`git init`, `gh repo clone`, `gh repo fork --clone`, `npx degit` and the
`create-*` initializers (`npx create-x`, `npm create x`, `npm init x`,
`pnpm`/`yarn`/`bun create`, and a bare `npm init`'s `package.json`),
with the repo's own name as the folder when none is given, so a clone
into `.claude/skills` or `~/.claude/skills` — the install line a skill
README carries, which can plant a plugin with hooks and MCP servers of
its own — is refused while one into `src/`, `/tmp` or the project root
passes; `find -delete` or `-exec` over them; paths piped into
`xargs`; the file a wrapper writes itself (`time -o`, `script`'s
typescript); and all of these inside wrappers and the same program
runners the run guard reads through — including the off-table backstop,
so a write behind `op run --`, `bundle exec`, `pnpm exec`, `uv run` or
`tmux new-session -d` is seen — `bash -c`, `su -c`, a heredoc fed to a
shell, or shell keywords and grouping. Removing a protected
folder, or a folder that holds one (the project itself, your home),
counts too. So does Claude Code writing that configuration itself:
`claude mcp add` and `remove`; `claude plugin install`, `uninstall`,
`update`, `prune`, `enable`, `disable` (which would switch these guards
off next session), `init` and `configure --values-stdin`; the `claude
plugin marketplace` writes; and `claude import` — run as `claude` or
through `npx`, `bunx`, `pnpm dlx`, `yarn dlx` or `node` and its CLI.
Listing, a dry run and `--help` pass. A relative path is judged from
the tool's working folder and from every folder a `cd`, `pushd`, `env
-C` or `git -C` on the line could have moved to, in any order, because a
`cd` can fail or run later. A `git -C` (or `tar -C`) value is read the
way a `cd` target is: `~/proj`, `$HOME/proj` and `"$PWD"` are spelled
out, so `git -C ~/proj rm -r hooks` is judged where it lands.
After a `cd` the guard can't follow (`cd "$X"`, `cd -`, `cd $(…)`), a
relative write is refused with a line saying so — name the folder
plainly, or write to an absolute path, and it can judge it. The same
line refuses a write whose folder a substitution computes (`rm -rf
$(somecmd)/hooks`, `echo x > $(somecmd)/notes.txt`): nothing in front
of the `$(…)` anchors it, so it could land anywhere, a protected folder
included. The two computed folders the guard does know are spelled out
first, the way `$PWD` is — `$(pwd)` (or `` `pwd` ``) is the shell's
folder and `$(git rev-parse --show-toplevel)` is the repo root above it
— so `echo x > $(pwd)/notes.txt` passes and `rm -rf $(pwd)/hooks` is
refused as the hook directory it is. A `$(…)` elsewhere on the line is one word of its
command, so the literal target after it is judged as itself — `cp
$(echo x) hooks/hooks.json` is a cp onto the hooks file — and a computed
name under a folder the guard knows (`/tmp/$(date +%s).bak`) is judged
there, as a `$NAME` is. The body of a `<(…)` or `>(…)` runs too, and so
does a `$(…)` inside `$((…))` — or the whole `$((…))`, in a shell that
can't parse it as arithmetic and runs it as a subshell — so each is read
as a line of its own: `tee >(cat > hooks/hooks.json)` is a write onto
the hooks file and `$((rm -rf hooks))` removes the hook directory, while
`diff <(sort a) <(sort b)` and `echo $((1+2))` are the ordinary work
they look like. Bodies nest eight levels deep; a line nested deeper is
refused unread by both guards, with a line saying so — flatten it into
steps of its own and they can judge it. Reading
these files is untouched — inspecting a hook is ordinary work — and so
is a heredoc that is only data: its lines are never commands, but the
`$(…)` or backtick inside an unquoted body (`cat <<EOF`) runs before
the command ever reads it, so each is read as a line of its own, and
`cat <<EOF` / `$(rm -rf hooks)` / `EOF` is the removal it is, while
the quoted-delimiter `cat <<'EOF'` keeps the same text literal and
passes. The refusal names the file and then asks
the question that matters: if you did not ask for this, something the
agent read did, so find out where the instruction came from before
allowing it. The override, `CAIRN_HARNESS_EDIT=1`, is the owner's too:
set for the session, or as the leading assignment of one command, where
it exempts that command only, not the rest of a chained line.

The protected set also covers cairn's own trust anchors:
- the ship-gate stamps and run manifests in the cairn home (`$CAIRN_HOME`
  when set, `~/.cairn` either way), but not the run reports beside them,
  which the auto verb writes;
- the live plugin folder, everything in it except the project itself
  when the project sits inside it;
- `~/.claude/plugins/` (the registry and the plugin cache);
- `~/.claude/skills/`, `~/.claude/agents/` and `~/.claude/commands/`,
  since a folder in `~/.claude/skills/` carrying a plugin manifest loads
  next session as a plugin with its own hooks and MCP servers;
- `~/.claude/hooks/`, and every script a hook or the status line runs in
  your user settings, the project's `.claude/settings.json` and
  `settings.local.json`, or the project's and the live plugin's
  `hooks/hooks.json` — wherever it lives (`~/.config/…`, `$HOME/bin/…`,
  `$CLAUDE_PROJECT_DIR/…`, `${CLAUDE_PLUGIN_ROOT}/…`). A script swapped
  in runs at the next hook event, outside any tool call, so replacing
  one is refused like adding a hook is; so are removing the folder
  around it and a rename that drops a new one in its place. The
  settings are read fresh on every call; one that won't parse is
  skipped, and the folder rule still stands;
- every script a protected MCP config launches from outside the
  project — the stdio servers in `~/.claude.json` (its own and each
  project's), the project's `.mcp.json`, and Cursor's `.cursor/mcp.json`
  and `~/.cursor/mcp.json` — read off each server's `command` and `args`
  the same way (`node ~/repos/…/dist/index.js`, `$HOME/bin/server`, a
  symlink and the file it points to), and the folder a config names for
  its server to run in, protected whole — `uv --directory ~/weather run
  weather.py`, the MCP quickstart's Python shape, where the script has
  no slash and the folder is an option value; a server entry's `cwd`,
  which its `./dist/index.js` resolves from; and `node ~/srv/dirmain`,
  which runs that folder's `index.js`. That folder only, never its
  parents: a file beside it stays ordinary work. A swapped server script runs when
  the next session starts that server, with whatever tokens its config
  hands it, so it gets the same refusals a hook script does. A script
  inside the project stays writable on purpose: cairn's own `.mcp.json`
  launches its `server/dist` build, and a build has to rewrite it. A
  program found on `PATH` by name isn't looked up, and a config that
  won't parse is skipped;
- the project's `.claude/hooks/`, `.claude/agents/`, `.claude/skills/`
  and `.claude/commands/`;
- Cursor's `.cursor/hooks.json` and `.cursor/hooks/`, plus removing or
  replacing the `.cursor` folder itself.

The server's own writes to the stamp and manifests never pass through
the hook, so they are unaffected. One known gap is left open on purpose:
moving a live run to "stopped" is a legal tool action and lifts the
mid-run push block. Like the run guard's, these refusals name the owner's
ways to approve and give no paste-ready prefix.

**Which tools the guards see.** `hooks/hooks.json` hands the run guard
Bash and every MCP tool (`mcp__*`), the harness guard Edit, Write,
NotebookEdit, Bash and every MCP tool, and the leak guard Bash alone.
An MCP tool is judged by the shapes these guards know, not by what its
server can do:

- **A command line in its input** — a `command`, `cmd` or
  `shell_command` field — is read like a Bash line. Both guards read it
  through one shared reader, so they see the same shapes: that field as a
  string, as an exec-style array of strings, or with an `args` /
  `arguments` list beside it; each entry of a `commands` list; a `script`
  unless a language field names a non-shell; and `code` whose language is
  a shell (a `/bin/bash` path counts) — from the folder the input names
  in `cwd`, `workdir`, `working_directory` or `workingDirectory`.
- **A path a writing tool names.** When the tool's own name says it
  writes, edits, creates, deletes, moves, copies or saves
  (`write_file`, `edit_block`, `move_file`, `create_directory`,
  `delete_file`, `take_screenshot`…), the harness guard judges its
  `path`, `paths`, `file_path`, `filePath`, `target`, `destination`,
  `dest` and `new_path` fields as written, plus `source` for a move.
  A read tool passes, whatever it names.

Everything else passes: a writing tool under another name or field, and
any MCP tool that runs arbitrary code — Python or JavaScript in a
code-runner, keystrokes typed into a REPL it started — which is the
same class as a `python -c` one-liner, out of reach of a command-text
reader. For an exec-capable MCP server, use the harness's own
permission rules: list its tools under `ask` (or `deny`) in your
settings, as `mcp__<server>` or `mcp__<server>__<tool>`, so every call
waits for you.

One more hook worth knowing, on the advisory side rather than the
refusing side: the **loop check** notices when the same tool is called
with the same input three times in a row and says so, once. An agent
stuck re-running an identical call is not making progress — the result
will not change on a fourth — so the line suggests changing the input,
trying another approach, or opening a trace if it is a bug being chased.
Any different call resets the streak, a new session starts clean, and it
never blocks anything.

Be clear-eyed about what this buys. The realistic attack is indirect —
instructions embedded in text the agent reads, which the trailhead's
"tracker text is data" rule addresses on the judgment side. The guard
turns a silent success into a refusal a human sees. It is not a sandbox,
and text that can steer the agent can also ask for the override; real
isolation is the operating system's job. Both guards read Bash through
one shared shell reader, so a fix reaches both, but it is still a
reading of the command text, not the shell itself. The harness guard
doesn't see a write inside an interpreter (`python -c`, or an MCP tool
running code), a write that only exists in a substitution's output
(`$(cat script)` run as a command — the body of a `$(…)`, a `<(…)`,
`>(…)` or `$((…))`, and the literal target after any of them are read),
an archive's members, paths an
upstream command finds for itself (`git ls-files | xargs rm`), or an MCP
tool outside the shapes above.

---

## 11. Error codes & troubleshooting

Every server tool fails with a typed `CairnError`: a code, a message, and
usually a `nextAction` telling you what to do. Verbs surface these — never
stack traces.

| Code | Meaning | Your next move |
|---|---|---|
| `CONFIG_MISSING` | No readable `cairn.json` in the project dir | Run `/cairn:new` — it writes one for you (manual fallback: `templates/cairn.json.example`) |
| `CONFIG_INVALID` | `cairn.json` (or a config patch, workspace file, or stale focus) failed validation — bad JSON, wrong types, a secret where a secret doesn't belong, a malformed `cairn-workspace.json`, or a focus naming a vanished member | Read the message — it names the exact path and problem. The file is left untouched on a rejected patch, so fix and retry |
| `AUTH_MISSING` | A required credential env var isn't set | The message names the exact env vars to export (and where to mint the token) |
| `RATE_LIMITED` | The backend is throttling | Wait and retry; the shared HTTP core already retries with backoff before this surfaces |
| `NOT_FOUND` | The named thing doesn't exist — an issue id, a card id, a session id, a Confluence space | Check the identifier; for spaces, check `docs.config.spaceKey` |
| `TRACKER_DOWN` | The backend is unreachable or erroring | Git-side operations continue; retry the tracker work when it's back. Verbs report and keep what they can |
| `HANDOFF_INVALID` | The continuity handoff file is malformed | Inspect or discard it; a fresh checkpoint rewrites it |
| `HANDOFF_STALE` | The handoff is too old to trust | Inspect or discard — stale handoffs are never auto-resumed |
| `UNSUPPORTED` | The operation isn't valid here — e.g. an invalid node/edge type in a map patch, or a capability the backend doesn't have | Use a supported type/path; capability differences are in section 4 |
| `NATIVE_MODULE_BROKEN` | The better-sqlite3 compiled binding is missing (never compiled in this install) or built for a different node ABI — memory *index* tools (`mem_index`/`mem_search`/`mem_stats`/`mem_timeline`) fail; card tools keep working | Run the command in the message: `cd <install root> && npm rebuild better-sqlite3`, then open `/plugin` and close it — plugin changes apply on menu close — or restart the session, so the server picks up the new binding. The directory is derived from where better-sqlite3 actually resolves from — the install root, **not** the plugin cache's `server/` — so paste it as given. The message names which of the two modes you hit; `config_probe` reports both preemptively (`native.kind`) |
| `PRECONDITION_FAILED` | The operation's gate isn't satisfied — unverified phases at summit, closing a session without its gate entry, starting a duplicate open session, a map patch with dangling edges, board writes without a workspace, a peer that isn't on PATH / is disabled / timed out | The message names the gate. Satisfy it and re-run — these operations are built to be safely re-runnable |

### Common failure scenarios

**Missing env vars.** The first tracker or docs call fails `AUTH_MISSING`
with the exact names to export. Export them and re-run — nothing partial
happened.

**Drift flags mid-flow.** `plan`, `ship`, or `status` reports missing or
closed-unverified issues. Reconcile before proceeding: recreate + relink
missing issues; for closed-unverified, either verify the phase or reopen
the issue. `ship` will not push over drift, full stop.

**`PRECONDITION_FAILED` on summit.** At least one phase lacks
VERIFICATION.md. Run `/cairn:verify <N>` for each listed phase, then re-run
summit — milestone completion is idempotent, so re-running after a partial
tracker failure is safe too.

**Tracker down mid-work.** The current issue's tracker writes fail
`TRACKER_DOWN`; git-side work, plans, memory, and sessions continue
untouched (one backend being down never blocks git-side operations). The
verb reports what it couldn't mirror; when the tracker returns, the close
comments and state transitions catch up — and `resync`'s cursor means
nothing external that changed meanwhile gets lost.

**Session refuses to close.** Every session kind mechanically requires its
gate entry (verdict / decision / wrap) before closing. Log the gate entry —
that's the whole design: no session ends without its conclusion written
down.

**Stolen basecamp focus.** In parallel-dispatch topology, another session's
focus switch can repoint yours between calls. The discipline in section 3
(confirm focus before every write; re-read the board after claiming) is the
fix; a lost claim race means back off and pick different work.

**Memory tools fail with `NATIVE_MODULE_BROKEN`.** Symptom: every
`mem_index`/`mem_search`/`mem_stats`/`mem_timeline` call fails (card tools
still work). Nothing you did wrong. The error names one of two modes,
because they are not the same problem:

- **no compiled binding in this install** — nothing was ever built here. A
  freshly installed plugin cache ships no compiled better-sqlite3, and the
  runtime deps live at the cache **root**, so there is no `server/node_modules`
  to rebuild in. If npm reports nothing to rebuild, the dependency isn't
  installed at that root at all — `npm install` there first, then rebuild.
- **built for a different runtime** — a binding exists but targets another
  node ABI (or another platform). The rebuild re-targets it.

Fix, both modes: run the exact command in the error message —
`cd <install root> && npm rebuild better-sqlite3` — once, then retry. The
directory is derived from where better-sqlite3 actually resolves from, never
hardcoded, so paste it as given rather than guessing at `server/`.
The rebuild alone isn't enough — open `/plugin` and close it again
(plugin changes apply on menu close), or restart the session, so the
server picks up the new binding; a running server keeps failing on its
cached load until you do.
`config_probe` reports the same thing up front as an advisory `native` line
(ok / broken + `kind` + fix), so a preflight catches it before any memory
call does.

**Running an older cairn than you think.** Symptom: a verb documents a
tool the session can't call, or a fix you know landed doesn't take. Cause:
the plugin you're running is not the source you're reading. Three numbers
settle it, and `/cairn:medic` reports them as one finding:

| The number | Where it comes from |
|---|---|
| installed version | `claude plugin list --json` — the entry's `version` and the cache path it runs from; `config_probe` reports the same pair from inside the server |
| marketplace pin | `.claude-plugin/marketplace.json` → the plugin's `source.ref` — the release tag an install or update actually fetches |
| running server | `config_probe`'s version line, against `git describe --tags` in the source tree you're editing |

The nasty case is the one where all three version *strings* agree and the
plugin is still stale: `git describe --tags` reads `vX.Y.Z-<n>-g<sha>`
with `<n>` above zero, meaning the working tree is `<n>` commits past the
tag the pin names. Installed = released by design (see the README's dev
mode vs installed plugin note), so everything merged since that tag is
invisible to the session even though no version number disagrees. Version
equality is not freshness. The other two cases are louder: installed
version ≠ pin means an update was never adopted, and an installed plugin
whose marketplace has vanished from `claude plugin marketplace list` is
orphaned — nothing can update it, because `update` has no source to fetch
from.

Fix: `/plugin` → update → close the menu; plugin changes apply on menu
close, no reload step and no restart. Where there's no TTY to answer the
consent prompt — a headless run, CI, a batch job — the mutating
subcommands take `-y` (`claude plugin install <plugin>@<marketplace> -y`,
and the same on `update` and `uninstall`), which accepts the
marketplace-declared command without prompting and is *required* when
stdin or stdout isn't a TTY. Read state with `claude plugin list --json`
rather than scraping the human output; which other subcommands emit JSON
moves with the Claude Code version, so `--help` is the authority, not this
table.

**Planning directory looks wrong.** `/cairn:medic` for the diagnosis,
`medic --repair` for the mechanical subset, `medic forensics <phase>` when
you need to know what actually happened versus what the docs claim.

---

## 12. Appendix

### Artifact map — what lives where, and who writes it

| Path | What | Written by |
|---|---|---|
| `cairn.json` | project config | you (initially), then `config_set` via `tune` — single-writer |
| `.cairn/plans/PROJECT.md` | vision + requirements | `new` interview (scaffolded, never overwritten) |
| `.cairn/plans/roadmap.md` | phase table + status, milestone id | `new`; updated at verify/ship/summit/route |
| `.cairn/plans/phases/NN-slug/CONTEXT.md` | locked decisions | planning discussion |
| `.cairn/plans/phases/NN-slug/RESEARCH.md` | research brief (with scout's done/pending markers) | research fan-out / `scout` |
| `.cairn/plans/phases/NN-slug/PLAN.md` | task breakdown; frontmatter: `issues:`, `depth:`, `tdd:`, `wave_N` | `plan` (frontmatter only via server tools) |
| `.cairn/plans/phases/NN-slug/VERIFICATION.md` | goal-backward check results — its existence marks the phase verified | `verify`, on pass only |
| `.cairn/plans/phases/NN-slug/LEDGER.md` | append-only task ledger: what shipped, commit ranges, TDD pairs | `ledger_append` at issue close |
| `.cairn/plans/milestones/vN/` | archived phases per completed milestone | `summit` |
| `.cairn/memory/cards/*.md` | durable memory cards (git-committed) | `mem_card_create` via remember/mark/retro/trace |
| `.cairn/trace/`, `.cairn/probe/`, `.cairn/draft/`, `.cairn/thread/` | session files + `archive/` per kind; probe/draft artifact dirs; `draft/themes/default.css` + `tokens.json` | the session tools per kind |
| `.cairn/audit/<scope>-<date>.md` | audit/review/triage/medic/backtrack records | `audit_record` |
| `.cairn/map/map.json` | the knowledge graph | `map_set` via `map build` only |
| `.cairn/profile.md` | developer profile (advisory) | `profile` — no tool, direct write |
| `.cairn/state/active-context.json` | per-machine active project/phase/issue | `context_set` |
| `.cairn/tracker-marker.json` | tracker-delta snapshot cursor | `plan_tracker_delta` |
| `cairn-workspace.json` (workspace root) | workspace name + members | `basecamp init` |
| `.cairn/basecamp/focus.json` (workspace root) | workspace-global focus — last write wins | `workspace_focus` |
| `.cairn/basecamp/board.json` (workspace root) | dispatch board workstreams | `board_update` |
| `docs/BRIEF.md` | generated onboarding briefing (full overwrite) | `brief` |
| `docs/` ARCHITECTURE / ADRs / CHANGELOG | public-safe synthesized docs | `distill` (section-merge, never clobbers hand-written) |
| `~/.cairn/index/<project>.db` | tier-1 memory index — disposable | `mem_index` |
| `~/.cairn/handoff/<project>-<hash>.json` | session handoff — ephemeral, per-machine | every state-changing tool + hooks |
| `~/.cairn/banner/<project>-<hash>.md` | pre-rendered recall banner | re-rendered on card/context changes |

### The 87 MCP tools, by subsystem

**Active context (3):** `context_get` · `context_set` · `context_meter`
(context rent rollup: per-turn average, bands, residency, prefix)

**Tracker / issues (14):** `issue_create` · `issue_get` · `issue_update` ·
`issue_close` · `issue_list` · `issue_comment` · `issue_attach` ·
`issue_link` · `issue_unlink` · `issue_links` · `graph_report` ·
`tracker_migrate` · `phase_create` · `phase_list`

**Milestones (3):** `milestone_create` · `milestone_list` ·
`milestone_complete`

**Planning (11):** `plan_scaffold_project` · `plan_scaffold_phase` ·
`plan_status` · `plan_phase_ensure` · `plan_drift` · `plan_issues_set` ·
`plan_meta_set` · `plan_resync` · `plan_tracker_delta` · `plan_unplanned` ·
`plan_import`

**Memory (9):** `mem_index` · `mem_search` · `mem_stats` ·
`mem_card_create` · `mem_card_list` · `mem_card_recall` ·
`mem_card_update` · `mem_timeline` · `mem_compact`
(retro-gated card compaction, the capacity guard's action)

**Continuity (4):** `continuity_checkpoint` · `continuity_get` ·
`continuity_clear` · `ledger_append`

**Config (3):** `config_get` · `config_set` · `config_probe`

**Sessions (14):** `trace_start` · `trace_log` · `trace_list` ·
`trace_close` · `probe_start` · `probe_log` · `probe_close` ·
`draft_start` · `draft_log` · `draft_close` · `thread_start` ·
`thread_log` · `thread_close` · `session_landscape`

**Plan checks / audit records (2):** `plan_check` · `audit_record`

**Research checkpoints (1):** `research_sections`

**Knowledge graph (3):** `map_set` · `map_get` · `map_query`

**Workspace & board (5):** `workspace_list` · `workspace_focus` ·
`workspace_status` · `board_get` · `board_update`

**Peers (3):** `peer_list` · `peer_run` · `peer_state`

**Outlook / portfolio (4):** `outlook_emit` · `outlook_get` ·
`outlook_refresh` · `outlook_forget`

**Docs connector (3):** `docs_publish` · `docs_status` · `docs_drift`
(deterministic report of verified phases the public docs have drifted from)

**Budget (2):** `budget_check` · `token_estimate`
(spend ledger gate for headless batch runs; predicted phase token spend as a range)

**Run manifest (1):** `run_manifest`
(staging interview output and manifest for headless batch runs)

**Seats (1):** `seat_roster`
(merged roster: shipped default seats overridden by project seats)

**Distill (1):** `distill_manifest`
(one phase's manifest: the scope an incremental distill run may touch)

---

That's the whole machine. Start with `/cairn:new` (or `/cairn:import` if
the work already exists), keep the loop honest — plan, work, verify, ship —
and let the gates do their job. They're not there to slow you down; they're
there so that when something says "done," it actually is…
