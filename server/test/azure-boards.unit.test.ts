import { describe, it, expect } from "vitest";
import { AzureBoardsTracker } from "../src/tracker/adapters/azure-boards.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records requests; replies from a queue of canned responses. */
function fixtureFetch(fixtures: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  const f: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx.body), { status: fx.status });
  };
  return { f, calls };
}

const cfg = {
  orgUrl: "https://dev.azure.com/org",
  project: "Proj",
  workItemType: "Issue",
  patEnv: "AZURE_DEVOPS_PAT",
  apiVersion: "7.0",
  states: { in_progress: "Doing", closed: "Done", open: "To Do" },
};

const wi = (over: Record<string, unknown> = {}) => ({
  id: 7,
  fields: {
    "System.Title": "t",
    "System.Description": "b",
    "System.State": "To Do",
    "System.Tags": "cairn-test",
    "System.ChangedDate": "2026-07-12T00:00:00Z",
    ...(over.fields as Record<string, unknown> | undefined),
  },
  url: "https://dev.azure.com/org/Proj/_apis/wit/workitems/7",
  ...over,
});

/** Constructs a tracker wired to a fixture fetch, mirroring the file's inline construction convention. */
function makeAzure(f: FetchLike): AzureBoardsTracker {
  return new AzureBoardsTracker(cfg, f, () => "pat123");
}

