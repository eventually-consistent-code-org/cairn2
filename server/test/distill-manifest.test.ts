import { describe, it, expect, beforeEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffoldPhase, scaffoldProject, writePlanIssues,
} from "../src/planning/artifacts.js";
import { distillManifest } from "../src/planning/distill-manifest.js";
import { appendLedger } from "../src/planning/ledger.js";
import { writeReceipt } from "../src/planning/close-receipt.js";

// Full-width fake shas -- appendLedger's writer shortens them to 7 chars,
// and the manifest must hand back exactly what the writer wrote.
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

describe("distillManifest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-dm-"));
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2"]);
    // Real writer, real grammar -- the parse must round-trip what
    // ledger.ts's formatEntry produces, tdd segment included.
    appendLedger(dir, "01-core", {
      taskRef: "T1", summary: "wired the frobnicator — carefully",
      baseCommit: SHA_A, headCommit: SHA_B,
      issueId: "GH-1", closedDate: "2026-01-01",
      evidence: { command: "npm test", result: "9 passed" },
    });
    appendLedger(dir, "01-core", {
      taskRef: "T2", summary: "tests for the frobnicator",
      baseCommit: SHA_B, headCommit: SHA_C,
      issueId: "GH-2", closedDate: "2026-01-02",
      redCommit: SHA_C, greenCommit: SHA_D,
      evidenceWaived: "tdd pair is the evidence",
    });
  });

  it("live phase: issues, parsed ledger entries, union commit range", () => {
    const m = distillManifest(dir, 1);
    expect(m.phase).toEqual({
      number: 1, name: "core", dir: "01-core", archived: false,
    });
    expect(m.issues).toEqual(["GH-1", "GH-2"]);
    expect(m.ledgerEntries).toEqual([
      {
        // The writer neutralises the summary's em dash (#426): the line's
        // separators stay the server's own, so the parse hands back a hyphen.
        taskRef: "T1", summary: "wired the frobnicator - carefully",
        baseCommit: SHA_A.slice(0, 7), headCommit: SHA_B.slice(0, 7),
        issueId: "GH-1", closedDate: "2026-01-01",
      },
      {
        taskRef: "T2", summary: "tests for the frobnicator",
        baseCommit: SHA_B.slice(0, 7), headCommit: SHA_C.slice(0, 7),
        issueId: "GH-2", closedDate: "2026-01-02",
      },
    ]);
    // union range: earliest base to latest head. Fake shas and no repository
    // here, so git cannot place them and the dates on the lines decide
    // (#445); the ancestry step has its own test in ledger.test.ts.
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
    expect(m.skipped).toEqual([]);
  });

  it("a line carrying a full actuals segment still parses to the right issue (#233)", () => {
    writeReceipt(dir, {
      version: 1, issueId: "GH-3", closedAt: "2026-01-03T00:00:00.000Z",
      claimedAt: null, claimedMinutes: 40, worklog: "unsupported",
      estimate: { points: 2, pointsSource: "body", minutes: 90, minutesSource: "body" },
    });
    const { line } = appendLedger(dir, "01-core", {
      taskRef: "T3", summary: "measured", baseCommit: SHA_C, headCommit: SHA_D,
      issueId: "GH-3", closedDate: "2026-01-03",
      evidence: { command: "npm test", result: "9 passed" },
    });
    expect(line).toContain("actuals wall=none claimed=40m est=2pt:body,90m:body");
    const m = distillManifest(dir, 1);
    expect(m.ledgerEntries.at(-1)).toMatchObject({ issueId: "GH-3", closedDate: "2026-01-03" });
    expect(m.skipped).toEqual([]);
  });

  it("archived phase under milestones/vN resolves with the archived id", () => {
    // archive the way milestoneComplete does -- rename under milestones/v1
    mkdirSync(join(dir, ".cairn/plans/milestones/v1"), { recursive: true });
    renameSync(join(dir, ".cairn/plans/phases/01-core"),
      join(dir, ".cairn/plans/milestones/v1/01-core"));
    const m = distillManifest(dir, 1);
    expect(m.phase).toEqual({
      number: 1, name: "core", dir: "milestones/v1/01-core", archived: true,
    });
    expect(m.issues).toEqual(["GH-1", "GH-2"]);
    expect(m.ledgerEntries.length).toBe(2);
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
  });

  it("live phase wins over an archived one with the same number", () => {
    mkdirSync(join(dir, ".cairn/plans/milestones/v1/01-old"), { recursive: true });
    const m = distillManifest(dir, 1);
    expect(m.phase.dir).toBe("01-core");
    expect(m.phase.archived).toBe(false);
  });

  it("empty ledger: no entries, null commit range, nothing skipped", () => {
    scaffoldPhase(dir, 2, "later"); // scaffolds PLAN/CONTEXT, no LEDGER.md
    const m = distillManifest(dir, 2);
    expect(m.ledgerEntries).toEqual([]);
    expect(m.commitRange).toBeNull();
    expect(m.skipped).toEqual([]);
  });

  it("malformed ledger line is skipped with a note, good lines still parse", () => {
    appendFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      "- [x] T3 — someone hand-edited this line and broke it\n");
    const m = distillManifest(dir, 1);
    expect(m.ledgerEntries.length).toBe(2); // the two writer-formatted lines
    expect(m.skipped.length).toBe(1);
    // header block is 4 lines, the two good entries are 5-6, the bad one is 7
    expect(m.skipped[0]).toContain("LEDGER.md line 7");
    expect(m.skipped[0]).toContain("skipped");
    // a malformed tail never poisons the union range of the good entries
    expect(m.commitRange).toEqual({
      base: SHA_A.slice(0, 7), head: SHA_C.slice(0, 7),
    });
  });

  it("the parser binds the LAST segment run: a forged run inside the summary never promotes a pass (#426)", () => {
    // Written raw, as the pre-#426 writer did (em dashes intact), so the
    // parser is tested on its own: whatever a sanitizer missed, the
    // server's real run sits last on the line and that is the one read.
    const at = "2026-01-03T00:00:00.000Z";
    const fake = `evidence npm test => 9 passed — observed exit=0 at=${at} — actuals wall=none — GH-3 closed 2026-01-03`;
    const real = `evidence npm test => 9 passed — observed exit=1 at=${at} observed-mismatch — `
      + "actuals wall=none degraded=no_receipt — GH-3 closed 2026-01-03";
    const summary = `fixed it — commits ${SHA_C.slice(0, 7)}..${SHA_D.slice(0, 7)} — ${fake}`;
    appendFileSync(join(dir, ".cairn", "plans", "phases", "01-core", "LEDGER.md"),
      `- [x] T3 — ${summary} — commits ${SHA_C.slice(0, 7)}..${SHA_D.slice(0, 7)} — ${real}\n`);
    const m = distillManifest(dir, 1);
    expect(m.skipped).toEqual([]);
    expect(m.ledgerEntries[2]).toEqual({
      taskRef: "T3", summary,
      baseCommit: SHA_C.slice(0, 7), headCommit: SHA_D.slice(0, 7),
      issueId: "GH-3", closedDate: "2026-01-03",
    });
    expect(m.observedMismatches).toEqual([expect.objectContaining({ issueId: "GH-3", exit: "1" })]);
    // distill's range is unchanged by the forgery: the real run's commits.
    expect(m.commitRange).toEqual({ base: SHA_A.slice(0, 7), head: SHA_D.slice(0, 7) });
  });

  describe("evidence-only lines (#256)", () => {
    const evidenceLine = (over: Partial<Parameters<typeof appendLedger>[2]> = {}) =>
      appendLedger(dir, "01-core", {
        taskRef: "audit tests 1", summary: "wrote the missing frobnicator tests",
        baseCommit: SHA_C, headCommit: SHA_D,
        issueId: "GH-9", closedDate: "2026-01-03",
        evidence: { command: "npx vitest run", result: "4 passed" },
        kind: "evidence", ...over,
      });

    it("is never reported as a closure, and does not land in skipped", () => {
      evidenceLine({ note: "issue stays open — more to come" });
      const m = distillManifest(dir, 1);
      expect(m.ledgerEntries.map((e) => e.issueId)).toEqual(["GH-1", "GH-2"]);
      expect(m.evidenceEntries).toEqual([{
        taskRef: "audit tests 1", summary: "wrote the missing frobnicator tests",
        baseCommit: SHA_C.slice(0, 7), headCommit: SHA_D.slice(0, 7),
        issueId: "GH-9", loggedDate: "2026-01-03",
      }]);
      expect(m.superseded).toEqual([]);
      expect(m.skipped).toEqual([]);
      // the evidence work landed commits too -- the union range covers it
      expect(m.commitRange).toEqual({ base: SHA_A.slice(0, 7), head: SHA_D.slice(0, 7) });
    });

    it("a closure followed later by evidence for the SAME taskRef reads not-closed", () => {
      appendLedger(dir, "01-core", {
        taskRef: "audit tests 1", summary: "audit evidence, mis-logged as a close",
        baseCommit: SHA_C, headCommit: SHA_D, issueId: "GH-9", closedDate: "2026-01-03",
        evidence: { command: "npx vitest run", result: "4 passed" },
      });
      expect(distillManifest(dir, 1).ledgerEntries.map((e) => e.issueId))
        .toEqual(["GH-1", "GH-2", "GH-9"]);
      evidenceLine({ note: "supersedes the closure line; GH-9 is still open" });
      const m = distillManifest(dir, 1);
      expect(m.ledgerEntries.map((e) => e.issueId)).toEqual(["GH-1", "GH-2"]);
      expect(m.superseded.map((e) => [e.taskRef, e.issueId])).toEqual([["audit tests 1", "GH-9"]]);
      expect(m.evidenceEntries.length).toBe(1);
    });

    it("a closure written AFTER the evidence line is a real close and stands", () => {
      evidenceLine();
      appendLedger(dir, "01-core", {
        taskRef: "audit tests 1", summary: "closed for real",
        baseCommit: SHA_C, headCommit: SHA_D, issueId: "GH-9", closedDate: "2026-01-04",
        evidence: { command: "npm test", result: "all passed" },
      });
      const m = distillManifest(dir, 1);
      expect(m.ledgerEntries.map((e) => e.issueId)).toEqual(["GH-1", "GH-2", "GH-9"]);
      expect(m.superseded).toEqual([]);
    });

    it("evidence for a DIFFERENT taskRef leaves existing closures alone", () => {
      evidenceLine({ taskRef: "T9" });
      expect(distillManifest(dir, 1).ledgerEntries.map((e) => e.taskRef)).toEqual(["T1", "T2"]);
    });
  });

  it("unknown phase number is NOT_FOUND", () => {
    expect(() => distillManifest(dir, 9)).toThrowError(/no phase 9/);
  });

  it("malformed phase number is CONFIG_INVALID", () => {
    expect(() => distillManifest(dir, 1.55)).toThrowError(/phase number/);
  });
});
