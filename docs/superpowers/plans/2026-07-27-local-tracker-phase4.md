# Local Tracker Phase 4 — Promotion to Hosted Trackers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-command promotion of a local-tracker project to any hosted backend — full history, ID remap, provenance — per spec §Migration (CRN-50, phase 4 of 4).

**Architecture:** Two small SPI read methods (`listComments?`/`listWorklogs?` — the migration needs to READ what phase 1 only wrote), a pure-ish migration module (`server/src/tracker/migrate.ts`) walking phases → issues → comments → worklogs → links, and a `tracker_migrate` server tool (dry-run by default is OFF; explicit `dryRun: true` supported) that also writes `MIGRATED.json` and marks the local store's `config.json`.

**Tech Stack:** TypeScript ESM, vitest, FakeTracker as the hosted stand-in. No new dependencies.

## Global Constraints

- Migration NEVER mutates the source store beyond the `migratedTo` marker in its `config.json`; a failed migration must leave the local store fully usable.
- Per-item failures (one comment 4xx, one link unsupported) become `warnings[]` entries, never aborts — partial progress is reported honestly.
- Provenance: every migrated issue body ends with `\n\n[migrated from <old-id>]`.
- Deviation from spec (amend spec inline): unmigratable links become dst COMMENTS (`[link] blocks → <new-id>`), not body rewrites — one mechanism, no post-create body surgery.

---

### Task 1: SPI read surface — `listComments?` / `listWorklogs?`

**Files:**
- Modify: `server/src/tracker/types.ts`, `server/src/tracker/adapters/local.ts`, `server/src/tracker/fake.ts`, `server/src/tracker/cached.ts`
- Test: `server/test/local.unit.test.ts`, `server/test/cache.test.ts` (extend)

**Interfaces (Task 2 consumes):**

```ts
export interface IssueComment { at?: string; author?: string; text: string }
export interface WorklogEntry { at?: string; author?: string; minutes: number }
// Tracker, optional:
listComments?(id: string): Promise<IssueComment[]>;
listWorklogs?(id: string): Promise<WorklogEntry[]>;
```

- [ ] **Step 1: Failing tests.** `local.unit.test.ts`: comment twice + logWork, then `listComments` returns both texts in file order with `at` (ISO-ish) and `author` parsed from filenames; `listWorklogs` returns `[{minutes: 25, ...}]`. `cache.test.ts`: forwarding present on wrap of FakeTracker (which gains `listComments` over its existing comment store), absent when inner lacks it.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement.** Local: parse `comments/`/`worklog/` filenames `^(.+Z)-(.+)\.md$` → `at` (stamp de-mangled enough to keep ordering; raw stamp string is acceptable), `author`; body = file text (trimmed); worklog minutes = leading `(\d+)m`. Fake: map its `comments(id)` store to `IssueComment[]` (no timestamps). CachedTracker: forward both (reads, no cache-clear).
- [ ] **Step 4: Run — green; full suite + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): comment/worklog read surface on the SPI — local + fake + forwarding`

### Task 2: Migration module

**Files:**
- Create: `server/src/tracker/migrate.ts`
- Test: `server/test/migrate.test.ts` (create)

**Interfaces (Task 3 consumes):**

```ts
export interface MigrateResult {
  remap: Record<string, string>;          // old issue id → new
  phaseRemap: Record<string, string>;
  counts: { phases: number; issues: number; comments: number; worklogs: number; links: number };
  warnings: string[];
}
export async function migrateTracker(src: Tracker, dst: Tracker): Promise<MigrateResult>;
```

- [ ] **Step 1: Failing tests** (`migrate.test.ts`, LocalTracker temp dir → FakeTracker): seed local with 1 open phase + 3 issues (one in the phase, one closed with priority label + assignee, one with 2 comments + a 25m worklog) + a `blocks` link; migrate; assert — every count, remap size 3, dst issue titles/labels/states/phase-remap correct, provenance suffix on each dst body, comments arrived prefixed `[<at> <author>]` (Fake has no native metadata), worklog arrived as a comment `[worklog ...] 25m` (Fake hasWorklog false → fallback), link arrived NATIVELY on dst (Fake has real links). Second test: dst missing `linkIssues` (strip it) → link becomes a comment + a warning entry. Third: a dst.commentIssue that throws once → warning recorded, migration completes.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement.** Order per spec: phases (closePhase when closed & supported) → issues (labels pass through incl. priority:*, phase remapped, body + provenance; state via one updateIssue when ≠ open; assignee attempted, failure → warning) → comments (`[${at ?? "?"} ${author ?? "?"}] ${text}` only when metadata exists, else raw) → worklogs (`dst.logWork` when present+hasWorklog, else comment fallback) → links (native when dst.linkIssues, else comment on the FROM issue + warning). Every per-item try/catch feeds `warnings`.
- [ ] **Step 4: Run — green; full suite + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): SPI-level migration — phases, issues, history, links with remap + provenance`