describe("AzureBoardsTracker mapping", () => {
  it("createIssue POSTs json-patch to workitems/$type with api-version and Basic-PAT auth", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: wi() }]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const issue = await t.createIssue({ title: "t", body: "b", labels: ["cairn-test"] });

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/Proj/_apis/wit/workitems/%24Issue");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].headers.get("content-type")).toBe("application/json-patch+json");
    expect(calls[0].headers.get("authorization")).toBe(
      `Basic ${Buffer.from(":pat123").toString("base64")}`,
    );
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.Title", value: "t" },
        { op: "add", path: "/fields/System.Description", value: "b" },
        { op: "add", path: "/fields/System.Tags", value: "cairn-test" },
      ]),
    );
    expect(issue).toMatchObject({ id: "7", title: "t", state: "To Do", category: "open", labels: ["cairn-test"] });
  });

  it("createIssue with phase adds System.IterationPath op using the stored id->path map", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1", path: "Proj\\Sprint 1" }] } },
      { status: 200, body: wi() },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listPhases(); // populate id->path map
    await t.createIssue({ title: "t", phase: "guid-1" });
    const createCall = calls[calls.length - 1];
    expect(createCall.body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.IterationPath", value: "Proj\\Sprint 1" },
      ]),
    );
  });

  it("getIssue normalizes state via StateCategory when present", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "InProgress" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    expect((await t.getIssue("7")).category).toBe("in_progress");
  });

  it("getIssue falls back to states map when StateCategory absent", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Done" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    expect((await t.getIssue("7")).category).toBe("closed");
  });

  it("StateCategory Completed/Removed -> closed, Proposed -> open", async () => {
    const { f: f1 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Completed" } }) },
    ]);
    const t1 = new AzureBoardsTracker(cfg, f1, () => "pat123");
    expect((await t1.getIssue("7")).category).toBe("closed");

    const { f: f2 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Removed" } }) },
    ]);
    const t2 = new AzureBoardsTracker(cfg, f2, () => "pat123");
    expect((await t2.getIssue("7")).category).toBe("closed");

    const { f: f3 } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.StateCategory": "Proposed" } }) },
    ]);
    const t3 = new AzureBoardsTracker(cfg, f3, () => "pat123");
    expect((await t3.getIssue("7")).category).toBe("open");
  });

  it("updateIssue(state=in_progress) PATCHes System.State to states.in_progress", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Doing" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.updateIssue("7", { state: "in_progress" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toContain("/Proj/_apis/wit/workitems/7");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].headers.get("content-type")).toBe("application/json-patch+json");
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "Doing" },
      ]),
    );
  });

  it("updateIssue(state=open) PATCHes System.State back to states.open default 'To Do'", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "To Do" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.updateIssue("7", { state: "open" });
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "To Do" },
      ]),
    );
  });

  it("closeIssue PATCHes System.State to states.closed", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "Done" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.closeIssue("7");
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.State", value: "Done" },
      ]),
    );
  });

  it("labels: System.Tags splits on '; ' for read and joins with '; ' for write", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.Tags": "alpha; beta; gamma" } }) },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const issue = await t.getIssue("7");
    expect(issue.labels).toEqual(["alpha", "beta", "gamma"]);

    const { f: f2, calls } = fixtureFetch([{ status: 200, body: wi() }]);
    const t2 = new AzureBoardsTracker(cfg, f2, () => "pat123");
    await t2.createIssue({ title: "t", labels: ["alpha", "beta"] });
    expect(calls[0].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.Tags", value: "alpha; beta" },
      ]),
    );
  });

  it("listIssues(phase) runs WIQL then batch-fetches ids, escaping single quotes in the iteration path", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "O'Brien's Sprint", path: "Proj\\O'Brien's Sprint" }] } },
      { status: 200, body: { workItems: [{ id: 7 }, { id: 8 }] } },
      { status: 200, body: { value: [wi({ id: 7 }), wi({ id: 8 })] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listPhases();
    const issues = await t.listIssues({ phase: "guid-1" });

    const wiqlCall = calls[1];
    expect(wiqlCall.method).toBe("POST");
    expect(wiqlCall.url).toContain("/_apis/wit/wiql");
    expect(wiqlCall.url).toContain("api-version=7.0");
    expect(wiqlCall.body.query).toContain("[System.IterationPath] = 'Proj\\O''Brien''s Sprint'");

    const batchCall = calls[2];
    expect(batchCall.url).toContain("/_apis/wit/workitems?");
    expect(batchCall.url).toContain("ids=7%2C8");
    expect(issues).toHaveLength(2);
  });

  it("listIssues() without a phase scopes the WIQL query to the configured project", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { workItems: [{ id: 7 }] } },
      { status: 200, body: { value: [wi({ id: 7 })] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listIssues();
    const wiqlCall = calls[0];
    expect(wiqlCall.body.query).toContain("[System.TeamProject] = 'Proj'");
  });

  it("listIssues(phase) scopes the WIQL query to the configured project in addition to the iteration path", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1", path: "Proj\\Sprint 1" }] } },
      { status: 200, body: { workItems: [{ id: 7 }] } },
      { status: 200, body: { value: [wi({ id: 7 })] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await t.listPhases();
    await t.listIssues({ phase: "guid-1" });
    const wiqlCall = calls[1];
    expect(wiqlCall.body.query).toContain("[System.TeamProject] = 'Proj'");
    expect(wiqlCall.body.query).toContain("[System.IterationPath] = 'Proj\\Sprint 1'");
  });

  it("listIssues caps at 100 ids and logs a truncation warning", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const { f } = fixtureFetch([
      { status: 200, body: { workItems: ids.map((id) => ({ id })) } },
      { status: 200, body: { value: ids.slice(0, 100).map((id) => wi({ id })) } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const errSpy: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errSpy.push(msg);
    try {
      const issues = await t.listIssues();
      expect(issues).toHaveLength(100);
      expect(errSpy.some((m) => m.includes("truncat"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("createPhase POSTs classificationnodes/iterations and returns id=identifier GUID, name kept", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { identifier: "guid-2", name: "Sprint 2" } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const ph = await t.createPhase("Sprint 2");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/_apis/wit/classificationnodes/iterations");
    expect(calls[0].url).toContain("api-version=7.0");
    expect(calls[0].body).toMatchObject({ name: "Sprint 2" });
    expect(ph).toMatchObject({ id: "guid-2", name: "Sprint 2" });
  });

  it("listPhases GETs classificationnodes/iterations with $depth and maps identifier/name", async () => {
    const { f, calls } = fixtureFetch([
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1" }, { identifier: "guid-2", name: "Sprint 2" }] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const phases = await t.listPhases();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/_apis/wit/classificationnodes/iterations");
    expect(phases).toEqual([
      { id: "guid-1", name: "Sprint 1", state: "open" },
      { id: "guid-2", name: "Sprint 2", state: "open" },
    ]);
  });

  it("rejects non-numeric work item ids before any HTTP call", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    await expect(t.getIssue("7/comments")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls.length).toBe(0);
  });

  it("missing PAT env throws AUTH_MISSING with zero HTTP calls", async () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AzureBoardsTracker(cfg, f, () => {
      throw new Error("should not be reached in this path — use default token resolver");
    });
    const prevEnv = process.env.AZURE_DEVOPS_PAT;
    delete process.env.AZURE_DEVOPS_PAT;
    try {
      const noTokenTracker = new AzureBoardsTracker(cfg, f);
      await expect(noTokenTracker.getIssue("7")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prevEnv !== undefined) process.env.AZURE_DEVOPS_PAT = prevEnv;
    }
  });

  it("listPhases tolerates the root-node/children response shape (no top-level value), normalizing \\Iteration\\ paths", async () => {
    // Real Azure DevOps root classification-node response: no top-level `value`
    // wrapper — the root node itself, with a `children` array. Paths are
    // stored as `\Proj\Iteration\Sprint 1` (leading backslash + literal
    // "Iteration" segment) but System.IterationPath values look like
    // `Proj\Sprint 1` — normalize before storing so phase resolution matches.
    const { f, calls } = fixtureFetch([
      {
        status: 200,
        body: {
          identifier: "root-guid", name: "Proj", path: "\\Proj",
          children: [
            { identifier: "guid-9", name: "Sprint 9", path: "\\Proj\\Iteration\\Sprint 9" },
          ],
        },
      },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    const phases = await t.listPhases();
    expect(calls[0].method).toBe("GET");
    expect(phases).toEqual([{ id: "guid-9", name: "Sprint 9", state: "open" }]);

    // The id->path map must store the normalized form matching System.IterationPath.
    const { f: f2 } = fixtureFetch([
      { status: 200, body: { workItems: [{ id: 7 }] } },
      { status: 200, body: { value: [wi({ id: 7, fields: { "System.IterationPath": "Proj\\Sprint 9" } })] } },
    ]);
    const t2 = new AzureBoardsTracker(cfg, f2, () => "pat123");
    (t2 as unknown as { phasePaths: Map<string, string> }).phasePaths = (t as unknown as { phasePaths: Map<string, string> }).phasePaths;
    (t2 as unknown as { phasesLoaded: boolean }).phasesLoaded = true;
    const issues = await t2.listIssues();
    expect(issues[0].phase).toBe("guid-9");
  });

  it("getIssue self-heals phase lookup on cold phasePaths map (no prior listPhases call)", async () => {
    // COLD map scenario: work item assigned to "Proj\\Sprint 9" iteration by another session.
    // The map is empty. getIssue should:
    // 1. Fetch the work item (IterationPath = "Proj\\Sprint 9")
    // 2. Call listPhases to populate the map (finds "Sprint 9" with id guid-sprint-9)
    // 3. Rescan and resolve phase = guid-sprint-9
    const { f, calls } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.IterationPath": "Proj\\Sprint 9" } }) },
      { status: 200, body: { value: [{ identifier: "guid-sprint-9", name: "Sprint 9", path: "Proj\\Sprint 9" }] } },
    ]);
    const t = new AzureBoardsTracker(cfg, f, () => "pat123");
    // Do NOT call listPhases — map is cold
    const issue = await t.getIssue("7");
    expect(issue.phase).toBe("guid-sprint-9");
    // Verify both API calls happened in order: GET work item, then GET classificationnodes
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/workitems/7");
    expect(calls[1].url).toContain("/classificationnodes/iterations");
  });

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

  it("closePhase is UNSUPPORTED (phase primitive has no closed state)", async () => {
    const { f } = fixtureFetch([]);
    const t = makeAzure(f);
    expect(t.capabilities.hasPhaseClose).toBe(false);
    await expect(t.closePhase("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("commentIssue POSTs a work-item comment with the preview api-version", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: 4001, url: "https://dev.azure.com/o/p/_apis/wit/workItems/55/comments/4001" } }]);
    const t = makeAzure(f);
    const c = await t.commentIssue("55", "plain note");
    expect(calls[0].url).toContain("/workItems/55/comments");
    expect(calls[0].url).toContain("api-version=7.1-preview.4");
    expect(calls[0].body).toEqual({ text: "plain note" });
    expect(c.id).toBe("4001");
  });
});

describe("AzureBoardsTracker identity", () => {
  it("resolveSelf returns the authenticated user's account from connectionData, memoized", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: {
      authenticatedUser: { properties: { Account: { $value: "me@corp.com" } },
        providerDisplayName: "Me Corp" },
    } }]);
    const t = makeAzure(f);
    expect(await t.resolveSelf!()).toBe("me@corp.com");
    expect(await t.resolveSelf!()).toBe("me@corp.com");
    expect(calls.filter((c) => c.url.includes("connectionData")).length).toBe(1);
  });

  it("resolveSelf falls back to providerDisplayName, undefined when absent", async () => {
    const { f } = fixtureFetch([{ status: 200, body: {
      authenticatedUser: { providerDisplayName: "Fallback Name" },
    } }, { status: 200, body: {} }]);
    const t = makeAzure(f);
    expect(await t.resolveSelf!()).toBe("Fallback Name");
    const t2 = makeAzure(f);
    expect(await t2.resolveSelf!()).toBeUndefined();
  });
});

describe("AzureBoardsTracker probe (CRN-48)", () => {
  it("ok on a 200 from /_apis/projects/{project} -- validates the target, not just the token", async () => {
    const { f, calls } = fixtureFetch([{ status: 200, body: { id: "guid-1", name: "Proj" } }]);
    const t = makeAzure(f);
    await expect(t.probe!()).resolves.toEqual({ verdict: "ok" });
    expect(calls[0].url).toContain("/_apis/projects/Proj");
  });

  it("bad_host on a valid PAT but a nonexistent project (live-verification gap)", async () => {
    // A valid PAT passes connectionData every time -- probing connectionData
    // alone can never catch a typo'd project. /_apis/projects/{project}
    // catches both.
    const f: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("connectionData")) {
        return new Response(JSON.stringify({
          authenticatedUser: { properties: { Account: { $value: "me@corp.com" } } },
        }), { status: 200 });
      }
      if (u.includes("/_apis/projects/")) {
        return new Response(JSON.stringify({ message: "project does not exist" }), { status: 404 });
      }
      throw new Error(`unexpected url in test: ${u}`);
    };
    const t = makeAzure(f);
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "bad_host" });
  });

  it("missing_scope on a 403 with a scope-shaped body", async () => {
    const { f } = fixtureFetch([
      { status: 403, body: { message: "missing required scope for this operation" } },
    ]);
    const t = makeAzure(f);
    await expect(t.probe!()).resolves.toMatchObject({ verdict: "missing_scope" });
  });
});

