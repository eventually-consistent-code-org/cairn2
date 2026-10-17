# Cairn 2.0 — Tier A: Planning Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six new live verbs (`scout route summit auto fast resync`) + flag richness on `plan`/`work`, backed by tracker-native milestones with capability fallback, out-of-band commit detection, wave/TDD plan metadata, and TDD commit evidence in the ledger. Spec: `docs/superpowers/specs/2026-07-18-cairn-2-tier-a-planning-depth.md`.

**Architecture:** Mechanism-first, two stages. Stage 1 (Tasks 1–9) is one server sweep: `Milestone` + `closePhase` land in the `Tracker` interface with `hasMilestones`/`hasPhaseClose` capabilities (native: Jira fixVersions, Azure Epics; phase-close native: GitHub/GitLab/Jira); a `milestones.ts` planning module owns the summit orchestration; `resync.ts` owns ledger-coverage math (first read-only git use in the server); `plan_meta_set` owns wave/TDD frontmatter. Five new tools, 28 → 33. Stage 2 (Tasks 10–15) is the plugin surface: routing-table sweep, six verb subroutines, flag updates to `plan`/`work`, policy additions to `cairn-planning`.

**Tech Stack:** TypeScript 5, Node ≥ 20, zod, vitest, `@modelcontextprotocol/sdk` — as P0–A0. No new dependencies.

## Global Constraints

- Base branch: `main`. Paths repo-relative. Conventional commits, one per task.
- Green before every commit: `cd server && npx vitest run && npx tsc --noEmit`. From Task 10 on, also `node scripts/check-surface.mjs`.
- New tools named EXACTLY: `milestone_create`, `milestone_list`, `milestone_complete`, `plan_resync`, `plan_meta_set`. Tool count 28 → 33.
- New error codes EXACTLY: `UNSUPPORTED`, `PRECONDITION_FAILED` (added to `ErrorCode`).
- `Milestone.state` is EXACTLY `"open" | "released"`. Capabilities added EXACTLY: `hasMilestones`, `hasPhaseClose`.
- Native milestone backends this tier: Jira (fixVersions), Azure Boards (Epic). GitHub, GitLab, Asana, ClickUp: `hasMilestones: false`. Phase-close native: GitHub, GitLab, Jira; Azure/Asana/ClickUp: `hasPhaseClose: false` (their phase primitives have no closed state — recorded skips, never fake closes).
- Server may READ git (`execFileSync("git", …)` in `resync.ts`); server never WRITES git (no add/commit/tag) — tagging/committing stays agent-side in verbs.
- Roadmap frontmatter keys EXACTLY: `milestone` (int ≥ 1, default 1), `milestone_id` (string), `last_resync` (sha). PLAN.md meta keys EXACTLY: `wave_1`, `wave_2`, … (contiguous from 1) and `tdd`. All frontmatter writes go through server functions — never hand-edit.
- `plan_resync` is project-level (no phase param): a commit ledgered in ANY phase is covered. Coverage math is inherently project-wide.
- Live verbs after Tier A EXACTLY: `plan work verify ship status new import remember recall help do waypoint scout route summit auto fast resync` (18). Reserved EXACTLY: `probe`(C) `draft`(C) `mark retro distill brief tune`(B) `trace`(C) `triage`(D) `basecamp`(F) (10).
- Subroutine frontmatter stays exactly three fields (`verb`, `args`, `status: live`). Batch related questions in ONE AskUserQuestion everywhere (#1010).
- Every new/modified file location verified against this plan's file list at review time (P3 lesson).
- Dist rebuilt + committed at the end of each stage (A7 policy): Task 9 and Task 15.

## File Structure (end state)

```
server/src/
  errors.ts                       # +UNSUPPORTED, +PRECONDITION_FAILED
  tracker/
    types.ts                      # +Milestone, +closePhase, +milestone methods, +2 capabilities
    unsupported.ts                # new — throwing stubs for non-native backends
    fake.ts cached.ts             # implement the new surface
    adapters/{github,gitlab,jira,asana,azure-boards,clickup}.ts
  planning/
    milestones.ts                 # new — roadmap meta + summit orchestration
    resync.ts                     # new — ledger-coverage math over git log
    artifacts.ts                  # +readPlanMeta/writePlanMeta
    ledger.ts                     # +redCommit/greenCommit
  index.ts                        # +5 tools (33 total)
server/test/
  milestones.test.ts resync.test.ts   # new
  (extended: contract.ts, cache.test.ts, jira.unit.test.ts,
   azure-boards.unit.test.ts, github.unit.test.ts, gitlab.unit.test.ts,
   asana.unit.test.ts, clickup.unit.test.ts, artifacts.test.ts,
   ledger.test.ts, mcp.test.ts)
skills/cairn-trailhead/
  SKILL.md                        # 6 rows → live; probe/draft → reserved-C
  verbs/{scout,route,summit,auto,fast,resync}.md   # new
  verbs/{plan,work}.md            # flag updates
skills/cairn-planning/SKILL.md    # --mvp policy, TDD eligibility rubric
scripts/check-surface.mjs         # SPEC_RESERVED + TOOL_PREFIXES updates
server/README.md  VERIFICATION.md
```

---

## Stage 1 — server sweep

### Task 1: Interface sweep — Milestone, closePhase, capabilities, fake/cached/contract

**Files:**
- Modify: `server/src/errors.ts`, `server/src/tracker/types.ts`, `server/src/tracker/fake.ts`, `server/src/tracker/cached.ts`
- Create: `server/src/tracker/unsupported.ts`
- Modify (compile-green stubs): all six `server/src/tracker/adapters/*.ts`
- Test: `server/test/contract.ts`, `server/test/cache.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export interface Milestone {
    id: string; name: string; state: "open" | "released"; url?: string;
  }
  // on Capability:
  hasMilestones: boolean; hasPhaseClose: boolean;
  // on Tracker:
  closePhase(id: string): Promise<Phase>;
  createMilestone(name: string): Promise<Milestone>;
  listMilestones(): Promise<Milestone[]>;
  completeMilestone(id: string): Promise<Milestone>;
  ```
- Produces (unsupported.ts):
  ```ts
  import { CairnError } from "../errors.js";
  export function milestonesUnsupported(backend: string): never {
    throw new CairnError("UNSUPPORTED",
      `${backend} adapter has no native milestone mapping yet`,
      "summit falls back to phase-close + git archive on this backend");
  }
  export function phaseCloseUnsupported(backend: string): never {
    throw new CairnError("UNSUPPORTED",
      `${backend} phase primitive has no closed state`,
      "milestone_complete records this as a skipped phase close");
  }
  ```
- Errors: `ErrorCode` union gains `"UNSUPPORTED" | "PRECONDITION_FAILED"`.

- [ ] **Step 1: Write failing contract tests** — append to the `describe` block in `server/test/contract.ts`:

```ts
    it("closePhase closes when hasPhaseClose; throws UNSUPPORTED otherwise", async () => {
      const p = await t.createPhase(`contract phase close ${Date.now()}`);
      if (t.capabilities.hasPhaseClose) {
        const closed = await eventually(async () => {
          const r = await t.closePhase(p.id);
          expect(r.state).toBe("closed");
          return r;
        });
        expect(closed.id).toBe(p.id);
      } else {
        await expect(t.closePhase(p.id)).rejects.toMatchObject({ code: "UNSUPPORTED" });
      }
    });

    it("milestone create → list → complete when hasMilestones; throws UNSUPPORTED otherwise", async () => {
      if (!t.capabilities.hasMilestones) {
        await expect(t.createMilestone("contract m")).rejects.toMatchObject({ code: "UNSUPPORTED" });
        return;
      }
      const m = await t.createMilestone(`contract milestone ${Date.now()}`);
      expect(m.state).toBe("open");
      await eventually(async () => {
        const all = await t.listMilestones();
        expect(all.map((x) => x.id)).toContain(m.id);
      });
      const done = await t.completeMilestone(m.id);
      expect(done.state).toBe("released");
    });
```

- [ ] **Step 2: Run to verify failure** — `cd server && npx tsc --noEmit` — Expected: FAIL (`closePhase` does not exist on type `Tracker`).
- [ ] **Step 3: Implement** —
  - `errors.ts`: extend the union with `| "UNSUPPORTED" | "PRECONDITION_FAILED"`.
  - `types.ts`: add the `Milestone` interface, the two capability fields, and the four methods exactly as in Interfaces above.
  - Create `unsupported.ts` exactly as in Interfaces above.
  - `fake.ts` (capabilities gain `hasMilestones: true, hasPhaseClose: true`; add a `milestones` map):

```ts
  private milestones = new Map<string, Milestone>();

  async closePhase(id: string): Promise<Phase> {
    const p = this.phases.get(id);
    if (!p) throw new CairnError("NOT_FOUND", `not found: ${id}`);
    const next: Phase = { ...p, state: "closed" };
    this.phases.set(id, next);
    return { ...next };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const id = `FM-${++this.seq}`;
    const m: Milestone = { id, name, state: "open", url: `fake://milestone/${id}` };
    this.milestones.set(id, m);
    return { ...m };
  }

  async listMilestones(): Promise<Milestone[]> {
    return [...this.milestones.values()].map((m) => ({ ...m }));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const m = this.milestones.get(id);
    if (!m) throw new CairnError("NOT_FOUND", `not found: ${id}`);
    const next: Milestone = { ...m, state: "released" };
    this.milestones.set(id, next);
    return { ...next };
  }
