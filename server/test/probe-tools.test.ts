// #396: probe_start owns its "investigation started" mirror comment, the way
// trace_start has since #367. Asserted against the fake tracker. draft_start and
// thread_start share the registration but keep today's behavior (no comment).
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { GitHubTracker } from "../src/tracker/adapters/github.js";
import type { Tracker } from "../src/tracker/types.js";

describe("probe_start owns its started comment (#396)", () => {
  let client: Client;
  let projectDir: string;
  let fakeTracker: FakeTracker;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-probe-tools-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    fakeTracker = new FakeTracker();
    const server = buildServer({
      projectDir,
      tracker: fakeTracker,
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  };
  const comments = (issue: string) => fakeTracker.comments(issue).map((c) => c.text);

  it("posts the started comment on the issue it creates; return shape is unchanged", async () => {
    const started = await call("probe_start", { description: "does the cache survive a restart" });
    expect(Object.keys(started.json).sort()).toEqual(["id", "issue"]);
    expect(comments(started.json.issue)).toEqual([
      "Investigation started: does the cache survive a restart",
    ]);
  });

  it("posts the started comment on a given issueId", async () => {
    const issue = await fakeTracker.createIssue({ title: "pre-existing spike" });
    const started = await call("probe_start", { description: "given issue", issueId: issue.id });
    expect(started.json.issue).toBe(issue.id);
    expect(comments(issue.id)).toEqual(["Investigation started: given issue"]);
  });

  it("a mirror the tracker refuses never blocks the start (fail-open)", async () => {
    const started = await call("probe_start", { description: "ghost issue", issueId: "FAKE-404" });
    expect(started.isError).toBeFalsy();
    expect(started.json).toEqual({ id: started.json.id, issue: "FAKE-404" });
    expect(existsSync(join(projectDir, ".cairn", "probe", `${started.json.id}.md`))).toBe(true);
  });

  it("draft_start and thread_start keep today's behavior: no started comment", async () => {
    const draft = await call("draft_start", { description: "two layouts" });
    const thread = await call("thread_start", { description: "auth rework" });
    expect(comments(draft.json.issue)).toEqual([]);
    expect(comments(thread.json.issue)).toEqual([]);
  });
});

// #485: config_probe carries branchProtection for a tracker that can read it,
// so ship can say when the push gate is the guard alone. The read never fails
// the probe; a tracker without the read leaves the field absent.
describe("config_probe reports branchProtection (#485)", () => {
  async function probeWith(tracker: Tracker) {
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-probe-bp-"));
    writeFileSync(
      join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }),
    );
    const server = buildServer({
      projectDir,
      tracker,
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    const res = await c.callTool({ name: "config_probe", arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { ...res, json: JSON.parse(text) };
  }
  const github = (routes: Record<string, { status: number; body: unknown }>) =>
    new GitHubTracker({ repo: "o/r" }, async (url) => {
      const u = String(url);
      const hit = Object.keys(routes).find((suffix) => u.endsWith(suffix));
      if (!hit) throw new Error(`unexpected url in test: ${u}`);
      return new Response(JSON.stringify(routes[hit].body), { status: routes[hit].status });
    }, () => "tok");
  const repo = { status: 200, body: { full_name: "o/r", default_branch: "main" } };

  it("rules present ride along with the tracker verdict", async () => {
    const res = await probeWith(github({
      "/repos/o/r": repo,
      "/repos/o/r/rules/branches/main": {
        status: 200,
        body: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
      },
    }));
    expect(res.isError).toBeFalsy();
    expect(res.json.tracker).toEqual({ verdict: "ok" });
    expect(res.json.branchProtection).toEqual({
      default: "main", rules: ["pull_request", "required_reviews:1"], source: "rulesets",
    });
  });

  it("rules empty: the guard-alone case is reported as a measured empty list", async () => {
    const res = await probeWith(github({
      "/repos/o/r": repo,
      "/repos/o/r/rules/branches/main": { status: 200, body: [] },
      "/repos/o/r/branches/main/protection": {
        status: 404, body: { message: "Branch not protected" },
      },
    }));
    expect(res.json.branchProtection).toEqual({ default: "main", rules: [], source: "legacy" });
  });

  it("unreadable: a 403 on the protection read is carried, never an empty verdict", async () => {
    const res = await probeWith(github({
      "/repos/o/r": repo,
      "/repos/o/r/rules/branches/main": { status: 200, body: [] },
      "/repos/o/r/branches/main/protection": { status: 403, body: { message: "Forbidden" } },
    }));
    expect(res.isError).toBeFalsy();
    expect(res.json.branchProtection.rules).toEqual([]);
    expect(res.json.branchProtection.source).toMatch(/^unreadable: /);
  });

  it("a tracker verdict that is not ok skips the read and says so", async () => {
    const res = await probeWith(github({
      "/repos/o/r": { status: 401, body: { message: "Bad credentials" } },
    }));
    expect(res.json.tracker.verdict).toBe("bad_token");
    expect(res.json.branchProtection).toEqual({
      default: "unknown", rules: [], source: "unreadable: tracker probe verdict bad_token",
    });
  });

  it("a tracker without the read leaves the field absent (the fake)", async () => {
    const res = await probeWith(new FakeTracker());
    expect(res.json.tracker).toEqual({ verdict: "ok" });
    expect(res.json.branchProtection).toBeUndefined();
  });
});
