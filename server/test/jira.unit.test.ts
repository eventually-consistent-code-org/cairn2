import { describe, it, expect, vi } from "vitest";
import { JiraTracker } from "../src/tracker/adapters/jira.js";
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
    // 204/205/304 responses must not carry a body, or the Response ctor throws.
    const noBody = fx.status === 204 || fx.status === 205 || fx.status === 304;
    return new Response(noBody ? null : JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const BASE = "https://o.atlassian.net";

const cfg = {
  baseUrl: BASE,
  projectKey: "CHN",
  issueType: "Task",
  emailEnv: "JIRA_EMAIL",
  tokenEnv: "JIRA_API_TOKEN",
  transitions: { in_progress: "In Progress", closed: "Done" },
};

const adfBody = (text: string) => ({
  type: "doc", version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Constructs a JiraTracker against project "PROJ" for the milestone/closePhase tests. */
function makeJira(f: FetchLike) {
  return new JiraTracker(
    { ...cfg, projectKey: "PROJ", baseUrl: "https://x.atlassian.net" },
    f,
    () => ({ email: "e", token: "t" }),
  );
}

const jiraIssue = (over: Record<string, unknown> = {}) => ({
  key: "CHN-101",
  fields: {
    summary: "t",
    description: adfBody("b"),
    status: { statusCategory: { key: "new" } },
    updated: "2026-07-12T00:00:00.000+0000",
    labels: ["cairn-test"],
    parent: undefined,
    ...over,
  },
});

describe("JiraTracker mapping", () => {
  it("createIssue POSTs an ADF-wrapped body to /rest/api/3/issue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-101" } },
      { status: 200, body: { values: [] } }, // board detect: no board configured
      { status: 200, body: jiraIssue() },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({
      fields: {
        project: { key: "CHN" },
        summary: "t",
        description: adfBody("b"),
        issuetype: { name: "Task" },
      },
    });
    expect(issue.id).toBe("CHN-101");
  });

  it("createIssue with phase sets fields.parent = { key }", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-102" } },
      { status: 200, body: { values: [] } }, // board detect: no board configured
      { status: 200, body: jiraIssue({ key: "CHN-102" }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.createIssue({ title: "t", phase: "CHN-1" });
    expect(calls[0].body).toMatchObject({ fields: { parent: { key: "CHN-1" } } });
  });

  it("sends Basic auth header base64(email:token)", async () => {
    let auth = "";
    const f: FetchLike = async (_u, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(jiraIssue()), { status: 200 });
    };
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.getIssue("CHN-101");
    const expected = "Basic " + Buffer.from("e@x.com:tok").toString("base64");
    expect(auth).toBe(expected);
  });

  it.each([
    ["new", "open"],
    ["indeterminate", "in_progress"],
    ["done", "closed"],
  ] as const)("statusCategory.key=%s maps to state=%s", async (cat, expected) => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: cat } } }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.state).toBe(expected);
  });

  it("getIssue extracts plain text from ADF description recursively", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ description: adfBody("hello world") }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.body).toContain("hello world");
  });

  it("updateIssue(state=in_progress) does GET transitions then POSTs matching id", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "11", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "indeterminate" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.updateIssue("CHN-101", { state: "in_progress" });

    const getTransitionsCall = calls.find((c) => c.method === "GET" && c.url.includes("/transitions"));
    expect(getTransitionsCall).toBeDefined();
    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "11" } });
  });

  it("updateIssue(state=open) from in_progress transitions to a status whose category is 'new'", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "11", name: "Start Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
            { id: "31", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "new" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.updateIssue("CHN-101", { state: "open" });

    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "31" } });
  });

  it("closeIssue transitions to the configured closed transition name", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          transitions: [
            { id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
          ],
        },
      },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "done" } } }) }, // GET after
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const closed = await t.closeIssue("CHN-101");
    const postTransitionCall = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(postTransitionCall!.body).toMatchObject({ transition: { id: "21" } });
    expect(closed.state).toBe("closed");
  });

  it("updateIssue logs (does not throw) when no matching transition is found", async () => {
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: { transitions: [{ id: "21", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } }] },
      },
      { status: 200, body: jiraIssue({ status: { statusCategory: { key: "new" } } }) }, // GET after (no transition POSTed)
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.updateIssue("CHN-101", { state: "in_progress" })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("CHN-101"));
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/transitions"))).toBe(false);
    spy.mockRestore();
  });

  it("listIssues(phase) POSTs a JQL search with parent = <KEY> and maxResults 100", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issues = await t.listIssues({ phase: "CHN-1" });
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/search/jql`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ jql: "parent = CHN-1", maxResults: 100 });
    expect(issues).toHaveLength(1);
  });

  it("listIssues() without a phase excludes epics from the JQL (epics are phases, not issues)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listIssues();
    expect(calls[0].body).toMatchObject({ jql: "project = CHN AND issuetype != Epic" });
  });

  it("listIssues(phase) does NOT add the epic-exclusion clause (parent filter already excludes epics)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue()] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listIssues({ phase: "CHN-1" });
    expect(calls[0].body).toMatchObject({ jql: "parent = CHN-1" });
  });

  it("listIssues warns via console.error when results are truncated at the 100 cap", async () => {
    const many = Array.from({ length: 100 }, (_, i) => jiraIssue({ key: `CHN-${i}` }));
    const { f } = fixtureFetch([
      { status: 200, body: { issues: many, total: 250 } },
    ]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issues = await t.listIssues();
    expect(issues).toHaveLength(100);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("createPhase creates an Epic-typed issue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-1" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const phase = await t.createPhase("Phase 1");
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue`);
    expect(calls[0].body).toMatchObject({
      fields: { issuetype: { name: "Epic" }, summary: "Phase 1", project: { key: "CHN" } },
    });
    expect(phase).toMatchObject({ id: "CHN-1", name: "Phase 1" });
  });

  it("listPhases JQL-searches for issuetype = Epic", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { issues: [jiraIssue({ key: "CHN-1", summary: "Phase 1" })] } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await t.listPhases();
    expect(calls[0].body).toMatchObject({ jql: expect.stringContaining("issuetype = Epic") });
  });

  it("normalizes Jira's +0000 offset timestamps to valid ISO-8601", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ updated: "2026-07-12T10:30:00.000+0000" }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.updatedAt).toBe("2026-07-12T10:30:00.000+00:00");
    expect(Number.isNaN(Date.parse(issue.updatedAt))).toBe(false);
  });

  it("rejects malformed issue ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.getIssue("not-a-key!!")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("rejects a non-key phase filter before any HTTP (JQL injection guard)", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e@x.com", token: "tok" }));
    await expect(t.listIssues({ phase: "CHN-1 OR project = X" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("throws AUTH_MISSING with zero HTTP calls when email/token env vars are absent", async () => {
    const { f, calls } = fixtureFetch([]);
    const original = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    try {
      const { make } = await import("../src/tracker/adapters/jira.js");
      const t = make(cfg, f);
      await expect(t.getIssue("CHN-101")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (original.email !== undefined) process.env.JIRA_EMAIL = original.email;
      if (original.token !== undefined) process.env.JIRA_API_TOKEN = original.token;
    }
  });

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

  it("commentIssue POSTs an ADF-wrapped comment", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: { id: "10500" } }]);
    const t = makeJira(f);
    const c = await t.commentIssue("PROJ-9", "plain note");
    expect(calls[0].url).toContain("/rest/api/3/issue/PROJ-9/comment");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ body: adfBody("plain note") });
    expect(c.id).toBe("10500");
  });

  it("logWork POSTs a Jira worklog with timeSpentSeconds", async () => {
    const { f, calls } = fixtureFetch([{ status: 201, body: {} }]);
    const t = makeJira(f);
    await t.logWork!("PROJ-7", 90);
    const call = calls.find((c) => c.url.endsWith("/rest/api/3/issue/PROJ-7/worklog"));
    expect(call).toBeDefined();
    expect(call!.method).toBe("POST");
    expect(call!.body).toEqual({ timeSpentSeconds: 5400 });
  });

  it("logWork rejects malformed issue ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = makeJira(f);
    await expect(t.logWork!("not-a-key!!", 90)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("declares hasWorklog", () => {
    const { f } = fixtureFetch([]);
    const t = makeJira(f);
    expect(t.capabilities.hasWorklog).toBe(true);
  });
});

