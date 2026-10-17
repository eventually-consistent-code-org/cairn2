# Jira Sprint Awareness + Estimation Fields (CRN-30, CRN-35) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrum boards get sprint-aware issue creation (CRN-30) and every backend that can carry estimates gets story points + original time estimates populated at plan time (CRN-35) — burndown/velocity/workload reports stop being empty.

**Architecture:** One SPI extension (`estimate?: { points?, minutes? }` on create/patch/read + `Capability.hasEstimates`), implemented on Fake (contract stand-in), Jira (story-point custom field discovered lazily + `timetracking.originalEstimate`), and Local (frontmatter, carried through migration). Sprint awareness is Jira-adapter-internal: lazy board-type detection via the Agile API, best-effort active-sprint assignment on create — never aborts a create.

**Tech Stack:** TypeScript ESM, vitest, fixture-fetch mocks. No new dependencies. Live smoke possible: CRN space is a real scrum board with creds available.

## Global constraints

- Sprint assignment is best-effort: any Agile-API failure logs one stderr warning and the create still succeeds. Kanban boards and boardless projects are byte-identical to today.
- Estimates are silently ignored by adapters with `hasEstimates: false` (assignee precedent) — callers never need capability checks to write.
- Jira story-point field id varies per site ("Story point estimate" team-managed, "Story Points" company-managed) — discovered once via `/rest/api/3/field`, cached per instance; not found → skip points with one stderr warning, minutes still write.
- Epics (cairn phases) are never sprinted.

---

### Task 1: SPI estimates — types, fake, contract

**Files:**
- Modify: `server/src/tracker/types.ts`, `server/src/tracker/fake.ts`, all 7 other adapters (declare `hasEstimates`), `server/test/contract.ts`

**Interfaces (later tasks consume):**

```ts
export interface IssueEstimate { points?: number; minutes?: number }
// Capability += hasEstimates: boolean
// IssueCreate/IssuePatch += estimate?: IssueEstimate
// Issue += estimate?: IssueEstimate  (readback where the backend can)
```

- [ ] Contract test: create with `{points: 3, minutes: 90}` → getIssue returns it when `hasEstimates`; update replaces it. Fake: flag true, store/patch/readback. Adapters gitub/gitlab/asana/azure-boards/clickup/linear: flag false (ignore silently); jira/local false here, flipped in their tasks.
- [ ] Red → implement → green; full suite + tsc.
- [ ] **Commit** `feat(tracker): estimate fields on the SPI — points + minutes, capability-gated`

### Task 2: Jira sprint awareness (CRN-30)

**Files:** `server/src/tracker/adapters/jira.ts`, `server/test/jira.unit.test.ts`

- [ ] Failing tests: config gains optional `boardId`; lazy board resolve (`GET /rest/agile/1.0/board?projectKeyOrId=`) cached; scrum board + active sprint (`GET .../board/{id}/sprint?state=active`) → after issue POST, `POST /rest/agile/1.0/sprint/{id}/issue {issues:[key]}`; kanban → no agile calls beyond board detect; no board / agile 4xx → warning, create still returns; epics never sprinted; board+sprint cached across creates.
- [ ] Red → implement → green + tsc.
- [ ] **Commit** `feat(jira): scrum-board awareness — creates land in the active sprint (CRN-30)`

### Task 3: Jira estimates (CRN-35)

**Files:** same two.

- [ ] Failing tests: story-point field discovery (`GET /rest/api/3/field` → name match "Story point estimate" | "Story Points") cached; create/update with estimate writes `{[custom]: points, timetracking: {originalEstimate: "<m>m"}}`; readback maps custom field + `timetracking.originalEstimateSeconds` into `issue.estimate`; field-not-found → points skipped with warning, minutes written; `hasEstimates: true`.
- [ ] Red → implement → green + tsc.
- [ ] **Commit** `feat(jira): story points + original estimates on the SPI estimate fields (CRN-35)`

### Task 4: Local estimates + migration carry

**Files:** `server/src/tracker/adapters/local.ts`, `server/src/tracker/migrate.ts`, `server/test/local.unit.test.ts`, `server/test/migrate.test.ts`

- [ ] Failing tests: frontmatter `points:` / `minutes:` fields (spaced-frontmatter idiom), create/patch/readback, `hasEstimates: true`; migrate carries `estimate` to the destination create (seed local issue with estimate → dst receives it).
- [ ] Red → implement → green + tsc.
- [ ] **Commit** `feat(local): estimates in issue frontmatter — stored, read back, migrated`

### Task 5: Tools + verb + docs

**Files:** `server/src/index.ts` (`issue_create`/`issue_update` gain `estimatePoints`/`estimateMinutes`), `skills/cairn-trailhead/verbs/plan.md` (estimate at issue-creation time: points from task complexity, minutes realistic — quick 1-2pt, standard 3-5, deep 8+), `docs/01-runbook.md` (capability table row, Jira section: boardId + sprint behavior + estimate fields), `server/README.md` (matrix note), rebuild `server/dist`.

- [ ] Tests: mcp pins unchanged (70), tool accepts estimate params and forwards.
- [ ] **Commit** `feat(server): estimate params on issue tools; plan verb estimates at creation — docs`

## Verification (gate)

- Full suite + tsc + `check-surface.mjs` + dist freshness.
- Live smoke against the real CRN scrum board (creds present): scratch-titled issue via the adapter → lands in the active sprint (or backlog if none live), story points + original estimate visible on the issue; close scratch issue after. This validates the two riskiest unknowns: the site's story-point field id and the sprint-assign endpoint.
- Comment + close CRN-30 and CRN-35 on merge.
