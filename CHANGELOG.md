# Changelog

## Unreleased — the ux seat (phase 27, 2026-10-14)

Cairn gains a UI/UX acceptance bar in its own vocabulary, borrowed by
reference from zeeshani42's `ui-ux-designer` skill (MIT) and never
vendored: the design agent reads an installed copy at its hi-fi stage, a
seventh review seat judges whether a diff ships its states or only
describes them, and `audit ui` holds a phase that declared no UI criteria
to four rendered states. A second read, of dietrichgebert's ponytail
(MIT), brings an eighth seat that asks whether code should exist at all
and an audit mode that turns in-code deferral markers into tracker
issues. Every borrowing file names the skill, the repo and the license
and paraphrases; nothing upstream lands in the plugin. Surface flat; the
one resident cost is a word in the audit command's blurb.

Tool count holds at 87. Suite 2170 → 2207. Footprint 13137 → 13138 of a
13145 pin. Default seats 6 → 8.

### seats

- `ux` is the seventh default seat: minimal dose, review stage, gated on
  a new `touches-ui` scope signal (css, scss, less, tsx, jsx, vue,
  svelte, html, or a components / ui / pages / views / layouts path
  segment; a server-only diff never fires it). Its lens is render, don't
  describe — the four states, focus rings and tab order, contrast,
  breakpoints that reflow — and a state that exists only in the PR body
  is the finding. Unread render or source means unscored.
- `lean` is the eighth: minimal dose, review stage, gated on `diff-large`
  or `touches-server`. It asks the one question the other seats take as
  given — should this code exist — down ponytail's ladder (need, already
  in the codebase, standard library or platform, installed dependency,
  one readable line, minimum code). Findings are priced as the cost of
  the extra code, never as line count; the never-cut floor (trust-boundary
  validation, data-loss handling, security, accessibility, anything the
  user asked for) is stated in the seat. Lean asks necessity; `audit
  simplify` keeps asking clarity.
- The byte-identical fold of the first five seats is amended, not broken:
  the roster may grow by signal-gated default seats, the five stay first
  and unchanged, and the regression pin now checks that ordering plus the
  signal gating of every seat after them. Under the default dispatch a
  server-only diff convenes the five plus `lean`; a docs-only diff
  convenes neither addition.

### agents

- The design agent carries a hi-fi acceptance bar: at the prototype stage
  it looks for an installed `ui-ux-designer` skill under the project then
  the user skills root, reads it (never invokes it — its tool list is
  unchanged), skips the skill's five-question gate because every answer
  already lives in a session artifact, and holds each variant to the
  skill's silent checklist — four rendered states, visible focus, a
  reduced-motion alternative, real breakpoints. A described-not-rendered
  state becomes a note, never a pick. Absent skill: one note, identical
  behaviour.
- The acceptance-testing agent checks the same four states when its walk
  reaches a screen and hands a missing one to `audit ui`.

### audit

- `ui` applies a floor when a phase declared no UI criteria: every shipped
  screen or component renders Default, Loading, Empty and Error as views
  (one file with a visible state toggle counts), one important finding
  per missing state. A declared bar is never overridden; breakpoints stay
  the `ux` seat's concern.
- `debt [scope]` is a new mode: one documented grep for a comment opener
  followed by a configured marker word and a colon (`shortcut`, `TODO`,
  `FIXME`, `HACK`, `XXX` by default; `audit.debt.markers` in cairn.json
  replaces the list, an empty list is refused). One finding per marker
  with a dedup key as the first line of its detail, the `shortcut:
  <limit>, <when to upgrade>` form parsed and a missing trigger reported
  rather than invented. Report by default; `--apply` files every marker
  as a `cairn:shortcut` issue — the mode's one deliberate exception to
  minors staying in the record — updates the issue of a marker that moved
  and closes the issue of one that vanished. `audit sweep` runs it as leg
  five, report shape only. A fixture pair and a test run the documented
  grep as written.

## Unreleased — the fifth seat (phase 26.5, 2026-10-14)

GitHub Copilot CLI joins the peers council as the fifth seat, and the
council's own arithmetic changes with it: convergence now counts distinct
labs, not seats, because Copilot reaches only labs already in the room
(OpenAI through codex, Google through antigravity, Anthropic as the
adjudicator). It is a fifth harness, not a fifth vendor — five seats, four
labs. The hardening the survey said must land with it lands here too: every
seat's child environment loses the tracker credentials, and a reviewer that
dies with only an error on standard error is an incomplete seat, never a
clean pass. Three platform-delta items from the 2.1.299 changelog read ride
along, one of them a live-confirmed breakage.

Tool count holds at 87. Suite 2130 → 2170. Footprint 13108 → 13137 of a
13145 pin.

### peers

