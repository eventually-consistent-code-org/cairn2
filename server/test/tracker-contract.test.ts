// The freeze check knows a display name's category on every adapter (#471).
// Phase 30 (#427) made issue_update ask the adapter which category a
// requested state resolves to, so a frozen batch run could not close an
// issue by spelling the close the way the board spells it. Only the local
// adapter answered; on Jira, Linear, ClickUp and Azure Boards the lookup
// was absent, the check was skipped, and the backend's own transition ran.
// This file drives the real adapter classes, over a fixture fetch, through
// the server that named a frozen run: the backend's closed display name is
// refused RUN_FROZEN and no state write reaches the wire; a name the
// adapter cannot place falls closed the same way; a name that resolves to
// open, and a label edit, still pass; and a server that never named the
// run is never frozen (the gate refuses nothing it should not).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import type { Tracker } from "../src/tracker/types.js";
import type { FetchLike } from "../src/tracker/http.js";
import { JiraTracker } from "../src/tracker/adapters/jira.js";
import { LinearTracker } from "../src/tracker/adapters/linear.js";
import { ClickUpTracker } from "../src/tracker/adapters/clickup.js";
import { AzureBoardsTracker } from "../src/tracker/adapters/azure-boards.js";

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts", "pretooluse-runguard.mjs");
const RUN = "run-frz-spelling";
const SESSION = "sess-run-spelling";
const estimate = { low: 1, high: 2, estUsd: { low: 0, high: 0 } };

interface Call { url: string; method: string; body?: unknown }

/** A fetch that answers from a per-adapter router and records every call,
 *  so a test can say which writes reached the wire. */
function routedFetch(route: (c: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = route(c);
    const status = r.status ?? 200;
    const noBody = status === 204;
    return new Response(noBody ? null : JSON.stringify(r.body ?? {}), { status });
  };
  return { f, calls };
}