describe("JiraTracker identity + assignee", () => {
  it("resolveSelf returns the accountId from /myself and memoizes", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { accountId: "acc-123" } }]);
    const t = makeJira(f);
    expect(await t.resolveSelf!()).toBe("acc-123");
    expect(await t.resolveSelf!()).toBe("acc-123");
    expect(calls.filter((c) => c.url.includes("/rest/api/3/myself")).length).toBe(1);
  });

  it("normalize surfaces the assignee accountId", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ assignee: { accountId: "acc-9" } }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect((await t.getIssue("CHN-101")).assignee).toBe("acc-9");
  });

  it("updateIssue writes assignee as {accountId}, resolving an email first", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: [{ accountId: "acc-77" }] },   // user search
      { status: 204, body: null },                        // PUT fields
      { status: 200, body: jiraIssue({ assignee: { accountId: "acc-77" } }) }, // re-get
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const updated = await t.updateIssue("CHN-101", { assignee: "user@example.com" });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ fields: { assignee: { accountId: "acc-77" } } });
    expect(updated.assignee).toBe("acc-77");
  });

  it("updateIssue passes a bare accountId through without a search", async () => {
    const { f, calls } = fixtureFetch([
      { status: 204, body: null },
      { status: 200, body: jiraIssue({ assignee: { accountId: "acc-55" } }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.updateIssue("CHN-101", { assignee: "acc-55" });
    expect(calls.some((c) => c.url.includes("user/search"))).toBe(false);
  });
});

describe("JiraTracker probe (CRN-48)", () => {
  it("ok on a 200 from /project/{projectKey} -- validates the target, not just the token", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: "10001" } }]);
    const t = makeJira(f);
    await expect(t.probe!()).resolves.toEqual({ verdict: "ok" });
    expect(calls[0].url).toContain("/rest/api/3/project/PROJ");
  });

  it("bad_host on a valid token but a nonexistent project key (live-verification gap)", async () => {
    // A valid token passes /myself every time -- probing /myself alone can
    // never catch a typo'd projectKey. /project/{projectKey} catches both.
    const f: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("/rest/api/3/myself")) {
        return new Response(JSON.stringify({ accountId: "acc-123" }), { status: 200 });
      }
      if (u.includes("/rest/api/3/project/")) {
        return new Response(JSON.stringify({ errorMessages: ["No project could be found"] }), { status: 404 });
      }
      throw new Error(`unexpected url in test: ${u}`);
    };
    const t = makeJira(f);
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_host" });
  });

  it("bad_host on a network error", async () => {
    vi.useFakeTimers();
    try {
      const f: FetchLike = async () => { throw new Error("ENOTFOUND o.atlassian.net"); };
      const t = makeJira(f);
      const pending = t.probe!();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ verdict: "bad_host" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bad_token on a 401 with a plain-rejected-credentials body", async () => {
    const { f } = fixtureFetch([{ status: 401, body: { message: "the token was rejected" } }]);
    const t = makeJira(f);
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_token" });
  });

  it("missing_scope on a 403 with a scope-shaped body", async () => {
    const { f } = fixtureFetch([
      { status: 403, body: { message: "missing required scope for this operation" } },
    ]);
    const t = makeJira(f);
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "missing_scope" });
  });

  it("rate_limited on an exhausted 429", async () => {
    vi.useFakeTimers();
    try {
      const f: FetchLike = async () => new Response(JSON.stringify({}), { status: 429 });
      const t = makeJira(f);
      const pending = t.probe!();
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ verdict: "rate_limited" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("JiraTracker sprint awareness", () => {
  const scrumBoard = { values: [{ id: 7, type: "scrum" }] };
  const activeSprint = { values: [{ id: 42 }] };

  it("scrum board + active sprint: create lands the issue in the sprint", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-201" } },
      { status: 200, body: scrumBoard },        // GET board?projectKeyOrId
      { status: 200, body: activeSprint },      // GET board/7/sprint?state=active
      { status: 204, body: null },              // POST sprint/42/issue
      { status: 200, body: { ...jiraIssue(), key: "CHN-201" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t" });
    expect(calls[1].url).toBe(`${BASE}/rest/agile/1.0/board?projectKeyOrId=CHN`);
    expect(calls[2].url).toBe(`${BASE}/rest/agile/1.0/board/7/sprint?state=active`);
    expect(calls[3].url).toBe(`${BASE}/rest/agile/1.0/sprint/42/issue`);
    expect(calls[3].method).toBe("POST");
    expect(calls[3].body).toEqual({ issues: ["CHN-201"] });
    expect(issue.id).toBe("CHN-201");
  });

  it("kanban board: no sprint calls beyond board detect", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-202" } },
      { status: 200, body: { values: [{ id: 8, type: "kanban" }] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-202" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "t" });
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.url.includes("/sprint"))).toBe(false);
  });

  it("scrum board with no active sprint: create succeeds, no sprint POST", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-203" } },
      { status: 200, body: scrumBoard },
      { status: 200, body: { values: [] } },    // no active sprint
      { status: 200, body: { ...jiraIssue(), key: "CHN-203" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "t" });
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/sprint/"))).toHaveLength(0);
  });

  it("board + active sprint are cached across creates (one detect, one sprint lookup)", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-204" } },
      { status: 200, body: scrumBoard },
      { status: 200, body: activeSprint },
      { status: 204, body: null },
      { status: 200, body: { ...jiraIssue(), key: "CHN-204" } },
      { status: 201, body: { key: "CHN-205" } },
      { status: 204, body: null },              // straight to sprint assign
      { status: 200, body: { ...jiraIssue(), key: "CHN-205" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "a" });
    await t.createIssue({ title: "b" });
    expect(calls.filter((c) => c.url.includes("/rest/agile/1.0/board?"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes("sprint?state=active"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/sprint/42/issue"))).toHaveLength(2);
  });

  it("agile API failure never aborts the create — warning only", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-206" } },
      { status: 400, body: { errorMessages: ["agile unavailable"] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-206" } },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t" });
    expect(issue.id).toBe("CHN-206");
    expect(errSpy).toHaveBeenCalled();
    expect(calls).toHaveLength(3);
    errSpy.mockRestore();
  });

  it("config boardId skips discovery and fetches that board directly", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-207" } },
      { status: 200, body: { id: 5, type: "scrum" } },   // GET board/5
      { status: 200, body: activeSprint },
      { status: 204, body: null },
      { status: 200, body: { ...jiraIssue(), key: "CHN-207" } },
    ]);
    const t = new JiraTracker({ ...cfg, boardId: 5 }, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "t" });
    expect(calls[1].url).toBe(`${BASE}/rest/agile/1.0/board/5`);
  });

  it("createPhase (Epic) is never sprinted", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-300" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createPhase("Phase 9");
    expect(calls).toHaveLength(1);
  });
});

