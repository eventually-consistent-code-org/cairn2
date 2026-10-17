# Cairn 2.0 — Tier D: Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `triage` verb — open-issue sweep against project conventions, report-only by default, `--apply` for the safe subset. Zero server changes. Spec: `docs/superpowers/specs/2026-07-22-cairn-2-tier-d-triage.md`.

**Architecture:** One PR, one stage, two tasks: the verb + ratchet flip, then docs + verification. Pure plugin surface.

**Tech Stack:** Markdown verb doc; check-surface as the only gate beyond the untouched server suite.

## Global Constraints

- Base branch: `main`. Conventional commits, one per task. Green before every commit: `node scripts/check-surface.mjs && cd server && npx vitest run && npx tsc --noEmit`.
- **Server untouched:** zero changes under `server/` (src, test, dist). 50 tools stays 50.
- Live verbs after D EXACTLY: previous 28 + `triage` (29). Reserved EXACTLY: `basecamp`(F) (1).
- Verb doc tool references limited to registered tools: `issue_list`, `issue_get`, `issue_update`, `issue_comment`, `issue_close`, `audit_record`, `session_landscape`, `plan_status`.
- Triage classes, severities, `--apply` action table, and never-rules copied EXACTLY from spec §2 (duplicates never closed; bodiless/unowned report-only; labels only from the existing set; closes only with quoted evidence; leak discipline).
- Record scope EXACTLY `triage` (date suffix comes from `audit_record` itself).

## File Structure (end state)

```
skills/cairn-trailhead/
  SKILL.md               # triage row flips live
  verbs/triage.md        # new
scripts/check-surface.mjs # SPEC_RESERVED − triage
README.md VERIFICATION.md # tier record; server/README.md untouched
```

---

### Task 1: `triage` verb + surface ratchet

**Files:**
- Create: `skills/cairn-trailhead/verbs/triage.md`
- Modify: `skills/cairn-trailhead/SKILL.md`, `scripts/check-surface.mjs`

**Interfaces:**
- Consumes tools (exact list above; check-surface validates every backtick reference).
- Produces: live verb `triage` (29 live, 1 reserved).

- [ ] **Step 1: Ratchet first** — `SPEC_RESERVED = { basecamp: "F" };`, flip the SKILL.md row:

```markdown
| `triage` | Open-issue sweep against project conventions — report by default, --apply for the safe subset | `[--stale-days N]` \| `--apply` | verbs/triage.md | live |
```

Run `node scripts/check-surface.mjs` → FAIL on missing verbs/triage.md. That failure is the test.

- [ ] **Step 2: Write `verbs/triage.md`** — house voice (read verbs/audit.md + review.md first; triage is their sibling). Required content, all findable:
  - The sweep: `issue_list(state: "open")`, then the six-class table from spec §2 verbatim (class / rule / severity), `--stale-days` default 14.
  - resolved-but-open evidence rule: cross-check `cairn:bug` issues against `session_landscape` resolutions and `cairn:audit`/`cairn:review` issues against `.cairn/audit/` records; no evidence = not this class.
  - Report discipline: `audit_record(scope: "triage", verdict, findings)`, every finding carrying its `issue:` id; plain-language summary grouped by class with a proposed action per issue; NO new issues created — the mirror touch is a comment on the existing issue, and only under `--apply` (state the C3-deviation rationale in one line).
  - `--apply` table verbatim from spec §2 incl. the never-rules (duplicates never closed; bodiless/unowned always report-only; labels only from labels already in use — `issue_list` shows the vocabulary; closes = evidence-quoting comment then `issue_close`).
  - Leak-pattern rules on every comment; same-day supersede noted; nothing deleted, ever.
  - ~90-110 lines.

- [ ] **Step 3: Verify green**

Run: `node scripts/check-surface.mjs && cd server && npx vitest run && npx tsc --noEmit`
Expected: check-surface clean — 29 live, 1 reserved, 50 server tools; suite 398/6 skipped; tsc clean; `git status server/` clean.

- [ ] **Step 4: Commit**

```bash
git add skills/cairn-trailhead scripts/check-surface.mjs
git commit -m "feat(plugin): triage verb live — open-issue sweep, safe-subset apply"
```

### Task 2: Docs + verification record

**Files:**
- Modify: `README.md`, `VERIFICATION.md`

- [ ] **Step 1: README.md** — verbs table + `triage` (live); tier status line → Tier D shipped. `server/README.md` NOT touched (no server changes).

- [ ] **Step 2: VERIFICATION.md** — Tier D section, house format: surface conformance (29/1/50), suite totals (run them, cite exactly), "server untouched" stated with the `git diff --stat main -- server/` evidence line, spec success criteria 1–6 mapped (criterion 6 = the untouched-server check itself), and the single drill procedure marked "PENDING (run live post-merge)" itemized per spec §3 (staged issues: unlabeled, bodiless, resolved-but-open cairn:bug, near-duplicate pair; report leg: record + linked findings + zero mutations; apply leg: label-from-existing-set, evidence-quoting close, cross-link comments with both dupes still open, bodiless untouched; leak scan; same-day supersede).

- [ ] **Step 3: Final green**

Run: `node scripts/check-surface.mjs && cd server && npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md VERIFICATION.md
git commit -m "docs(cairn): Tier D verification record — drill procedure pending live run"
```

---

## Post-merge (tier convention)

PR to `main`, merge, author + run `server/drills/drill-triage.mjs` against the real tracker, commit the drills-run record.