describe("a frozen run cannot close an issue by the backend's own spelling (#471)", () => {
  let savedHome: string | undefined;
  let home: string;
  let projectDir: string;

  /** A server over `tracker` for the frozen project; `bound` names the run
   *  (run_manifest read binds, #358) so the freeze applies to it. */
  async function connect(tracker: Tracker, bound: boolean) {
    const server = buildServer({ projectDir, tracker });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-spelling-${bound ? "run" : "owner"}`, version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { isError: res.isError === true, json: JSON.parse(text) };
    };
    if (bound) expect((await call("run_manifest", { action: "read", runId: RUN })).isError).toBe(false);
    return call;
  }

  /** One run-guard refusal from the run's session, judged against this file's cairn home. */
  const refuse = () => spawnSync(process.execPath, [RUNGUARD], {
    cwd: projectDir, encoding: "utf8", timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CAIRN_HOME: join(home, ".cairn") },
    input: JSON.stringify({
      tool_name: "Bash", tool_input: { command: "git reset --hard" }, cwd: projectDir, session_id: SESSION,
    }),
  });

  beforeAll(async () => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cairn-spelling-home-"));
    process.env.HOME = home;
    projectDir = mkdtempSync(join(tmpdir(), "cairn-spelling-proj-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    // stage and freeze one run; every adapter's server below binds to it
    const stage = await connect(new FakeTracker(), false);
    expect((await stage("run_manifest", {
      action: "create", runId: RUN, phases: [{ number: 1, name: "one", estimate }], sessionId: SESSION,
    })).isError).toBe(false);
    await stage("run_manifest", { action: "set_status", runId: RUN, status: "running" });
    await stage("run_manifest", { action: "set_phase", runId: RUN, phase: 1 });
    for (let i = 0; i < 3; i++) expect(refuse().status).toBe(2);
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // ---- Jira: the transitions map spells the close "Done" --------------
  const jiraIssue = (status: { name: string; key: string }) => ({
    key: "CHN-7",
    fields: {
      summary: "t", description: null,
      status: { name: status.name, statusCategory: { key: status.key } },
      updated: "2026-07-12T00:00:00.000+0000", labels: [],
    },
  });
  const jiraRoute = (c: Call) => {
    if (c.url.includes("/transitions") && c.method === "GET") return { body: { transitions: [
      { id: "11", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
      { id: "21", name: "In Progress", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
      { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
    ] } };
    if (c.url.includes("/transitions")) return { status: 204 };
    if (c.url.includes("/comment")) return { body: { id: "c1" } };
    if (c.method === "PUT") return { status: 204 };
    return { body: jiraIssue({ name: "To Do", key: "new" }) };
  };
  const jiraCfg = {
    baseUrl: "https://o.atlassian.net", projectKey: "CHN", issueType: "Task",
    emailEnv: "JIRA_EMAIL", tokenEnv: "JIRA_API_TOKEN",
    transitions: { in_progress: "In Progress", closed: "Done" },
  };
  const makeJira = () => {
    const { f, calls } = routedFetch(jiraRoute);
    return { tracker: new JiraTracker(jiraCfg, f, () => ({ email: "e", token: "t" })), calls };
  };
  const jiraTransitions = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.includes("/transitions"));

  it("jira: 'Done' and 'done' are refused RUN_FROZEN with no transition posted; a name it cannot place is refused too", async () => {
    const { tracker, calls } = makeJira();
    const call = await connect(tracker, true);
    expect(tracker.stateCategory?.("Done")).toBe("closed");
    for (const state of ["Done", "done", "Finito"]) {
      const res = await call("issue_update", { id: "CHN-7", state });
      expect(res.isError).toBe(true);
      expect(res.json.code).toBe("RUN_FROZEN");
    }
    expect(jiraTransitions(calls)).toHaveLength(0);
  });

  it("jira: a label edit and a display name Jira has shown as open still pass while frozen", async () => {
    const { tracker, calls } = makeJira();
    const call = await connect(tracker, true);
    // 'To Do' is unknown until a read shows it with its statusCategory --
    // here the label edit's own read-back is that read
    expect(tracker.stateCategory?.("To Do")).toBeUndefined();
    expect((await call("issue_update", { id: "CHN-7", labels: ["later"] })).isError).toBe(false);
    expect(tracker.stateCategory?.("To Do")).toBe("open");
    expect((await call("issue_update", { id: "CHN-7", state: "To Do" })).isError).toBe(false);
    expect(jiraTransitions(calls)).toHaveLength(1);
  });

  it("jira: the owner's server, which never named the run, closes 'Done' as before", async () => {
    const { tracker, calls } = makeJira();
    const call = await connect(tracker, false);
    expect((await call("issue_update", { id: "CHN-7", state: "Done" })).isError).toBe(false);
    expect(jiraTransitions(calls)).toHaveLength(1);
  });

  // ---- Linear: the team's completed state is named "Done" --------------
  const linearNode = (identifier: string, state: { name: string; type: string }) => ({
    id: `uuid-${identifier}`, identifier, title: "t", description: "b",
    url: `https://linear.app/acme/issue/${identifier}`, updatedAt: "2026-07-28T00:00:00.000Z",
    state, labels: { nodes: [] }, project: null, assignee: null,
  });
  const linearRoute = (c: Call) => {
    const { query, variables } = c.body as { query: string; variables: Record<string, unknown> };
    if (query.includes("query States")) return { body: { data: { team: { states: { nodes: [
      { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
      { id: "st-doing", name: "In Progress", type: "started", position: 2 },
      { id: "st-done", name: "Done", type: "completed", position: 3 },
    ] } } } } };
    if (query.includes("query Labels")) return { body: { data: { team: { labels: { nodes: [{ id: "l1", name: "later" }] } } } } };
    if (query.includes("query IssueId")) return { body: { data: { issue: { id: "uuid-x" } } } };
    if (query.includes("CommentCreate")) return { body: { data: { commentCreate: { comment: { id: "c1" } } } } };
    if (query.includes("IssueUpdate")) return { body: { data: { issueUpdate: { issue: linearNode("ENG-2", { name: "Todo", type: "unstarted" }) } } } };
    const id = String(variables.id);
    return { body: { data: { issue: id === "ENG-2"
      ? linearNode("ENG-2", { name: "Todo", type: "unstarted" })
      : linearNode("ENG-1", { name: "Done", type: "completed" }) } } };
  };
  const makeLinear = () => {
    const { f, calls } = routedFetch(linearRoute);
    return { tracker: new LinearTracker({ teamId: "team-uuid-1", apiKeyEnv: "LINEAR_API_KEY" }, f, () => "lin_key"), calls };
  };
  const linearUpdates = (calls: Call[]) =>
    calls.filter((c) => (c.body as { query: string }).query.includes("IssueUpdate"));

  it("linear: 'Done' is refused RUN_FROZEN before the team's states were ever fetched, and after a read showed it completed", async () => {
    const { tracker, calls } = makeLinear();
    const call = await connect(tracker, true);
    // nothing fetched yet: the adapter cannot place the name, so the gate falls closed
    expect(tracker.stateCategory?.("Done")).toBeUndefined();
    expect((await call("issue_update", { id: "ENG-1", state: "Done" })).json.code).toBe("RUN_FROZEN");
    expect((await call("issue_get", { id: "ENG-1" })).isError).toBe(false);
    expect(tracker.stateCategory?.("Done")).toBe("closed");
    expect((await call("issue_update", { id: "ENG-1", state: "Done" })).json.code).toBe("RUN_FROZEN");
    expect((await call("issue_update", { id: "ENG-1", state: "Finito" })).json.code).toBe("RUN_FROZEN");
    expect(linearUpdates(calls)).toHaveLength(0);
  });

  it("linear: a label edit and a state a read showed as unstarted still pass while frozen", async () => {
    const { tracker, calls } = makeLinear();
    const call = await connect(tracker, true);
    expect((await call("issue_update", { id: "ENG-2", labels: ["later"] })).isError).toBe(false);
    expect((await call("issue_get", { id: "ENG-2" })).isError).toBe(false);
    expect(tracker.stateCategory?.("Todo")).toBe("open");
    expect((await call("issue_update", { id: "ENG-2", state: "Todo" })).isError).toBe(false);
    expect(linearUpdates(calls)).toHaveLength(2);
  });

  // ---- ClickUp: a configured alias that writes the closed status ------
  const cuTask = (status: { status: string; type: string }) => ({
    id: "abc123", name: "t", description: "b", status, tags: [], list: { id: "900" },
    assignees: [], date_updated: "1700000000000", url: "https://app.clickup.com/t/abc123",
  });
  const cuRoute = (c: Call) => {
    if (c.url.includes("/comment")) return { body: { id: 1 } };
    if (c.method === "PUT") {
      const status = String((c.body as { status?: string }).status ?? "to do");
      return { body: cuTask({ status, type: status === "complete" ? "closed" : status === "in progress" ? "custom" : "open" }) };
    }
    return { body: cuTask({ status: "to do", type: "open" }) };
  };
  // `finish` is the alias a hostile config adds to spell the close another
  // way; `backlog` is its harmless twin pointing at the open status
  const cuCfg = {
    defaultListId: "900", folderId: "folder1", tokenEnv: "CLICKUP_TOKEN",
    statuses: { open: "to do", in_progress: "in progress", closed: "complete", finish: "complete", backlog: "to do" },
  };
  const makeClickUp = () => {
    const { f, calls } = routedFetch(cuRoute);
    return { tracker: new ClickUpTracker(cuCfg, f, () => "tok"), calls };
  };
  const cuWrites = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

  it("clickup: the alias that writes the closed status, the status's own name, and an unplaceable name are refused RUN_FROZEN", async () => {
    const { tracker, calls } = makeClickUp();
    const call = await connect(tracker, true);
    expect(tracker.stateCategory?.("finish")).toBe("closed");
    for (const state of ["finish", "complete", "Finito"]) {
      expect((await call("issue_update", { id: "abc123", state })).json.code).toBe("RUN_FROZEN");
    }
    expect(cuWrites(calls)).toHaveLength(0);
  });

  it("clickup: the alias pointing at the open status still passes while frozen", async () => {
    const { tracker, calls } = makeClickUp();
    const call = await connect(tracker, true);
    expect(tracker.stateCategory?.("backlog")).toBe("open");
    expect((await call("issue_update", { id: "abc123", state: "backlog" })).isError).toBe(false);
    expect(cuWrites(calls)).toHaveLength(1);
  });

  // ---- Azure Boards: a configured alias that writes the closed state --
  const wi = (state: string) => ({
    id: 7,
    fields: {
      "System.Title": "t", "System.Description": "b", "System.State": state,
      "System.Tags": "", "System.ChangedDate": "2026-07-12T00:00:00Z",
    },
    url: "https://dev.azure.com/org/Proj/_apis/wit/workitems/7",
  });
  const azRoute = (c: Call) => {
    if (c.url.includes("/comments")) return { body: { id: 1 } };
    if (c.method === "PATCH") {
      const op = (c.body as Array<{ path: string; value: string }>).find((o) => o.path === "/fields/System.State");
      return { body: wi(op?.value ?? "To Do") };
    }
    return { body: wi("To Do") };
  };
  const azCfg = {
    orgUrl: "https://dev.azure.com/org", project: "Proj", workItemType: "Issue",
    patEnv: "AZURE_DEVOPS_PAT", apiVersion: "7.0",
    states: { in_progress: "Doing", closed: "Done", open: "To Do", finish: "Done", backlog: "To Do" },
  };
  const makeAzure = () => {
    const { f, calls } = routedFetch(azRoute);
    return { tracker: new AzureBoardsTracker(azCfg, f, () => "pat123"), calls };
  };
  const azWrites = (calls: Call[]) => calls.filter((c) => c.method === "PATCH");

  it("azure-boards: the alias that writes the closed state, the state's own name, and an unplaceable name are refused RUN_FROZEN", async () => {
    const { tracker, calls } = makeAzure();
    const call = await connect(tracker, true);
    expect(tracker.stateCategory?.("finish")).toBe("closed");
    for (const state of ["finish", "Done", "Finito"]) {
      expect((await call("issue_update", { id: "7", state })).json.code).toBe("RUN_FROZEN");
    }
    expect(azWrites(calls)).toHaveLength(0);
  });

  it("azure-boards: the alias pointing at the open state still passes while frozen", async () => {
    const { tracker, calls } = makeAzure();
    const call = await connect(tracker, true);
    expect(tracker.stateCategory?.("backlog")).toBe("open");
    expect((await call("issue_update", { id: "7", state: "backlog" })).isError).toBe(false);
    expect(azWrites(calls)).toHaveLength(1);
  });
});
