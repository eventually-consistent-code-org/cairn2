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
