// The close receipt and the close comment carry the pause beside the
// measurement (#380): a usage-limit wait inside the claim-to-close span is
// dead time, so the measured figure is the span less the pause, and both
// numbers are stated where the team reads them -- the receipt the ledger
// append consumes, the close comment, the actuals segment. The rung label
// and the agent's claimed number are untouched (ADR 0020). With no pause
// the receipt, the comment and the segment are byte-identical to today.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { scaffoldPhase, scaffoldProject } from "../src/planning/artifacts.js";
import { measuredText, pausesPath } from "../src/planning/duration.js";
import { actualsSegment, receiptsDir, type CloseReceipt } from "../src/planning/close-receipt.js";

const T0 = "2026-10-01T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const pauseRow = (kind: string, min: number) =>
  JSON.stringify({ kind, type: "x", event: "Notification", observedAt: at(min), session_id: "s1" });

describe("the receipt and the close comment carry pausedMinutes beside measured (#380)", () => {
  // The pauses log lives under the cairn home, so HOME is a temp folder for
  // this block -- a fixture log, and no real one touched.
  let savedHome: string | undefined;
  beforeAll(() => {
    savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "cairn-receipt-home-"));
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  // A claimed issue on a tracker that lists comments, with the clock in hand.
  const harness = async () => {
    const tracker = new FakeTracker();
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-receipt-"));
    writeFileSync(join(projectDir, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    scaffoldProject(projectDir, "P");
    scaffoldPhase(projectDir, 1, "Core");
    let clock = Date.parse(T0);
    const now = () => new Date(clock);
    tracker.now = now;
    const server = buildServer({ projectDir, tracker, now });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "receipt", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      return { ...res, json: JSON.parse(text) };
    };
    const made = await call("issue_create", { title: "receipt", claim: { baseCommit: "a1b2c3d4e5f6" } });
    const id = made.json.id as string;
    return { call, tracker, projectDir, id, advance: (min: number) => { clock += min * 60_000; } };
  };

  /** The one close receipt on disk -- the ledger append has not consumed it yet. */
  const receipt = (projectDir: string): CloseReceipt => {
    const dir = receiptsDir(projectDir);
    const name = readdirSync(dir).find((f) => f.endsWith(".close.json"))!;
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as CloseReceipt;
  };

  it("with a pause in the span: receipt and comment state both; rung and claim unchanged", async () => {
    const { call, tracker, projectDir, id, advance } = await harness();
    const log = pausesPath(projectDir, join(process.env.HOME!, ".cairn"));
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, [pauseRow("paused", 10), pauseRow("resumed", 320)].join("\n") + "\n");
    advance(352);
    const closed = await call("issue_close", {
      id, timeSpentMinutes: 128, evidence: { command: "npm test", result: "1 passed" },
    });
    expect(closed.json.measured).toEqual({ minutes: 42, source: "claim_comment", pausedMinutes: 310 });
    expect(closed.json.claimedMinutes).toBe(128);
    const r = receipt(projectDir);
    expect(r.measured).toEqual({ minutes: 42, source: "claim_comment", pausedMinutes: 310 });
    expect(r.claimedMinutes).toBe(128);
    expect(tracker.comments(id).at(-1)!.text).toBe(
      "evidence: `npm test` → 1 passed\n"
      + "measured: ~42m (claim comment to close), 5h 10m paused on a usage limit (subtracted)");
  });

  it("with no pause in the span: the receipt and the comment are byte-identical to today", async () => {
    const { call, tracker, projectDir, id, advance } = await harness();
    advance(12);
    const closed = await call("issue_close", {
      id, timeSpentMinutes: 128, evidence: { command: "npm test", result: "1 passed" },
    });
    expect(closed.json.measured).toEqual({ minutes: 12, source: "claim_comment" });
    const r = receipt(projectDir);
    expect(r.measured).toEqual({ minutes: 12, source: "claim_comment" });
    expect(JSON.stringify(r)).not.toContain("pausedMinutes");
    expect(tracker.comments(id).at(-1)!.text)
      .toBe("evidence: `npm test` → 1 passed\nmeasured: ~12m (claim comment to close)");
  });
});

describe("the pause in the ledger's actuals segment and the measured line (#380)", () => {
  const receipt: CloseReceipt = {
    version: 1, issueId: "7", closedAt: at(60), claimedAt: T0,
    measured: { minutes: 42, source: "claim_comment", pausedMinutes: 310 },
    claimedMinutes: 128,
    estimate: { points: null, pointsSource: null, minutes: null, minutesSource: null },
    worklog: "logged",
  };

  it("paused=<n>m rides beside wall when there was a pause, and is absent otherwise", () => {
    expect(actualsSegment({ receipt, wall: receipt.measured! }))
      .toBe("actuals wall=42m:claim_comment paused=310m claimed=128m est=none worklog=logged — ");
    expect(actualsSegment({ receipt, wall: { minutes: 42, source: "claim_comment" } }))
      .toBe("actuals wall=42m:claim_comment claimed=128m est=none worklog=logged — ");
    expect(actualsSegment({ degraded: "no_receipt", wall: { minutes: 9, source: "git_span", pausedMinutes: 5 } }))
      .toBe("actuals wall=9m:git_span paused=5m degraded=no_receipt — ");
  });

  it("the measured line spells the pause in hours and minutes", () => {
    expect(measuredText({ minutes: 42, source: "claim_comment", pausedMinutes: 310 }))
      .toBe("measured: ~42m (claim comment to close), 5h 10m paused on a usage limit (subtracted)");
    expect(measuredText({ minutes: 0, source: "observed_claim", pausedMinutes: 120 }))
      .toBe("measured: ~0m (claim the server saw to close), 2h paused on a usage limit (subtracted)");
    expect(measuredText({ minutes: 8, source: "observed_claim", pausedMinutes: 3 }))
      .toBe("measured: ~8m (claim the server saw to close), 3m paused on a usage limit (subtracted)");
    expect(measuredText({ minutes: 12, source: "claim_comment" })).toBe("measured: ~12m (claim comment to close)");
  });
});