describe("JiraTracker estimates", () => {
  const fieldList = [
    { id: "customfield_10016", name: "Story point estimate" },
    { id: "customfield_10020", name: "Sprint" },
  ];
  const estimated = (key: string) => ({
    ...jiraIssue(), key,
    fields: {
      ...jiraIssue().fields,
      customfield_10016: 3,
      timetracking: { originalEstimateSeconds: 5400 },
    },
  });

  it("createIssue with points+minutes discovers the story-point field and writes both", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: fieldList },                 // GET /rest/api/3/field
      { status: 201, body: { key: "CHN-401" } },
      { status: 200, body: { values: [] } },            // board detect
      { status: 200, body: estimated("CHN-401") },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t", estimate: { points: 3, minutes: 90 } });
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/field`);
    expect(calls[1].body).toMatchObject({ fields: {
      customfield_10016: 3,
      timetracking: { originalEstimate: "90m" },
    } });
    expect(issue.estimate).toMatchObject({ points: 3, minutes: 90 });
  });

  it("minutes-only estimate skips field discovery entirely", async () => {
    const { f, calls } = fixtureFetch([
      { status: 201, body: { key: "CHN-402" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-402" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "t", estimate: { minutes: 45 } });
    expect(calls.some((c) => c.url.endsWith("/rest/api/3/field"))).toBe(false);
    expect(calls[0].body).toMatchObject({ fields: { timetracking: { originalEstimate: "45m" } } });
  });

  it("story-point field not found: points skipped with a warning, minutes still write", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: [{ id: "customfield_9", name: "Unrelated" }] },
      { status: 201, body: { key: "CHN-403" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-403" } },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.createIssue({ title: "t", estimate: { points: 8, minutes: 30 } });
    const created = calls.find((c) => c.method === "POST" && c.url.endsWith("/rest/api/3/issue"))!;
    expect(JSON.stringify(created.body)).not.toContain("customfield");
    expect(created.body).toMatchObject({ fields: { timetracking: { originalEstimate: "30m" } } });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  // #231 — the silent-loss path. hasEstimates stays true (minutes always land),
  // so the loss has to travel back with the call or the caller never learns.
  it("no story-point field: the create RESULT says points were dropped and minutes landed", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: [{ id: "customfield_9", name: "Unrelated" }] },
      { status: 201, body: { key: "CHN-404" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-404" } },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t", estimate: { points: 8, minutes: 30 } });
    errSpy.mockRestore();
    expect(issue.estimateSkipped).toContain("story-point field");
    expect(issue.estimateSkipped).toContain("minutes landed");
  });

  it("no story-point field, points only: the note claims no surviving half", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: [{ id: "customfield_9", name: "Unrelated" }] },
      { status: 201, body: { key: "CHN-405" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-405" } },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t", estimate: { points: 8 } });
    errSpy.mockRestore();
    expect(issue.estimateSkipped).toContain("points dropped;");
    expect(issue.estimateSkipped).not.toContain("minutes landed");
  });

  it("no story-point field: updateIssue reports the drop too", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: [{ id: "customfield_9", name: "Unrelated" }] },
      { status: 204, body: null },
      { status: 200, body: { ...jiraIssue(), fields: {
        ...jiraIssue().fields, timetracking: { originalEstimateSeconds: 1800 },
      } } },
    ]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.updateIssue("CHN-101", { estimate: { points: 5, minutes: 30 } });
    errSpy.mockRestore();
    expect(issue.estimateSkipped).toContain("minutes landed");
    // the half that DID land is still on the issue — this is a partial skip
    expect(issue.estimate).toMatchObject({ minutes: 30 });
  });

  it("site WITH a story-point field reports no skip on either write", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: fieldList },
      { status: 201, body: { key: "CHN-406" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: estimated("CHN-406") },
      { status: 204, body: null },
      { status: 200, body: estimated("CHN-406") },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const created = await t.createIssue({ title: "t", estimate: { points: 3, minutes: 90 } });
    expect(created.estimateSkipped).toBeUndefined();
    const updated = await t.updateIssue("CHN-406", { estimate: { points: 3 } });
    expect(updated.estimateSkipped).toBeUndefined();
  });

  it("minutes-only never reports a skip — timetracking is standard on every site", async () => {
    const { f } = fixtureFetch([
      { status: 201, body: { key: "CHN-407" } },
      { status: 200, body: { values: [] } },
      { status: 200, body: { ...jiraIssue(), key: "CHN-407" } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.createIssue({ title: "t", estimate: { minutes: 45 } });
    expect(issue.estimateSkipped).toBeUndefined();
  });

  it("updateIssue(estimate) writes the discovered field + timetracking", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: fieldList },
      { status: 204, body: null },                      // PUT
      { status: 200, body: estimated("CHN-101") },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    await t.updateIssue("CHN-101", { estimate: { points: 5, minutes: 120 } });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({ fields: {
      customfield_10016: 5,
      timetracking: { originalEstimate: "120m" },
    } });
  });

  it("readback: minutes always (timetracking); points once the field cache is warm", async () => {
    // Cold instance — no discovery on plain reads, minutes still map.
    const { f: cold } = fixtureFetch([
      { status: 200, body: { ...jiraIssue(), fields: {
        ...jiraIssue().fields, timetracking: { originalEstimateSeconds: 5400 },
      } } },
    ]);
    const t1 = new JiraTracker(cfg, cold, () => ({ email: "e", token: "t" }));
    const got = await t1.getIssue("CHN-101");
    expect(got.estimate).toMatchObject({ minutes: 90 });
    expect(got.estimate?.points).toBeUndefined();

    // Warm instance — after an estimate write, reads request + map the custom field.
    const { f: warm, calls } = fixtureFetch([
      { status: 200, body: fieldList },
      { status: 204, body: null },
      { status: 200, body: estimated("CHN-101") },
      { status: 200, body: estimated("CHN-101") },
    ]);
    const t2 = new JiraTracker(cfg, warm, () => ({ email: "e", token: "t" }));
    await t2.updateIssue("CHN-101", { estimate: { points: 3 } });
    const again = await t2.getIssue("CHN-101");
    expect(calls[3].url).toContain("customfield_10016");
    expect(again.estimate).toMatchObject({ points: 3, minutes: 90 });
  });

  it("capabilities declare hasEstimates", () => {
    const { f } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.capabilities.hasEstimates).toBe(true);
  });
});

describe("JiraTracker attachments", () => {
  /** Non-JSON-body-tolerant fixture — multipart uploads record the FormData raw. */
  function rawFetch(fixtures: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string; body?: unknown;
      headers: Record<string, string> }> = [];
    const f: FetchLike = async (url, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
      let body: unknown = init?.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* raw */ } }
      calls.push({ url: String(url), method: init?.method ?? "GET", body, headers: h });
      const fx = fixtures.shift()!;
      return new Response(JSON.stringify(fx.body), { status: fx.status });
    };
    return { f, calls };
  }

  it("attachFile POSTs multipart with the no-check header", async () => {
    const { f, calls } = rawFetch([
      { status: 200, body: [{ id: "10001", filename: "shot.png" }] },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const res = await t.attachFile!("CHN-101", "shot.png", Buffer.from([1, 2]), "image/png");
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue/CHN-101/attachments`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["x-atlassian-token"]).toBe("no-check");
    expect(calls[0].headers["content-type"] ?? "").not.toContain("application/json");
    expect(calls[0].body).toBeInstanceOf(FormData);
    expect(res.id).toBe("10001");
  });

  it("declares hasIssueAttachments", () => {
    const { f } = rawFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.capabilities.hasIssueAttachments).toBe(true);
  });
});