```

  - `cached.ts` (import `Milestone`; writes clear the whole cache, list is cached under `"milestones"` — same shape as `listPhases`):

```ts
  async closePhase(id: string): Promise<Phase> {
    const result = await this.inner.closePhase(id);
    this.cache.clear();
    return result;
  }

  async createMilestone(name: string): Promise<Milestone> {
    const result = await this.inner.createMilestone(name);
    this.cache.clear();
    return result;
  }

  async listMilestones(): Promise<Milestone[]> {
    const key = "milestones";
    const cached = this.cache.get<Milestone[]>(key);
    if (cached) return this.clone(cached);
    const result = await this.inner.listMilestones();
    this.cache.set(key, this.clone(result));
    return result;
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const result = await this.inner.completeMilestone(id);
    this.cache.clear();
    return result;
  }
```

  - All six adapters: add `hasMilestones: false, hasPhaseClose: false` to `capabilities` and these compile-green stubs (native implementations replace them in Tasks 2–4). Each adapter imports from `../unsupported.js`:

```ts
  async closePhase(_id: string): Promise<Phase> { return phaseCloseUnsupported("<backend>"); }
  async createMilestone(_name: string): Promise<Milestone> { return milestonesUnsupported("<backend>"); }
  async listMilestones(): Promise<Milestone[]> { return milestonesUnsupported("<backend>"); }
  async completeMilestone(_id: string): Promise<Milestone> { return milestonesUnsupported("<backend>"); }
```

    (`<backend>` = `"github"`, `"gitlab"`, `"jira"`, `"asana"`, `"azure-boards"`, `"clickup"` respectively; add `Milestone` to each adapter's type import.)
- [ ] **Step 4: cached invalidation test** — append to `server/test/cache.test.ts` (match its existing FakeTracker-wrapping style):

```ts
  it("listMilestones is cached; createMilestone/completeMilestone invalidate", async () => {
    const fake = new FakeTracker();
    const t = new CachedTracker(fake);
    const m = await t.createMilestone("m1");
    expect((await t.listMilestones()).length).toBe(1);
    await t.createMilestone("m2");                       // write clears cache
    expect((await t.listMilestones()).length).toBe(2);
    await t.completeMilestone(m.id);
    expect((await t.listMilestones()).find((x) => x.id === m.id)?.state).toBe("released");
  });
```

- [ ] **Step 5: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS (contract-fake exercises the native path; contract-cached inherits).
- [ ] **Step 6: Commit** — `git commit -m "feat(server): Milestone + closePhase in Tracker interface — capabilities, fake, cached, contract"`

### Task 2: GitHub + GitLab native closePhase

**Files:**
- Modify: `server/src/tracker/adapters/github.ts`, `server/src/tracker/adapters/gitlab.ts`
- Test: `server/test/github.unit.test.ts`, `server/test/gitlab.unit.test.ts`

**Interfaces:**
- Consumes: Task 1's interface. Both adapters flip `hasPhaseClose: true` (milestone stubs stay).

- [ ] **Step 1: Failing tests** — github.unit.test.ts (uses the file's existing `fixtureFetch` helper):

```ts
  it("closePhase PATCHes the milestone closed", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { number: 3, title: "Phase 1: core", state: "closed" } },
    ]);
    const t = new GitHubTracker({ repo: "o/r" }, f, () => "tok");
    const p = await t.closePhase("3");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/milestones/3");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toMatchObject({ state: "closed" });
    expect(p).toMatchObject({ id: "3", state: "closed" });
  });
```

  gitlab.unit.test.ts (same shape as its existing fixture tests):

```ts
  it("closePhase PUTs state_event=close on the milestone", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { id: 9, title: "Phase 1: core", state: "closed" } },
    ]);
    const t = new GitLabTracker({ baseUrl: "https://gitlab.com", project: "g/p", tokenEnv: "T", extraLabels: [] }, f);
    process.env.T = "tok";
    const p = await t.closePhase("9");
    expect(calls[0].url).toContain("/milestones/9");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ state_event: "close" });
    expect(p).toMatchObject({ id: "9", state: "closed" });
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run github.unit gitlab.unit` — Expected: FAIL (UNSUPPORTED thrown).
- [ ] **Step 3: Implement** — github.ts: `hasPhaseClose: true`; replace the stub:

```ts
  async closePhase(id: string): Promise<Phase> {
    this.assertId(id);
    const raw = (await this.api("PATCH", `/repos/${this.cfg.repo}/milestones/${id}`,
      { state: "closed" })) as { number: number; title: string; state: string };
    return { id: String(raw.number), name: raw.title,
      state: raw.state === "closed" ? "closed" : "open" };
  }
```

  gitlab.ts: `hasPhaseClose: true`; replace the stub:

```ts
  async closePhase(id: string): Promise<Phase> {
    this.assertId(id);
    const raw = (await this.api("PUT", `/milestones/${id}`,
      { state_event: "close" }, "phase_close")) as GlMilestone;
    return { id: String(raw.id), name: raw.title,
      state: raw.state === "closed" ? "closed" : "open" };
  }
```

- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): native closePhase for GitHub and GitLab milestones"`

### Task 3: Jira — closePhase (epic transition) + fixVersion milestones

**Files:**
- Modify: `server/src/tracker/adapters/jira.ts`
- Test: `server/test/jira.unit.test.ts`

**Interfaces:**
- Consumes: Jira's existing `this.api(method, path, body?, context?)` and its transition machinery in `closeIssue`.
- Produces: `hasPhaseClose: true`, `hasMilestones: true`. Milestone = fixVersion: create `POST /rest/api/3/version` (numeric `projectId` resolved once from `GET /rest/api/3/project/{projectKey}`), list `GET /rest/api/3/project/{projectKey}/versions`, complete `PUT /rest/api/3/version/{id}` `{ released: true }`. `state = released ? "released" : "open"`; `url = ${baseUrl}/projects/${projectKey}/versions/${id}`.

- [ ] **Step 1: Failing tests** — jira.unit.test.ts (match its existing fixture-fetch style):

```ts
  it("createMilestone resolves projectId once then POSTs a version", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { id: "10000" } },                                   // GET project
      { status: 201, body: { id: "10001", name: "v1", released: false } },      // POST version
      { status: 201, body: { id: "10002", name: "v2", released: false } },      // POST version (cached projectId)
    ]);
    const t = makeJira(f);
    const m = await t.createMilestone("v1");
    expect(calls[0].url).toContain("/rest/api/3/project/PROJ");
    expect(calls[1].url).toContain("/rest/api/3/version");
    expect(calls[1].body).toMatchObject({ name: "v1", projectId: 10000 });
    expect(m).toMatchObject({ id: "10001", name: "v1", state: "open" });
    await t.createMilestone("v2");
    expect(calls.length).toBe(3); // no second project lookup
  });

  it("listMilestones GETs project versions; completeMilestone releases", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: [{ id: "10001", name: "v1", released: true }] },     // GET versions
      { status: 200, body: { id: "10001", name: "v1", released: true } },       // PUT version
    ]);
    const t = makeJira(f);
    const all = await t.listMilestones();
    expect(calls[0].url).toContain("/rest/api/3/project/PROJ/versions");
    expect(all[0]).toMatchObject({ id: "10001", state: "released" });
    const done = await t.completeMilestone("10001");
    expect(calls[1].method).toBe("PUT");
    expect(calls[1].body).toMatchObject({ released: true });
    expect(done.state).toBe("released");
  });

  it("closePhase delegates to the epic close transition", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: { transitions: [
        { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } } ] } },
      { status: 204, body: {} },
      { status: 200, body: { key: "PROJ-9", fields: { summary: "Phase 1: core",
        status: { statusCategory: { key: "done" } }, updated: "2026-07-18T00:00:00.000+0000" } } },
    ]);
    const t = makeJira(f);
    const p = await t.closePhase("PROJ-9");
    expect(p).toMatchObject({ id: "PROJ-9", state: "closed" });
  });
```

  (If the file lacks a `makeJira(f)` helper, add one wrapping `new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }))` with `projectKey: "PROJ"`, `baseUrl: "https://x.atlassian.net"` and the schema defaults — mirror however the existing tests construct the tracker.)
- [ ] **Step 2: Run to verify failure** — `npx vitest run jira.unit` — Expected: FAIL.
- [ ] **Step 3: Implement** — capabilities → `hasPhaseClose: true, hasMilestones: true`. Add:

```ts
  private projectId: number | undefined;

  private async resolveProjectId(): Promise<number> {
    if (this.projectId === undefined) {
      const raw = (await this.api("GET",
        `/rest/api/3/project/${this.cfg.projectKey}`, undefined,
        "jira project_get")) as { id: string };
      this.projectId = Number(raw.id);
    }
    return this.projectId;
  }

  private normalizeVersion(raw: { id: string; name: string; released?: boolean }): Milestone {
    return {
      id: raw.id, name: raw.name,
      state: raw.released ? "released" : "open",
      url: `${this.cfg.baseUrl.replace(/\/$/, "")}/projects/${this.cfg.projectKey}/versions/${raw.id}`,
    };
  }

  async closePhase(id: string): Promise<Phase> {
    // Jira phases are Epics, and Epics are issues — the close transition applies.
    const closed = await this.closeIssue(id);
    return { id: closed.id, name: closed.title, state: "closed" };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const projectId = await this.resolveProjectId();
    const raw = (await this.api("POST", "/rest/api/3/version",
      { name, projectId }, "jira milestone_create")) as
      { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }

  async listMilestones(): Promise<Milestone[]> {
    const raw = (await this.api("GET",
      `/rest/api/3/project/${this.cfg.projectKey}/versions`, undefined,
      "jira milestone_list")) as Array<{ id: string; name: string; released?: boolean }>;
    return raw.map((v) => this.normalizeVersion(v));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const raw = (await this.api("PUT", `/rest/api/3/version/${id}`,
      { released: true }, "jira milestone_complete")) as
      { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }
```

  (Import `Milestone` in the type import; remove the Task 1 stubs and the now-unused `unsupported.js` import.)
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): Jira native milestones (fixVersions) + epic closePhase"`

### Task 4: Azure Boards — Epic milestones

**Files:**
- Modify: `server/src/tracker/adapters/azure-boards.ts`
- Test: `server/test/azure-boards.unit.test.ts`

**Interfaces:**
- Consumes: the adapter's existing `this.api(method, path, body, { params?, contentType?, context })`, `this.projectPath`, `this.cfg.states`, `escapeWiql`.
- Produces: `hasMilestones: true` (`hasPhaseClose` stays `false` — iteration nodes have no closed state). Milestone = Epic work item: create via JSON-patch `POST …/workitems/$Epic`, list via WIQL (`WorkItemType = 'Epic'`) + batch GET (same two-step shape as `listIssues`), complete via JSON-patch `PATCH …/workitems/{id}` setting `System.State` to `cfg.states.closed`. `state = System.State === cfg.states.closed ? "released" : "open"`.

- [ ] **Step 1: Failing tests** (match the file's existing fixture style):

```ts
  it("createMilestone POSTs an Epic with json-patch title", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { id: 55, fields: { "System.Title": "v1", "System.State": "To Do" } } },
    ]);
    const t = makeAzure(f);
    const m = await t.createMilestone("v1");
    expect(calls[0].url).toContain("/_apis/wit/workitems/%24Epic");
    expect(calls[0].body).toEqual([{ op: "add", path: "/fields/System.Title", value: "v1" }]);
    expect(m).toMatchObject({ id: "55", name: "v1", state: "open" });
  });

  it("listMilestones WIQLs epics then batch-gets; completeMilestone patches state", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { workItems: [{ id: 55 }] } },                                  // WIQL
      { status: 200, body: { value: [{ id: 55, fields: { "System.Title": "v1", "System.State": "Done" } }] } }, // batch
      { status: 200, body: { id: 55, fields: { "System.Title": "v1", "System.State": "Done" } } },              // PATCH
    ]);
    const t = makeAzure(f);
    const all = await t.listMilestones();
    expect(String(calls[0].body?.query ?? "")).toContain("[System.WorkItemType] = 'Epic'");
    expect(all[0]).toMatchObject({ id: "55", state: "released" });
    const done = await t.completeMilestone("55");
    expect(calls[2].method).toBe("PATCH");
    expect(calls[2].body).toEqual([{ op: "add", path: "/fields/System.State", value: "Done" }]);
    expect(done.state).toBe("released");
  });
```

  (`makeAzure(f)` mirrors the file's existing constructor helper with `states: { in_progress: "Doing", closed: "Done", open: "To Do" }`.)
- [ ] **Step 2: Run to verify failure** — Expected: FAIL (UNSUPPORTED).
- [ ] **Step 3: Implement** — capabilities → `hasMilestones: true`; replace the milestone stubs (keep the `closePhase` stub):

```ts
  private normalizeEpic(raw: WorkItem): Milestone {
    const state = raw.fields["System.State"] === this.cfg.states.closed ? "released" : "open";
    return { id: String(raw.id), name: raw.fields["System.Title"] ?? "", state,
      url: raw.url };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const raw = await this.api(
      "POST", `/${this.projectPath}/_apis/wit/workitems/${encodeURIComponent("$Epic")}`,
      [{ op: "add", path: "/fields/System.Title", value: name }],
      { contentType: "application/json-patch+json", context: "azure-boards milestone_create" },
    );
    return this.normalizeEpic(raw as WorkItem);
  }

  async listMilestones(): Promise<Milestone[]> {
    const query = "SELECT [System.Id] FROM WorkItems WHERE "
      + `[System.TeamProject] = '${this.escapeWiql(this.cfg.project)}' `
      + "AND [System.WorkItemType] = 'Epic'";
    const wiqlRaw = await this.api(
      "POST", `/${this.projectPath}/_apis/wit/wiql`, { query },
      { context: "azure-boards milestone_list_wiql" },
    ) as { workItems: Array<{ id: number }> };
    const ids = wiqlRaw.workItems.map((w) => w.id).slice(0, MAX_IDS);
    if (ids.length === 0) return [];
    const batchRaw = await this.api(
      "GET", `/${this.projectPath}/_apis/wit/workitems`, undefined,
      { params: { ids: ids.join(",") }, context: "azure-boards milestone_list_batch" },
    ) as { value: WorkItem[] };
    return batchRaw.value.map((w) => this.normalizeEpic(w));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const raw = await this.api(
      "PATCH", `/${this.projectPath}/_apis/wit/workitems/${id}`,
      [{ op: "add", path: "/fields/System.State", value: this.cfg.states.closed }],
      { contentType: "application/json-patch+json", context: "azure-boards milestone_complete" },
    );
    return this.normalizeEpic(raw as WorkItem);
  }
```

  (Adjust the `$Epic` URL encoding to match how `createIssue` builds its `$<type>` segment in this file — reuse the same `encodeURIComponent` pattern verbatim.)
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): Azure Boards native milestones as Epic work items"`

### Task 5: Fallback-adapter unit coverage (GitHub/GitLab milestones, Asana, ClickUp)

**Files:**
- Test: `server/test/github.unit.test.ts`, `server/test/gitlab.unit.test.ts`, `server/test/asana.unit.test.ts`, `server/test/clickup.unit.test.ts`

**Interfaces:** none new — pins the fallback contract so a future refactor can't silently flip it.

- [ ] **Step 1: Add one test per file** (constructor helpers as in each file's existing tests; no fixtures needed — stubs throw before any fetch):

```ts
  it("milestones are UNSUPPORTED (capability-flagged fallback)", async () => {
    const t = /* file's usual constructor */;
    expect(t.capabilities.hasMilestones).toBe(false);
    await expect(t.createMilestone("v1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.listMilestones()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.completeMilestone("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
```

  For asana + clickup additionally:

```ts
  it("closePhase is UNSUPPORTED (phase primitive has no closed state)", async () => {
    const t = /* file's usual constructor */;
    expect(t.capabilities.hasPhaseClose).toBe(false);
    await expect(t.closePhase("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
```

  (azure-boards gets the same `closePhase` test in its file too.)
- [ ] **Step 2: Run** — `npx vitest run` — Expected: PASS immediately (behavior exists since Task 1; these are pinning tests).
- [ ] **Step 3: Commit** — `git commit -m "test(server): pin milestone/phase-close fallback contract on non-native adapters"`

### Task 6: `planning/milestones.ts` — roadmap meta + summit orchestration

**Files:**
- Create: `server/src/planning/milestones.ts`
- Test: `server/test/milestones.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RoadmapMeta { milestone: number; milestoneId?: string; lastResync?: string }
  export function readRoadmapMeta(projectDir: string): RoadmapMeta            // NOT_FOUND if no roadmap.md
  export function patchRoadmapMeta(projectDir: string,
    patch: { milestone?: number; milestoneId?: string | null; lastResync?: string }): void  // null deletes
  export interface MilestoneCompleteReport {
    closedPhases: string[]; skippedPhases: Array<{ dir: string; reason: string }>;
    released?: Milestone; archivedTo: string; nextMilestone: number;
  }
  export async function milestoneComplete(tracker: Tracker, projectDir: string,
    summary: string): Promise<MilestoneCompleteReport>
  export async function milestoneCreate(tracker: Tracker, projectDir: string,
    name: string): Promise<{ milestone: number; native?: Milestone }>
  export async function milestoneList(tracker: Tracker, projectDir: string):
    Promise<{ current: number; currentId?: string; archived: string[]; native?: Milestone[] }>
  ```
- Consumes: `parseFrontmatter`/`serializeFrontmatter`, `plansRoot`, `projectStatus`, Task 1's tracker surface.

- [ ] **Step 1: Failing tests** — `server/test/milestones.test.ts` (temp project dir via `mkdtempSync`, FakeTracker; mirror `artifacts.test.ts` setup style):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import {
  readRoadmapMeta, patchRoadmapMeta, milestoneComplete, milestoneCreate, milestoneList,
} from "../src/planning/milestones.js";

const verify = (dir: string, phaseDir: string) =>
  writeFileSync(join(dir, ".cairn/plans/phases", phaseDir, "VERIFICATION.md"), "# ok\n");

describe("roadmap meta", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
  });

  it("defaults milestone to 1 when frontmatter is absent", () => {
    expect(readRoadmapMeta(dir)).toEqual({ milestone: 1 });
  });

  it("patch round-trips and null deletes", () => {
    patchRoadmapMeta(dir, { milestone: 2, milestoneId: "10001", lastResync: "abc1234" });
    expect(readRoadmapMeta(dir)).toEqual({ milestone: 2, milestoneId: "10001", lastResync: "abc1234" });
    patchRoadmapMeta(dir, { milestoneId: null });
    expect(readRoadmapMeta(dir).milestoneId).toBeUndefined();
    // body preserved
    expect(readFileSync(join(dir, ".cairn/plans/roadmap.md"), "utf8")).toContain("| Phase | Name | Status |");
  });
});