### Task 3: `tracker_migrate` tool + store marking

**Files:**
- Modify: `server/src/index.ts`, `server/src/tracker/adapters/local.ts` (migratedTo stderr warning)
- Test: `server/test/mcp.test.ts` (pins 69 → 70; note: harness runs FakeTracker, NOT local, so the happy-path mcp test asserts the local-source gate instead), `server/test/migrate.test.ts` (extend for marker file)

- [ ] **Step 1: Failing tests.** mcp: `tracker_migrate` exists in pins; calling it on the (fake-backed) harness → `CONFIG_INVALID` "source tracker is not local". migrate.test.ts: after a successful run through a helper that mimics the tool's post-steps, `<dir>/MIGRATED.json` holds `{ target: {type}, remap, at? }`-shaped data (no Date assertions beyond presence) and `config.json` gains `migratedTo`; a subsequent LocalTracker write still WORKS (soft warning only).
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement.** Tool input `{ targetType: <tracker enum>, targetConfig: z.record(z.unknown()), dryRun: z.boolean().optional() }`; gate `loadConfig(d).tracker.type === "local"`; build dst via `makeTracker({...cfg, tracker: {type: targetType, config: targetConfig}} as CairnConfig, d)`; `dryRun` → return counts of WOULD-migrate (list issues/phases/links only, no writes); real run → `migrateTracker`, then write `MIGRATED.json` (target type, remap, counts, warnings) into the local dir and patch its `config.json` with `migratedTo: targetType`; return the MigrateResult + file path. Local adapter: on first write op when `config.json` has `migratedTo`, `console.error` one warning naming the target. Pins/docs: 70 tools, tracker group +1.
- [ ] **Step 4: Run — green; full suite + tsc.**
- [ ] **Step 5: Commit** `feat(server): tracker_migrate — promote a local project to a hosted backend`

### Task 4: Docs

**Files:** `docs/01-runbook.md` (local section's promotion paragraph → real subsection: what carries, the comment-metadata caveat, dry-run, MIGRATED.json, don't-keep-writing warning), `server/README.md` tool blurb, spec amendment (links-as-comments deviation).

- [ ] Write + commit `docs: local→hosted promotion — tracker_migrate`

## Verification (phase gate)

- Full suite + typecheck green.
- End-to-end smoke: scratch local project (issues/comments/worklog/links/phases) → `tracker_migrate` dry-run counts match → real run into a FakeTracker-backed... no: smoke into the REAL Jira CRN space is destructive-ish (creates issues) — use a scratch prefix and close them after, OR smoke local→local? Target must differ; FakeTracker isn't reachable via config. Decision: live smoke into Jira CRN with clearly-marked scratch titles, then close the created issues — proves the real path end to end.
- Comment phase-4 completion on CRN-50; CRN-50 closes when this merges (all four phases done).