describe("JiraTracker state fidelity", () => {
  it("surfaces the real status name as state, category from the status category", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: { ...jiraIssue(), fields: { ...jiraIssue().fields,
        status: { name: "In Review", statusCategory: { key: "indeterminate" } } } } },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.state).toBe("In Review");
    expect(issue.category).toBe("in_progress");
  });

  it("falls back to the category string when the status has no name", async () => {
    const { f } = fixtureFetch([{ status: 200, body: jiraIssue() }]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.getIssue("CHN-101");
    expect(issue.category).toBe("open");
    expect(issue.state).toBe("open");
  });
});

describe("JiraTracker custom states", () => {
  const cfgReview = { ...cfg, transitions: { in_progress: "In Progress", closed: "Done", review: "In Review" } };

  it("custom state key resolves through the transitions map", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { transitions: [
        { id: "41", name: "Review", to: { name: "In Review", statusCategory: { key: "indeterminate" } } },
      ] } },
      { status: 200, body: {} }, // POST transition
      { status: 200, body: { ...jiraIssue(), fields: { ...jiraIssue().fields,
        status: { name: "In Review", statusCategory: { key: "indeterminate" } } } } },
    ]);
    const t = new JiraTracker(cfgReview, f, () => ({ email: "e", token: "t" }));
    const issue = await t.updateIssue("CHN-101", { state: "review" });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"))!;
    expect(post.body).toMatchObject({ transition: { id: "41" } });
    expect(issue.state).toBe("In Review");
    expect(issue.category).toBe("in_progress");
  });

  it("unmapped custom state falls through as a literal transition name", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { transitions: [
        { id: "9", name: "Blocked", to: { name: "Blocked", statusCategory: { key: "indeterminate" } } },
      ] } },
      { status: 200, body: {} },
      { status: 200, body: jiraIssue() },
    ]);
    const t = new JiraTracker(cfgReview, f, () => ({ email: "e", token: "t" }));
    await t.updateIssue("CHN-101", { state: "Blocked" });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"))!;
    expect(post.body).toMatchObject({ transition: { id: "9" } });
  });
});