describe("milestoneComplete", () => {
  let dir: string; let tracker: FakeTracker;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    scaffoldPhase(dir, 2, "polish");
    tracker = new FakeTracker();
    await tracker.createPhase("Phase 1: core");
    await tracker.createPhase("Phase 2: polish");
  });

  it("gates on unverified phases and moves nothing", async () => {
    verify(dir, "01-core"); // 02-polish left unverified
    await expect(milestoneComplete(tracker, dir, "s"))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(existsSync(join(dir, ".cairn/plans/phases/01-core"))).toBe(true);
  });

  it("closes tracker phases, releases native milestone, archives, bumps roadmap", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    const m = await tracker.createMilestone("v1");
    patchRoadmapMeta(dir, { milestoneId: m.id });
    const report = await milestoneComplete(tracker, dir, "shipped v1");
    expect(report.closedPhases.length).toBe(2);
    expect(report.released?.state).toBe("released");
    expect(report.nextMilestone).toBe(2);
    expect(existsSync(join(dir, ".cairn/plans/milestones/v1/01-core/PLAN.md"))).toBe(true);
    expect(existsSync(join(dir, ".cairn/plans/phases/01-core"))).toBe(false);
    const meta = readRoadmapMeta(dir);
    expect(meta.milestone).toBe(2);
    expect(meta.milestoneId).toBeUndefined();
    expect(readFileSync(join(dir, ".cairn/plans/roadmap.md"), "utf8"))
      .toContain("shipped v1");
  });

  it("is re-runnable: already-closed tracker phases are fine", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    const phases = await tracker.listPhases();
    for (const p of phases) await tracker.closePhase(p.id);
    const report = await milestoneComplete(tracker, dir, "s");
    expect(report.closedPhases.length).toBe(2);
  });

  it("records skips when hasPhaseClose is false, and archives anyway", async () => {
    verify(dir, "01-core"); verify(dir, "02-polish");
    (tracker.capabilities as { hasPhaseClose: boolean }).hasPhaseClose = false;
    const report = await milestoneComplete(tracker, dir, "s");
    expect(report.skippedPhases.length).toBe(2);
    expect(report.skippedPhases[0].reason).toContain("no closed state");
    expect(existsSync(join(dir, ".cairn/plans/milestones/v1"))).toBe(true);
  });
});

