# Auto-assign on Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claiming an issue (`issue_update` → `in_progress`) auto-assigns it to the working user, per `docs/superpowers/specs/2026-07-26-auto-assign-on-claim-design.md` (CRN-34).

**Architecture:** Optional `Tracker.resolveSelf?()` on the SPI (Jira/GitHub/Azure/Fake implement; CachedTracker forwards), plus a server-side hook in the `issue_update` handler that folds the resolved identity into the claim patch when the issue is unassigned. Jira additionally gains its missing assignee read/write surface.

**Tech Stack:** TypeScript ESM, vitest, mocked `FetchLike` for adapter tests, MCP harness (`test/mcp.test.ts` style) for the hook.

## Global Constraints

- Auto-assign never blocks a claim: any `resolveSelf`/lookup failure degrades silently.
- Never override an existing assignee or an explicit `assignee` argument.
- `resolveSelf` memoizes per adapter instance.
- Identity precedence: `config.user.handle` > `resolveSelf()`.

---

### Task 1: SPI + FakeTracker + CachedTracker forwarding

**Files:**
- Modify: `server/src/tracker/types.ts` (Tracker interface)
- Modify: `server/src/tracker/fake.ts`
- Modify: `server/src/tracker/cached.ts`
- Test: `server/test/cache.test.ts` (extend)

**Interfaces:**
- Produces: `Tracker.resolveSelf?(): Promise<string | undefined>`; `FakeTracker.resolveSelf()` → `"fake-user"`; CachedTracker conditional forwarding.

- [ ] **Step 1: Failing tests** (append to `cache.test.ts` `CachedTracker` describe)

```ts
  it("forwards resolveSelf when the inner adapter has it", async () => {
    const t = new CachedTracker(new FakeTracker());
    expect(t.resolveSelf).toBeDefined();
    expect(await t.resolveSelf!()).toBe("fake-user");
  });

  it("leaves resolveSelf undefined when the inner adapter has none", () => {
    const bare = new FakeTracker();
    // strip the method to simulate an adapter without identity support
    (bare as { resolveSelf?: unknown }).resolveSelf = undefined;
    const t = new CachedTracker(bare);
    expect(t.resolveSelf).toBeUndefined();
  });
```

- [ ] **Step 2: Run** `cd server && npx vitest run test/cache.test.ts` — expect FAIL (resolveSelf undefined on wrapper and fake).

- [ ] **Step 3: Implement**

`types.ts`, after `logWork?`:

```ts
  /** Backend-native identifier for the authenticated user (assignee form).
   *  Present only on adapters that can derive it. Memoized per instance. */
  resolveSelf?(): Promise<string | undefined>;
```

`fake.ts`:

```ts
  async resolveSelf(): Promise<string | undefined> {
    return "fake-user";
  }
```

`cached.ts` — alongside the existing `logWork` field/constructor block:

```ts
  resolveSelf?: () => Promise<string | undefined>;
```

and in the constructor after the `logWork` forwarding:

```ts
    if (inner.resolveSelf) {
      this.resolveSelf = () => this.inner.resolveSelf!();
    }
```

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — all green.
- [ ] **Step 5: Commit** `feat(tracker): optional resolveSelf identity on the SPI, forwarded by CachedTracker`

---

### Task 2: Jira assignee surface + resolveSelf

**Files:**
- Modify: `server/src/tracker/adapters/jira.ts`
- Test: `server/test/jira.unit.test.ts` (extend, reuse its `FetchLike` mock pattern)

**Interfaces:**
- Consumes: Task 1's SPI slot.
- Produces: Jira `resolveSelf()` → accountId via `/rest/api/3/myself`; `normalize` maps `fields.assignee?.accountId` → `Issue.assignee`; `updateIssue` writes `fields.assignee = {accountId}`, resolving emails via `/rest/api/3/user/search?query=`.