describe("JiraTracker scoped-token gateway", () => {
  /** Header-capturing fetch (JSON or FormData bodies) — same idiom as the attachments block. */
  function gatewayFetch(fixtures: Array<{ status: number; body: unknown }>) {
    const calls: Array<{ url: string; method: string; body?: unknown;
      headers: Record<string, string> }> = [];
    const f: FetchLike = async (url, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
      let body: unknown = init?.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* raw */ } }
      calls.push({ url: String(url), method: init?.method ?? "GET", body, headers: h });
      const fx = fixtures.shift()!;
      return new Response(JSON.stringify(fx.body), { status: fx.status });
    };
    return { f, calls };
  }

  const GW_BASE = "https://o.atlassian.net";
  const CLOUD_ID = "cid-123";
  const FIELDS = "summary,description,status,updated,labels,parent,assignee,timetracking";

  function makeGwJira(f: FetchLike, token: string, authMode?: "site" | "gateway") {
    return new JiraTracker(
      { ...cfg, baseUrl: GW_BASE, ...(authMode ? { authMode } : {}) },
      f,
      () => ({ email: "e@x.io", token }),
    );
  }

  it("ATCTT token resolves cloudId via unauthenticated tenant_info, then routes API calls through the gateway with Basic auth", async () => {
    const { f, calls } = gatewayFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: jiraIssue() },
    ]);
    const t = makeGwJira(f, "ATCTTsecret");
    const issue = await t.getIssue("CHN-101");

    expect(calls[0].url).toBe(`${GW_BASE}/_edge/tenant_info`);
    expect(calls[0].headers.authorization).toBeUndefined();

    expect(calls[1].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/CHN-101?fields=${FIELDS}`);
    expect(calls[1].headers.authorization).toBe(`Basic ${Buffer.from("e@x.io:ATCTTsecret").toString("base64")}`);

    // Human-facing link stays on the site host in gateway mode.
    expect(issue.url).toBe(`${GW_BASE}/browse/CHN-101`);
  });

  it("memoizes cloudId across multiple operations — tenant_info fetched exactly once", async () => {
    const { f, calls } = gatewayFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: jiraIssue() },
      { status: 200, body: jiraIssue() },
    ]);
    const t = makeGwJira(f, "ATCTTsecret");
    await t.getIssue("CHN-101");
    await t.getIssue("CHN-101");
    expect(calls.filter((c) => c.url.includes("/_edge/tenant_info")).length).toBe(1);
    expect(calls.filter((c) => c.url.includes("api.atlassian.com")).length).toBe(2);
  });

  it("classic token: zero behavior change — no tenant_info call, site routing as before", async () => {
    const { f, calls } = gatewayFetch([{ status: 200, body: jiraIssue() }]);
    const t = makeGwJira(f, "classic-token-123");
    await t.getIssue("CHN-101");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${GW_BASE}/rest/api/3/issue/CHN-101?fields=${FIELDS}`);
  });

  it("attachFile routes through the gateway too, sharing cloudId resolution with api()", async () => {
    const { f, calls } = gatewayFetch([
      { status: 200, body: { cloudId: CLOUD_ID } },
      { status: 200, body: [{ id: "10001", filename: "shot.png" }] },
    ]);
    const t = makeGwJira(f, "ATCTTsecret");
    const res = await t.attachFile!("CHN-101", "shot.png", Buffer.from([1, 2]), "image/png");
    expect(calls[0].url).toBe(`${GW_BASE}/_edge/tenant_info`);
    expect(calls[1].url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/CHN-101/attachments`);
    expect(calls[1].headers["x-atlassian-token"]).toBe("no-check");
    expect(calls[1].body).toBeInstanceOf(FormData);
    expect(res.id).toBe("10001");
  });

  it('authMode: "site" forces site routing even with an ATCTT token', async () => {
    const { f, calls } = gatewayFetch([{ status: 200, body: jiraIssue() }]);
    const t = makeGwJira(f, "ATCTTsecret", "site");
    await t.getIssue("CHN-101");
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${GW_BASE}/rest/api/3/issue/CHN-101?fields=${FIELDS}`);
  });
});

