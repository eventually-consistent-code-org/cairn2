# Local Tracker Phase 3 — Scaffolding + Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local tracker discoverable and chooseable — `/cairn:new` offers it, all docs present it as the seventh backend. Spec §Scaffolding, phase 3 of 4 (CRN-50). No server code changes; this phase is verb-text + docs, so there is no TDD loop — the verification gate is a docs-accuracy sweep instead.

## Global Constraints

- Local is "the seventh adapter", zero-credential, repo-resident; `.tracker/` must be COMMITTED — every doc that mentions it repeats that.
- Never call it experimental — it passes the same contract suite as the hosted six.

---

### Task 1: `/cairn:new` offers the local tracker

**Files:** `skills/cairn-trailhead/verbs/new.md`

- [ ] Step 1 of the verb currently dead-ends when `cairn.json` is missing. Replace with: no `cairn.json` → ask which tracker (one AskUserQuestion; "local — issues live in this repo, no accounts" listed first, the six hosted options after). Local chosen → write a minimal `cairn.json` (`tracker: {type: "local", config: {prefix: <project slug, 2–10 lowercase alnum>}}`) via `config_set`-equivalent file write, then check `.gitignore` doesn't match `.tracker/` — if it does, warn with the exact line to remove and stop until resolved. Hosted chosen → point at `templates/cairn.json.example` for that backend as today.
- [ ] Commit: `feat(new): offer the local tracker at project setup`

### Task 2: Runbook — local backend section + seven-adapter sweep

**Files:** `docs/01-runbook.md`, `README.md`, `server/README.md`, `docs/00-quickstart.md`

- [ ] Runbook §4 gains `### Local` (before GitHub, it's the zero-setup path): config block, storage layout sketch, commit-the-dir rule, merge-safety promise (same-field races conflict on purpose), links/graph pointer to the §4 "The dependency graph" subsection, migration teaser (phase 4).
- [ ] Capability table sweep: "all six" rows → include local (comments: all seven; assignee writes: + local; worklog: Jira + local; new row: issue links/graph — local only). Adapter-maturity paragraph: local needs no live suite — the filesystem IS the live backend.
- [ ] `README.md` "six adapters" → seven, name local's zero-credential niche. `server/README.md:379` "all six adapters" → "all seven".
- [ ] Quickstart: one early line — no tracker account? `"type": "local"` and skip credentials entirely.
- [ ] Commit: `docs: local tracker is the seventh backend — runbook section + sweep`

## Verification

- `grep -rn "six adapters\|all six" README.md server/README.md docs/` returns nothing stale.
- Fresh-eyes read of the new runbook section against the actual phase-1/2 behavior (dir default, prefix rule, graph features list).
- Comment phase-3 progress on CRN-50.
