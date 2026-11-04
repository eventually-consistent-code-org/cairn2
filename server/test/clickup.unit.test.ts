import { describe, it, expect } from "vitest";
import { ClickUpTracker } from "../src/tracker/adapters/clickup.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const cuTask = (over: Record<string, unknown> = {}) => ({
  id: "abc123", name: "t", description: "b",
  status: { status: "to do", type: "open" },
  tags: [{ name: "cairn-test" }],
  list: { id: "900" },
  assignees: [],
  date_updated: "1700000000000",
  url: "https://app.clickup.com/t/abc123",
  ...over,
});

const cfg = {
  defaultListId: "900",
  folderId: "folder1",
  tokenEnv: "CLICKUP_TOKEN",
  statuses: { open: "to do", in_progress: "in progress", closed: "complete" },
};

describe("ClickUpTracker mapping", () => {
  it("sends the raw token as Authorization header (no Bearer prefix)", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(cuTask()), { status: 200 });
    };
    const t = new ClickUpTracker(cfg, f, () => "tok123");
    await t.getIssue("abc123");
    expect(auth).toBe("tok123");
  });

  it("converts date_updated (unix-ms string) to ISO-8601", async () => {
    const { f } = fixtureFetch([{ status: 200, body: cuTask({ date_updated: "1700000000000" }) }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const issue = await t.getIssue("abc123");
    expect(issue.updatedAt).toBe(new Date(1700000000000).toISOString());
  });

  it("createIssue without phase posts to the defaultListId", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask() }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.createIssue({ title: "t", body: "b" });
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/900/task");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ name: "t", description: "b" });
  });

  it("createIssue with phase posts to the phase (list) id", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask({ list: { id: "555" } }) }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.createIssue({ title: "t", phase: "555" });
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/555/task");
  });

  it("getIssue maps status.type=open to state=open", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "to do", type: "open" } }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect((await t.getIssue("abc123")).category).toBe("open");
  });

  it("getIssue maps status.type=done/closed to state=closed", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "complete", type: "done" } }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect((await t.getIssue("abc123")).category).toBe("closed");

    const { f: f2 } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "closed", type: "closed" } }) },
    ]);
    const t2 = new ClickUpTracker(cfg, f2, () => "tok");
    expect((await t2.getIssue("abc123")).category).toBe("closed");
  });

  it("getIssue maps custom status matching statuses.in_progress (case-insensitive) to in_progress", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "In Progress", type: "custom" } }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect((await t.getIssue("abc123")).category).toBe("in_progress");
  });

  it("getIssue maps custom status NOT matching statuses.in_progress to open", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "blocked", type: "custom" } }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect((await t.getIssue("abc123")).category).toBe("open");
  });

  it("updateIssue(state=in_progress) PUTs status: statuses.in_progress", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask() }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.updateIssue("abc123", { state: "in_progress" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/task/abc123");
    expect(calls[0].body).toMatchObject({ status: "in progress" });
  });

  it("updateIssue(state=open) PUTs status: statuses.open", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask() }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.updateIssue("abc123", { state: "open" });
    expect(calls[0].body).toMatchObject({ status: "to do" });
  });

  it("closeIssue PUTs status: statuses.closed", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "complete", type: "done" } }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const closed = await t.closeIssue("abc123");
    expect(calls[0].body).toMatchObject({ status: "complete" });
    expect(closed.category).toBe("closed");
  });

  it("listIssues(no phase) GETs the defaultListId with include_closed=true", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { tasks: [cuTask()] } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const issues = await t.listIssues();
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/900/task?include_closed=true");
    expect(calls[0].method).toBe("GET");
    expect(issues).toHaveLength(1);
  });

  it("listIssues(phase) GETs /list/{id}/task?include_closed=true", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { tasks: [cuTask({ list: { id: "555" } })] } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.listIssues({ phase: "555" });
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/list/555/task?include_closed=true");
  });

  it("listIssues rejects an injection-shaped phase id before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await expect(t.listIssues({ phase: "../../team/x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("createPhase POSTs /folder/{folderId}/list when configured with folderId", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: "777", name: "Phase 1" } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const ph = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/folder/folder1/list");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ name: "Phase 1" });
    expect(ph).toMatchObject({ id: "777", name: "Phase 1" });
  });

  it("createPhase POSTs /space/{spaceId}/list when configured with spaceId", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: "778", name: "Phase 2" } }]);
    const spaceCfg = { ...cfg, folderId: undefined, spaceId: "space1" };
    const t = new ClickUpTracker(spaceCfg, f, () => "tok");
    await t.createPhase("Phase 2");
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/space/space1/list");
  });

  it("listPhases GETs /folder/{id}/lists when configured with folderId", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { lists: [{ id: "777", name: "Phase 1" }] } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const phases = await t.listPhases();
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/folder/folder1/lists");
    expect(phases).toEqual([{ id: "777", name: "Phase 1", state: "open" }]);
  });

  it("listPhases GETs /space/{id}/lists when configured with spaceId", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { lists: [] } }]);
    const spaceCfg = { ...cfg, folderId: undefined, spaceId: "space1" };
    const t = new ClickUpTracker(spaceCfg, f, () => "tok");
    await t.listPhases();
    expect(calls[0].url).toBe("https://api.clickup.com/api/v2/space/space1/lists");
  });

  it("reads tags[].name as labels", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ tags: [{ name: "bug" }, { name: "p1" }] }) },
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect((await t.getIssue("abc123")).labels).toEqual(["bug", "p1"]);
  });

  it("updateIssue reconciles tags: adds missing and removes extra when patch.labels is provided", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: cuTask({ tags: [{ name: "keep" }, { name: "drop-me" }] }) }, // GET (no body change, since only labels patched)
      { status: 200, body: {} }, // DELETE drop-me
      { status: 200, body: {} }, // POST add-me
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.updateIssue("abc123", { labels: ["keep", "add-me"] });

    const deleteCall = calls.find((c) => c.method === "DELETE");
    const postCall = calls.find((c) => c.method === "POST");
    expect(deleteCall?.url).toBe("https://api.clickup.com/api/v2/task/abc123/tag/drop-me");
    expect(postCall?.url).toBe("https://api.clickup.com/api/v2/task/abc123/tag/add-me");
  });

  it("updateIssue does NOT touch tags when patch.labels is undefined", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask() }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.updateIssue("abc123", { title: "new title" });
    expect(calls.some((c) => c.method === "DELETE" || c.url.includes("/tag/"))).toBe(false);
  });

  it("updateIssue silently ignores assignee patch; preserves title in PUT body", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: cuTask({ name: "t" }) }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await t.updateIssue("abc123", { title: "t", assignee: "someone" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toMatchObject({ name: "t" });
    expect(calls[0].body).not.toHaveProperty("assignees");
  });

  it("rejects non-alphanumeric issue ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await expect(t.getIssue("abc/123")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("caps listIssues at 100 and logs a truncation warning when exactly at the cap", async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => cuTask({ id: `id${i}` }));
    const { f } = fixtureFetch([{ status: 200, body: { tasks } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const errSpy = { called: false };
    const origError = console.error;
    console.error = (...args: unknown[]) => { errSpy.called = true; origError(...args); };
    try {
      const issues = await t.listIssues();
      expect(issues).toHaveLength(100);
      expect(errSpy.called).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("throws AUTH_MISSING with zero HTTP calls when token env var is unset", async () => {
    const { f, calls } = fixtureFetch([]);
    const prev = process.env.CLICKUP_TOKEN;
    delete process.env.CLICKUP_TOKEN;
    try {
      const { make, configSchema } = await import("../src/tracker/adapters/clickup.js");
      const parsed = configSchema.parse(cfg);
      const t = make(parsed, f);
      await expect(t.getIssue("abc123")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.CLICKUP_TOKEN = prev;
    }
  });

  it("configSchema requires exactly one of folderId/spaceId", async () => {
    const { configSchema } = await import("../src/tracker/adapters/clickup.js");
    expect(configSchema.safeParse({ defaultListId: "1", folderId: "f1", spaceId: "s1" }).success).toBe(false);
    expect(configSchema.safeParse({ defaultListId: "1" }).success).toBe(false);
    expect(configSchema.safeParse({ defaultListId: "1", folderId: "f1" }).success).toBe(true);
    expect(configSchema.safeParse({ defaultListId: "1", spaceId: "s1" }).success).toBe(true);
  });

  it("milestones are UNSUPPORTED (capability-flagged fallback)", async () => {
    const { f } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect(t.capabilities.hasMilestones).toBe(false);
    await expect(t.createMilestone("v1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.listMilestones()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(t.completeMilestone("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("closePhase is UNSUPPORTED (phase primitive has no closed state)", async () => {
    const { f } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect(t.capabilities.hasPhaseClose).toBe(false);
    await expect(t.closePhase("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("commentIssue POSTs a task comment", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: 888 } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const c = await t.commentIssue("abc123", "plain note");
    expect(calls[0].url).toContain("/task/abc123/comment");
    expect(calls[0].body).toEqual({ comment_text: "plain note" });
    expect(c.id).toBe("888");
  });
});

describe("ClickUpTracker custom states", () => {
  it("custom statuses-map key writes the mapped native status", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "code review", type: "custom" } }) },
    ]);
    const t = new ClickUpTracker({ ...cfg, statuses: { ...cfg.statuses, review: "code review" } }, f, () => "tok");
    await t.updateIssue("abc123", { state: "review" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ status: "code review" });
  });

  it("unknown custom state is CONFIG_INVALID", async () => {
    const { f } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await expect(t.updateIssue("abc123", { state: "wat" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("ClickUpTracker probe (CRN-48)", () => {
  it("ok on a 200 from /list/{defaultListId} -- validates the target, not just the token", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: "900", name: "List" } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await expect(t.probe!()).resolves.toEqual({ verdict: "ok" });
    expect(calls[0].url).toContain("/list/900");
  });

  it("bad_host on a valid token but a nonexistent list id (live-verification gap)", async () => {
    // A valid token passes /team every time -- probing /team alone can never
    // catch a typo'd defaultListId. /list/{defaultListId} catches both.
    const f: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("/team")) return new Response(JSON.stringify({ teams: [{ id: "1" }] }), { status: 200 });
      if (u.includes("/list/")) return new Response(JSON.stringify({ err: "List not found" }), { status: 404 });
      throw new Error(`unexpected url in test: ${u}`);
    };
    const t = new ClickUpTracker({ ...cfg, defaultListId: "nonexistent" }, f, () => "tok");
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_host" });
  });

  it("bad_token on a 401 with a plain-rejected-credentials body", async () => {
    const { f } = fixtureFetch([{ status: 401, body: { err: "Token invalid" } }]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_token" });
  });
});

describe("ClickUpTracker re-phase degradation (#142)", () => {
  it("declares hasPhaseReassign: false — a task's list is a creation-time parent", () => {
    const { f } = fixtureFetch([]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    expect(t.capabilities.hasPhaseReassign).toBe(false);
  });

  it("updateIssue ignores patch.phase — no PUT body field, no list-move call", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: cuTask() }, // PUT carries only the title
    ]);
    const t = new ClickUpTracker(cfg, f, () => "tok");
    const issue = await t.updateIssue("abc123", { title: "t2", phase: "901" });
    expect(calls.length).toBe(1);
    expect(calls[0].body).toEqual({ name: "t2" });
    expect(issue.phase).toBe("900"); // unchanged: still the fixture's list
  });
});

describe("ClickUpTracker.stateCategory -- the pre-write question, from the statuses map and data already fetched (#471)", () => {
  // `finish` is the alias a hostile config adds to spell the close another
  // way; `backlog` its harmless twin pointing at the open status
  const aliased = { ...cfg, statuses: { ...cfg.statuses, finish: "complete", backlog: "to do", review: "code review" } };

  it("answers the canonical three, the configured statuses by native name and an alias by its target's category, with no fetch", () => {
    const { f, calls } = fixtureFetch([]);
    const t = new ClickUpTracker(aliased, f, () => "tok");
    expect(t.stateCategory("open")).toBe("open");
    expect(t.stateCategory("in_progress")).toBe("in_progress");
    expect(t.stateCategory("closed")).toBe("closed");
    expect(t.stateCategory("complete")).toBe("closed");
    expect(t.stateCategory("COMPLETE")).toBe("closed");
    expect(t.stateCategory("in progress")).toBe("in_progress");
    expect(t.stateCategory("to do")).toBe("open");
    expect(t.stateCategory("finish")).toBe("closed");
    expect(t.stateCategory("backlog")).toBe("open");
    expect(calls.length).toBe(0);
  });

  it("an alias whose target ClickUp has not shown is undefined until a task read carries that status with its type", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: cuTask({ status: { status: "code review", type: "custom" } }) },
      { status: 200, body: cuTask({ status: { status: "archived", type: "done" } }) },
    ]);
    const t = new ClickUpTracker(aliased, f, () => "tok");
    expect(t.stateCategory("review")).toBeUndefined();
    expect(t.stateCategory("Finito")).toBeUndefined();
    await t.getIssue("abc123");
    await t.getIssue("abc124");
    // a custom-type status that is not the configured in_progress buckets to open, as normalize does
    expect(t.stateCategory("review")).toBe("open");
    expect(t.stateCategory("code review")).toBe("open");
    expect(t.stateCategory("archived")).toBe("closed");
    expect(t.stateCategory("Finito")).toBeUndefined();
  });
});