describe("JiraTracker re-phase (#142)", () => {
  it("updateIssue(phase) PUTs a parent Epic key — same mapping as createIssue", async () => {
    const { f, calls } = fixtureFetch([
      { status: 204, body: undefined }, // PUT issue fields
      { status: 200, body: jiraIssue({ parent: { key: "CHN-9" } }) }, // getIssue readback
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    const issue = await t.updateIssue("CHN-101", { phase: "CHN-9" });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe(`${BASE}/rest/api/3/issue/CHN-101`);
    expect(calls[0].body).toMatchObject({ fields: { parent: { key: "CHN-9" } } });
    expect(issue.phase).toBe("CHN-9");
  });

  it("declares hasPhaseReassign", () => {
    const { f } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.capabilities.hasPhaseReassign).toBe(true);
  });
});

describe("JiraTracker.stateCategory -- the pre-write question, from data already fetched (#471)", () => {
  const transitions = {
    transitions: [
      { id: "11", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
      { id: "21", name: "Start review", to: { name: "In Review", statusCategory: { key: "indeterminate" } } },
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
    ],
  };

  it("answers the canonical three by name and the transitions-map targets by their category, case-insensitively, with no fetch", () => {
    const { f, calls } = fixtureFetch([]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.stateCategory("open")).toBe("open");
    expect(t.stateCategory("in_progress")).toBe("in_progress");
    expect(t.stateCategory("closed")).toBe("closed");
    expect(t.stateCategory("Done")).toBe("closed");
    expect(t.stateCategory("done")).toBe("closed");
    expect(t.stateCategory("DONE")).toBe("closed");
    expect(t.stateCategory("In Progress")).toBe("in_progress");
    expect(calls.length).toBe(0);
  });

  it("a transitions-map alias resolves through its target: `finish: \"Done\"` is closed", () => {
    const { f } = fixtureFetch([]);
    const t = new JiraTracker({ ...cfg, transitions: { ...cfg.transitions, finish: "Done" } }, f, () => ({ email: "e", token: "t" }));
    expect(t.stateCategory("finish")).toBe("closed");
  });

  it("a name Jira has not shown is undefined -- never guessed -- until an issue read carries it with its statusCategory", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: jiraIssue({ status: { name: "In Review", statusCategory: { key: "indeterminate" } } }) },
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.stateCategory("In Review")).toBeUndefined();
    expect(t.stateCategory("Finito")).toBeUndefined();
    await t.getIssue("CHN-101");
    expect(t.stateCategory("In Review")).toBe("in_progress");
    expect(t.stateCategory("in review")).toBe("in_progress");
    expect(t.stateCategory("Finito")).toBeUndefined();
  });

  it("a transitions list teaches every target it lists, by status name and by transition name", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: transitions }, // transitionByName GET
      { status: 204, body: undefined }, // POST transition
      { status: 200, body: jiraIssue({ status: { name: "To Do", statusCategory: { key: "new" } } }) }, // readback
    ]);
    const t = new JiraTracker(cfg, f, () => ({ email: "e", token: "t" }));
    expect(t.stateCategory("To Do")).toBeUndefined();
    await t.updateIssue("CHN-101", { state: "To Do" });
    expect(t.stateCategory("To Do")).toBe("open");
    expect(t.stateCategory("In Review")).toBe("in_progress");
    expect(t.stateCategory("Start review")).toBe("in_progress");
  });
});
