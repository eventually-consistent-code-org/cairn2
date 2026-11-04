import { describe, it, expect, vi } from "vitest";
import { LinearTracker, configSchema, make } from "../src/tracker/adapters/linear.js";
import type { FetchLike } from "../src/tracker/http.js";

/** Records GraphQL calls; replies from a queue of canned {data}/{errors} bodies. */
function gqlFetch(fixtures: Array<unknown>) {
  const calls: Array<{ query: string; variables: Record<string, unknown>; headers: Headers }> = [];
  const f: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ query: body.query, variables: body.variables ?? {}, headers: new Headers(init?.headers) });
    const fx = fixtures.shift()!;
    return new Response(JSON.stringify(fx), { status: 200 });
  };
  return { f, calls };
}

const TEAM = "team-uuid-1";
const t = (f: FetchLike) => new LinearTracker({ teamId: TEAM, apiKeyEnv: "LINEAR_API_KEY" }, f, () => "lin_key");

// Canned issue node in Linear's shape
const node = (over: Record<string, unknown> = {}) => ({
  id: "uuid-1", identifier: "ENG-1", title: "t", description: "b",
  url: "https://linear.app/acme/issue/ENG-1",
  updatedAt: "2026-07-28T00:00:00.000Z",
  state: { type: "backlog" },
  labels: { nodes: [] as Array<{ name: string }> },
  project: null,
  assignee: null,
  ...over,
});

