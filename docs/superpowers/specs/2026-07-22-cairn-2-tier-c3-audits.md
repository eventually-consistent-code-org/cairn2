# Cairn 2.0 — Tier C3: Audits & Review Governance

**Date:** 2026-07-22
**Status:** Approved design (owner delegated decisions this tier — "finish it" directive 2026-07-22; calls recorded below)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier C item 17
**Siblings:** C1 (trace — shipped 2026-07-21), C2 (probe/draft — shipped 2026-07-22).

## Outcome

Two new live verbs — `audit` (cross-phase UAT, milestone, security/ui/eval/
validation retro-audits, and test-gap generation, as scoped modes of one
verb) and `review` (code review of a diff, branch, or phase) — with every
Critical/Important finding landing as a real tracker issue in plain
language, fix loops that never improvise past the trace discipline, and two
new server tools: `plan_check` (the #2891 plan-checker upgrades:
cross-plan contract-drift detection and unanchored-quantitative-threshold
warnings, deterministic and read-only) and `audit_record` (single-writer
audit record files under `.cairn/audit/`). GSD parity covered:
audit-uat, audit-milestone, audit-fix, code-review, code-review-fix,
ui-review, eval-review, validate-phase, add-tests.

## Why (decision record)

- **One `audit` verb with modes, not seven verbs (owner call, delegated).**
  GSD ships audit-uat/audit-milestone/ui-review/eval-review/validate-phase/
  add-tests as separate commands; cairn folds them into `audit <mode>` —
  same fold-don't-multiply precedent as C2's `--wrap`. Surface goes
  26 → 28 live (audit, review), not 26 → 33. Rejected: separate verbs
  (routing-table bloat, identical machinery per mode).
- **Fix loops are flags: `audit --fix`, `review --fix` (owner call,
  delegated).** GSD's audit-fix and code-review-fix become flags on the
  verb that produced the findings, mirroring C2's wrap-as-flag call.
- **Findings are tracker-first (project law).** Critical/Important findings
  = real tracker issues labeled `cairn:audit` (audit modes) or
  `cairn:review` (code review), plain-language title + body, severity in
  the body's first line. Minor findings live only in the audit record
  file. Rejected: findings-as-comments-only (standalone audits would have
  no tracker object for management to see or assign).
- **No new session kind (owner call, delegated).** Audits are point-in-time
  reports plus a fix loop — not long-lived investigations. The sessions
  core stays three kinds; audit state lives in the record file + tracker
  issues. Bug-shaped findings route into `trace` (#726 consistency: a
  finding needing INVESTIGATION is never fixed inline; mechanical fixes
  under `--fix` are applied directly with ledger evidence, the C1
  fast-lane balance).
- **`plan_check` is a server tool, not prompt guidance (spec mandate,
  #2891).** Contract-drift and threshold checks must be deterministic and
  drillable — same reasoning as C2's `session_landscape`. Read-only over
  the planning docs; the verb interprets, the tool detects.

## 1. Scope & surface

- New live verbs: `audit`, `review` (26 → 28 live; reserved stays
  `triage`(D), `basecamp`(F)).
- Server tools 48 → **50**: `plan_check`, `audit_record`.
- Zero adapter/interface work; mirror rides `issue_create`/`issue_comment`/
  `issue_close`.
- check-surface: `TOOL_PREFIXES` gains `audit` (`plan_` already covered;
  `audit_record` needs the prefix).

## 2. `plan_check` tool (the #2891 upgrades)

Read-only scan over a phase's plan documents (`.cairn`-registered planning
dir; same source `plan_status`/`plan_drift` read). Two detectors:

- **Contract drift:** collect `Produces:`/`Consumes:` declarations across a
  phase's plans (the Interfaces blocks cairn plans already carry). A
  consumer naming a producer symbol whose declaration text differs
  (signature, parameter names, return shape) — and no shared fixture file
  referenced by BOTH plans — is a `contract-drift` finding naming both
  plans, both lines, and the differing text.
- **Unanchored thresholds:** quantitative thresholds in plan text
  (`<100ms`, `99.9%`, `>= 500 rps` — number+unit/comparison patterns) with
  no anchor in the surrounding sentence (an anchor is a named source:
  fixture path, benchmark file, spec section, measurement) become
  `unanchored-threshold` warnings with plan + line + the matched text.

Output: `{ findings: [{ type, plan, line, detail, counterpart? }], scanned:
<plan count> }` — deterministic ordering (plan path, then line), byte-equal
across calls on an unchanged tree. Zero findings on clean plans — the
detectors must be quiet by default; anchored thresholds and
fixture-backed contracts produce nothing.