- [ ] **Step 1: Failing tests** (extend `jira.unit.test.ts`; follow the file's existing mock-fetch helper style — read it first, mirror how `makeJira(f)` builds an adapter around a `FetchLike`)

```ts
  it("resolveSelf returns the accountId from /myself and memoizes", async () => {
    let calls = 0;
    const f: FetchLike = async (url) => {
      if (String(url).includes("/rest/api/3/myself")) {
        calls++;
        return jsonResponse({ accountId: "acc-123" });
      }
      throw new Error(`unexpected ${url}`);
    };
    const j = makeJira(f);
    expect(await j.resolveSelf!()).toBe("acc-123");
    expect(await j.resolveSelf!()).toBe("acc-123");
    expect(calls).toBe(1);
  });

  it("normalize surfaces the assignee accountId", async () => {
    const f: FetchLike = async (url) => jsonResponse({
      key: "CRN-1",
      fields: { summary: "s", status: { statusCategory: { key: "new" } },
        updated: "2026-07-26T00:00:00.000+0000",
        assignee: { accountId: "acc-9" } },
    });
    const j = makeJira(f);
    expect((await j.getIssue("CRN-1")).assignee).toBe("acc-9");
  });

  it("updateIssue writes assignee as {accountId}, resolving an email first", async () => {
    const puts: unknown[] = [];
    const f: FetchLike = async (url, init) => {
      const u = String(url);
      if (u.includes("/user/search")) return jsonResponse([{ accountId: "acc-77" }]);
      if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return jsonResponse({}); }
      return jsonResponse({ key: "CRN-1", fields: { summary: "s",
        status: { statusCategory: { key: "new" } },
        updated: "2026-07-26T00:00:00.000+0000" } });
    };
    const j = makeJira(f);
    await j.updateIssue("CRN-1", { assignee: "user@example.com" });
    expect(puts[0]).toMatchObject({ fields: { assignee: { accountId: "acc-77" } } });
  });
```

(`jsonResponse` = whatever helper the file already uses to fabricate a 200 JSON `Response`; reuse it verbatim.)

- [ ] **Step 2: Run** `npx vitest run test/jira.unit.test.ts` — expect FAIL.

- [ ] **Step 3: Implement in `jira.ts`**

`JiraIssueFields` gains `assignee?: { accountId?: string } | null;`
`normalize` gains `assignee: f.assignee?.accountId ?? undefined,`
`getIssue`/`listIssues` field lists gain `,assignee`.

New members:

```ts
  private self: string | undefined;

  async resolveSelf(): Promise<string | undefined> {
    if (this.self) return this.self;
    const me = await this.api("GET", "/rest/api/3/myself", undefined,
      "jira myself") as { accountId?: string };
    this.self = me.accountId;
    return this.self;
  }

  /** Assignee values may arrive as an email (user.handle) — Jira wants accountId. */
  private async toAccountId(value: string): Promise<string> {
    if (!value.includes("@")) return value;
    const hits = await this.api("GET",
      `/rest/api/3/user/search?query=${encodeURIComponent(value)}`, undefined,
      "jira user_search") as Array<{ accountId?: string }>;
    const id = hits[0]?.accountId;
    if (!id) {
      throw new CairnError("NOT_FOUND", `no Jira user matches '${value}'`,
        "set user.handle in cairn.json to a Jira accountId or exact email");
    }
    return id;
  }
```

`updateIssue`, with the other field mappings:

```ts
    if (patch.assignee !== undefined) {
      fields.assignee = { accountId: await this.toAccountId(patch.assignee) };
    }
```

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green.
- [ ] **Step 5: Commit** `feat(jira): assignee read/write + resolveSelf via /myself`

---

### Task 3: GitHub + Azure Boards resolveSelf

**Files:**
- Modify: `server/src/tracker/adapters/github.ts`
- Modify: `server/src/tracker/adapters/azure-boards.ts`
- Test: `server/test/github.unit.test.ts`, `server/test/azure-boards.unit.test.ts` (extend, each file's existing mock pattern)

**Interfaces:**
- Produces: GitHub `resolveSelf()` → `login` from `GET /user`; Azure `resolveSelf()` → `authenticatedUser.properties.Account.$value ?? authenticatedUser.providerDisplayName` from `GET <org>/_apis/connectionData`.

- [ ] **Step 1: Failing tests** — one per adapter, same shape as the Jira memoization test: mock the identity endpoint, assert the identifier comes back and the endpoint is hit once across two calls. Read each unit-test file first and reuse its adapter-construction helper.

- [ ] **Step 2: Run both test files** — expect FAIL.

- [ ] **Step 3: Implement** — memoized `resolveSelf` on each adapter, hitting the endpoint named above through the adapter's existing `api`/fetch helper, returning `undefined` (not throwing) when the response lacks the field.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green.
- [ ] **Step 5: Commit** `feat(tracker): resolveSelf for github and azure-boards`

---

### Task 4: Server hook in issue_update

**Files:**
- Modify: `server/src/index.ts` (issue_update handler, ~line 224)
- Test: `server/test/mcp.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveSelf` through CachedTracker; `loadConfig(d).user?.handle`.
- Produces: `issue_update` result gains `autoAssigned: true` when the hook fired.

- [ ] **Step 1: Failing tests** (append to `mcp.test.ts`; harness runs on FakeTracker where `resolveSelf` → `"fake-user"`)

```ts
  it("claiming an unassigned issue auto-assigns the working user", async () => {
    const made = await call("issue_create", { title: "claim me" });
    const wip = await call("issue_update", { id: made.json.id, state: "in_progress" });
    expect(wip.json.assignee).toBe("fake-user");
    expect(wip.json.autoAssigned).toBe(true);
  });

  it("an explicit assignee wins over auto-assign", async () => {
    const made = await call("issue_create", { title: "explicit" });
    const wip = await call("issue_update",
      { id: made.json.id, state: "in_progress", assignee: "someone-else" });
    expect(wip.json.assignee).toBe("someone-else");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("an already-assigned issue is left untouched on claim", async () => {
    const made = await call("issue_create", { title: "taken" });
    await call("issue_update", { id: made.json.id, assignee: "owner" });
    const wip = await call("issue_update", { id: made.json.id, state: "in_progress" });
    expect(wip.json.assignee).toBe("owner");
    expect(wip.json.autoAssigned).toBeUndefined();
  });

  it("non-claim transitions never auto-assign", async () => {
    const made = await call("issue_create", { title: "close only" });
    const closed = await call("issue_update", { id: made.json.id, state: "closed" });
    expect(closed.json.assignee).toBeUndefined();
  });
```

- [ ] **Step 2: Run** `npx vitest run test/mcp.test.ts` — expect FAIL.

- [ ] **Step 3: Implement** — in the issue_update handler, before `updateIssue`:

```ts
      const tracker = await getTracker(d);
      let autoAssigned = false;
      if (patch.state === "in_progress" && patch.assignee === undefined) {
        // best-effort claim attribution — identity failures never block the claim
        try {
          const current = await tracker.getIssue(id);
          if (!current.assignee) {
            const who = loadConfig(d).user?.handle ?? await tracker.resolveSelf?.();
            if (who) { patch.assignee = who; autoAssigned = true; }
          }
        } catch { /* claim proceeds unassigned */ }
      }
      const result = await tracker.updateIssue(id, patch);
```

and fold into the return: `return { ...result, ...(autoAssigned ? { autoAssigned: true } : {}) };`
(The handler currently calls `(await getTracker(d)).updateIssue(...)` inline — restructure to the shape above, keeping `snapshotNote`/`refreshHandoff` untouched.)

Note: the harness project's cairn.json must NOT set `user.handle`, or the fake-user assertions change — check the fixture; if it sets one, assert on that handle instead.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green.
- [ ] **Step 5: Commit** `feat(server): auto-assign the working user when claiming an unassigned issue`

---

### Task 5: Docs

**Files:**
- Modify: `docs/01-runbook.md` (work/claim semantics + config table `user.handle` row if present — `grep -n "user.handle\|handle" docs/01-runbook.md`)

- [ ] **Step 1:** Document: claims auto-assign to the working user (credentials-derived identity, `user.handle` override, backends: Jira/GitHub/Azure — GitLab/ClickUp pending), never overrides an existing assignee, `autoAssigned: true` on the result.
- [ ] **Step 2: Commit** `docs: auto-assign-on-claim semantics`

---

## Verification

- Full suite + typecheck green.
- Live Jira smoke (env vars present locally): create scratch issue in CRN, claim via `issue_update`, confirm assignee lands in Jira UI/API, close scratch issue.
- Close CRN-34 with summary + time.