describe("milestoneCreate / milestoneList", () => {
  it("create stamps milestone_id; list merges git archive with native", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-ms-"));
    scaffoldProject(dir, "proj");
    const tracker = new FakeTracker();
    const { native } = await milestoneCreate(tracker, dir, "v1");
    expect(native?.id).toBeTruthy();
    expect(readRoadmapMeta(dir).milestoneId).toBe(native!.id);
    mkdirSync(join(dir, ".cairn/plans/milestones/v1"), { recursive: true });
    const listed = await milestoneList(tracker, dir);
    expect(listed.current).toBe(1);
    expect(listed.archived).toEqual(["v1"]);
    expect(listed.native?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run milestones` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `server/src/planning/milestones.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import type { Milestone, Tracker } from "../tracker/types.js";
import { plansRoot } from "./artifacts.js";
import { projectStatus } from "./status.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";

export interface RoadmapMeta { milestone: number; milestoneId?: string; lastResync?: string }

const roadmapPath = (projectDir: string) => join(plansRoot(projectDir), "roadmap.md");

function readRoadmapRaw(projectDir: string): {
  data: Record<string, string | string[]>; body: string;
} {
  const path = roadmapPath(projectDir);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", "no roadmap.md under .cairn/plans",
      "run plan_scaffold_project first");
  }
  return parseFrontmatter(readFileSync(path, "utf8"));
}

export function readRoadmapMeta(projectDir: string): RoadmapMeta {
  const { data } = readRoadmapRaw(projectDir);
  const n = data.milestone === undefined ? 1 : Number(data.milestone);
  if (!Number.isInteger(n) || n < 1) {
    throw new CairnError("CONFIG_INVALID", `roadmap.md milestone: must be an int >= 1, got '${data.milestone}'`);
  }
  const meta: RoadmapMeta = { milestone: n };
  if (typeof data.milestone_id === "string" && data.milestone_id) meta.milestoneId = data.milestone_id;
  if (typeof data.last_resync === "string" && data.last_resync) meta.lastResync = data.last_resync;
  return meta;
}

export function patchRoadmapMeta(projectDir: string,
  patch: { milestone?: number; milestoneId?: string | null; lastResync?: string }): void {
  const { data, body } = readRoadmapRaw(projectDir);
  if (patch.milestone !== undefined) data.milestone = String(patch.milestone);
  if (patch.milestoneId === null) delete data.milestone_id;
  else if (patch.milestoneId !== undefined) data.milestone_id = patch.milestoneId;
  if (patch.lastResync !== undefined) data.last_resync = patch.lastResync;
  writeFileSync(roadmapPath(projectDir), serializeFrontmatter(data, body));
}

export interface MilestoneCompleteReport {
  closedPhases: string[]; skippedPhases: Array<{ dir: string; reason: string }>;
  released?: Milestone; archivedTo: string; nextMilestone: number;
}

export async function milestoneComplete(tracker: Tracker, projectDir: string,
  summary: string): Promise<MilestoneCompleteReport> {
  const status = projectStatus(projectDir);
  if (status.phases.length === 0) {
    throw new CairnError("PRECONDITION_FAILED", "no live phases to complete",
      "scaffold and work phases before summit");
  }
  const unverified = status.phases.filter((p) => !p.hasVerification);
  if (unverified.length > 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `unverified phases: ${unverified.map((p) => p.dir).join(", ")}`,
      "run /cairn verify <N> for each before summit");
  }
  const meta = readRoadmapMeta(projectDir);

  // -- tracker steps (collect errors; archive only runs when these fully succeed)
  const closedPhases: string[] = [];
  const skippedPhases: Array<{ dir: string; reason: string }> = [];
  const errors: string[] = [];
  const trackerPhases = await tracker.listPhases();
  for (const p of status.phases) {
    const match = trackerPhases.find((tp) => tp.name.startsWith(`Phase ${p.number}:`));
    if (!match) { skippedPhases.push({ dir: p.dir, reason: "no tracker phase object" }); continue; }
    if (match.state === "closed") { closedPhases.push(match.id); continue; }
    if (!tracker.capabilities.hasPhaseClose) {
      skippedPhases.push({ dir: p.dir, reason: "backend phase primitive has no closed state" });
      continue;
    }
    try {
      await tracker.closePhase(match.id);
      closedPhases.push(match.id);
    } catch (e) {
      errors.push(`closePhase(${match.id}): ${e}`);
    }
  }
  let released: Milestone | undefined;
  if (tracker.capabilities.hasMilestones && meta.milestoneId) {
    try {
      released = await tracker.completeMilestone(meta.milestoneId);
    } catch (e) {
      errors.push(`completeMilestone(${meta.milestoneId}): ${e}`);
    }
  }
  if (errors.length > 0) {
    throw new CairnError("TRACKER_DOWN",
      `milestone_complete tracker steps failed: ${errors.join("; ")}`,
      "fix and re-run — completed steps are idempotent, nothing was archived");
  }

  // -- archive (only after tracker steps fully succeeded)
  const dest = join(plansRoot(projectDir), "milestones", `v${meta.milestone}`);
  mkdirSync(dest, { recursive: true });
  for (const p of status.phases) {
    renameSync(join(plansRoot(projectDir), "phases", p.dir), join(dest, p.dir));
  }
  const { data, body } = readRoadmapRaw(projectDir);
  const archiveNote = `\n## Archived — v${meta.milestone}\n\n`
    + `${summary} — see milestones/v${meta.milestone}/\n`;
  data.milestone = String(meta.milestone + 1);
  delete data.milestone_id;
  writeFileSync(roadmapPath(projectDir), serializeFrontmatter(data, body + archiveNote));

  return {
    closedPhases, skippedPhases, released,
    archivedTo: join(".cairn", "plans", "milestones", `v${meta.milestone}`),
    nextMilestone: meta.milestone + 1,
  };
}

export async function milestoneCreate(tracker: Tracker, projectDir: string,
  name: string): Promise<{ milestone: number; native?: Milestone }> {
  const meta = readRoadmapMeta(projectDir);
  let native: Milestone | undefined;
  if (tracker.capabilities.hasMilestones) {
    native = await tracker.createMilestone(name);
    patchRoadmapMeta(projectDir, { milestoneId: native.id });
  }
  return { milestone: meta.milestone, native };
}

export async function milestoneList(tracker: Tracker, projectDir: string):
  Promise<{ current: number; currentId?: string; archived: string[]; native?: Milestone[] }> {
  const meta = readRoadmapMeta(projectDir);
  const msDir = join(plansRoot(projectDir), "milestones");
  const archived = existsSync(msDir)
    ? readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
        .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    : [];
  const out: { current: number; currentId?: string; archived: string[]; native?: Milestone[] } =
    { current: meta.milestone, archived };
  if (meta.milestoneId) out.currentId = meta.milestoneId;
  if (tracker.capabilities.hasMilestones) out.native = await tracker.listMilestones();
  return out;
}
```

- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): milestones planning module — roadmap meta + summit orchestration"`

### Task 7: `planning/resync.ts` — out-of-band commit detection

**Files:**
- Create: `server/src/planning/resync.ts`
- Test: `server/test/resync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OutOfBandCommit { sha: string; subject: string; files: string[] }
  export interface ResyncReport {
    outOfBand: OutOfBandCommit[]; sinceSha: string | null;
    headSha: string; initialized?: boolean;
  }
  export function resyncReport(projectDir: string): ResyncReport
  ```
- Consumes: `readRoadmapMeta`/`patchRoadmapMeta` (Task 6), `plansRoot`, LEDGER.md's `commits <base>..<head>` line format from `ledger.ts` `formatEntry`.
- First run (no `last_resync` marker): initializes the marker to HEAD and returns `{ outOfBand: [], sinceSha: null, initialized: true }` — never scans unbounded history.

- [ ] **Step 1: Failing tests** — `server/test/resync.test.ts` (builds a real throwaway git repo):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { readRoadmapMeta } from "../src/planning/milestones.js";
import { resyncReport } from "../src/planning/resync.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function commit(dir: string, file: string, msg: string): string {
  writeFileSync(join(dir, file), `${msg}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", msg, "--no-gpg-sign");
  return git(dir, "rev-parse", "HEAD");
}

describe("resyncReport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-rs-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    commit(dir, "seed.txt", "seed");
  });

  it("first run initializes the marker and reports nothing", () => {
    const r = resyncReport(dir);
    expect(r.initialized).toBe(true);
    expect(r.outOfBand).toEqual([]);
    expect(readRoadmapMeta(dir).lastResync).toBe(r.headSha);
  });

  it("flags commits not covered by any ledger range; ledgered ranges are covered", () => {
    resyncReport(dir); // initialize at seed
    const base = git(dir, "rev-parse", "HEAD");
    const covered = commit(dir, "a.txt", "ledgered work");
    // hand-write a ledger line in the real format
    appendFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      `# Phase 1: core — Ledger\n\n- [x] T1 — did work — commits ${base.slice(0, 7)}..${covered.slice(0, 7)} — GH-1 closed 2026-07-18\n`);
    const rogue = commit(dir, "b.txt", "out of band hotfix");
    const r = resyncReport(dir);
    expect(r.outOfBand.map((c) => c.sha)).toEqual([rogue]);
    expect(r.outOfBand[0].subject).toBe("out of band hotfix");
    expect(r.outOfBand[0].files).toEqual(["b.txt"]);
    expect(r.sinceSha).toBeTruthy();
  });

  it("advances the marker: a second run sees nothing new", () => {
    resyncReport(dir);
    commit(dir, "c.txt", "rogue");
    expect(resyncReport(dir).outOfBand.length).toBe(1);
    expect(resyncReport(dir).outOfBand.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run resync` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `server/src/planning/resync.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { readRoadmapMeta, patchRoadmapMeta } from "./milestones.js";

export interface OutOfBandCommit { sha: string; subject: string; files: string[] }
export interface ResyncReport {
  outOfBand: OutOfBandCommit[]; sinceSha: string | null;
  headSha: string; initialized?: boolean;
}

// Matches ledger.ts formatEntry: "… — commits abc1234..def5678 — …"
const RANGE_RE = /commits ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/;

function git(projectDir: string, args: string[]): string {
  try {
    return execFileSync("git", args,
      { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new CairnError("PRECONDITION_FAILED", `git ${args[0]} failed: ${e}`,
      "plan_resync needs a git repository with at least one commit");
  }
}

function ledgerRanges(projectDir: string): Array<{ base: string; head: string }> {
  const phasesDir = join(plansRoot(projectDir), "phases");
  const ranges: Array<{ base: string; head: string }> = [];
  if (!existsSync(phasesDir)) return ranges;
  for (const entry of readdirSync(phasesDir)) {
    const ledger = join(phasesDir, entry, "LEDGER.md");
    if (!existsSync(ledger)) continue;
    for (const line of readFileSync(ledger, "utf8").split("\n")) {
      const m = RANGE_RE.exec(line);
      if (m) ranges.push({ base: m[1], head: m[2] });
    }
  }
  return ranges;
}

export function resyncReport(projectDir: string): ResyncReport {
  const headSha = git(projectDir, ["rev-parse", "HEAD"]).trim();
  const meta = readRoadmapMeta(projectDir);
  if (!meta.lastResync) {
    // First run: initialize, never scan unbounded history.
    patchRoadmapMeta(projectDir, { lastResync: headSha });
    return { outOfBand: [], sinceSha: null, headSha, initialized: true };
  }

  const covered = new Set<string>();
  for (const r of ledgerRanges(projectDir)) {
    try {
      for (const sha of git(projectDir, ["rev-list", `${r.base}..${r.head}`])
        .split("\n").map((s) => s.trim()).filter(Boolean)) covered.add(sha);
    } catch {
      // range refers to unknown shas (rebased/gc'd) — skip it, stay honest elsewhere
    }
  }

  // \x1e separates commit records, \x1f separates sha from subject;
  // --name-only lists touched files after each record.
  const raw = git(projectDir, ["log", "--no-merges", "--format=%x1e%H%x1f%s",
    "--name-only", `${meta.lastResync}..HEAD`]);
  const outOfBand: OutOfBandCommit[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [sha, subject] = lines[0].split("\x1f");
    if (covered.has(sha)) continue;
    outOfBand.push({
      sha, subject: subject ?? "",
      files: lines.slice(1).map((l) => l.trim()).filter(Boolean),
    });
  }

  patchRoadmapMeta(projectDir, { lastResync: headSha });
  return { outOfBand, sinceSha: meta.lastResync, headSha };
}
```

- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): plan_resync mechanism — ledger-coverage math over git log"`

### Task 8: PLAN.md wave/tdd meta + ledger TDD evidence

**Files:**
- Modify: `server/src/planning/artifacts.ts`, `server/src/planning/ledger.ts`
- Test: `server/test/artifacts.test.ts`, `server/test/ledger.test.ts`

**Interfaces:**
- Produces (artifacts.ts):
  ```ts
  export interface PlanMeta { issues: string[]; waves: string[][]; tdd: string[] }
  export function readPlanMeta(projectDir: string, phaseDir: string): PlanMeta
  export function writePlanMeta(projectDir: string, phaseDir: string,
    meta: { waves?: string[][]; tdd?: string[] }): void
  ```
  Frontmatter keys: `wave_1: [ids]`, `wave_2: [ids]`, … (contiguous), `tdd: [ids]`. Writes replace ALL existing `wave_*` keys when `waves` is passed. Validation (`CONFIG_INVALID` on failure): every id ∈ `issues:`; no id in two waves; no empty wave.
- Produces (ledger.ts): `LedgerEntryInput` gains `redCommit?: string; greenCommit?: string` — both or neither (`CONFIG_INVALID` if only one). When present, the line gains a ` — tdd <red7>..<green7>` segment before the `— <issueId> closed` segment.

- [ ] **Step 1: Failing tests** — append to `artifacts.test.ts`:

```ts
describe("plan meta (waves/tdd)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-meta-"));
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3"]);
  });

  it("write + read round-trips waves and tdd", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2"], ["GH-3"]], tdd: ["GH-2"] });
    expect(readPlanMeta(dir, "01-core")).toEqual({
      issues: ["GH-1", "GH-2", "GH-3"],
      waves: [["GH-1", "GH-2"], ["GH-3"]],
      tdd: ["GH-2"],
    });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2]");
    expect(raw).toContain("wave_2: [GH-3]");
    expect(raw).toContain("tdd: [GH-2]");
  });

  it("re-writing waves replaces stale wave_N keys", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-2"], ["GH-3"]] });
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2", "GH-3"]] });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2, GH-3]");
    expect(raw).not.toContain("wave_2");
  });

  it("rejects unknown ids, duplicates across waves, and empty waves", () => {
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-9"]] }))
      .toThrowError(/GH-9/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-1"]] }))
      .toThrowError(/more than one wave/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [[]] }))
      .toThrowError(/empty/);
    expect(() => writePlanMeta(dir, "01-core", { tdd: ["GH-9"] }))
      .toThrowError(/GH-9/);
  });

  it("issues writes preserve meta keys (writePlanIssues keeps wave_*/tdd)", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"]], tdd: ["GH-1"] });
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3", "GH-4"]);
    expect(readPlanMeta(dir, "01-core").waves).toEqual([["GH-1"]]);
  });
});
```

  Append to `ledger.test.ts` (reuse its existing setup that scaffolds a phase):

```ts
  it("appends a tdd evidence segment when red+green are given", () => {
    const { line } = appendLedger(dir, "01-core", {
      taskRef: "T2", summary: "tdd task", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-2", closedDate: "2026-07-18",
      redCommit: "c".repeat(40), greenCommit: "d".repeat(40),
    });
    expect(line).toContain("— tdd ccccccc..ddddddd —");
  });

  it("rejects a lone red or green commit", () => {
    expect(() => appendLedger(dir, "01-core", {
      taskRef: "T3", summary: "s", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-3", closedDate: "2026-07-18",
      redCommit: "c".repeat(40),
    })).toThrowError(/both or neither/);
  });
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** — artifacts.ts additions:

```ts
export interface PlanMeta { issues: string[]; waves: string[][]; tdd: string[] }

const WAVE_KEY_RE = /^wave_(\d+)$/;

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function readPlanMeta(projectDir: string, phaseDir: string): PlanMeta {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) return { issues: [], waves: [], tdd: [] };
  const { data } = parseFrontmatter(readFileSync(path, "utf8"));
  const waveKeys = Object.keys(data)
    .map((k) => WAVE_KEY_RE.exec(k)).filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  return {
    issues: asList(data.issues),
    waves: waveKeys.map((m) => asList(data[m[0]])),
    tdd: asList(data.tdd),
  };
}

export function writePlanMeta(projectDir: string, phaseDir: string,
  meta: { waves?: string[][]; tdd?: string[] }): void {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND",
      `no PLAN.md at phaseDir '${phaseDir}' — scaffold it first with plan_scaffold_phase`);
  }
  const raw = readFileSync(path, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const issues = new Set(asList(data.issues));
  const assertKnown = (ids: string[], what: string): void => {
    for (const id of ids) {
      if (!issues.has(id)) {
        throw new CairnError("CONFIG_INVALID",
          `${what} references '${id}' which is not in this plan's issues list`,
          "add it with plan_issues_set first");
      }
    }
  };
  if (meta.waves !== undefined) {
    const seen = new Set<string>();
    for (const [i, wave] of meta.waves.entries()) {
      if (wave.length === 0) {
        throw new CairnError("CONFIG_INVALID", `wave ${i + 1} is empty`);
      }
      assertKnown(wave, `wave ${i + 1}`);
      for (const id of wave) {
        if (seen.has(id)) {
          throw new CairnError("CONFIG_INVALID",
            `issue '${id}' appears in more than one wave`);
        }
        seen.add(id);
      }
    }
    for (const k of Object.keys(data)) if (WAVE_KEY_RE.test(k)) delete data[k];
    meta.waves.forEach((wave, i) => { data[`wave_${i + 1}`] = wave; });
  }
  if (meta.tdd !== undefined) {
    assertKnown(meta.tdd, "tdd");
    data.tdd = meta.tdd;
  }
  writeFileSync(path, serializeFrontmatter(data, body));
}
```

  ledger.ts — extend `LedgerEntryInput` with `redCommit?: string; greenCommit?: string;` and change `formatEntry`:

```ts
function formatEntry(entry: LedgerEntryInput): string {
  if ((entry.redCommit === undefined) !== (entry.greenCommit === undefined)) {
    throw new CairnError("CONFIG_INVALID",
      "redCommit/greenCommit: both or neither",
      "pass the failing-test commit AND the passing commit, or omit both");
  }
  const tdd = entry.redCommit
    ? `tdd ${shortSha(sanitize(entry.redCommit))}..${shortSha(sanitize(entry.greenCommit!))} — `
    : "";
  return `- [x] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
    + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
    + `${tdd}${sanitize(entry.issueId)} closed ${sanitize(entry.closedDate)}\n`;
}
```

- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS (including all pre-existing ledger tests — the no-TDD format is unchanged).
- [ ] **Step 5: Commit** — `git commit -m "feat(server): wave/tdd plan meta + TDD commit evidence in the ledger"`

### Task 9: Register the five tools; rebuild dist

**Files:**
- Modify: `server/src/index.ts`, `server/README.md`
- Test: `server/test/mcp.test.ts`

**Interfaces:**
- Produces tools (33 total): `milestone_create{name}`, `milestone_list{}`, `milestone_complete{summary}`, `plan_resync{}`, `plan_meta_set{phaseDir, waves?, tdd?}`.
- Consumes: Tasks 6–8 functions; existing `wrap`, `getTracker`, `PHASE_DIR_RE`, `refreshHandoff`.

- [ ] **Step 1: Failing test** — extend `mcp.test.ts` the way it asserts existing tools (list-tools contains names; a FakeTracker-backed call round-trips):

```ts
  it("registers the Tier A tools", async () => {
    const names = await listToolNames(); // file's existing helper for tool enumeration
    for (const n of ["milestone_create", "milestone_list", "milestone_complete",
      "plan_resync", "plan_meta_set"]) expect(names).toContain(n);
  });
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** — in `index.ts`, after the `ledger_append` registration:

```ts
  server.registerTool("milestone_create",
    { description: "Start the next milestone — native tracker object when the backend supports it; stamps milestone_id into roadmap.md",
      inputSchema: { name: z.string() } },
    wrap(async (a: { name: string }) =>
      milestoneCreate(await getTracker(), deps.projectDir, a.name)));

  server.registerTool("milestone_list",
    { description: "Current milestone number, archived milestones, and the tracker's native list when supported",
      inputSchema: {} },
    wrap(async () => milestoneList(await getTracker(), deps.projectDir)));

  server.registerTool("milestone_complete",
    { description: "Complete the current milestone: gate on all-phases-verified, close tracker phases, "
        + "release the native milestone when supported, archive phases/ to milestones/vN/, bump roadmap. "
        + "Idempotent — safe to re-run after a partial tracker failure",
      inputSchema: { summary: z.string() } },
    wrap(async (a: { summary: string }) =>
      milestoneComplete(await getTracker(), deps.projectDir, a.summary)));

  server.registerTool("plan_resync",
    { description: "Detect out-of-band commits (covered by no LEDGER.md range) since the last resync marker; "
        + "advances the marker. First run initializes the marker and reports nothing",
      inputSchema: {} },
    wrap(() => resyncReport(deps.projectDir)));

  server.registerTool("plan_meta_set",
    { description: "Set wave grouping (wave_N frontmatter) and/or the TDD-eligible task list on a phase's PLAN.md",
      inputSchema: { phaseDir: z.string(),
                     waves: z.array(z.array(z.string())).optional(),
                     tdd: z.array(z.string()).optional() } },
    wrap((a: { phaseDir: string; waves?: string[][]; tdd?: string[] }) => {
      if (!PHASE_DIR_RE.test(a.phaseDir)) {
        throw new CairnError("CONFIG_INVALID",
          `phaseDir must look like 01-name, got '${a.phaseDir}'`);
      }
      writePlanMeta(deps.projectDir, a.phaseDir, { waves: a.waves, tdd: a.tdd });
      refreshHandoff({
        source: "tool",
        phase: { number: Number(a.phaseDir.slice(0, 2)), slug: a.phaseDir.slice(3) },
      });
      return { ok: true, ...readPlanMeta(deps.projectDir, a.phaseDir) };
    }));
```

  Imports to add: `milestoneCreate, milestoneList, milestoneComplete` from `./planning/milestones.js`; `resyncReport` from `./planning/resync.js`; `readPlanMeta, writePlanMeta` from `./planning/artifacts.js`. Also extend `ledger_append`'s inputSchema + handler args with `redCommit: z.string().optional(), greenCommit: z.string().optional()` (passes straight through in `entry`). NOTE: `PHASE_DIR_RE` is declared just above `plan_issues_set` — the new `plan_meta_set` registration must come after it.
  `server/README.md`: extend the tool table with the 5 tools (one line each, description text matching the registrations) and bump the stated tool count to 33.
- [ ] **Step 4: Run + rebuild** — `npx vitest run && npx tsc --noEmit && npm run build` — Expected: PASS, dist updated.
- [ ] **Step 5: Commit** (include `server/dist`) — `git commit -m "feat(server): milestone_*, plan_resync, plan_meta_set tools — 33 total; ledger TDD passthrough"`

---

## Stage 2 — plugin surface

### Task 10: Surface sweep — probe/draft re-tier + check-surface updates

**Files:**
- Modify: `skills/cairn-trailhead/SKILL.md`, `scripts/check-surface.mjs`

**Interfaces:** routing-table rows for `probe`/`draft` flip `reserved-A` → `reserved-C` (spec decision record); `SPEC_RESERVED` in check-surface matches; `TOOL_PREFIXES` learns the `milestone_` prefix so verb docs' milestone tool references are validated.

- [ ] **Step 1:** In SKILL.md flip the two rows:

```markdown
| `probe` | Risk-ordered throwaway spike experiments with verdicts | | verbs/probe.md | reserved-C |
| `draft` | Multi-variant mockups on a shared theme | | verbs/draft.md | reserved-C |
```

  In check-surface.mjs set `probe: "C", draft: "C"` in `SPEC_RESERVED`, and:

```js
const TOOL_PREFIXES = /^(context|issue|plan|mem|continuity|ledger|milestone)_/;
```

- [ ] **Step 2: Verify** — `node scripts/check-surface.mjs` — Expected: clean, 12 live / 16 reserved (counts unchanged; tiers moved). `cd server && npx vitest run && npx tsc --noEmit` — PASS.
- [ ] **Step 3: Commit** — `git commit -m "fix(plugin): probe/draft re-tiered to reserved-C per Tier A spec decision record"`

### Task 11: `plan`/`work` flags + `cairn-planning` policy

**Files:**
- Modify: `skills/cairn-trailhead/verbs/plan.md`, `skills/cairn-trailhead/verbs/work.md`, `skills/cairn-trailhead/verbs/verify.md`, `skills/cairn-trailhead/SKILL.md` (two args cells), `skills/cairn-planning/SKILL.md`

**Interfaces:** consumes `plan_meta_set`, `readPlanMeta` semantics (via tool result), `ledger_append` red/green, `plan_resync`, `issue_create`, `plan_issues_set`.

- [ ] **Step 1:** Routing-table args cells become:
  - plan: `<N> [--quick\|--deep] [--model <auto\|haiku\|sonnet\|opus>] [--tdd] [--mvp] [--prd <file>] [--ingest <glob>] [--gaps]`
  - work: `<N> [--wave [N]]`
- [ ] **Step 2:** `verbs/plan.md` — update the frontmatter `args` to match, and insert after existing step 3 ("Write the task breakdown…"):

```markdown
4. Flags (combinable; all task-list changes still flow through `plan_issues_set`
   / `plan_meta_set`, never hand-edits):
   - `--mvp`: shape tasks per the cairn-planning skill's vertical-slice-first
     policy before writing PLAN.md.
   - `--prd <file>`: read the file first; interview ONLY the gaps it leaves,
     batched into one AskUserQuestion.
   - `--ingest <glob>`: read matching docs; write their decisions into
     CONTEXT.md as locked decisions with source links. Conflicting docs →
     surface the conflict, never silently pick.
   - `--tdd`: per task, judge eligibility per the cairn-planning rubric;
     batch the proposed eligible/ineligible split into ONE AskUserQuestion
     for overrides; then `plan_meta_set(phaseDir, tdd: [<eligible ids>])`.
   - `--gaps`: read this phase's VERIFICATION.md failures + the latest
     `plan_resync` report; propose new/amended tasks. Goal-breaking gaps →
     issues in this phase now (`issue_create` + `plan_issues_set`); minor →
     offer to backlog. Severity call is yours; say which and why.
   - Wave grouping (with or without flags): when tasks are independent,
     propose waves and write them with `plan_meta_set(phaseDir,
     waves: [[ids…], …])`. Waves must partition cleanly — an issue in two
     waves is a tool error.
```

  (Renumber the existing steps 4–6 to 5–7.)
- [ ] **Step 3:** `verbs/work.md` — update frontmatter `args`; insert after existing step 1:

```markdown
2. `--wave` (only when PLAN.md has `wave_N` frontmatter — else say so and
   point at `/cairn plan <N>`): run waves in order (`--wave N` runs just
   that wave). Within a wave, dispatch one subagent per issue IN PARALLEL —
   worktree isolation for any file-mutating issue. Each subagent runs the
   full per-issue lifecycle below (claim → work → close → ledger). Wave
   N+1 starts only when every wave-N issue is closed and merged. A failed
   issue: let the wave's others finish, then STOP before the next wave and
   report — never build on possibly-broken foundations.
```

  And extend the "Do the work" step with the TDD procedure:

```markdown
   When this issue's id is in PLAN.md `tdd:` frontmatter, the work is
   RED → GREEN → REFACTOR, each its own commit: (RED) write the failing
   test, run it, show the failure, commit; (GREEN) minimal code to pass,
   run, commit; (REFACTOR) clean up, tests stay green, commit. Record the
   RED and GREEN shas — `ledger_append` takes them as `redCommit` /
   `greenCommit` at close. Skipping RED on an eligible task: stop and
   restart the task; verify fails the phase on a missing pair regardless.
```

  (Renumber subsequent steps; the `ledger_append` step's field list gains `redCommit`/`greenCommit` for TDD tasks.)
- [ ] **Step 4:** `skills/cairn-trailhead/verbs/verify.md` — add a step after its tests/drift checks (spec §3: a missing pair on a TDD task is a verify failure):

```markdown
- TDD evidence: for every id in PLAN.md `tdd:` frontmatter, this phase's
  LEDGER.md line for that id must carry a `tdd <red>..<green>` segment.
  Any TDD task missing its pair → the phase FAILS verification — report
  which ids, do not write VERIFICATION.md.
```

- [ ] **Step 5:** `skills/cairn-planning/SKILL.md` — add two policy blocks (after the Depth dial section):

```markdown
## MVP shaping (`plan --mvp`)

First tasks form ONE thin vertical slice exercising every layer end-to-end
(walking skeleton); depth and breadth come only after the slice stands.
A slice that can't demo is not a slice.

## TDD eligibility (`plan --tdd`)

Eligible: behavior-testable code — logic, APIs, parsers, state machines.
Not eligible: config, docs, scaffolding, pure styling, generated code.
Eligibility is per task, decided at plan time, stored in PLAN.md `tdd:`
frontmatter via `plan_meta_set`; work-time enforcement is the RED/GREEN
commit pair in the ledger, checked at verify.
```

- [ ] **Step 6: Verify** — `node scripts/check-surface.mjs` clean; `cd server && npx vitest run && npx tsc --noEmit` PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(plugin): plan/work flag richness — tdd, mvp, prd, ingest, gaps, waves"`

### Task 12: `scout` + `route` verbs

**Files:**
- Create: `skills/cairn-trailhead/verbs/scout.md`, `skills/cairn-trailhead/verbs/route.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (two rows → live)

- [ ] **Step 1:** SKILL.md rows:

```markdown
| `scout` | Research a phase only — resumable RESEARCH.md checkpoints | `<N>` | verbs/scout.md | live |
| `route` | Re-route the roadmap — insert/remove/edit phases | `insert\|remove\|edit <N> ["name"]` | verbs/route.md | live |
```

- [ ] **Step 2:** `verbs/scout.md`:

```markdown
---
verb: scout
args: "<N>"
status: live
---

Research the given phase WITHOUT planning it — `plan`'s research stage alone,
resumable (#1961 shape: never redo finished research).

1. `plan_status()` — phase dir must exist (else `plan_scaffold_phase` with
   `research: true` first).
2. If RESEARCH.md exists, parse its section markers: each `## <topic>`
   section carries `<!-- scout: done -->` or `<!-- scout: pending -->` on
   the line after the heading. Sections marked `done` are FINISHED — do not
   re-research them. No marker = legacy content, treat as done.
3. Determine research topics from CONTEXT.md unknowns + PLAN.md gaps (depth
   dial and model routing per the `cairn-planning` skill). New topics get
   `pending` sections appended; only `pending` sections get researched.
4. Research each pending section (fan out per the model-routing rubric);
   write findings into its section and flip its marker to `done` as EACH
   section completes — a kill mid-run must lose at most one section.
5. `mem_index` the finished brief (source: the RESEARCH.md path). Report
   sections done/remaining and suggest `/cairn plan <N>`.
```

- [ ] **Step 3:** `verbs/route.md`:

```markdown
---
verb: route
args: "insert|remove|edit <N> [\"name\"]"
status: live
---

Roadmap surgery. Never renumbers existing phases — decimal insertion only
(renumbering is where GSD broke).

- **insert `<N.5>` "name"** — confirm placement, then `plan_scaffold_phase`
  with the decimal number and name, `plan_phase_ensure` for the tracker
  object, add the roadmap.md row between its neighbors. Existing phases
  untouched.
- **remove `<N>`** — show what dies first: the phase's open issues
  (`issue_list` by phase) and artifacts. One batched AskUserQuestion:
  confirm removal + per open issue close-or-reassign. Then: close/reassign
  issues (`issue_update`/`issue_close`), close the tracker phase object if
  the backend supports it (`hasPhaseClose` — else annotate its name via the
  backend's usual update path and say so), move the phase dir to
  `.cairn/plans/milestones/removed/`, strike the roadmap row
  (`~~Phase N~~`).
- **edit `<N>` "new name"** — retitle/rescope: rename the phase dir slug
  (git mv), update the roadmap row and PLAN.md/CONTEXT.md headings, update
  the tracker phase name (backend update path). Scope changes to CONTEXT.md
  are locked-decision edits — record what changed and why.
```

- [ ] **Step 4: Verify** — `node scripts/check-surface.mjs` — Expected: clean, 14 live / 14 reserved. Server suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): scout + route verbs live"`

### Task 13: `summit` + `auto` verbs

**Files:**
- Create: `skills/cairn-trailhead/verbs/summit.md`, `skills/cairn-trailhead/verbs/auto.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (two rows → live; shared Continuity rule already names summit)

- [ ] **Step 1:** SKILL.md rows:

```markdown
| `summit` | Complete the milestone — verify gate, tracker close/release, archive, tag | | verbs/summit.md | live |
| `auto` | Chained hands-off execution of remaining phases (opt-in) | | verbs/auto.md | live |
```

- [ ] **Step 2:** `verbs/summit.md`:

```markdown
---
verb: summit
args: ""
status: live
---

Complete the current milestone. The server gates hard — nothing archives
until every phase is verified.

1. `milestone_list()` + `plan_status()` — show what's completing: phases,
   verification state, native milestone (when the backend has one). Any
   unverified phase → stop, list them, point at `/cairn verify <N>`.
2. Interview the milestone summary (1–3 sentences, what shipped) — one
   AskUserQuestion, batched with the "start next milestone?" question.
3. `milestone_complete(summary)` — closes tracker phases (skips recorded
   for backends whose phase primitive can't close), releases the native
   milestone when supported, archives `phases/` → `milestones/vN/`, bumps
   roadmap. On PRECONDITION_FAILED or TRACKER_DOWN: report and stop —
   re-running after a fix is safe (idempotent).
4. Git (agent-side, server never writes git): commit the archive
   (`chore(cairn): summit — v<N> archived`) and tag `v<N>`.
5. `continuity_clear()` — the milestone is done; no handoff survives it.
6. If starting the next milestone (from step 2's answer):
   `milestone_create("<name>")`, then the next-milestone interview —
   goals, first phases — batched; scaffold via `plan_scaffold_phase` +
   `plan_phase_ensure`; add roadmap rows. Otherwise report and stop.
```

- [ ] **Step 3:** `verbs/auto.md`:

```markdown
---
verb: auto
args: ""
status: live
---

Chained hands-off execution of remaining phases. OPT-IN and explicit: show
exactly what will run before anything runs.

1. `plan_status()` — the run list is every phase with CONTEXT.md and
   without VERIFICATION.md, in order. Show it (phases, issue counts) with
   ONE confirmation question. No CONTEXT.md → that phase is excluded and
   listed as skipped — auto never invents context.
2. Per phase, in order: plan if PLAN.md has no tasks (the `plan` verb's
   steps, standard depth) → the `work` verb's steps → the `verify` verb's
   steps. The A0 handoff tools track progress automatically; a killed run
   resumes via `/cairn waypoint resume`.
3. HARD STOPS — halt the run, report, hand back: failed verify;
   `plan_drift` flags; any tracker error; any security-relevant decision
   (auth, secrets, data exposure, dependency trust).
4. Unattended decisions resolve against these principles, in order: prefer
   completeness over shortcuts; match existing patterns; choose reversible
   options; mirror the user's past choices; defer ambiguity (pick the
   defer-able reading, note it); escalate security (that's a hard stop,
   not a principle call). Every such decision is logged in the run report
   with the principle that resolved it.
5. Genuinely subjective taste calls (naming, UX copy, structure with no
   pattern to match) do NOT stop the run: take the reversible option, add
   it to the taste batch, present the batch as ONE review at the end.
6. End of run (or stop): report — phases completed, decisions + principles,
   taste batch, stop reason if stopped, next step.
```

- [ ] **Step 4: Verify** — `node scripts/check-surface.mjs` — 16 live / 12 reserved. Server suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): summit + auto verbs live"`

### Task 14: `fast` + `resync` verbs

**Files:**
- Create: `skills/cairn-trailhead/verbs/fast.md`, `skills/cairn-trailhead/verbs/resync.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (two rows → live)

- [ ] **Step 1:** SKILL.md rows:

```markdown
| `fast` | Trivial inline change — one issue, ≤3 files, atomic commit | `"<change>"` | verbs/fast.md | live |
| `resync` | Detect out-of-band commits; refresh plan context | | verbs/resync.md | live |
```

- [ ] **Step 2:** `verbs/fast.md`:

```markdown
---
verb: fast
args: "\"<change>\""
status: live
---

Trivial inline change. No plan artifacts, no phase — but still
tracker-first: every change is visible where the team looks.

1. Guardrail first: if the change plausibly touches >3 files or needs
   design judgment, STOP and suggest `/cairn plan` — before creating
   anything.
2. `issue_create(title: <change>, labels: ["fast"])`.
3. Make the change. The moment it grows past 3 files: stop, report, leave
   the issue open with a note, suggest `/cairn plan`.
4. Tests relevant to the touched files pass → ONE atomic commit
   (conventional message).
5. `issue_close(id)` — close note carries the commit sha. No ledger entry
   (no phase). Report: issue, files, sha.
```

- [ ] **Step 3:** `verbs/resync.md`:

```markdown
---
verb: resync
args: ""
status: live
---

Codebase ↔ plan drift: find commits the planning layer never saw, refresh
the context they invalidate.

1. `plan_resync()` — first run just initializes the marker (say so, done).
2. No out-of-band commits → report clean, done.
3. Otherwise group the commits by likely phase (file paths vs each phase's
   PLAN.md task areas — judgment, say your reasoning) and present the
   report: sha, subject, files, suspected phase.
4. For each affected phase, batched into one AskUserQuestion per phase at
   most: refresh CONTEXT.md (what the out-of-band work changed about the
   locked decisions) and PLAN.md task notes. Assumptions broken outright →
   offer `/cairn plan <N> --gaps`.
5. The marker already advanced (the tool did it) — note that re-running
   reports clean from here, and say what was refreshed.
```

- [ ] **Step 4: Verify** — `node scripts/check-surface.mjs` — Expected: clean, **18 live / 10 reserved**. Server suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): fast + resync verbs live — Tier A surface complete"`

### Task 15: Docs, drills procedure, final green

**Files:**
- Modify: `VERIFICATION.md`, `README.md` (repo root — verb list), `server/README.md` (only if Task 9 missed anything)

- [ ] **Step 1:** VERIFICATION.md — append a Tier A section recording: the CI ratchet counts (18 live / 10 reserved / 33 tools), unit evidence (milestone mapping fixtures per adapter, `milestone_complete` idempotency, resync coverage math, plan-meta validation matrix, ledger TDD pair), and the three dogfood drill procedures from spec §6.3 (summit drill on Jira or Azure + GitHub fallback; auto drill with rigged verify-failure + SIGKILL resume; wave drill 4 issues / 2 waves) — each marked **PENDING until run live**, same convention as Tier 0/A0.
- [ ] **Step 2:** Repo README — update the verb table/count to 18 live.
- [ ] **Step 3: Full gate** — `cd server && npx vitest run && npx tsc --noEmit && npm run build && cd .. && node scripts/check-surface.mjs` — Expected: all green; commit dist if the build changed it.
- [ ] **Step 4: Commit** — `git commit -m "docs(cairn): Tier A verification record — drill procedures pending live run"`

---

**Success criteria traceability (spec §Success):** 1 summit drill → Task 15 procedure (live-run pending) over Tasks 3/4/6 mechanism; 2 auto principled decisions → Task 13 verb doc + Task 15 drill; 3 TDD missing pair fails verify → Tasks 8/11 (+ verify step in work/verify docs); 4 scout resume → Task 12 markers; 5 fast refuses 4 files → Task 14 guardrail; 6 CI surface counts → Tasks 10–14 ratchet, checked at Task 15.
