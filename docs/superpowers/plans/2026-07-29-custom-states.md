# Custom Status Vocabulary — Widened IssueState (CRN-26) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issues carry their real workflow state name ("In Review", "Blocked") with full fidelity, custom states are writable per backend config, and every cairn mechanism keeps working — because a semantic **category** rides underneath (CRN-26, widened-IssueState variant, locked decision).

**Architecture:** `Issue.state` widens to `string` (native/custom display name) and `Issue.category: StateCategory` (`open | in_progress | closed`) is added — the bucket ALL machinery keys off (drift, ship gate, ready frontier, mirror, migrate, filters). Adapters derive category from native semantics (Jira status category, Linear state type, GitHub/GitLab binary) or config (`categories` block on azure/clickup/local). Writes: the canonical three always work everywhere (existing paths); custom names resolve per backend — Jira fires the named transition, Linear matches a team workflow state, azure/clickup map through config extras, local stores verbatim; backends with no custom-state surface throw `CONFIG_INVALID` with guidance.

**Tech Stack:** TypeScript ESM, vitest. No new dependencies. No new tools (issue_update/issue_list schemas widen in place).

## Global constraints

- **Category is the semantic API.** Nothing mechanical may compare `state` to a literal after this branch — the sweep converts every `.state === "closed"`-style site to `.category`. `state` is for humans and fidelity.
- **Canonical compat:** `updateIssue({state: "open" | "in_progress" | "closed"})` behaves byte-identically to today on every backend.
- **Read fallback:** where a backend exposes no display name, `state` falls back to the category string — existing fixtures and downstream text stay stable.
- Unknown custom name on write → `CONFIG_INVALID` naming the config surface to extend, never a silent no-op.
- Migration carries fidelity with a safety net: try the source's state name on the destination, fall back to the category (warning) when the destination doesn't know it.

---

### Task 1: Category plumbing — types, adapters, machinery sweep

**Files:**
- Modify: `server/src/tracker/types.ts` (`StateCategory`, `Issue.state: string` + `Issue.category`, `IssuePatch.state: string`), all 8 adapters + `fake.ts` + `cached.ts` (category derivation; `state` = native display name ?? category), `server/src/tracker/graph.ts`, `server/src/tracker/migrate.ts`, `server/src/planning/collab.ts`, `server/src/planning/mirror.ts`, `server/src/planning/milestones.ts`, `server/src/planning/tracker-delta.ts`, `server/src/index.ts` (StateEnum → string for update; list filter matches category OR name)
- Test: contract + unit sweeps — canonical assertions move to `category`; new asserts that Jira surfaces `status.name` as `state`

- [ ] **Step 1: Failing tests.** contract: create → `category: "open"`; close → `category: "closed"`; `state` is a non-empty string. jira unit: fixture with `status: { name: "In Review", statusCategory: { key: "indeterminate" } }` → `state: "In Review"`, `category: "in_progress"`; fixtures without a name fall back to the category string. list filter: `state: "closed"` matches by category; `state: "In Review"` matches by name.
- [ ] **Step 2: Run — red.**  **Step 3: Implement** (mechanical sweep; grep gate: no `\.state [!=]== "` outside adapters when done).  **Step 4: Green + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): widen IssueState — real state names + semantic category everywhere`

### Task 2: Custom-state writes per backend

**Files:**
- Modify: `server/src/tracker/adapters/jira.ts` (transitions map takes arbitrary keys; unknown key falls through to transition-by-name), `linear.ts` (match team workflow state by name, category from its type), `azure-boards.ts` + `clickup.ts` (map extras + shared `categories` config block for read-back), `local.ts` (`states` vocab config: name → category; store verbatim), `fake.ts` (vocab option for contract determinism), `github.ts`/`gitlab.ts`/`asana.ts` (custom name → CONFIG_INVALID with guidance)
- Test: per-adapter units (write "review" → mapped native call; unknown → CONFIG_INVALID; read-back category correct), contract addition (custom vocab roundtrip on fake/local)

- [ ] Red → green + tsc.
- [ ] **Commit** `feat(tracker): custom status vocabulary — per-backend config, category-safe (CRN-26)`

### Task 3: Config schemas, docs, dist

**Files:** config examples (`templates/cairn.json.example` — jira transitions with a `review` key, local `states` vocab), `docs/01-runbook.md` (state-mapping row + a Custom States subsection: fidelity vs category, per-backend surface), `server/README.md`, verb text touch (`status.md` renders `state` name with category grouping unchanged), rebuild dist.

- [ ] Sweep + commit `docs: custom status vocabulary — config surface + category model`

## Verification (gate)

- Full suite + tsc + check-surface + dist freshness.
- Live smoke on CRN (real Jira): issues read back with their real status names ("To Do" / "In Progress" / "Done") and correct categories; a `review: "In Progress"` transitions-map alias written as `state: "review"` lands on the board's real column; canonical close still closes. Scratch issue, closed after.
- Comment + close CRN-26 on merge.
