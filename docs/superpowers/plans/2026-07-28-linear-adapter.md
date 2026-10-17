# Linear Tracker Adapter (CRN-23) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Linear as the eighth tracker backend — every cairn verb works against a Linear team unchanged, behind the normalized Tracker SPI + contract suite (CRN-23).

**Architecture:** One GraphQL adapter (`server/src/tracker/adapters/linear.ts`) speaking to `https://api.linear.app/graphql` with a personal API key (`Authorization: <key>`, no Bearer). Lazy per-instance caches for the team's workflow states (stateId by type), label name→id, and org project statuses. Cairn phase → Linear **Project** (locked decision); links are **native for blocks / relates-to / parent-of, UNSUPPORTED for supersedes** (locked decision) — first hosted adapter with real link methods.

**Tech Stack:** TypeScript ESM, vitest, fixture-fetch mocks (asana pattern). No new dependencies. No live creds available (`LINEAR_API_KEY` unset) — live contract test is env-gated like github/asana.

## Capability matrix (honest)

| capability | value | mapping |
|---|---|---|
| hasInProgress | true | team workflow state of type `started` |
| hasPhases | true | Linear Project (`projectId` on issues) |
| hasPhaseClose | true | `projectUpdate` → org project status of type `completed` |
| hasDependencies | true | issue relations (`blocks`/`related`) + native parent |
| hasLabels | true | team labels, find-or-create by name |
| hasMilestones | false | no workspace-level milestone mapping |
| hasComments | true | `commentCreate` |
| hasWorklog | false | Linear has no time tracking |

## Global constraints

- Public issue id = Linear `identifier` (e.g. `ENG-123`) — human-diffable like Jira keys. Mutations that need UUIDs resolve identifier → UUID via `issue(id:)` first (also gives free NOT_FOUND).
- State writes always go through the cached team-state lookup; normalize reads from `state.type`: `completed|canceled`→closed, `started`→in_progress, else open.
- `updateIssue(labels)` replaces the full label set (`labelIds`), matching SPI patch semantics.
- Cycle rejection on `blocks` happens adapter-side (DFS over `listLinks()` blocks edges) — the contract requires `CONFIG_INVALID`, Linear itself won't reject.
- `supersedes` → `UNSUPPORTED` CairnError; `relates-to` maps to Linear `related`; incoming `duplicate` relations are ignored on read.
- List reads cap at 100 with the standard truncation `console.error` (asana idiom).

---

### Task 1: Adapter core — config, gql helper, issue CRUD, states + labels

**Files:**
- Create: `server/src/tracker/adapters/linear.ts`
- Test: `server/test/linear.unit.test.ts` (create)

- [ ] **Step 1: Failing tests.** Fixture-fetch (GraphQL: one endpoint, assert on parsed `body.query`/`body.variables`): auth header is raw key (no Bearer); AUTH_MISSING before any HTTP when env unset; `configSchema` defaults `apiKeyEnv: "LINEAR_API_KEY"`; createIssue resolves labels (find via team labels query, create missing via `issueLabelCreate`) then `issueCreate` with `teamId/title/description/labelIds/projectId`; getIssue normalizes identifier/state.type/labels/project/updatedAt/url; updateIssue maps state→stateId via cached team states (one states query, then reused); closeIssue = state closed; listIssues filters team + optional project, client-side state filter, truncation warn at 100; GraphQL `errors` array → typed CairnError (entity-not-found → NOT_FOUND).
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement.** `configSchema { teamId: z.string().min(1), apiKeyEnv: z.string().default("LINEAR_API_KEY") }`; `make(config, fetchImpl?)`; class with `gql(query, variables, context)` → fetchJson + errors-array mapping; lazy `states()`, `labelIds(names)` caches.
- [ ] **Step 4: Run — green; full suite + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): Linear adapter core — issue CRUD over GraphQL with state/label caches`

### Task 2: Phases as Projects, comments, milestones-unsupported

**Files:** same two.

- [ ] **Step 1: Failing tests.** createPhase → `projectCreate(input:{name, teamIds:[teamId]})`; listPhases → team projects with state normalize (completed/canceled→closed); closePhase → org `projectStatuses` lookup (type completed) then `projectUpdate(statusId)`; commentIssue resolves identifier→UUID then `commentCreate`; milestones throw UNSUPPORTED via `milestonesUnsupported("linear")`.
- [ ] **Step 2: Run — red.**  **Step 3: Implement.**  **Step 4: Green + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): Linear phases as Projects — create/list/close, comments`

### Task 3: Links — first hosted adapter with real link methods

**Files:** same two.

- [ ] **Step 1: Failing tests.** linkIssues blocks → resolve both UUIDs + `issueRelationCreate(type:"blocks")`; relates-to → `type:"related"`; parent-of → `issueUpdate(to, {parentId: fromUuid})`; supersedes → UNSUPPORTED; nonexistent target → NOT_FOUND before relation call; cycle (b blocks a after a blocks b) → CONFIG_INVALID with no mutation call; listLinks(id) merges relations + inverseRelations + parent/children into `IssueLink[]` (duplicate relations ignored); listLinks() walks team issues; unlinkIssues blocks → find relation id then `issueRelationDelete`, parent-of → `parentId: null`.
- [ ] **Step 2: Run — red.**  **Step 3: Implement.**  **Step 4: Green + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): Linear native issue links — blocks/related/parent, cycle-safe`

### Task 4: Wiring — config enum, registry, migrate target, live gate

**Files:**
- Modify: `server/src/config.ts` (type enum + "linear"), `server/src/tracker/registry.ts` (ADAPTER_PATHS), `server/src/index.ts` (`tracker_migrate` targetType enum)
- Create: `server/test/linear.live.test.ts` (contract suite, env-gated on `LINEAR_API_KEY` + `CAIRN_TEST_LINEAR_TEAM`)
- Test: config accepts `type: "linear"`; registry resolves it; mcp pins unchanged (70 tools).

- [ ] Red → green → full suite + tsc.
- [ ] **Commit** `feat(server): linear is a first-class tracker type — config, registry, migrate target`

### Task 5: Docs

**Files:** `docs/01-runbook.md` (tracker.type row + linear config example), `server/README.md` (adapter matrix row + live-test section), `templates/cairn.json.example`, `skills/cairn-trailhead/verbs/new.md` (setup offering, if it enumerates backends).

- [ ] Sweep + commit `docs: linear backend — eighth adapter, config + capability notes`

## Verification (gate)

- Full suite + typecheck green; `scripts/check-surface.mjs` clean.
- Live contract run deferred until a `LINEAR_API_KEY` exists — README marks linear "⏳ implemented, live pending credentials" (clickup precedent). Project-status close (`projectUpdate.statusId`) is the riskiest unverified mapping; note it in the README row.
- Comment completion on CRN-23; close on merge.
