import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTrace, appendTrace, listTraces, closeTrace, traceId, traceIssue, traceProvenance,
} from "../src/trace/store.js";

describe("trace store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cairn-tr-")); });

  it("start writes frontmatter + title; id is description-hashed", () => {
    const { id, path } = startTrace(dir, "index breaks past 64KB", "GH-12");
    expect(id).toBe(traceId("index breaks past 64KB"));
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("status: open");
    expect(raw).toContain("issue: GH-12");
    expect(raw).toContain("# Trace: index breaks past 64KB");
  });

  it("duplicate open start is refused", () => {
    startTrace(dir, "same bug", "GH-1");
    expect(() => startTrace(dir, "same bug", "GH-2")).toThrowError(/already open/);
  });

  it("append is append-only: prior bytes untouched, blocks accumulate", () => {
    const { id, path } = startTrace(dir, "b", "GH-1");
    appendTrace(dir, id, "evidence", "fails only over 64KB");
    const after1 = readFileSync(path, "utf8");
    appendTrace(dir, id, "hypothesis", "off-by-one at page edge");
    const after2 = readFileSync(path, "utf8");
    expect(after2.startsWith(after1)).toBe(true);
    expect(after2).toContain("## evidence — ");
    expect(after2).toContain("## hypothesis — ");
  });

  it("list reports counts and both statuses", () => {
    const { id } = startTrace(dir, "b1", "GH-1");
    appendTrace(dir, id, "evidence", "e");
    appendTrace(dir, id, "verdict", "v");
    const open = listTraces(dir, "open");
    expect(open.length).toBe(1);
    expect(open[0].entryCounts.evidence).toBe(1);
    expect(open[0].entryCounts.verdict).toBe(1);
    expect(open[0].description).toBe("b1");
  });

  it("close without a verdict is refused; with one it archives + stamps", () => {
    const { id } = startTrace(dir, "b2", "GH-3");
    appendTrace(dir, id, "evidence", "e");
    appendTrace(dir, id, "test", "npm test -- pagination → FAIL: expected 3 pages, got 2");
    expect(() => closeTrace(dir, id, "done")).toThrowError(/verdict/);
    appendTrace(dir, id, "verdict", "root cause: X; fixed in abc1234");
    const out = closeTrace(dir, id, "fixed the pagination");
    expect(out.verdicts).toEqual(["root cause: X; fixed in abc1234"]);
    expect(out.repro).toBe("npm test -- pagination → FAIL: expected 3 pages, got 2");
    expect(existsSync(out.archivePath)).toBe(true);
    expect(readFileSync(out.archivePath, "utf8")).toContain("status: resolved");
    expect(listTraces(dir, "open").length).toBe(0);
    expect(listTraces(dir, "resolved").length).toBe(1);
  });

  it("append to resolved or unknown trace is refused", () => {
    const { id } = startTrace(dir, "b3", "GH-4");
    appendTrace(dir, id, "evidence", "e");
    appendTrace(dir, id, "test", "t");
    appendTrace(dir, id, "verdict", "v");
    closeTrace(dir, id, "r");
    expect(() => appendTrace(dir, id, "evidence", "late")).toThrowError(/resolved/);
    expect(() => appendTrace(dir, "trace-00000000", "evidence", "x")).toThrowError(/no trace/);
  });

  it("whitespace-only verdict does not satisfy the close gate", () => {
    const { id } = startTrace(dir, "b4", "GH-9");
    appendTrace(dir, id, "evidence", "e");
    appendTrace(dir, id, "test", "t");
    appendTrace(dir, id, "verdict", "   ");
    expect(() => closeTrace(dir, id, "r")).toThrowError(/verdict/);
  });

  describe("repro gate (phase 23)", () => {
    it("a verdict alone cannot close: the refusal names every missing required kind", () => {
      const { id } = startTrace(dir, "b5", "GH-5");
      appendTrace(dir, id, "verdict", "obviously the null check");
      const err = (() => { try { closeTrace(dir, id, "r"); } catch (e) { return e as Error; } })()!;
      expect(err.message).toMatch(/missing required entries: evidence \(0\/1\), test \(0\/1\)/);
      expect(String((err as { nextAction?: string }).nextAction ?? "")).toMatch(/repro/);
    });

    it("evidence without a test entry is still refused; whitespace test does not count", () => {
      const { id } = startTrace(dir, "b6", "GH-6");
      appendTrace(dir, id, "evidence", "fails past 64KB");
      appendTrace(dir, id, "verdict", "v");
      expect(() => closeTrace(dir, id, "r")).toThrowError(/test \(0\/1\)/);
      appendTrace(dir, id, "test", "   ");
      expect(() => closeTrace(dir, id, "r")).toThrowError(/test \(0\/1\)/);
      appendTrace(dir, id, "test", "node scripts/repro.mjs 65536 → RangeError: offset out of bounds");
      expect(closeTrace(dir, id, "r").repro).toBe("node scripts/repro.mjs 65536 → RangeError: offset out of bounds");
    });

    it("the FIRST test entry is the repro, later tests are experiments", () => {
      const { id } = startTrace(dir, "b7", "GH-7");
      appendTrace(dir, id, "evidence", "e");
      appendTrace(dir, id, "test", "repro: cmd → failing output");
      appendTrace(dir, id, "hypothesis", "h");
      appendTrace(dir, id, "test", "experiment that disproves h");
      appendTrace(dir, id, "verdict", "v");
      expect(closeTrace(dir, id, "r").repro).toBe("repro: cmd → failing output");
    });
  });

  describe("trace tools own their mirror (#367)", () => {
    it("start with evidence seeds the first entry; without it the file is frontmatter + title only", () => {
      const seeded = startTrace(dir, "seeded", "GH-20", "npm test → FAIL: expected 1, got 0");
      const raw = readFileSync(seeded.path, "utf8");
      expect(raw).toContain("## evidence — ");
      expect(raw.trimEnd().endsWith("npm test → FAIL: expected 1, got 0")).toBe(true);
      expect(listTraces(dir, "open").find((t) => t.id === seeded.id)!.entryCounts.evidence).toBe(1);

      const bare = startTrace(dir, "bare", "GH-21");
      const bareRaw = readFileSync(bare.path, "utf8");
      expect(bareRaw).not.toContain("## ");
      expect(bareRaw.trimEnd().endsWith("# Trace: bare")).toBe(true);
      // whitespace-only evidence is no evidence
      const blank = startTrace(dir, "blank", "GH-22", "   ");
      expect(readFileSync(blank.path, "utf8")).not.toContain("## evidence");
    });

    it("traceIssue resolves an open trace's issue and null otherwise", () => {
      const { id } = startTrace(dir, "lookup", "GH-30");
      expect(traceIssue(dir, id)).toBe("GH-30");
      expect(traceIssue(dir, "trace-00000000")).toBeNull();
      appendTrace(dir, id, "evidence", "e");
      appendTrace(dir, id, "test", "t");
      appendTrace(dir, id, "verdict", "v");
      closeTrace(dir, id, "r");
      expect(traceIssue(dir, id)).toBeNull();
    });

    it("provenance pairs each named file with the same-entry commit, else the last commit named", () => {
      const prov = traceProvenance([
        { kind: "evidence", text: "fails in server/src/index.ts:2134 past 64KB (port 3000, 20261015 run)" },
        { kind: "hypothesis", text: "maybe hooks/scripts/ghost.mjs at deadbeef1" },
        { kind: "test", text: "node scripts/repro.mjs → RangeError" },
        { kind: "verdict", text: "off-by-one in server/src/trace/store.ts; fixed in abc1234d, see trace-0badf00d" },
      ]);
      expect(prov).toEqual([
        { file: "server/src/index.ts", commit: "abc1234d" },
        { file: "scripts/repro.mjs", commit: "abc1234d" },
        { file: "server/src/trace/store.ts", commit: "abc1234d" },
      ]);
    });

    it("provenance is empty when no entry names a commit; plain numbers and trace ids are not shas", () => {
      expect(traceProvenance([
        { kind: "evidence", text: "server/src/index.ts breaks at 65536 bytes on 20261015" },
        { kind: "verdict", text: "fixed; see trace-abcdef12" },
      ])).toEqual([]);
    });

    it("provenance dedupes a file named twice against the same commit", () => {
      expect(traceProvenance([
        { kind: "evidence", text: "server/src/a.ts" },
        { kind: "test", text: "server/src/a.ts again" },
        { kind: "verdict", text: "fixed in 1a2b3c4d5e" },
      ])).toEqual([{ file: "server/src/a.ts", commit: "1a2b3c4d5e" }]);
    });

    it("close returns the provenance its entries name", () => {
      const { id } = startTrace(dir, "b8", "GH-8");
      appendTrace(dir, id, "evidence", "server/src/x.ts throws");
      appendTrace(dir, id, "test", "npm test → FAIL");
      appendTrace(dir, id, "verdict", "fixed in cafe0001");
      expect(closeTrace(dir, id, "r").provenance).toEqual([{ file: "server/src/x.ts", commit: "cafe0001" }]);
    });
  });
});
