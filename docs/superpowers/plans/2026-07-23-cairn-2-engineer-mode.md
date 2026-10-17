# Engineer Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `user.mode: vibe | engineer` posture switch — work pairing, no-self-merge review gate, decision surfacing — per `docs/superpowers/specs/2026-07-23-cairn-2-engineer-mode-design.md`.

**Architecture:** One config key in the server's zod schema; everything else is verb-doc policy branching on that key. No new tool, verb, or command shim. Depends on the tracker-mirror fidelity plan (paper trail + delta ingest) being merged first — human-claimed work rides both.

**Tech Stack:** TypeScript (one zod schema line + test), markdown verb docs, vitest.

## Global Constraints

- Default is `vibe` — a `cairn.json` without the key behaves exactly as today; every doc edit below must be inside an "engineer mode only" guard.
- No new verb, no new command shim, no new server tool.
- `node scripts/check-surface.mjs` passes after every verb-doc task.
- Comments cairn writes about human-claimed work identify themselves: "logged by cairn for <handle>".

---

### Task 1: Config key `user.mode`

**Files:**
- Modify: `server/src/config.ts:18`
- Test: `server/test/config.test.ts` (extend; if that file doesn't exist, add the cases to whichever existing test file exercises the config schema — find it with `grep -rl "user" server/test | xargs grep -l handle`)

**Interfaces:**
- Produces: `user.mode?: "vibe" | "engineer"` on `CairnConfig`, settable via the existing `config_set` dot-path flow (`tune mode engineer` → `{user: {mode: "engineer"}}`). Absent key ≡ `"vibe"`.

- [ ] **Step 1: Write the failing test**

```ts
it("accepts user.mode engineer and vibe, rejects others", () => {
  const base = { user: { handle: "jr", mode: "engineer" } };
  expect(configSchema.safeParse({ ...valid, ...base }).success).toBe(true);
  base.user.mode = "vibe";
  expect(configSchema.safeParse({ ...valid, ...base }).success).toBe(true);
  base.user.mode = "yolo" as never;
  expect(configSchema.safeParse({ ...valid, ...base }).success).toBe(false);
});

it("user.mode is optional", () => {
  expect(configSchema.safeParse({ ...valid, user: { handle: "jr" } }).success).toBe(true);
});
```

(`valid` = the minimal passing config object the surrounding tests already
use; reuse their fixture name.)

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/config.test.ts` (or the file found above)
Expected: FAIL — unknown key `mode` (schema is a strict object) or enum mismatch.

- [ ] **Step 3: Implement — `config.ts:18` becomes**

```ts
  user: z.object({
    handle: z.string().min(1),
    mode: z.enum(["vibe", "engineer"]).optional(),
  }).optional(),
```

Note: `handle` stays required inside the block — engineer mode needs an
identity to assign human-claimed issues to, so `tune mode engineer`
without a handle fails loudly at the schema (`CONFIG_INVALID`), which is
the correct behavior; the `tune` doc (Task 2) tells the user to set both.

- [ ] **Step 4: Run tests, then full suite**

Run: `cd server && npm run build && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/test/
git commit -m "feat(config): user.mode vibe|engineer key"
```

---

### Task 2: Mode setting surface — `tune`, `new`, `profile` docs

**Files:**
- Modify: `skills/cairn-trailhead/verbs/tune.md`
- Modify: `skills/cairn-trailhead/verbs/new.md`
- Modify: `skills/cairn-trailhead/verbs/profile.md`

- [ ] **Step 1: `tune.md` — add a bullet after the `tune leakguard` bullet**

```markdown
- `tune mode vibe|engineer` = `config_set({user: {mode: <value>}})` — the
  collaboration posture switch. Engineer mode requires `user.handle`
  (assignment identity); the server rejects the combination without it —
  when that happens, ask for the handle and set both in one patch.
```

- [ ] **Step 2: `new.md` — extend interview step 2**

Append to step 2's text:

```markdown
   The interview also asks the mode once (skip when cairn.json already
   sets `user.mode`): vibe — cairn drives end-to-end (default) — or
   engineer — you claim issues, write code, and make the design calls;
   cairn pairs, verifies, and keeps the tracker mirror honest for both.
   Engineer chosen → collect the tracker handle too and set both via
   `config_set` in one patch.
```

- [ ] **Step 3: `profile.md` — one line in "Infer first, ask only what's left"**

Append to item 3 (the batched-question item):

```markdown
   When `user.mode` is unset in cairn.json, fold the vibe/engineer mode
   choice into the same batch (writes via `config_set`, not the profile
   file — mode is workflow state, not tone calibration).
```

- [ ] **Step 4: Check + commit**

Run: `node scripts/check-surface.mjs` — Expected: clean.

```bash
git add skills/cairn-trailhead/verbs/
git commit -m "docs(verbs): mode setting via tune/new/profile"
```

---

### Task 3: `work.md` — pairing split

**Files:**
- Modify: `skills/cairn-trailhead/verbs/work.md`

- [ ] **Step 1: Add the engineer-mode section**

Insert directly after the frontmatter's opening line ("Execute the given
phase per the `cairn-planning` skill."):

```markdown
**Mode check:** read `user.mode` from cairn.json (`config_get`). Absent or
`vibe` → the procedure below runs exactly as written. `engineer` → the
pairing overlay applies:

- After step 1's issue list, ask "mine or yours?" ONCE for the whole
  wave/phase — one AskUserQuestion listing the issues, the user marks
  which they're taking. Never per-issue friction.
- **cairn-claimed** issues run the unchanged lifecycle below, except the
  finished work lands as a branch/PR and does NOT merge — the close
  comment links the PR and names the human as reviewer (no-self-merge
  gate; `ship` enforces it).
- **human-claimed** issues: cairn scaffolds and steps back — create the
  branch, move the issue to in_progress with `assignee: <user.handle>`,
  and post the claim comment carrying the context: the PLAN.md task text,
  files likely touched, and (for `tdd:` issues) the failing test written
  first. Then wait — do not write further code for that issue.
- **Human says done** (or `resync`/`plan_tracker_delta` shows their
  commits landed): run the tests and the phase's verify posture against
  their work, then the standard close — close comment with evidence and
  approximate time ("logged by cairn for <handle>"),
  `issue_close(timeSpentMinutes: ...)`, ledger entry with their commit
  range. Offer `/cairn:review` on their diff — offer, not force; a
  decline is recorded in the close comment as "review declined".
- Wave ordering, TDD gates, and the failed-issue stop rule apply
  identically regardless of who holds an issue.
```

- [ ] **Step 2: Check + commit**

Run: `node scripts/check-surface.mjs` — Expected: clean.

```bash
git add skills/cairn-trailhead/verbs/work.md
git commit -m "docs(work): engineer-mode pairing overlay"
```

---

### Task 4: No-self-merge gate — `auto.md`, `ship.md`

**Files:**
- Modify: `skills/cairn-trailhead/verbs/auto.md`
- Modify: `skills/cairn-trailhead/verbs/ship.md`

- [ ] **Step 1: `auto.md` — engineer-mode stop condition**

Append to step 3's HARD STOPS list:

```markdown
   Engineer mode (`user.mode: engineer`) adds one more: a completed
   cairn-authored issue whose PR awaits human review is a natural stop —
   auto never merges its own work past a human gate. The run report
   lists the waiting PRs.
```

- [ ] **Step 2: `ship.md` — gate addition**

Insert as a new step between the current steps 2 and 3 (renumber the
current step 3 to 4):

```markdown
3. Engineer mode only (`user.mode: engineer` in cairn.json): no
   cairn-authored PR may still be awaiting human review — list any that
   are and stop. Human review is the merge gate; ship never overrides it.
```

- [ ] **Step 3: Check + commit**

Run: `node scripts/check-surface.mjs` — Expected: clean.

```bash
git add skills/cairn-trailhead/verbs/auto.md skills/cairn-trailhead/verbs/ship.md
git commit -m "docs(verbs): engineer-mode no-self-merge gate in auto/ship"
```

---

### Task 5: Decision surfacing — trailhead shared rule

**Files:**
- Modify: `skills/cairn-trailhead/SKILL.md` (Shared rules section)

- [ ] **Step 1: Add one shared rule bullet**

Append to the "Shared rules (inherited by every subroutine)" list:

```markdown
- **Decision surfacing (engineer mode).** When `user.mode: engineer`, a
  genuine design fork — multiple defensible shapes with meaningful
  trade-offs — stops for the user: one AskUserQuestion per fork, options
  with trade-offs, cairn's recommendation first. Boilerplate, mechanical
  edits, and obvious implementations stay automatic; the bar is "would a
  peer have wanted a say," not "is this a decision." Vibe mode (default):
  unchanged — judgment calls resolve silently.
```

- [ ] **Step 2: Check + commit**

Run: `node scripts/check-surface.mjs` — Expected: clean (the shared-rules
section isn't table-parsed; the routing table is untouched).

```bash
git add skills/cairn-trailhead/SKILL.md
git commit -m "docs(trailhead): engineer-mode decision-surfacing shared rule"
```

---

### Task 6: Dogfood checklist

**Files:**
- Modify: `VERIFICATION.md` (append)

- [ ] **Step 1: Append**

```markdown
## Engineer mode — dogfood checklist (pending live pass)

- [ ] `tune mode engineer` without a handle fails CONFIG_INVALID, then
      succeeds when handle+mode are set together.
- [ ] `work` on a 2-issue phase asks "mine or yours?" once; one issue
      each way.
- [ ] Human-claimed issue: branch + claim comment with context appear;
      cairn writes no code for it; after human commits land, cairn runs
      tests, closes with "logged by cairn for <handle>" + time, offers
      review.
- [ ] cairn-claimed issue lands as an unmerged PR; `ship` stops while it
      awaits review; passes after human merge.
- [ ] A config without user.mode: all verbs behave exactly as before
      (vibe default).
```

- [ ] **Step 2: Full gate + commit**

Run: `cd server && npm run build && npm test && cd .. && node scripts/check-surface.mjs`
Expected: all green.

```bash
git add VERIFICATION.md
git commit -m "docs: engineer-mode dogfood checklist"
```

---

## Self-review notes (done)

- Spec coverage: config mechanism (T1), setting surface tune/new/profile
  (T2), pairing (T3), no-self-merge + review-offer (T3 close path + T4),
  decision surfacing (T5), backward-compat + dogfood (T6, T1 optional
  test). Deferred items (plan posture, TDD handoff) intentionally absent.
- The review-offer on human-claimed close lives in T3's work.md overlay
  (single home) rather than review.md — review.md needs no edit; it's
  invoked, not changed.
- Names consistent: `user.mode`, `"vibe" | "engineer"`, `user.handle`
  used identically across tasks and matching `config.ts:18`.