## 3. `audit_record` tool

Single-writer record: `audit_record(scope, verdict, findings)` writes
`.cairn/audit/<scope>-<YYYY-MM-DD>.md` (frontmatter: `scope`, `verdict:
pass|findings`, `created`; body: one `## finding — <severity>` block per
finding with `issue:` line when mirrored). Overwrites the same
scope+date file on re-run (an audit re-run the same day supersedes
itself); prior dates are immutable history. Returns `{ path, findings:
<count> }`.

## 4. Verbs

### `verbs/audit.md` — modes, one discipline

`/cairn audit <mode> [target]` where mode ∈ `uat | milestone | security |
ui | eval | validation | tests | plans`:

- **uat [phase]** — walk the phase's shipped flows end-to-end as a user
  would (GSD audit-uat parity); evidence per flow, verdict per flow.
- **milestone [n]** — every phase in the milestone: goals vs delivered,
  `plan_status` + `issue_list` + ledger cross-check (GSD audit-milestone).
- **security | ui | eval | validation [phase]** — retro-audits of
  implemented work against the phase's stated criteria (GSD ui-review /
  eval-review / validate-phase family).
- **tests [phase]** — test-gap generation (GSD add-tests): find untested
  requirements, WRITE the missing tests, evidence in the ledger.
- **plans [phase]** — run `plan_check`; present findings in plain language.
- Every mode ends with `audit_record`; every Critical/Important finding
  becomes a `cairn:audit` issue (plain language, severity first line);
  Minor findings live in the record only.
- `--fix`: mechanical findings fixed directly, each fix committed with the
  finding's issue closed (`issue_close` after a plain-language close
  comment); investigation-shaped findings open a `trace` instead — NEVER
  an improvised inline fix (#726).

### `verbs/review.md`

`/cairn review [target]` — target = diff, branch, or phase (default:
working diff). Five-axis review (correctness, clarity, architecture,
security, tests). Critical/Important → `cairn:review` issues;
Minor → review record via `audit_record(scope: "review-<target>")`.
`--fix` same contract as audit. Plain-language mirror discipline
throughout; leak-pattern rules apply to everything sent to the tracker.

### Surfacing

`status.md` adds open audit/review issue counts (via `issue_list` label
filter, plain language). Banner untouched (audits are not sessions).

## 5. Testing (three rings)

- **Unit:** `plan_check` detectors — drifted contract pair flagged with
  both endpoints; fixture-backed pair silent; unanchored threshold
  flagged, anchored silent; deterministic byte-equal output; zero
  findings on the repo's own clean fixtures. `audit_record` — file shape,
  same-day overwrite, prior-date immutability, frontmatter validation.
- **MCP ring:** both tools registered (50), schemas, error paths.
- **Drills (mechanical, real tracker, post-merge):**
  - `drill-plan-check.mjs` — seeded scratch phase: one drifted
    producer/consumer pair + one unanchored threshold → exactly two
    findings, correct lines; fixed fixtures → zero findings; two calls
    byte-equal.
  - `drill-audit.mjs` — audit run writes the record, mirrors two findings
    as real `cairn:audit` issues (severity first line, leak-clean), `--fix`
    mechanics close one issue with a plain-language close note; the
    investigation-shaped finding opens a real trace instead of an inline
    fix (#726 leg).
  - `drill-review.mjs` — review of a seeded diff mirrors one
    `cairn:review` issue + record; close-note discipline; leak scan zero
    hits.

## Non-goals

- No new session kind; no banner changes.
- No CI integration, no coverage tooling — `audit tests` reads the suite
  the way an engineer does.
- `plan_check` parses cairn plan conventions (Produces/Consumes blocks,
  prose thresholds); it is not a general markdown linter.
- No cross-AI review (Tier F), no triage (D).

## Success criteria

1. A drifted producer/consumer contract across two plans in a phase is
   detected mechanically with both endpoints named; adding the shared
   fixture reference silences it (#2891 leg one).
2. An unanchored quantitative threshold in a plan warns; anchoring it to a
   named source silences it (#2891 leg two).
3. Every Critical/Important audit/review finding is visible on the tracker
   as a labeled issue in plain language, leak-clean; Minors stay in the
   record file.
4. `--fix` closes mechanical findings with commits + close notes;
   investigation-shaped findings open traces — zero improvised inline
   fixes (#726 held).
5. Audit records are reproducible history: same-day re-run supersedes,
   prior dates immutable.
6. C1/C2 surfaces bit-for-bit unaffected (sessions store, trace/probe/draft
   tools, banner) — their test files pass unedited.
