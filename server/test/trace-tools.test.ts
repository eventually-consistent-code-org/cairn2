// Tool-level folds of #367: the trace tools own their mirror. trace_start
// posts the started comment and can seed evidence; trace_log can post the
// cause-identified comment; trace_close can write the gotcha card. Each fold
// is asserted against the fake tracker, and each tool with the new params
// omitted keeps today's return shape and side effects.
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { cardsDir, readCard } from "../src/memory/cards.js";

describe("trace tools own their mirror (#367)", () => {
  let client: Client;
  let projectDir: string;
  let fakeTracker: FakeTracker;

  beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "cairn-trace-tools-"));
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
  const traceFile = (id: string) => join(projectDir, ".cairn", "trace", `${id}.md`);

  describe("trace_start", () => {
    it("posts the started comment on the issue it creates; return shape is unchanged", async () => {
      const started = await call("trace_start", { description: "index breaks past 64KB" });
      expect(Object.keys(started.json).sort()).toEqual(["id", "issue"]);
      expect(comments(started.json.issue)).toEqual(["Investigation started: index breaks past 64KB"]);
      // no evidence param → no entry on disk, same as before the fold
      expect(readFileSync(traceFile(started.json.id), "utf8")).not.toContain("## ");
    });

    it("posts the started comment on a given issueId", async () => {
      const issue = await fakeTracker.createIssue({ title: "pre-existing bug" });
      const started = await call("trace_start", { description: "given issue", issueId: issue.id });
      expect(started.json.issue).toBe(issue.id);
      expect(comments(issue.id)).toEqual(["Investigation started: given issue"]);
    });

    it("evidence becomes the first entry — the failed-verification route is one call", async () => {
      const started = await call("trace_start", {
        description: "verify failed: pagination",
        evidence: "npm test -- pagination → FAIL: expected 3 pages, got 2",
      });
      const raw = readFileSync(traceFile(started.json.id), "utf8");
      expect(raw).toContain("## evidence — ");
      expect(raw).toContain("npm test -- pagination → FAIL: expected 3 pages, got 2");
      const open = await call("trace_list", { status: "open" });
      const me = open.json.find((t: { id: string }) => t.id === started.json.id);
      expect(me.entryCounts.evidence).toBe(1);
    });

    it("a mirror the tracker refuses never blocks the start (fail-open)", async () => {
      // FAKE-404 was never created: commentIssue throws NOT_FOUND inside the handler.
      const started = await call("trace_start", { description: "ghost issue", issueId: "FAKE-404" });
      expect(started.isError).toBeFalsy();
      expect(started.json).toEqual({ id: started.json.id, issue: "FAKE-404" });
      expect(existsSync(traceFile(started.json.id))).toBe(true);
    });
  });

  describe("trace_log", () => {
    it("without mirror returns exactly { path } and posts nothing", async () => {
      const started = await call("trace_start", { description: "quiet log" });
      const before = comments(started.json.issue).length;
      const logged = await call("trace_log", { id: started.json.id, kind: "hypothesis", text: "h1" });
      expect(Object.keys(logged.json)).toEqual(["path"]);
      expect(comments(started.json.issue).length).toBe(before);
    });

    it("mirror: cause-identified posts the entry as the cause-identified comment", async () => {
      const started = await call("trace_start", { description: "loud log" });
      const logged = await call("trace_log", {
        id: started.json.id, kind: "hypothesis", text: "the page edge is off by one",
        mirror: "cause-identified",
      });
      expect(logged.json.mirrored).toBe(true);
      expect(comments(started.json.issue)).toEqual([
        "Investigation started: loud log",
        "Cause identified: the page edge is off by one",
      ]);
      // the entry itself landed too
      expect(readFileSync(traceFile(started.json.id), "utf8")).toContain("the page edge is off by one");
    });

    it("mirror on a trace whose issue the tracker lost reports mirrored: false, entry still lands", async () => {
      const started = await call("trace_start", { description: "lost issue", issueId: "FAKE-405" });
      const logged = await call("trace_log", {
        id: started.json.id, kind: "hypothesis", text: "h", mirror: "cause-identified",
      });
      expect(logged.isError).toBeFalsy();
      expect(logged.json.mirrored).toBe(false);
      expect(readFileSync(traceFile(started.json.id), "utf8")).toContain("## hypothesis — ");
    });
  });

  describe("trace_close", () => {
    const openProven = async (description: string) => {
      const started = await call("trace_start", {
        description, evidence: "server/src/trace/store.ts drops the last page",
      });
      await call("trace_log", {
        id: started.json.id, kind: "test", text: "npm test -- store → FAIL: expected 3, got 2",
      });
      await call("trace_log", {
        id: started.json.id, kind: "verdict", text: "off-by-one at the page edge; fixed in abc1234d",
      });
      return started.json as { id: string; issue: string };
    };

    it("without card: today's return shape, no card written, issue closed with the resolution comment", async () => {
      const { id, issue } = await openProven("close plain");
      const cardsBefore = existsSync(cardsDir(projectDir)) ? readdirSync(cardsDir(projectDir)).length : 0;
      const closed = await call("trace_close", { id, resolution: "fixed the page edge" });
      expect(Object.keys(closed.json).sort()).toEqual(
        ["archivePath", "description", "id", "issue", "issueClosed", "repro", "verdicts"],
      );
      expect(closed.json.issueClosed).toBe(true);
      expect(comments(issue).at(-1)).toBe(
        "Resolved: fixed the page edge\n\nReproduced by: npm test -- store → FAIL: expected 3, got 2",
      );
      const cardsAfter = existsSync(cardsDir(projectDir)) ? readdirSync(cardsDir(projectDir)).length : 0;
      expect(cardsAfter).toBe(cardsBefore);
    });

    it("with card: writes the gotcha with confidence high and provenance from the trace's own entries", async () => {
      const { id, issue } = await openProven("close with card");
      const closed = await call("trace_close", {
        id, resolution: "fixed", card: { body: "The page loop stops one short at the 64KB edge." },
      });
      expect(closed.json.issueClosed).toBe(true);
      expect(closed.json.cardId).toMatch(/^gotcha-[0-9a-f]{8}$/);
      expect(closed.json.provenance).toEqual([
        { file: "server/src/trace/store.ts", commit: "abc1234d" },
      ]);
      const card = readCard(projectDir, closed.json.cardId);
      expect(card.frontmatter.type).toBe("gotcha");
      expect(card.frontmatter.confidence).toBe("high");
      expect(card.frontmatter.scopeIssue).toBe(issue);
      expect(card.frontmatter.provenanceFiles).toEqual(["server/src/trace/store.ts"]);
      expect(card.frontmatter.provenanceCommits).toEqual(["abc1234d"]);
      expect(card.body).toBe("The page loop stops one short at the 64KB edge.\n");
    });

    it("with card but no commit named anywhere: the card still writes, provenance empty", async () => {
      const started = await call("trace_start", { description: "no sha", evidence: "server/src/a.ts throws" });
      await call("trace_log", { id: started.json.id, kind: "test", text: "cmd → FAIL" });
      await call("trace_log", { id: started.json.id, kind: "verdict", text: "null check" });
      const closed = await call("trace_close", {
        id: started.json.id, resolution: "r", card: { body: "Null check missing on the first page." },
      });
      expect(closed.json.cardId).toMatch(/^gotcha-/);
      expect(closed.json.provenance).toEqual([]);
      expect(readCard(projectDir, closed.json.cardId).frontmatter.provenanceFiles).toEqual([]);
    });

    it("the repro gate still runs first: a card never rescues an unproven trace", async () => {
      const started = await call("trace_start", { description: "unproven" });
      await call("trace_log", { id: started.json.id, kind: "verdict", text: "obviously" });
      const early = await call("trace_close", {
        id: started.json.id, resolution: "r", card: { body: "should not exist" },
      });
      expect(early.isError).toBe(true);
      expect(early.json.code).toBe("PRECONDITION_FAILED");
      const ids = existsSync(cardsDir(projectDir)) ? readdirSync(cardsDir(projectDir)) : [];
      for (const f of ids) {
        expect(readFileSync(join(cardsDir(projectDir), f), "utf8")).not.toContain("should not exist");
      }
    });
  });
});