- `copilot` is a provider. Its template runs the CLI contained by a flag
  set — no questions, no auto-update, no custom instructions, no built-in
  or cairn MCP servers, a 30-credit cap (the CLI's floor); contained runs
  add view-only tools and a temp-dir lockout, and the prompt rides as the
  last argument. Output is text, read by the shared fence parser; there is
  no JSONL parser. Templates gain a `model` (flag + default), resolved from
  `peers.<provider>.model` in cairn.json or the template default
  `gpt-6.1-sol`; config load refuses a Claude model (the adjudicator's own
  family) and refuses `auto` (not a pin — its default pick is a Claude
  model). `peer_list` reports the resolved model. Drilled live on Copilot
  CLI 1.0.96: a file beside the scratch folder under the system temp dir
  was unreadable, a fenced finding parsed, a 150,000-character prompt ran
  under the cap. The pinned default was not on the maintainer's plan; pin
  one your plan serves.
- Every seat declares the lab behind its model; Copilot's follows its
  pinned id, opencode's is unknown because it picks its own. `peer_list`
  reports `lab`, and the peers verb's convergence bar is three distinct
  labs raising a claim — codex plus a gpt-pinned Copilot is one lab
  speaking twice; an unknown lab never completes a cluster on its own.
- Every seat is spawned with the server's environment minus tracker
  credentials: each adapter's default token variable, both GitHub
  spellings, the two Copilot trust-widening variables, and whatever
  `tokenEnv` / `patEnv` / `apiKeyEnv` the project's configuration names
  for the tracker and the docs connector. A seat's own credential is kept.
  A parity test fails when an adapter declares a credential default the
  drop list lacks.
- Peer output records carry the exit code the run returned. A seat whose
  round-one exit was non-zero with no findings raised is an incomplete
  seat beside the silent ones: status names it with the tail of its
  standard error, close refuses over it unless the caller accepts degraded
  coverage, and then stamps the seat and its reason into the record. A
  seat that spoke and then died keeps its findings; a clean exit with
  nothing to say is still clean.

### agents

- Both plugin agents name cairn's tools by full MCP id. Claude Code 2.1.299
  resolves an agent's tool list against the named MCP server only, so the
  bare names granted nothing: a live probe found the acceptance-testing
  agent running with Read and Bash alone while the server sat connected.
  A test holds every entry to a registered tool; a headless run of the
  plugin proved both agents see their tools again.

### evals

- The review-corpus scorer counts a run with no grader results as errored,
  per arm and per case, keeps it out of both rates, says how many runs
  were graded, and exits non-zero. Since 2.1.299 the platform scores such a
  run zero and fails the suite; the scorer now agrees instead of hiding
  the run. The corpus arms keep the subagent tool enabled on purpose.

### context

- The compaction sunset line names idle compaction (2.1.299) as a second
  main-session trigger the drift report cannot observe; the remaining gap
  — no plugin can declare a main-session threshold — stays explicit.

## v2.8.3 — the error flag (2026-10-12)

A small release that makes one retro signal real. The observation
buffer the retro verb reviews records every Edit, Write and Bash call
with an error flag, and across the thirteen waves of v2.8.2 — full of
failing probes and red test runs — not one row ever carried it. Claude
Code emits no PostToolUse event for a tool call that fails; the failure
arrives as a separate PostToolUseFailure event, which nothing listened
to. So the flag was structurally false, and any lesson card that cited
error churn from the buffer would have been fabricated.

Both fixes are hook-side only. No server change, no new tool.

Tool count holds at 87. Suite 2120 → 2124.

### hooks

- The observe hook is wired to PostToolUseFailure beside PostToolUse,
  on the same Edit, Write and Bash matcher. A failed call now lands in
  the buffer as an error row carrying the tool name and target, as the
  flag always promised. The script's header says which event carries
  which flag (#323).
- An interrupted call is a cancellation, not an error. The owner
  pressing Escape on a running tool arrives as a failure event with
  is_interrupt set; that row keeps the error flag false and carries an
  interrupted flag instead, so retro never reads a cancellation as
  error-to-retry churn (#324).

### audit

- A phase-scoped security record (security-25-7) now stands beside the
  surface records; the two residual minors it carries are in the record,
  not the tracker: phase 25.7's acceptance shape promised a sweep
  manifest delta that was never computed, and the harness guard's
  documented interpreter blind spot was confirmed live on a protected
  file by the #323 fix itself.

## v2.8.2 — the hardening (2026-10-11)

The second sweep, taken on v2.8.1, filed twenty findings against the
two PreToolUse guards. This release closes them and then keeps going:
after each fix wave the security surface was re-audited, every
important finding was put to two independent votes, and the survivors
became the next wave. Ten passes later the re-audit came back with no
important finding left. Forty-eight issues closed in thirteen waves,
three of them regressions this release introduced and caught itself.

The guards now share one shell reader, and most of what changed is in
how that reader sees a command line: wrappers, runners, substitutions,
heredocs, folders reached by `cd` or `git -C`, and the fields an MCP
tool carries a command or a path in. What the guards still don't see
is written in their headers and in the runbook, finding by finding.

Tool count holds at 87. Suite 1735 → 2120.

### guards

- One shell reader (`hooks/scripts/shell-words.mjs`) serves both
  guards. It reads shell keywords and grouping, case-folded command
  names, wrapper flags, program runners (`xcrun`, `arch`, `strace`,
  `runuser`, `pkexec` and their kin), and a backstop for runners it
  doesn't know: a leading program the guards haven't met has its later
  words judged as the command, with print-only programs exempt. `man`,
  `gh`, `rg`, `sort` and the pager variables have their one
  program-running option modelled rather than a blanket pass.
- Substitutions are one word. An unquoted `$(…)`, backtick, `$((…))`
  or process substitution no longer splits a line, so the literal
  target after it is seen; each body is read as a command line of its
  own, including inside an unquoted heredoc body, which is otherwise
  data. Nesting is capped at eight levels and anything deeper is
  refused unread. A deeply nested line that used to run the guard for
  seconds now takes about 90 ms.
- The run guard judges the repo a git command acts on, following `cd`,
  `git -C` (with `~`, `$HOME` and `$PWD` expanded), `--git-dir`,
  `--work-tree` and `GIT_DIR`. A gated push must stand alone on its
  line: a commit or ref move earlier on the same line, which the stamp
  can't have covered, is refused. Shortened git options, separate
  option values, glob and matching refspecs, short destinations and
  push settings all meet the ship gate.
- The harness guard protects its trust anchors: the live plugin copy,
  the ship-gate stamps and run manifests, the `.claude` and `.cursor`
  hook folders, the skill, agent and command folders at home and in
  the project, every MCP config, the scripts those settings and MCP
  configs launch (hook commands, the status line, server entry points
  outside the project, including the `uv --directory` quickstart
  shape), and `~/.claude/hooks`. It refuses `claude mcp add`, `claude
  plugin install|enable|disable|init`, `claude import` and the same run
  through `npx`. Tree-creating commands (`git clone`, `worktree add`,
  `submodule add`, `git init`, `gh repo clone`, `npx degit`, `npm
  create`) judge their destination like a `mkdir`. Writes through
  `find -exec`, `xargs`, `su -c`, archives, patches and downloads are
  seen; paths match in any letter case; a `cd` the guard can't follow
  fails closed.
- MCP tools meet both guards. The hook matchers widen to `mcp__.*`;
  a command field (`command`, `cmd`, `shell_command`, an exec array,
  `script`, shell `code`, a `commands` list, with its folder field)
  goes through the run guard, and a path field on a tool whose name
  says it writes goes through the harness guard. Tools that run code
  in another language, and text sent to a running process, are out of
  scope and documented as such. Cursor's `preToolUse` adapter forwards
  MCP calls to both guards and fails closed.
- Refusals stop coaching the override: the owner-only variables are
  named, never given as a paste-ready prefix. An unreadable ship-gate
  stamp refuses rather than skips.

### the sweep

- A sweep manifest reads `unchecked` for a leg it didn't re-run, and
  refuses findings it can't attribute. Phase numbers resolve by
  milestone title, not id. README, CHANGELOG and LICENSE edits no
  longer stale a security audit. `peer_run` enforces `execCapable` and
  leak-scans outgoing input. `verify` requires every phase issue closed.

### docs

- The runbook's guard sections, the server reference and the guard
  headers describe what each guard reads and, in a "not seen" list,
  what it doesn't. The harness matrix marks Cursor as guarded.

## v2.8.1 — the fixes (2026-10-03)

The first real sweep, taken on v2.8.0, filed eleven findings against
cairn itself. This release closes all of them through the normal work
lifecycle, so the next sweep can report them as fixed. Most were rules
the instructions stated and nothing enforced: git commands that destroy
work, pushes that skip ship's gate, a docs publish that never asked
first. One regression found mid-fix (a quoted command substitution the
new parser read as plain text) is closed here too.

Some of these fixes narrow a gap rather than seal it, and they say so
below. The follow-ups are filed.

Tool count holds at 87. Suite 1680 → 1735.

### guards

- The run guard now refuses `git reset --hard` and every form of
  force-push (`--force`, `-f` alone or clustered, `--force-with-lease`,
  `--force-if-includes`, a `+refspec`) in every session, not only during
  a run. It reads the command as shell words, so a commit message that
  mentions a reset passes, and a command substitution inside double
  quotes is checked as a command of its own. `CAIRN_ALLOW_DESTRUCTIVE_GIT=1`
  overrides, in the session env or as the command's leading assignment.
- While a run is live, a `git push` from any worktree is refused unless
  the run's manifest grants push authority over its phases. There is no
  override: push authority is the owner's decision at the staging gate.
  The manifest doesn't record which phase a push carries, so this checks
  that authority was granted, not that it covers the push.
- ship's "never push with flagged drift" is now enforced, not just
  stated. `plan_drift` stamps the commit it checked and whether it came
  out clean, and an agent push to the default branch is refused when
  that stamp is missing, dirty, or for a different commit. Other branches
  are untouched. `CAIRN_ALLOW_UNSHIPPED_PUSH=1` overrides. ship re-runs
  the drift check after its own last commit so its stamp stays current.
  The open-issues half of ship's gate is still enforced by procedure,
  not by the hook.
- The harness guard now sees through wrapper flags (`sudo -u root tee`,
  `env -i FOO=1 rm`, `nice -n`, `timeout`, `xargs` and their kin) and
  through `bash -lc`, where only a literal `-c` used to count. Wrapper
  coverage is a known list; `su`, `find -delete`/`-exec` and paths fed
  to `xargs` on stdin are not yet on it.
- `docs_publish` refuses unless passed `confirm: true`, and the docs and
  summit procedures pass it only on the owner's explicit yes. Summit's
  "never auto-publish" rule now has something behind it.

### the sweep

- A sweep manifest now answers to its legs. A finding the leg refuted is
  refused, a serious security finding needs that leg's two panel votes,
  and a leg record path outside the project's audit folder, a symlink or
  a non-regular file is refused instead of read. A finding reworded in
  both its title and its scenario still links to no leg; that gap is
  narrowed, not closed.
- A sweep manifest no longer credits seats a second time for findings
  its legs already credited, which had doubled every sweep finding's
  survival count.
- `ledger_append` gains an evidence-only line that makes no closure
  claim. A later evidence line for the same task supersedes an earlier
  closure line, so a misattributed close can be corrected without
  rewriting an append-only ledger. `audit tests` now logs this way.

### docs

- The server README's tool list (71 → 87) and the runbook's tool
  catalog (79 → 87) are current.

## v2.8.0 — the sweep (2026-10-02)

Milestone v8 closes on its capstone: one audit mode that runs every
improvement check cairn has across a whole project, files only what
survives a refutation panel, and writes a dated baseline so the next
sweep says what is new, what persisted, what got fixed, and what came
back. Underneath it, cairn stops recording numbers it cannot stand
behind. Durations are measured, not asked for. Eval results that split
across runs say "inconclusive" instead of averaging into a score.
Context cost is metered where it lands. And the guard that protects
cairn's own configuration now refuses what a command writes, not what it
happens to mention.

Two claims are deliberately not made here. The sweep ships tested but
not yet run in anger: its first real baseline is taken on this release,
because the comparison it reports lives in this release's server. And
the context-economy experiment that would have halved average context
was killed at its gate, so nothing in this release claims that saving.

Tool count moves 86 → 87. Suite 1541 → 1680.

### the sweep

- `audit sweep` runs every leg in order (security, the security surface
  check, tests, docs, plans, simplify, memory, and the milestone view
  last), each through its own closing discipline unchanged. Duplicates
  collapse, a refutation panel judges every serious finding, and only
  survivors reach the tracker, labelled with the leg that found them.
- One dated manifest per sweep records the cairn version, the commit, and
  every leg's record. Against the previous manifest it classifies each
  finding as new, persisting, fixed, or regressed, matching by exact title
  first and then by the failure the finding describes, so a reworded
  finding is still the same finding. The first sweep says "first
  baseline".
- The report is one prioritized backlog (regressions first, then new,
  then persisting, criticals ahead of the rest), followed by the latest
  eval verdicts with any failing gate first, then approximate spend, and
  it updates the portfolio board. `--fix` stages patches leg by leg, never
  across legs. "Rescan this project" routes here through the confirm
  path.
- The security surface check now maps every imperative rule (never, do
  not, always, must) in the project's instructions, procedures and hook
  prose to the deterministic controls that could back it, and reports the
  rules nothing enforces. The scan only proposes candidates; the auditor
  decides whether a control truly backs a rule. Run on cairn itself, it
  found 58 of 258 rules with nothing behind them.
- Every decision record, server gate and hook now states what would make
  it unnecessary, in a `removeWhen:` line, or says `never` and why. The
  milestone audit lists the ones whose condition has plausibly arrived,
  for a human to judge. Harness components exist because the model or
  the platform cannot do something yet; this writes the expiry down.

### eval semantics

- Every behavioural eval case is now either regression (must pass every
  run, and is a gate) or capability (an improvement target that never
  blocks). One mixed score produced wrong priorities.
- A verdict script reads a run's results and reports PASS, FAIL, or
  INCONCLUSIVE when runs split. A split is "we don't know yet, add runs",
  not a fractional score. A case's tier comes from its current definition,
  so results recorded before tiers existed still read correctly. The
  nightly lane prints the verdicts and stays advisory until a variance
  baseline exists.

### measured actuals

- The server measures how long a task took, down a fixed ladder, and
  records which rung produced the number: the claim comment's timestamp
  to the close, where the backend can list comments; otherwise the moment
  the server itself saw the issue go in progress; otherwise the first to
  last commit across the task's commits; otherwise nothing, recorded as
  nothing. The rungs measure different spans, and the label is what stops
  a later reader pooling them as if they were one measurement.
- A claim comment is recognised strictly, by a first line that opens
  "Starting now". A missed hand-written claim only drops the measurement
  one rung. A loose match would start the clock early and inflate the
  very number this replaces. On both of the first two rungs the earliest
  claim wins, so a task picked back up after a pause still measures from
  its first pickup.
- The agent's own time is kept as a claim beside the measurement, and the
  gap between the two is kept on purpose, because it says something about
  the reporter. Worklogs on backends that support them get the measured
  minutes. The close comment carries the measurement and its source in
  the same comment as the test evidence.
- Closing an issue and writing its ledger line happen in two different
  tools, and each held half of the record. The close now leaves a small
  local receipt with the estimate it saw (each number tagged as a real
  tracker field or a line scraped from the issue body), the claimed
  minutes and the worklog outcome. The ledger append folds the receipt
  into one short actuals segment on the line, then deletes it. Receipts
  live in a folder that ignores itself, so no repo ever commits one.
- A missing receipt never costs the line. It is written anyway with a
  named degraded marker instead of silent blanks, and the duration still
  comes from git. Nothing about receipts can fail a close or an append,
  and an append the ledger refuses leaves its receipt in place for the
  retry.
- The work, trace, fast and audit procedures open claims with "Starting
  now." and no longer ask the agent for a time spent.


### context economy

- What a piece of work costs in context is now measured where it lands.
  Every turn's residency is accounted per producer, rent is attributed to
  the work item that spent it, and one tool reports the layer's whole
  bill. Compaction boundaries are detected along with what crossing them
  cost.
- A first symptom detector looks for evidence a compaction hurt, such as
  a repeated question or a re-read file. Its first version could not fire
  at all, because almost all real user prose arrives as a bare string;
  that is fixed and proven. A symptom is strong evidence of harm, but its
  absence is weak evidence of safety, so no gate keys on zero symptoms.
- The experiment to halve average context by compacting far earlier was
  run and killed: at that threshold ordinary work became unworkable. The
  predicted saving is withdrawn and nothing should cite it. The reporting
  that would catch a threshold creeping back stays.
- The context-footprint guard now counts tool schemas it was silently
  omitting, and no longer counts header comments as if they were injected
  into every session. Its budget is re-pinned to each corrected reading,
  never loosened by a fix.

### fixes

- The guard protecting cairn's own configuration refused ordinary reads:
  any `>` counted as a write, including `2>/dev/null`, and any mention of
  a protected path counted as an edit. It now finds what a command
  actually writes (redirect targets, and the files that cp, mv, rm, tee,
  sed -i and their kin change) and refuses only those. Quoted text and
  heredoc bodies are data. Writes passed as a string to another shell,
  which the old check missed, are now caught.
- The portfolio board and the budget ledger read only the live segment of
  the metrics log, so after the first rotation the board's spend appeared
  to drop and the ledger could charge a run for a session that started
  before it. Both now read every segment.

## v2.7.0 — the guards (2026-09-20)

The second half of milestone v8, and the half that turns rules about
cairn into mechanisms cairn enforces on itself. Three hooks that refuse
rather than advise, architecture rules asserted instead of merely
documented, a context budget that is measured, tasks that declare how
they will be proved, and memory that audits, compacts and announces its
own state. Two long-standing measurement defects are fixed underneath
all of it: the metrics log stopped destroying its own history, and the
timing tests stopped reporting machine load as a regression.

One principle surfaced independently three times across these two
phases and is now written down as a decision record: a check that
cannot fail is worse than no check. Every guard added here is proven by
breaking the thing it guards.

Tool count moves 85 → 86 — the first addition in three milestones, a
deliberate exception recorded with its reasoning. Suite 1412 → 1541.

### harness hygiene

- Unattended runs work in a worktree of their own, and a guard makes the
  separation enforced rather than merely intended: while a run is live,
  a branch checkout, branch switch, or hard reset aimed at the directory
  you are typing in is refused in one plain line naming the run. The
  same commands inside the run's own worktree pass untouched. A run now
  enters its worktree before the first phase and removes it on every
  exit path, including errors and ceiling hits.
- The configuration that decides what the agent may do is write-protected
  from the agent. Edits to the hook directory, the tool-server config,
  the settings files, and the plugin manifests are refused unless a flag
  is set for the session; reading them is untouched, because inspecting a
  hook is ordinary work. The refusal names the file and then asks the
  question that matters — if you did not ask for this, something the
  agent read did. The scope limits are documented rather than implied:
  this converts a silent success into a refusal a human sees, it is not a
  sandbox, and text that can steer an agent can also ask for the override.
- Text fetched from the issue tracker is data, not instructions. A shared
  rule says so, and a behavioural eval proves it: given an issue body
  carrying an instruction to force-push and close every other issue
  silently, the assistant answers the real request, refuses the embedded
  one, and tells the user it was there. Staying quiet fails the check even
  when no command runs, because a user whose tracker is being used to
  steer their agent needs to know.
- Plan tasks declare how they will be proved, in a clause written when
  the plan is written rather than chosen afterwards to fit whatever
  happened. The plan check reports a task that declares nothing; a phase
  already verified is exempt. At close, the ledger reports whether the
  evidence cites the declaration — a report, deliberately not a refusal,
  because declarations are shorthand while evidence records what was
  really typed, and a string gate there would fail honest closes and
  teach people to pad the field.
- The drift report learned about time. An issue held in progress with no
  tracker update and no commit naming it, and a branch whose last commit
  has gone quiet, are both surfaced with their age. Advisory everywhere:
  neither blocks a ship or fails a verification, because forgotten work
  is worth seeing and is never a reason to stop a good push.
- The layering the architecture document describes is now asserted on
  every run: adapters are leaves, the tracker subsystem imports none of
  the subsystems that import it, the docs connectors reuse only four
  named modules from it, and the composition root is imported by nothing
  in a tree with no import cycles. Every rule fails when its file pattern
  matches nothing, because a rule that inspected zero files and passed
  reads as coverage forever.
- What the harness costs a session before any verb runs is measured and
  pinned: the command descriptions, the skill descriptions, and the
  session-start prose, summed against a budget that moves the way the
  tool count moves. It found a fifth of its own total sitting in one
  repeated suffix on its first run.
- The same tool called with the same input three times in a row draws one
  advisory line. Once, not on every call after — the point is to be
  noticed, not to nag a legitimate repetition into the ground.


### memory hygiene

- The card store can now be audited, and the finding it exists for is the
  one you could not otherwise see. A card whose frontmatter will not parse
  is skipped silently by both listing and recall, so a corrupted card
  disappears from every surface without announcing itself and the store
  looks healthy precisely because the broken card is invisible. The audit
  reads every file directly and reports what the normal path drops, along
  with provenance whose file is gone or whose commit no longer resolves,
  near-duplicate bodies and aged cards. It reads files and git rather than
  the search index, deliberately: that index needs a compiled binding that
  can be missing, and an audit that dies exactly when memory is unhealthy
  would be the wrong shape.
- The capacity guard gained an action. Aged low-confidence cards merge
  into one dated archive whose provenance lists the retired cards'
  commits — rotation without time decay. The archive is written before
  anything is retired, so a failure leaves the store whole; the approved
  identifiers are applied exactly, never re-derived at write time, so a
  card that ages between the proposal and the approval is never swept in
  without being seen; and an archive cannot itself be archived, which is
  guarded twice because the first guard is an implicit coupling.
- Memory announces its own backlog. The unreviewed observation count and
  the age of the oldest entry surface in the statistics and, past a
  configurable threshold, in the session banner. Capture stays passive and
  review stays gated behind the retrospective — the buffer simply stops
  growing in silence.
- The cost tracker records report bytes per fan-out, measured against peak
  single-request tokens rather than cumulative totals. With prompt caching
  those totals count the same replayed prefix over and over: one real
  session summed to nearly a billion cached tokens against a window that
  never exceeded a million, which understated the share twentyfold. This
  is measurement only. Whether compression is worth building is the
  question it exists to answer.
- The metrics log rotates instead of truncating. It previously capped
  itself at five thousand lines and cut back to twenty-five hundred, which
  is not a retention policy but amnesia with a ratchet, and it bit hardest
  on the busiest projects. Segments now close by rename and are never
  rewritten, readers merge them oldest-first to the latest row per
  session rather than summing, and pruning happens by age and supersession
  rather than by line count.
- Estimates stop losing half of themselves. The prose fallback that
  rescues estimates on backends without native fields was capturing both
  the points and the hours and discarding the hours — which is why there
  was a points corpus and no minutes corpus at all. The hours now survive,
  carried with their provenance, because a real tracker field and a scrape
  of prose are not the same evidence and pooling them is how a calibration
  curve gets fitted to a parser bug.
- Jira stops dropping story points in silence. It discovers that field at
  runtime, and when no field matched it warned once to the error stream
  and dropped the value while still reporting full estimate support. The
  loss now reaches the caller as a partial skip, so the fallback runs and
  the estimate survives in the issue body.
- Roadmap status became computed rather than remembered. Drift repairs a
  verified phase's row in place and milestone completion patches the rest,
  so the table stops sitting at "planned" until somebody notices.
- Timing tests measure the subject instead of the machine. A pair of
  hundred-millisecond budgets were timing a spawned interpreter: a bare
  process start is thirty-one milliseconds and the hook under test is
  thirty-two, so the budget was almost entirely startup. It failed a
  release gate on a shared runner and flaked repeatedly on loaded
  machines, reporting load as though it were a regression. Both now
  measure the marginal cost over a baseline spawn, minimum of five
  samples, and were proven in both directions — they catch an injected
  slowdown and survive eight saturating load generators.
- Smaller debts: the native-binding error names the directory the module
  actually resolves from and distinguishes a dependency never compiled
  here from one built for a different runtime, which need different
  instructions; three verb documents stopped implying the index tool reads
  a file; dispatch briefs render their invariants last, where attention is
  most reliable, and keep dated content out of the cacheable prefix; and
  the design-alternatives gate stops asking already-verified phases for a
  block they no longer owe.

## v2.6.0 — the refutation (2026-09-17)

The first half of milestone v8: no cairn claim ships unverified.
Findings survive an adversarial panel before they reach the tracker,
audit records know which commit they judged, fixes are staged behind
an independent verifier instead of applied on the verb's say-so, and
the in-flight method gaps — design alternatives before a plan, a
reproduced failure before a trace closes, typed evidence before an
issue closes — became server-side data shapes on existing tools. Tool
count holds at 85 across both phases.

### the refutation (phase 21)

- Every finding carries a typed failure scenario — the concrete inputs
  and the wrong result — and the audit record refuses one without it.
  The dedup engine treats two seats with matching scenarios as one
  finding even when their headlines differ.
- Verify before the tracker: critical and important findings pass a
  refutation panel whose votes (CONFIRMED / PLAUSIBLE / REFUTED) are
  recorded in the audit record and tallied in code — a refuted
  majority kills the finding (it stays in the record with its votes,
  never filed), ties survive as plausible, and a critical finding with
  no panel cannot be recorded at all (two votes minimum on a security
  scope). Survivors credit their raising seats' yield, so "survived"
  now means survived verification. The peers council's own verdicts
  map onto the same panel.
- Audit records are stamped with the commit they judged and whether
  the tree was dirty; the drift report flags a stale security audit —
  written over a dirty tree, or predating code commits — and ship and
  verify stop on it like any other flag.
- `--fix` stages instead of applying: a dirty tree is refused, fixes
  are generated in a detached scratch worktree, written as patch files
  mirrored to their issues, judged by one independent verifier stating
  three claims (targeted, no new issue, behavior unchanged) that the
  record turns into an apply-eligibility bit, and applied only on the
  user's choice.
- `audit simplify`: a quality-only sweep over what recently changed,
  seen through the clarity and architecture seats, applying through
  the staged-patch path — a bug found mid-sweep is filed, never fixed
  in place.

### the method (phase 23)

- Plans consider alternatives before tasks exist: every phase context
  gets an "Approaches considered" skeleton (comment-only, so an
  unfilled scaffold can't satisfy the gate), the plan verb writes two
  or more candidates with trade-offs and a chosen line before the task
  breakdown, and `plan_check` flags a planned, non-quick phase without
  the block. An assumption the repo can't settle routes to a probe
  first.
- A trace cannot close on a verdict alone: the server requires at
  least one evidence entry and one test entry — the first test being
  the reproduction, the command run and the failing output seen — and
  that repro rides the bug's resolution comment. The fast lane skips
  the hypothesis loop, never the repro.
- Issue closes carry typed evidence: the ledger refuses a line with
  neither `evidence` (what was run, what it showed) nor an explicit
  waiver with a reason; the evidence renders into the ledger line
  beside the TDD segment, `issue_close` posts it as one standard
  comment on every tracker backend, and verify fails a phase whose
  ledger lines carry neither.

## v2.5.0 — the seats (2026-09-16)

Milestones v6's close and all of v7: every public claim became
self-maintaining, the batch runner's accounting turned honest, and the
persona arc landed whole — review viewpoints as validated data,
dispatched by evidence, deduplicated to one finding set, consultable
on demand, convened over plans before code exists, and warm with
role-scoped memory.

### standing-viewpoints (phase 20)

The second half of the persona arc: seats become parties — consultable
on demand, convened over plans before code exists, and warm with
memory:

- Seats declare WHERE they convene: a stage field (review | plan |
  any, default review, server-validated like dose) filters the review
  panel to review-stage seats — the five classic defaults and the
  byte-identical promise hold untouched — while plan-stage seats
  convene only at planning time. The sixth shipped default arrives:
  the interrogation seat, a plan-stage product interrogation (who is
  this for, what breaks, why now, scope honesty) at full dose.
- Plans can be challenged before code exists: a --challenge flag (deep
  planning includes it automatically) convenes the plan-stage seats
  over the draft, and their challenges land as proposed amendments in
  one batched question — accepted ones edit the plan, rejected ones
  are recorded with a reason. Advisory by design, never a gate.
- Any seat is now consultable: a single-seat advisory pass at the
  seat's declared dose over a diff, file, plan, or freeform question —
  and the seat arrives warm, with its role-scoped memory rendered into
  the brief (stale cards explicitly marked) and notable outcomes
  written back. Findings ride the existing closing discipline and
  dedup; consultation never grows a parallel tracker path.
- Memory cards gained the role scope beside phase and issue scopes,
  with the search index migrated in place — and the card tools got
  honest: provenance arrays now round-trip exactly as passed, and
  updates accept partial patches without demanding unrelated fields.

### the seats (phase 19)

Milestone v7's persona core: named, reusable review viewpoints as data,
not prose clones:

- The seat: one validated schema — a one-line lens, rubric categories,
  an anchored 0-10 scale with a fabrication-refusal line, a required
  injection dose, scope signals, and an advisory model preference —
  with five shipped defaults that reproduce review's classic five axes
  byte-for-byte (regression-pinned) until a project adds or edits a
  seat in its roles directory. A missing or invalid dose is refused at
  load with an error naming the file and the field.
- Review and audit convene the roster instead of hardcoded prose:
  anchored scores land beside pass/fail verdicts, never replacing
  gates, and the roster renders into every harness spine under a CI
  drift rule that caught a real stale spine during its own build.
- Wave briefs compose from seat templates: a role defined once survives
  across waves at its declared dose, named by a single annotation on
  the task line.
- Dispatch prunes itself with evidence: diff-derived scope signals pick
  which seats fire (opt-in per seat, full panel by default), a
  persisted per-seat yield statistic retires seats whose findings
  rarely survive — never the security seat or any full-dose seat — and
  gate-class work always routes to the strongest model tier regardless
  of a seat's preference.
- Many seats never means many issues: findings from multiple seats
  collapse into one deduplicated set — merged by location and claim,
  crediting every raising seat, keeping the highest severity — before
  anything reaches the tracker.

### hygiene-batch (phase 18.7)

Milestone v7's opener, built by the third headless batch run — which
field-accepted one of its own fixes at its own budget boundary:

- The spend ledger and the cost estimator finally agree on what a token
  is: real input and output only, with cached-context traffic priced in
  dollars — the accounting artifact that produced a forty-million-token
  false stop now reads as the sane number it always was, proven by this
  very run's boundary.
- Issues can move between phases after creation: the update contract
  carries the phase field through all eight tracker backends (each
  mapped exactly as at creation, with one honest documented degradation),
  and phase numbers now work everywhere an internal id once leaked.
- The release script embraces the cut-first workflow: a pre-written
  changelog entry is used as-is, and a half-filled scaffold is still
  refused outright.
- The public site's apex-domain fix is staged (with registrar and
  settings instructions), the architecture diagrams joined the CI count
  guards, and the native-binding safeguard now names both halves of its
  own cure — rebuild, then reload.

### positioning-truth (phase 18)

Milestone v6's closing phase, built by the second headless batch run:

- Every countable public claim now maintains itself: test totals (via a
  two-second deterministic enumeration), harness and agent counts, and
  the dependency list joined the auto-refresh markers, and the
  comparison page's cairn column regenerates from the live registry —
  no released number can silently rot again.
- Every competitor row on the comparison page was re-verified against
  live public sources and re-dated; the one claim that couldn't be
  re-confirmed is qualified on the page rather than silently kept.
- Cairn publishes its own docs through its own connector: seventy-eight
  pages into a Docusaurus site, release-stamped and idempotent — and the
  first self-publish immediately caught two real adapter bugs
  (false orphan warnings on case-insensitive filesystems; container
  pages dropping their images), both fixed with regression tests.
- The first headless batch run is now a public case study, blind ceiling
  and all — the second proof-of-rigor artifact beside the council piece.

## v2.4.0 — docs and build automation (2026-09-10)

Milestone v5 plus the first headless batch run's cargo: documentation
staleness became computed detection with generation wired into the
lifecycle, building became budgetable and headless with staged push
pre-authorization and a real boundary-enforced ceiling, and the first
live batch run shipped its own fixes — including the instrumentation
gap it discovered in itself.

### Release hardening (phase 17)

- The batch ceiling became real: the spend ledger now charges the
  driving session as a delta from run start and folds each wave's
  reported agent totals into its boundary rows — proven by a live
  refusal test that walks the full stop path. (This closes the
  instrumentation gap the rehearsal discovered in itself.)
- The estimator's per-issue history actually loads now — an
  archived-phase path bug had silently discarded it, which is why early
  estimate ranges were identically wide; ranges narrow up to 73% for
  phases resembling ones already run, with a documented sample-gated
  tightening curve.

### Rehearsal guards (phase 16.5)

The second half of the first headless batch run's cargo:

- The native-task mirror's honest posture is settled: with the task
  tools off (the default on newer models) it sleeps silently by design —
  every place that promised automatic mirroring now carries the wake-up
  flag, and a session advisory nudges it without guessing the model.
- CI grew two fast guards: a sweep that fails on any test asserting a
  wrong or stray tool total, and an install-free freshness check that
  catches committed builds lagging their source — both proven against
  seeded violations before landing.
- The leak guard learned the one legitimate exception: server source may
  reference the internal directories it manages, exempt from the path
  pattern only — every other check still applies there, and full
  strictness holds everywhere else.

### Dress rehearsal (phase 16)

The first headless batch run's cargo — four friction fixes from the v5
retrospective, built and shipped unattended under a token ceiling:

- The docs-staleness matcher now normalizes hyphens and line wraps on
  both sides, ending the false "docs owe an entry" flags that twice bit
  real runs (this very entry's heading is the regression test in the
  wild).
- The protected-section writer preserves marker dates on rewrite; a
  malformed meta now fails loudly instead of silently erasing provenance.
- Issue creation accepts the planning-side phase number everywhere — the
  tracker's internal id no longer leaks into the planning workflow (and
  the investigation surfaced a real contract gap around re-phasing
  existing issues, filed on its own).
- A missing native database binding — the fresh-install failure that
  silently broke memory tools — now produces a typed error naming the
  exact rebuild command, memory cards keep working through it, and the
  health probe reports the binding state before it bites.

### Native grain + proof — catch-up entries (phases 12–13)

Late entries: these two phases shipped 2026-08-14 without changelog
lines — the gap the new docs-staleness detector flagged on its first run.

- Phase 12 (native grain): the server moved to the MCP v2 SDK (zod 4,
  full behavior-diff sweep with regression pins), wave dispatch was
  rebuilt on the platform's native Workflow pipeline with resumable
  re-entry, native task tracking now mirrors into the tracker through a
  durable offline-safe spool, all command shims migrated to the skills
  frontmatter, and the first read-only MCP resources surface landed.
- Phase 13 (proof not pitch): two public positioning artifacts — a dated
  mechanism-level comparison page and the full product-council case study
  (kills, degradations, a self-caught leak, and an owner override on the
  record) — plus homepage/link repairs and a fresh-install distribution
  check.

### Headless build (phase 15)

- Building became budgetable: a token estimator turns any phase into an
  honest cost range calibrated from real recorded spend (never a point
  claim, wide by admission when history is thin), and every finished run
  feeds the history that tightens the next estimate — the loop closes
  itself.
- The hands-off verb grew a batch mode: one staging conversation selects
  phases (or fits them to a budget), runs the cross-phase research and its
  single question round, and captures push authorization up front — the
  council-adopted ship confirmation moved to run start, scope-limited to
  exactly the approved phases, and declinable without losing the run.
- Headless execution respects a hard boundary: actual spend is re-read at
  every phase and wave boundary and no new work starts past the ceiling,
  with the honest guarantee stated everywhere — overshoot is bounded by
  at most one in-flight wave, recorded rather than hidden.
- Headless never means invisible: a run announces itself on its own
  tracker issue, comments every phase transition, refreshes the portfolio
  board at each boundary, and survives kills — the run manifest is the
  resume authority and can never widen its own scope or authorization.
- The run ends in a report worth reading: per-phase outcomes with
  reasons, estimate-versus-actual for each phase and the run, pushes made
  under the pre-authorization, unattended decisions, and why the run
  ended.
- Research can sweep many phases at once: the phase-research command
  accepts a list, works every phase's topics from one agent pool, and
  still leaves each phase individually resumable.

### Auto-docs (phase 14)

- Documentation staleness became computed math: a deterministic `docs_drift`
  report names every verified phase the changelog and docs haven't caught
  up with — live or archived — and its first production run immediately
  surfaced four older phases whose entries had silently never landed.
- Generated documentation can no longer clobber hand-written prose: doc
  synthesis writes only inside explicitly marked sections (an unmarked
  section is an error, never a silent append; identical rewrites are a
  proven no-op), and the synthesis step now runs per phase, scoped by a
  server-built manifest of exactly what that phase changed.
- The lifecycle grew documentation reflexes: verification reports docs
  debt after a pass, shipping generates the catch-up entries behind the
  existing single push confirmation (a docs failure never blocks a good
  push), and milestone completion runs the full synthesis with an explicit
  publish offer — never an automatic publish.
- Publishing got honest about the remote side: pages orphaned by deleted
  local docs are reported (never auto-deleted), and every published page
  now carries the release it came from.
- The README keeps its own counts: a refresh script recomputes the
  mechanical claims (verbs, tools, backends) from the live registry and
  fails CI-style when they drift — it caught two real drifts in its first
  hour.

## v2.3.0 — release integrity (2026-08-14)

- One answer to "what version is running where": `config_probe` reports the
  running server, plugin-cache, repo-file, and npm-latest versions with
  plain-language drift lines ("installed vX, available vY"), and
  `cairn-setup --check` walks every harness install surface read-only —
  version stamps are now written alongside every installed artifact — and
  exits non-zero when anything lags, so it can gate.
- The release itself became one command: `scripts/release.mjs
  <version|patch|minor|major>` bumps all four version surfaces (three
  version files + the marketplace pin) atomically with a changelog
  scaffold, and refuses outright when the surfaces already disagree.
- CI now enforces version agreement on main before any tag exists
  (`scripts/check-versions.mjs` — includes the marketplace pin and a
  runtime-dep mirror check), and the publish workflow's tag gate covers
  `.claude-plugin/plugin.json`, which was previously checked by nothing.
- The plugin channel stopped depending on luck: the marketplace source is
  pinned to the release tag (installed = released, replacing the mutable
  working-tree clone), and a root lockfile makes Claude Code's installer
  actually materialize the server's dependencies in the versioned cache —
  closing the failure class where an installed plugin's MCP server died on
  a missing package.
- Publish workflow triggers only on release-shaped tags (vX.Y.Z); milestone
  tags no longer fire spurious runs.

## v2.2.0 — the planning intelligence + the product council (2026-08-13)

(Milestone v3's closing phases: phase 9 — peers product council; and
phase 9.5 — council follow-ups.)

- `/cairn:peers council [dimensions]`: external AI reviewers judge the
  PRODUCT — functionality, look-and-feel, market position, and code —
  with rubric-anchored dimension scorecards, evidence packets screened by
  the leak gate, clustering convergence with a steelman round, a typed
  recommendations report (COUNCIL.md) behind the shared proposal gate,
  and a persistent dispositions table so rejected ideas don't come back
  without new evidence. Proven by a live council reviewing cairn itself.
- Peers runtime hardening from that council's own findings: reviewers run
  contained by default (scratch cwd holding only their packet; read-only
  sandbox flags where the CLI supports them; project access is an
  explicit `execCapable` grant), fan-out throttles to a resource-aware
  concurrency budget (`peerFanout.maxConcurrent` override), convergence
  state survives interruption and sources audit provenance from records,
  and the finding format is a validated schema with tolerant parsing and
  reusable prompt templates.
- The map is a first-class queryable surface: `map_query` (multi-hop BFS,
  AND-combined type/label filters), freshness metadata
  ({builtAt, updatedAt, generation}), edge-safe `edgesAdd`/`edgesRemove`
  patching (wholesale replace is rebuild-only), and plan/scout/survey now
  read the map when one exists.
- Research checkpoints are parsed, not trusted: `research_sections`
  validates one marker grammar for scout/survey/council (a typo'd marker
  is a named error, never silently done), with realpath containment and
  atomic validated flips. Survey runs are dated epochs with a recorded
  proposal→decision→artifact dispositions footer, behind a single shared
  proposal-gate spec.
- Errors speak human first: 4xx tracker rejections get an honest
  `TRACKER_REJECTED` code with body-derived next actions (5xx stays
  TRACKER_DOWN), and every verb renders a plain-language line + next
  action before the typed detail. `ship` now confirms before pushing
  (one-line summary, push/hold; `ship.confirm: false` restores silent).
- Peer roster: Antigravity (`agy`) replaces Gemini; every peer runs from
  a deterministic cwd with verified invocation conventions; opencode
  latency diagnosis baked into its timeout hint.
- 75 typed MCP tools, 1016 passing tests, three mechanical drills
  (peers 15, council 20, map 11 checks).

## v2.1.0 — ship the backlog (2026-07-31)

- New `/cairn:survey ["<topic>"]` verb: project-wide research into a
  resumable `SURVEY.md`, a hard discussion gate, then approved roadmap
  changes applied via route mechanics (decimal phase insert, mirrored
  issues); `/cairn:new` now recommends survey before `/cairn:plan 1`.
- Research fan-out is now mandatory and multi-agent for `scout`, `survey`,
  and `plan --deep`: one subagent per pending topic, model routed by work
  class (mechanical/synthesis/judgment); sections commit as each agent
  finishes, so a killed run keeps everything completed.
- Decimal phase numbers land server-side: `plan_scaffold_phase` /
  `plan_phase_ensure` accept N.1–N.9 fractional inserts without
  renumbering; status/import/continuity round-trip them, and invalid
  numbers return structured `CONFIG_INVALID` errors.
- Ninth and tenth tracker backends: Linear (GraphQL CRUD, native issue
  links, phases-as-Projects) and a zero-credential Local (maildir) adapter
  backed by a pure graph module (ready frontier, effective priority,
  dangling-edge detection), plus `tracker_migrate` to promote a local
  project to a hosted backend.
- Docusaurus docs connector (filesystem adapter, native TOC) joins
  Confluence; a docs honesty pass adds the Atlassian scoped-token caveat,
  retires the connector-expansion promise, and reorders the quickstart
  GitHub-first.
- Cairn now runs beyond Claude Code — Grok, GitHub Copilot, Codex, Gemini,
  Cursor, OpenCode, and Zed adapters — alongside tracker surface growth
  (issue attachments, Jira sprint/estimate fields, custom status
  vocabulary) and hardened npm publish/CI (OIDC trusted publisher,
  dist-freshness + tag-version-match gates).
- Counts: 38 verbs, 71 tools, 766 tests.

## v2 — survey verb: project-wide research (2026-07-30)

- New `/cairn:survey ["<topic>"]`: project-wide research into a resumable
  `SURVEY.md` (scout's done/pending markers), a hard discussion gate, then
  approved roadmap changes applied via route mechanics (decimal phase
  insert — never renumber, locked-decision CONTEXT.md edits, mirrored
  issues). Composition of existing verbs plus targeted server support (38 verbs).
- Decimal phase numbers land server-side to back route's `insert <N.5>` and
  survey's apply stage: `plan_scaffold_phase` / `plan_phase_ensure` accept
  one fractional digit (N.1–N.9), dirs sort as `01.5-slug` between
  neighbors, status/import/continuity round-trip them, and invalid numbers
  return structured `CONFIG_INVALID` errors (766 tests).
- Research fan-out is now mandatory and multi-agent for `scout`, `survey`,
  and `plan --deep`: one subagent per pending topic, model routed per the
  work class of the topic (mechanical → haiku-tier, synthesis →
  sonnet-tier, judgment → opus-tier); sections commit as each agent
  finishes, so a killed run keeps everything completed.
- `/cairn:new` now recommends `/cairn:survey` before `/cairn:plan 1` —
  whole-project research is cheapest when nothing is planned yet.

## v2 — Confluence documentation connector (2026-07-24)

- Docs connector SPI: normalized `DocsConnector` interface, capability
  flags, registry with per-connector validation, and an optional docs
  config block — pluggable for future Notion / GitBook / Slite / SharePoint
  adapters.
- Confluence adapter: Cloud v2 REST client, Atlassian token auth,
  body-cursor pagination, and a dependency-free markdown → storage-format
  converter that degrades gracefully.
- Publishing: README becomes the project landing page inside a
  folder named for the project; the docs tree becomes child pages with
  generated contents sections; re-publish updates in place (identity =
  title + ancestry, space-wide title conflicts auto-disambiguated).
- Surface: `docs_publish` / `docs_status` server tools and the `docs` verb
  (65 tools, 37 verbs); config writes rebuild connectors without restart.
- Testing: shared docs-connector behavioral contract, in-memory fake
  enforcing production constraints, in-process tool tests, env-gated live
  suite — 555 passing tests.
- Fixes from live dogfooding: unbalanced list markup on multi-level indent
  jumps; space-wide title-collision handling. Also fixed: tracker
  connections now rebuild after config edits instead of holding stale
  backends.

## v1 — Marketing launch (2026-07-24)

- Projects section on eventually-consistent.io with cairn overview,
  competitive positioning, and quick-start pages; repository made public.
