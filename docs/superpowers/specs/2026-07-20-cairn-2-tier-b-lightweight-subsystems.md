# Cairn 2.0 — Tier B: Lightweight Subsystems

**Date:** 2026-07-20
**Status:** Approved design
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier B

## Outcome

Five new live verbs — `mark retro distill brief tune` — plus the leak guard
(hook #4) and the G6 confidence loop on memory cards. Capture goes
tracker-first with zero friction, retrospectives write provenance-backed
lessons that later retros re-grade, ship-time distillation produces
public-safe docs, and `cairn.json` gets a validated single-writer. Built
mechanism-first: one server sweep (3 new tools, 33 → 36, plus the hook),
then the verbs. `waypoint` (roadmap item 9) already shipped in Tier A0.

## Why (decision record)

- **Marks are tracker-first: work → tracker, knowledge → cards (owner
  call, 2026-07-19).** #1309's reported friction is forced problem/solution
  structure at capture time — cognitive, not network. So `backlog`/`seed`
  marks become bare tracker issues immediately (title = the sentence, a
  label, zero interview) where PMs can see them; `note` marks are
  knowledge, not work, and go to memory cards instead of cluttering the
  issue list. Rejected: everything-to-cards (backlog invisible to PMs until
  triage — fails tracker-first); everything-to-tracker (non-actionable
  notes never "close" meaningfully).
- **G6 confidence rides now; taste profile stays Tier E.** `retro` is the
  natural confidence writer and cards are already open for the `note`
  type — cheapest landing. The taste profile needs an approve/reject event
  stream that doesn't exist yet.
- **Leak guard = PreToolUse hook on `git commit`** over a git pre-commit
  installer (mutates the user's repo, collides with husky/lefthook, needs
  an uninstall story) and ship-time-scan-only (leaks sit in history until
  ship — the exact pain #2221 wants prevented). Accepted limitation:
  commits made outside Claude Code are unguarded; a git-hook installer can
  be a later `tune` offering.
- **Cards stay body-immutable.** `mem_card_update` patches frontmatter
  (`confidence`) only. Ids are content hashes of the body; a changed lesson
  is a NEW card — `retro` writes it and down-ranks the old one. No
  mutable-knowledge drift.
- **Mechanism-first, two stages** — Tier 0/A precedent: verbs land on a
  finished tool surface, check-surface ratchets cleanly.

## 1. Scope & surface

**Live verbs 18 → 23:** `mark retro distill brief tune`. Reserved drops to
5: `probe draft trace`(C) `triage`(D) `basecamp`(F). `SPEC_RESERVED` in
`check-surface.mjs` shrinks accordingly (established pattern).

| verb | args |
|---|---|
| `mark` | `"<text>" [--seed "<trigger>"] [--note]` |
| `retro` | `[<N> \| --milestone]` |
| `distill` | |
| `brief` | `[--stdout]` |
| `tune` | `[key] [value]` |

**New server tools (33 → 36):** `mem_card_update`, `config_get`,
`config_set`.

**Card schema (non-breaking):** `type` gains `note`; optional
`confidence: high | medium | low`, surfaced by recall results and the
banner.

**Hook #4:** PreToolUse (matcher `Bash`) leak guard, firing only on
`git commit` commands.

**Out of scope:** taste profile (Tier E); `triage` verb (Tier D — marks
just carry the labels it will consume); seed auto-firing (seeds surface in
`status`; trigger evaluation is agent judgment); git-native pre-commit
installer.

## 2. Server mechanism (cards + config)

### Cards

`CardFrontmatterSchema`: `type` enum gains `"note"`; optional
`confidence: z.enum(["high", "medium", "low"])`. `mem_card_create` accepts
both. Ids stay `type-<sha256(body)[:8]>` — confidence lives in frontmatter
only, so adjusting it never changes identity or breaks references.

### `mem_card_update({ id, confidence })`

The one mutation cards get, deliberately narrow: frontmatter-only patch,
body immutable. `NOT_FOUND` on unknown id. Rewrites through the same
serializer; triggers a banner re-render. The banner's byte-stability rule
holds — confidence is stable content, not volatile.

### Recall surfacing

`mem_search` / `mem_card_list` / `mem_card_recall` results and the
SessionStart banner include `confidence` when present. Ordering unchanged —
surfacing only; ranking by confidence is a Tier E decision alongside the
taste profile.

### `config_get()` / `config_set({ patch })`

`config_get` returns the parsed, validated, post-defaults view (so `tune`
shows effective values). `config_set` deep-merge-patches the raw
`cairn.json`, validates the merged result against `ConfigSchema` BEFORE
writing — invalid patch → `CONFIG_INVALID`, file untouched. `null` deletes
a key (same convention as `patchRoadmapMeta`). Patches touching tracker
credential/env fields are refused with a pointed error — secrets live in
env vars, never `cairn.json`. The single-writer rule now covers config.

`ConfigSchema` gains the `leakGuard` block (§3's shape, all fields
defaulted) so the guard's toggles validate like everything else.

## 3. Leak guard

### One pattern source

`hooks/scripts/leak-patterns.mjs` exports the regex set plus a tiny CLI
(`node leak-patterns.mjs <file…>` → hits listing, exit 1) so `distill` and
`ship` scrub with exactly the rules the hook enforces.

Default patterns (cairn-internal artifacts only):
- `.cairn/` path strings
- phase-dir refs (`phases/NN-slug`, `milestones/vN/`)
- cairn label strings (`cairn:seed`, `cairn:backlog`)
- the configured backend's issue-id pattern read from `cairn.json`
  (e.g. `PROJ-\d+` for Jira). For GitHub, bare `#N` is deliberately NOT
  matched — "fixes #123" is legitimate and desired.

### Hook flow — `hooks/scripts/pretooluse-leakguard.mjs`

PreToolUse matcher `Bash` → parse `tool_input.command` from stdin JSON; not
a `git commit` → exit 0 instantly. Otherwise scan `git diff --cached -U0`
ADDED lines, skipping allowlisted paths (`.cairn/**`, `docs/**`, `*.md`,
LEDGER/VERIFICATION artifacts). Hit → exit 2 with a file:line listing on
stderr (blocks the tool call; the agent sees exactly what leaked). Clean →
exit 0. Same <100ms budget and error posture as the A0 hooks: any internal
error → exit 0, never blocks work by accident. Commits that auto-stage or
name pathspecs (`-a`/`-am`/`--all`/pathspec forms) widen the scan to
`git diff HEAD` so they can't sidestep the index snapshot (amended at final
review, 2026-07-20).

### Escape hatches

`cairn.json` → `leakGuard: { enabled: true, allow: [globs],
extraPatterns: [regex] }` (editable via `tune`); one-shot override by
prefixing the command with `CAIRN_LEAK_OK=1`.

## 4. Verbs — mark, retro, brief

### `mark "<text>" [--seed "<trigger>"] [--note]`

Capture in ONE tool call, zero questions (#1309):
- default → `issue_create(title: <text>, labels: ["cairn:backlog"])`; echo
  the id, done.
- `--seed "<trigger>"` → label `cairn:seed`, body `Trigger: <trigger>`.
  Seeds fire as agent judgment: `status` lists open seeds and flags any
  whose trigger reads as met.
- `--note` → `mem_card_create(type: "note", body: <text>)`, auto-scoped to
  the active phase/issue from `context_get`.
- Verb doc rule: no AskUserQuestion, no enrichment prompts. Structure
  happens at pickup (`plan` adoption, Tier D `triage`, or recall).

### `retro [<N> | --milestone]`

The lessons-writer (#1003); default scope: last verified phase.
1. Gather: LEDGER.md (what shipped, ranges), VERIFICATION.md, `git log`
   over ledger ranges, closed issues.
2. Extract lessons → `mem_card_create` with provenance (files + commits
   from ledger ranges) and confidence: `high` = verified by this phase's
   events; `medium` = plausible inference; `low` = hunch worth recording.
3. Re-grade prior cards recalled for this scope: proved out →
   `mem_card_update` confidence up; contradicted → down to `low` + the
   corrected lesson written as a NEW card. One batched AskUserQuestion
   approves the whole set.
4. Report cards written/adjusted. That closes the G6 loop: retro writes ↔
   recall surfaces ↔ next retro re-grades.

### `brief [--stdout]`

Onboarding for someone who wasn't there (#1219): PROJECT.md vision +
roadmap state + per-phase one-liners (ledger summaries) + high-confidence
decision/constraint cards → one readable briefing at `docs/BRIEF.md`
(`--stdout` prints instead). Regenerated wholesale each run — it is a view,
not a source of truth. Cache-stability rules apply: no volatile timestamps,
date granularity only.

## 5. Verbs — distill, tune

### `distill`

Ship-time knowledge synthesis (#3519), run at/after `ship` or `summit`:
1. Inputs: shipped phases' CONTEXT.md locked decisions, PLAN.md outcomes,
   LEDGER.md, decision/constraint cards in scope.
2. Outputs into `docs/`:
   - `ARCHITECTURE.md` — per-section merge for what structurally changed;
     never clobbers hand-written content; conflicts flagged to the user.
   - `docs/adr/NNNN-<slug>.md` — one ADR per locked decision that shaped
     code, provenance-linked to commits.
   - `CHANGELOG.md` — entries from ledger summaries, grouped by phase.
3. Sanitization gate: every generated file passes the `leak-patterns.mjs`
   CLI before write — internal refs rewritten to public-safe form (tracker
   ids → plain prose, phase refs → milestone/version names). Output must
   read as if the repo never had planning scaffolding.
4. Nothing commits without a shown diff summary — one batched
   confirmation.

### `tune [key] [value]`

- Bare: `config_get` → effective config grouped (tracker / agents /
  memory / continuity / leakGuard), defaults marked; ONE AskUserQuestion
  batch for the chosen group; writes via `config_set`.
- `tune <key> <value>`: direct dot-path `config_set`
  (`tune continuity.resume auto`); echo old → new.
- `tune leakguard off|on` is the guard's front door.
- Secrets refused server-side; the verb explains where creds actually go
  (env vars).

## 6. Testing (three rings)

1. **Unit:** card schema (`note`, confidence round-trip; `mem_card_update`
   frontmatter-only + id stability + NOT_FOUND); banner shows confidence,
   stays byte-identical across two renders; `config_get` post-defaults
   view; `config_set` merge/null-delete/invalid-leaves-file-untouched/
   secret-refusal; leak-patterns matrix (every class hits; allowlist
   skips; GitHub `#N` does NOT match); hook spawned against fixture repos —
   blocks staged `.cairn/` leak (exit 2 + listing), passes clean staging,
   ignores non-commit commands, honors `CAIRN_LEAK_OK=1` and
   `leakGuard.enabled: false`, <100ms timing (hooks.test.ts harness).
2. **Contract/CI:** check-surface ratchets to **23 live / 5 reserved / 36
   tools**; dangling-reference scan covers hook #4 + new verb docs;
   hooks.json includes the new hook.
3. **Dogfood drills** (VERIFICATION.md, PENDING until run live):
   - **Mark drill:** three kinds → one tool call each, zero questions;
     backlog/seed issues appear bare on the real tracker; note card
     recallable.
   - **Leak drill:** staged source file with a `.cairn/` path + real
     tracker id → commit through Claude blocked with listing; fixed →
     passes; `CAIRN_LEAK_OK=1` overrides; `tune leakguard off` disables.
   - **Retro drill:** against a real completed phase — cards written with
     provenance + confidence; a planted wrong prior card down-ranked via
     `mem_card_update`.
   - **Distill drill:** post-summit on a scratch project — docs generated,
     zero leak-pattern hits in output (mechanically scanned), ADRs trace to
     locked decisions.

## Non-goals

- Taste profile / confidence-based recall ranking (Tier E).
- `triage` (Tier D).
- Git-native pre-commit installer (future `tune` offering).
- Seed auto-firing daemons.

## Success criteria

1. Mark capture is one tool call, no interview — real tracker for
   backlog/seed, card store for note.
2. Leak guard blocks a real staged leak in <100ms; both escape hatches
   work.
3. A card's confidence changes because of what a later phase proved —
   demonstrated live via `retro`.
4. Distill output contains zero internal refs, proven by the same scanner
   the hook uses.
5. Tune round-trips any legal config change; invalid input can never
   corrupt `cairn.json`.
6. CI surface check green at 23 live / 5 reserved / 36 tools.