const statesFixture = {
  data: { team: { states: { nodes: [
    { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
    { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "st-doing", name: "In Progress", type: "started", position: 2 },
    { id: "st-done", name: "Done", type: "completed", position: 3 },
  ] } } },
};

describe("LinearTracker mapping", () => {
  it("configSchema defaults apiKeyEnv to LINEAR_API_KEY", () => {
    const cfg = configSchema.parse({ teamId: TEAM });
    expect(cfg.apiKeyEnv).toBe("LINEAR_API_KEY");
  });

  it("make() throws AUTH_MISSING when the key env var is unset, before any HTTP call", async () => {
    const cfg = configSchema.parse({ teamId: TEAM });
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    const { f, calls } = gqlFetch([]);
    try {
      const tracker = make(cfg, f);
      await expect(tracker.getIssue("ENG-1")).rejects.toMatchObject({ code: "AUTH_MISSING" });
      expect(calls.length).toBe(0);
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev;
    }
  });

  it("sends the API key raw in the authorization header (no Bearer)", async () => {
    const { f, calls } = gqlFetch([{ data: { issue: node() } }]);
    await t(f).getIssue("ENG-1");
    expect(calls[0].headers.get("authorization")).toBe("lin_key");
  });

  it("createIssue posts issueCreate with teamId/title/description and normalizes", async () => {
    const { f, calls } = gqlFetch([{ data: { issueCreate: { issue: node() } } }]);
    const issue = await t(f).createIssue({ title: "t", body: "b" });
    expect(calls[0].query).toContain("issueCreate");
    expect(calls[0].variables.input).toMatchObject({ teamId: TEAM, title: "t", description: "b" });
    expect(issue).toMatchObject({ id: "ENG-1", title: "t", body: "b", state: "open" });
  });

  it("createIssue with labels finds existing + creates missing, then passes labelIds", async () => {
    const { f, calls } = gqlFetch([
      { data: { team: { labels: { nodes: [{ id: "lb-bug", name: "bug" }] } } } },
      { data: { issueLabelCreate: { issueLabel: { id: "lb-new", name: "new-one" } } } },
      { data: { issueCreate: { issue: node({ labels: { nodes: [{ name: "bug" }, { name: "new-one" }] } }) } } },
    ]);
    const issue = await t(f).createIssue({ title: "t", labels: ["bug", "new-one"] });
    expect(calls[0].query).toContain("labels");
    expect(calls[1].query).toContain("issueLabelCreate");
    expect(calls[1].variables.input).toMatchObject({ name: "new-one", teamId: TEAM });
    expect(calls[2].variables.input).toMatchObject({ labelIds: ["lb-bug", "lb-new"] });
    expect(issue.labels).toEqual(["bug", "new-one"]);
  });

  it("createIssue with phase passes projectId", async () => {
    const { f, calls } = gqlFetch([
      { data: { issueCreate: { issue: node({ project: { id: "prj-1" } }) } } },
    ]);
    const issue = await t(f).createIssue({ title: "t", phase: "prj-1" });
    expect(calls[0].variables.input).toMatchObject({ projectId: "prj-1" });
    expect(issue.phase).toBe("prj-1");
  });

  it("getIssue maps state.type: started→in_progress, completed→closed, canceled→closed, backlog→open", async () => {
    for (const [type, want] of [
      ["started", "in_progress"], ["completed", "closed"],
      ["canceled", "closed"], ["backlog", "open"], ["unstarted", "open"],
    ] as const) {
      const { f } = gqlFetch([{ data: { issue: node({ state: { type } }) } }]);
      expect((await t(f).getIssue("ENG-1")).state).toBe(want);
    }
  });

  it("updateIssue(state) resolves the team stateId once and caches it", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node({ state: { type: "started" } }) } } },
      { data: { issueUpdate: { issue: node({ state: { type: "completed" } }) } } },
    ]);
    const tracker = t(f);
    const first = await tracker.updateIssue("ENG-1", { state: "in_progress" });
    expect(first.state).toBe("in_progress");
    expect(calls[1].variables).toMatchObject({ id: "ENG-1", input: { stateId: "st-doing" } });
    await tracker.updateIssue("ENG-1", { state: "closed" });
    // second state write reuses the cached states — exactly 3 calls total
    expect(calls).toHaveLength(3);
    expect(calls[2].variables).toMatchObject({ input: { stateId: "st-done" } });
  });

  it("updateIssue(state: open) prefers the unstarted state over backlog", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node() } } },
    ]);
    await t(f).updateIssue("ENG-1", { state: "open" });
    expect(calls[1].variables).toMatchObject({ input: { stateId: "st-todo" } });
  });

  it("updateIssue(labels) replaces the full label set via labelIds", async () => {
    const { f, calls } = gqlFetch([
      { data: { team: { labels: { nodes: [{ id: "lb-bug", name: "bug" }] } } } },
      { data: { issueUpdate: { issue: node({ labels: { nodes: [{ name: "bug" }] } }) } } },
    ]);
    await t(f).updateIssue("ENG-1", { labels: ["bug"] });
    expect(calls[1].variables).toMatchObject({ input: { labelIds: ["lb-bug"] } });
  });

  it("closeIssue writes the completed stateId", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node({ state: { type: "completed" } }) } } },
    ]);
    const issue = await t(f).closeIssue("ENG-1");
    expect(calls[1].variables).toMatchObject({ input: { stateId: "st-done" } });
    expect(issue.state).toBe("closed");
  });

  it("listIssues filters by team; phase adds a project filter; state filters client-side", async () => {
    const { f, calls } = gqlFetch([
      { data: { issues: { nodes: [
        node({ identifier: "ENG-1", state: { type: "backlog" } }),
        node({ identifier: "ENG-2", state: { type: "completed" } }),
      ] } } },
    ]);
    const issues = await t(f).listIssues({ state: "open" });
    expect((calls[0].variables.filter as Record<string, unknown>).team)
      .toEqual({ id: { eq: TEAM } });
    expect(issues.map((i) => i.id)).toEqual(["ENG-1"]);

    const { f: f2, calls: calls2 } = gqlFetch([{ data: { issues: { nodes: [] } } }]);
    await t(f2).listIssues({ phase: "prj-1" });
    expect((calls2[0].variables.filter as Record<string, unknown>).project)
      .toEqual({ id: { eq: "prj-1" } });
  });

  it("listIssues warns on truncation at the 100-item cap", async () => {
    const nodes = Array.from({ length: 100 }, (_, i) => node({ identifier: `ENG-${i}` }));
    const { f } = gqlFetch([{ data: { issues: { nodes } } }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const issues = await t(f).listIssues();
    expect(issues).toHaveLength(100);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("GraphQL errors map to typed CairnErrors: entity-not-found → NOT_FOUND, else TRACKER_DOWN", async () => {
    const { f } = gqlFetch([{ errors: [{ message: "Entity not found: Issue" }] }]);
    await expect(t(f).getIssue("ENG-404")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { f: f2 } = gqlFetch([{ errors: [{ message: "something exploded" }] }]);
    await expect(t(f2).getIssue("ENG-1")).rejects.toMatchObject({ code: "TRACKER_DOWN" });
  });
});

describe("LinearTracker phases (Projects) + comments", () => {
  it("createPhase posts projectCreate with name + teamIds", async () => {
    const { f, calls } = gqlFetch([
      { data: { projectCreate: { project: { id: "prj-1", name: "Phase 1", state: "planned" } } } },
    ]);
    const ph = await t(f).createPhase("Phase 1");
    expect(calls[0].query).toContain("projectCreate");
    expect(calls[0].variables.input).toMatchObject({ name: "Phase 1", teamIds: [TEAM] });
    expect(ph).toMatchObject({ id: "prj-1", name: "Phase 1", state: "open" });
  });

  it("listPhases maps project state: completed/canceled→closed, else open", async () => {
    const { f } = gqlFetch([
      { data: { team: { projects: { nodes: [
        { id: "prj-1", name: "P1", state: "started" },
        { id: "prj-2", name: "P2", state: "completed" },
        { id: "prj-3", name: "P3", state: "canceled" },
      ] } } } },
    ]);
    const phases = await t(f).listPhases();
    expect(phases.map((p) => p.state)).toEqual(["open", "closed", "closed"]);
  });

  it("closePhase resolves the org's completed project status once, then projectUpdate(statusId)", async () => {
    const { f, calls } = gqlFetch([
      { data: { organization: { projectStatuses: { nodes: [
        { id: "ps-started", type: "started" },
        { id: "ps-done", type: "completed" },
      ] } } } },
      { data: { projectUpdate: { project: { id: "prj-1", name: "P1", state: "completed" } } } },
    ]);
    const ph = await t(f).closePhase("prj-1");
    expect(calls[1].query).toContain("projectUpdate");
    expect(calls[1].variables).toMatchObject({ id: "prj-1", input: { statusId: "ps-done" } });
    expect(ph.state).toBe("closed");
  });

  it("commentIssue resolves identifier → UUID, then commentCreate", async () => {
    const { f, calls } = gqlFetch([
      { data: { issue: { id: "uuid-1" } } },
      { data: { commentCreate: { comment: { id: "cm-1", url: "https://linear.app/c/1" } } } },
    ]);
    const c = await t(f).commentIssue("ENG-1", "plain note");
    expect(calls[0].variables).toMatchObject({ id: "ENG-1" });
    expect(calls[1].query).toContain("commentCreate");
    expect(calls[1].variables.input).toMatchObject({ issueId: "uuid-1", body: "plain note" });
    expect(c).toEqual({ id: "cm-1", url: "https://linear.app/c/1" });
  });

  it("milestones are UNSUPPORTED (capability-flagged fallback)", async () => {
    const { f } = gqlFetch([]);
    const tracker = t(f);
    expect(tracker.capabilities.hasMilestones).toBe(false);
    await expect(tracker.createMilestone("v1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(tracker.listMilestones()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(tracker.completeMilestone("1")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

// Fixtures for link tests — issue uuid resolutions and relation queries
const uuidFix = (uuid: string) => ({ data: { issue: { id: uuid } } });
const teamLinksFix = (nodes: unknown[]) => ({ data: { issues: { nodes } } });
const linkNode = (identifier: string, over: Record<string, unknown> = {}) => ({
  identifier, parent: null, relations: { nodes: [] as unknown[] }, ...over,
});

describe("LinearTracker links", () => {
  it("linkIssues(blocks) resolves both UUIDs, cycle-checks, then issueRelationCreate", async () => {
    const { f, calls } = gqlFetch([
      uuidFix("uuid-a"), uuidFix("uuid-b"),
      teamLinksFix([linkNode("ENG-1"), linkNode("ENG-2")]),
      { data: { issueRelationCreate: { issueRelation: { id: "rel-1" } } } },
    ]);
    await t(f).linkIssues!("ENG-1", "blocks", "ENG-2");
    expect(calls[3].query).toContain("issueRelationCreate");
    expect(calls[3].variables.input).toMatchObject({
      issueId: "uuid-a", relatedIssueId: "uuid-b", type: "blocks",
    });
  });

  it("linkIssues(relates-to) maps to Linear's 'related' type, no cycle check", async () => {
    const { f, calls } = gqlFetch([
      uuidFix("uuid-a"), uuidFix("uuid-b"),
      { data: { issueRelationCreate: { issueRelation: { id: "rel-1" } } } },
    ]);
    await t(f).linkIssues!("ENG-1", "relates-to", "ENG-2");
    expect(calls).toHaveLength(3);
    expect(calls[2].variables.input).toMatchObject({ type: "related" });
  });

  it("linkIssues(parent-of) sets the native sub-issue parent", async () => {
    const { f, calls } = gqlFetch([
      uuidFix("uuid-parent"),
      { data: { issueUpdate: { success: true } } },
    ]);
    await t(f).linkIssues!("ENG-1", "parent-of", "ENG-2");
    expect(calls[1].query).toContain("issueUpdate");
    expect(calls[1].variables).toMatchObject({ id: "ENG-2", input: { parentId: "uuid-parent" } });
  });

  it("linkIssues(supersedes) is UNSUPPORTED with no HTTP calls", async () => {
    const { f, calls } = gqlFetch([]);
    await expect(t(f).linkIssues!("ENG-1", "supersedes", "ENG-2"))
      .rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(calls).toHaveLength(0);
  });

  it("linkIssues to a nonexistent issue is NOT_FOUND before any mutation", async () => {
    const { f, calls } = gqlFetch([
      uuidFix("uuid-a"),
      { errors: [{ message: "Entity not found: Issue" }] },
    ]);
    await expect(t(f).linkIssues!("ENG-1", "blocks", "ENG-404"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(2);
  });

  it("linkIssues rejects a blocks cycle adapter-side with CONFIG_INVALID", async () => {
    const { f, calls } = gqlFetch([
      uuidFix("uuid-b"), uuidFix("uuid-a"),
      teamLinksFix([
        linkNode("ENG-1", { relations: { nodes: [
          { id: "rel-1", type: "blocks", relatedIssue: { identifier: "ENG-2" } },
        ] } }),
        linkNode("ENG-2"),
      ]),
    ]);
    await expect(t(f).linkIssues!("ENG-2", "blocks", "ENG-1"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toHaveLength(3); // no mutation happened
  });

  it("listLinks(id) merges relations, inverse relations, parent and children; ignores duplicates", async () => {
    const { f } = gqlFetch([
      { data: { issue: {
        identifier: "ENG-2",
        parent: { identifier: "ENG-9" },
        children: { nodes: [{ identifier: "ENG-10" }] },
        relations: { nodes: [
          { id: "rel-1", type: "blocks", relatedIssue: { identifier: "ENG-3" } },
          { id: "rel-2", type: "duplicate", relatedIssue: { identifier: "ENG-4" } },
        ] },
        inverseRelations: { nodes: [
          { id: "rel-3", type: "blocks", issue: { identifier: "ENG-1" } },
          { id: "rel-4", type: "related", issue: { identifier: "ENG-5" } },
        ] },
      } } },
    ]);
    const links = await t(f).listLinks!("ENG-2");
    expect(links).toContainEqual({ from: "ENG-2", type: "blocks", to: "ENG-3" });
    expect(links).toContainEqual({ from: "ENG-1", type: "blocks", to: "ENG-2" });
    expect(links).toContainEqual({ from: "ENG-5", type: "relates-to", to: "ENG-2" });
    expect(links).toContainEqual({ from: "ENG-9", type: "parent-of", to: "ENG-2" });
    expect(links).toContainEqual({ from: "ENG-2", type: "parent-of", to: "ENG-10" });
    expect(links.some((l) => l.to === "ENG-4" || l.from === "ENG-4")).toBe(false);
  });

  it("listLinks() walks team issues — relations owned once, parent-of derived from parent", async () => {
    const { f } = gqlFetch([
      teamLinksFix([
        linkNode("ENG-1", { relations: { nodes: [
          { id: "rel-1", type: "blocks", relatedIssue: { identifier: "ENG-2" } },
        ] } }),
        linkNode("ENG-2", { parent: { identifier: "ENG-1" } }),
      ]),
    ]);
    const links = await t(f).listLinks!();
    expect(links).toContainEqual({ from: "ENG-1", type: "blocks", to: "ENG-2" });
    expect(links).toContainEqual({ from: "ENG-1", type: "parent-of", to: "ENG-2" });
    expect(links).toHaveLength(2);
  });

  it("unlinkIssues(blocks) finds the owning relation id then issueRelationDelete", async () => {
    const { f, calls } = gqlFetch([
      { data: { issue: {
        identifier: "ENG-1", parent: null, children: { nodes: [] },
        relations: { nodes: [
          { id: "rel-7", type: "blocks", relatedIssue: { identifier: "ENG-2" } },
        ] },
        inverseRelations: { nodes: [] },
      } } },
      { data: { issueRelationDelete: { success: true } } },
    ]);
    await t(f).unlinkIssues!("ENG-1", "blocks", "ENG-2");
    expect(calls[1].query).toContain("issueRelationDelete");
    expect(calls[1].variables).toMatchObject({ id: "rel-7" });
  });

  it("unlinkIssues(parent-of) clears the parent", async () => {
    const { f, calls } = gqlFetch([{ data: { issueUpdate: { success: true } } }]);
    await t(f).unlinkIssues!("ENG-1", "parent-of", "ENG-2");
    expect(calls[0].variables).toMatchObject({ id: "ENG-2", input: { parentId: null } });
  });
});

describe("LinearTracker custom states", () => {
  it("custom state name matches a team workflow state case-insensitively", async () => {
    const { f, calls } = gqlFetch([
      statesFixture,
      { data: { issueUpdate: { issue: node({ state: { name: "In Progress", type: "started" } }) } } },
    ]);
    const issue = await t(f).updateIssue("ENG-1", { state: "in progress" });
    expect(calls[1].variables).toMatchObject({ input: { stateId: "st-doing" } });
    expect(issue.category).toBe("in_progress");
  });

  it("unknown state name is CONFIG_INVALID naming the team's states", async () => {
    const { f } = gqlFetch([statesFixture]);
    await expect(t(f).updateIssue("ENG-1", { state: "Nope" }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("LinearTracker probe (CRN-48)", () => {
  it("ok on a team(id) 200 -- validates the target, not just the key", async () => {
    const { f, calls } = gqlFetch([{ data: { team: { id: TEAM } } }]);
    await expect(t(f).probe!()).resolves.toEqual({ verdict: "ok" });
    expect(calls[0].query).toContain("team(");
    expect(calls[0].variables).toMatchObject({ teamId: TEAM });
  });

  it("bad_host on a valid API key but a nonexistent team id (live-verification gap)", async () => {
    // A valid key passes a bare {viewer{id}} query every time -- probing
    // viewer alone can never catch a typo'd teamId. team(id) catches both.
    const f: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("viewer")) {
        return new Response(JSON.stringify({ data: { viewer: { id: "u-1" } } }), { status: 200 });
      }
      if (body.query.includes("team(")) {
        return new Response(JSON.stringify({
          errors: [{ message: "Could not find referenced Team." }],
        }), { status: 200 });
      }
      throw new Error(`unexpected query in test: ${body.query}`);
    };
    await expect(t(f).probe!()).resolves.toMatchObject({ verdict: "bad_host" });
  });

  it("bad_token on a 401 rejecting the personal API key", async () => {
    const f: FetchLike = async () =>
      new Response(JSON.stringify({ message: "the token was rejected" }), { status: 401 });
    await expect(t(f).probe!()).resolves.toMatchObject({ verdict: "bad_token" });
  });
});

describe("LinearTracker re-phase (#142)", () => {
  it("updateIssue(phase) sends projectId — same mapping as createIssue", async () => {
    const { f, calls } = gqlFetch([
      { data: { issueUpdate: { issue: node({ project: { id: "proj-1" } }) } } },
    ]);
    const issue = await t(f).updateIssue("ENG-1", { phase: "proj-1" });
    expect(calls[0].variables.input).toMatchObject({ projectId: "proj-1" });
    expect(issue.phase).toBe("proj-1");
  });

  it("declares hasPhaseReassign", () => {
    const { f } = gqlFetch([]);
    expect(t(f).capabilities.hasPhaseReassign).toBe(true);
  });
});

describe("LinearTracker.stateCategory -- the pre-write question, from data already fetched (#471)", () => {
  it("answers the canonical three by name with no fetch, and nothing else before a read", () => {
    const { f, calls } = gqlFetch([]);
    const tr = t(f);
    expect(tr.stateCategory("open")).toBe("open");
    expect(tr.stateCategory("in_progress")).toBe("in_progress");
    expect(tr.stateCategory("closed")).toBe("closed");
    expect(tr.stateCategory("Done")).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it("an issue read teaches its state's name with the category its type buckets to", async () => {
    const { f } = gqlFetch([
      { data: { issue: node({ state: { name: "Done", type: "completed" } }) } },
      { data: { issue: node({ state: { name: "Won't do", type: "canceled" } }) } },
      { data: { issue: node({ state: { name: "In Progress", type: "started" } }) } },
    ]);
    const tr = t(f);
    await tr.getIssue("ENG-1");
    await tr.getIssue("ENG-2");
    await tr.getIssue("ENG-3");
    expect(tr.stateCategory("Done")).toBe("closed");
    expect(tr.stateCategory("done")).toBe("closed");
    expect(tr.stateCategory("Won't do")).toBe("closed");
    expect(tr.stateCategory("In Progress")).toBe("in_progress");
    expect(tr.stateCategory("Finito")).toBeUndefined();
  });

  it("the team states fetch teaches every workflow state at once", async () => {
    const { f } = gqlFetch([
      statesFixture, // stateId -> states()
      { data: { issueUpdate: { issue: node({ state: { name: "Todo", type: "unstarted" } }) } } },
    ]);
    const tr = t(f);
    await tr.updateIssue("ENG-1", { state: "Todo" });
    expect(tr.stateCategory("Backlog")).toBe("open");
    expect(tr.stateCategory("Todo")).toBe("open");
    expect(tr.stateCategory("In Progress")).toBe("in_progress");
    expect(tr.stateCategory("Done")).toBe("closed");
  });
});