describe("AzureBoardsTracker re-phase (#142)", () => {
  it("updateIssue(phase) resolves the iteration path and PATCHes System.IterationPath — same mapping as createIssue", async () => {
    const { f, calls } = fixtureFetch([
      // resolvePhasePath refresh: GET classificationnodes/iterations
      { status: 200, body: { value: [{ identifier: "guid-1", name: "Sprint 1", path: "\\Proj\\Iteration\\Sprint 1" }] } },
      // PATCH work item
      { status: 200, body: wi({ fields: { "System.IterationPath": "Proj\\Sprint 1" } }) },
    ]);
    const t = makeAzure(f);
    const issue = await t.updateIssue("7", { phase: "guid-1" });
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body).toEqual(
      expect.arrayContaining([
        { op: "add", path: "/fields/System.IterationPath", value: "Proj\\Sprint 1" },
      ]),
    );
    expect(issue.phase).toBe("guid-1");
  });

  it("updateIssue with an unknown phase id is NOT_FOUND", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: { value: [] } }, // listPhases refresh finds nothing
    ]);
    const t = makeAzure(f);
    await expect(t.updateIssue("7", { phase: "no-such-guid" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("AzureBoardsTracker.stateCategory -- the pre-write question, from the states map and data already fetched (#471)", () => {
  // `finish` is the alias a hostile config adds to spell the close another
  // way; `backlog` its harmless twin pointing at the open state
  const aliased = { ...cfg, states: { ...cfg.states, finish: "Done", backlog: "To Do", review: "In Review" } };

  it("answers the canonical three, the configured states by native name and an alias by its target's category, with no fetch", () => {
    const { f, calls } = fixtureFetch([]);
    const t = new AzureBoardsTracker(aliased, f, () => "pat123");
    expect(t.stateCategory("open")).toBe("open");
    expect(t.stateCategory("in_progress")).toBe("in_progress");
    expect(t.stateCategory("closed")).toBe("closed");
    expect(t.stateCategory("Done")).toBe("closed");
    expect(t.stateCategory("Doing")).toBe("in_progress");
    expect(t.stateCategory("To Do")).toBe("open");
    expect(t.stateCategory("finish")).toBe("closed");
    expect(t.stateCategory("backlog")).toBe("open");
    expect(calls.length).toBe(0);
  });

  it("an alias whose target Azure has not shown is undefined until a work item read carries that state with its category", async () => {
    const { f } = fixtureFetch([
      { status: 200, body: wi({ fields: { "System.State": "In Review", "System.StateCategory": "InProgress" } }) },
      { status: 200, body: wi({ fields: { "System.State": "Removed", "System.StateCategory": "Removed" } }) },
    ]);
    const t = new AzureBoardsTracker(aliased, f, () => "pat123");
    expect(t.stateCategory("review")).toBeUndefined();
    expect(t.stateCategory("Finito")).toBeUndefined();
    await t.getIssue("7");
    await t.getIssue("8");
    expect(t.stateCategory("review")).toBe("in_progress");
    expect(t.stateCategory("In Review")).toBe("in_progress");
    expect(t.stateCategory("Removed")).toBe("closed");
    expect(t.stateCategory("Finito")).toBeUndefined();
  });
});
