# Cairn 2.0 — Tier D: Triage

**Date:** 2026-07-22
**Status:** Approved design (owner-delegated decisions, "go for Tier D" directive 2026-07-22; calls recorded below)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier D item 18 (#907 parity)
**Siblings:** Tier C complete (C1 trace, C2 probe/draft, C3 audits — all shipped).

## Outcome

One new live verb — `triage` — that sweeps the tracker's open issues
against project conventions and reports what's rotting: unlabeled work,
stale threads, bodiless issues, in-progress work with no owner, cairn
artifacts (`cairn:bug`/`cairn:audit`/`cairn:review`) still open after
their trace or audit record says resolved, and likely duplicates. Report
lands as an `audit_record` (tracker-first discipline carried over from
C3); `--apply` executes the safe subset. **Zero new server tools** — the
roadmap called this tier "minimal new work" because P1's adapters already
carry everything triage needs (`Issue.updatedAt/labels/assignee/body`,
`issue_list` state filter), and that held on inspection.

## Why (decision record)

- **Zero server work (owner call, delegated).** `Issue` already exposes
  `updatedAt`, `labels`, `assignee`, `body`, `state`; `issue_list` filters
  by state; `issue_update` patches labels; `audit_record`/
  `session_landscape` (C2/C3) provide the report and the resolved-artifact
  cross-check. Rejected: a server-side staleness/classification tool — it
  would duplicate data the verb can already read, against the roadmap's
  own "minimal new work" positioning.
- **Report-only by default; `--apply` for the safe subset (owner call,
  delegated).** Triage mutating the tracker unprompted violates least
  surprise. `--apply` executes: label fixes (`issue_update`), stale-nudge
  comments (`issue_comment`), and closes ONLY for resolved-but-open cairn
  artifacts with evidence (the trace archive or audit record naming the
  resolution) — each close gets a plain-language note first. Duplicates
  are NEVER auto-closed — flagged with cross-linking comments only; a
  human (or a later explicit instruction) decides.
- **Report is an `audit_record` (reuse, not invent).** Scope
  `triage-<YYYY-MM-DD>` comes free from the record's date suffix — scope
  is just `triage`. Findings severity mapping: resolved-but-open =
  important; stale/unlabeled/bodiless/unassigned-in-progress = minor
  (record-only, no issue spam — triage findings ARE issues already;
  creating issues about issues is noise). This is the one deliberate
  deviation from C3's "Critical/Important → new tracker issue" rule, and
  the reason is structural: every triage finding already has a tracker
  object — the issue itself. The mirror touch is a comment ON that issue
  (under `--apply`), not a new issue about it.
- **PRs out of scope (owner call, delegated).** The Tracker interface is
  issue-centric; PR triage would mean interface + six-adapter work,
  contradicting "minimal new work." Revisit alongside Tier F cross-AI
  review if demand shows.

## 1. Scope & surface

- `triage`: `reserved-D` → **live** (28 → 29 live; reserved = `basecamp`(F)
  only). Server tools stay 50. Zero adapter/interface work.
- check-surface: `SPEC_RESERVED` drops `triage`; no `TOOL_PREFIXES` change.

## 2. `verbs/triage.md`

`/cairn triage [--stale-days N] [--apply]`

**Sweep:** `issue_list(state: "open")` → classify each issue:

| class | rule | severity |
|---|---|---|
| resolved-but-open | `cairn:bug`/`cairn:audit`/`cairn:review` label AND its trace (via `session_landscape` resolutions) or audit record names it resolved | important |
| stale | `updatedAt` older than N days (default 14) | minor |
| unlabeled | zero labels | minor |
| bodiless | empty body | minor |
| unowned-in-progress | `state: in_progress`, no assignee | minor |
| possible-duplicate | title near-match against another open issue (judgment, not regex — the verb reasons about it) | minor |

**Report (always):** `audit_record(scope: "triage", verdict, findings)` —
one finding per flagged issue, `issue:` field linking it; plain-language
summary to the user grouped by class, proposed action per issue.

**`--apply` (the safe subset only):**
- unlabeled → `issue_update` adding the best-fit label (from the labels
  already in use on the project — never invents new label names).
- stale → `issue_comment` nudge, plain language, one line.
- resolved-but-open → `issue_comment` naming the evidence (trace id /
  record scope + resolution text), then `issue_close`.
- possible-duplicate → cross-linking `issue_comment` on BOTH issues.
  NEVER closes either.
- bodiless / unowned-in-progress → report-only always (writing someone
  else's issue body or assigning work is a human call).

**Discipline:** leak-pattern rules on every comment; re-running triage the
same day supersedes the record (C3 semantics, free); nothing is ever
deleted; closes only with evidence, and the evidence is quoted in the
close note.

### Surfacing

`status.md`: no change — open-issue counts already surface; triage is a
verb you run, not a passive indicator.

## 3. Testing

- **No server ring** (no server changes). check-surface is the ratchet.
- **Drill (mechanical, real tracker, post-merge):** `drill-triage.mjs` —
  stage on the scratch tracker: one unlabeled issue, one bodiless issue,
  one `cairn:bug` issue whose trace is archived-resolved, two
  near-duplicate titles. Run the sweep mechanically (the tool-call
  sequence triage.md prescribes): record written with one important +
  minors, all findings linked to real issue ids; apply leg: label added
  from existing project labels, resolved-but-open closed WITH the
  evidence-quoting comment, duplicates cross-linked and both still open;
  bodiless untouched; leak scan zero hits; same-day re-run supersedes.

## Non-goals

- No PR triage, no new tools, no config keys (`--stale-days` is a flag,
  not `cairn.json` surface), no auto-assignment, no auto-dedup closes, no
  issue-body editing, no scheduled/cron triage (a `/cairn auto` or loop
  concern, not this verb's).

## Success criteria

1. A resolved-but-open cairn artifact is detected via its trace/record
   evidence and — only under `--apply` — closed with the evidence quoted
   in plain language.
2. Duplicates are cross-linked, never closed.
3. Report-only default: a bare `triage` run mutates nothing on the
   tracker and still writes the record.
4. Labels added under `--apply` come only from the project's existing
   label set.
5. Leak scan zero hits on every comment; same-day re-run supersedes the
   record.
6. Server surface untouched: 50 tools, all server test files unedited.
