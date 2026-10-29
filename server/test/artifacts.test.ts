import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify, phaseDirName, phaseDirPrefix, parsePhaseDirName, isValidPhaseNumber, scaffoldProject, scaffoldPhase,
  readPlanIssues, writePlanIssues, readPlanMeta, writePlanMeta,
} from "../src/planning/artifacts.js";
import { planCheck } from "../src/planning/check.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-plans-"));

describe("slugify / phaseDirName", () => {
  it("slugifies names and pads numbers", () => {
    expect(slugify("Tracker Core!! (v2)")).toBe("tracker-core-v2");
    expect(phaseDirName(3, "tracker-core")).toBe("03-tracker-core");
  });
  it("rejects traversal-shaped and empty slugs, bad numbers", () => {
    expect(() => slugify("../..")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => phaseDirName(0, "x")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => phaseDirName(100, "x")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("decimal phase numbers (CRN — insert without renumbering)", () => {
  it("accepts integers 1..99 and N.1-N.9 with N=1..98", () => {
    for (const n of [1, 99, 1.5, 12.3, 98.9, 1.1, 1.9]) {
      expect(isValidPhaseNumber(n)).toBe(true);
    }
  });
  it("treats a float that equals an integer (1.0) as that integer", () => {
    expect(isValidPhaseNumber(1.0)).toBe(true);
    expect(phaseDirName(1.0, "gamma")).toBe(phaseDirName(1, "gamma"));
  });
  it("rejects out-of-range, over-precise, negative, and boundary-breaking numbers", () => {
    for (const n of [1.55, 0.5, 99.5, -1, 0, 100, 99.1, 1.23]) {
      expect(isValidPhaseNumber(n)).toBe(false);
      expect(() => phaseDirName(n, "x")).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }));
    }
  });
  it("pads the integer part only, two digits, fraction appended before the slug", () => {
    expect(phaseDirName(1.5, "gamma")).toBe("01.5-gamma");
    expect(phaseDirName(12.3, "beta")).toBe("12.3-beta");
    expect(phaseDirName(98.9, "x")).toBe("98.9-x");
  });
  it("lexical ordering holds: 01-... < 01.5-... < 02-...", () => {
    const a = phaseDirName(1, "gamma");
    const b = phaseDirName(1.5, "gamma");
    const c = phaseDirName(2, "gamma");
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });
  it("parsePhaseDirName round-trips a decimal dir name to its exact float", () => {
    expect(parsePhaseDirName("01.5-gamma")).toEqual({ number: 1.5, slug: "gamma" });
    expect(parsePhaseDirName("12.3-beta")).toEqual({ number: 12.3, slug: "beta" });
    expect(parsePhaseDirName("03-tracker-core")).toEqual({ number: 3, slug: "tracker-core" });
  });
  it("parsePhaseDirName returns null for malformed dir names", () => {
    expect(parsePhaseDirName("../evil")).toBeNull();
    expect(parsePhaseDirName("1-x")).toBeNull();
    expect(parsePhaseDirName("01.55-x")).toBeNull();
  });
  it("phaseDirPrefix shares phaseDirName's pad-and-append scheme (CRN-40)", () => {
    expect(phaseDirPrefix(1)).toBe("01-");
    expect(phaseDirPrefix(1.5)).toBe("01.5-");
    expect(phaseDirPrefix(12.3)).toBe("12.3-");
    // Every phaseDirName is exactly phaseDirPrefix + slug -- same helper, no duplication.
    expect(phaseDirName(1.5, "gamma")).toBe(`${phaseDirPrefix(1.5)}gamma`);
  });
  it("phaseDirPrefix rejects an over-precise decimal as CONFIG_INVALID", () => {
    expect(() => phaseDirPrefix(1.55)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("scaffolding", () => {
  it("creates project files once, skips on re-run", () => {
    const d = dir();
    const first = scaffoldProject(d, "My Proj");
    expect(first.created.length).toBe(2);
    expect(existsSync(join(d, ".cairn/plans/PROJECT.md"))).toBe(true);
    const second = scaffoldProject(d, "My Proj");
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(2);
  });

  it("ships the union merge attribute for ledgers, idempotently (#361)", () => {
    const d = dir();
    const attrs = join(d, ".cairn/plans/.gitattributes");
    expect(scaffoldProject(d, "P").gitattributes).toBe("added");
    expect(readFileSync(attrs, "utf8")).toBe("**/LEDGER.md merge=union\n");
    expect(scaffoldProject(d, "P").gitattributes).toBe("present");
    expect(scaffoldPhase(d, 1, "Core").gitattributes).toBe("present");
    expect(readFileSync(attrs, "utf8")).toBe("**/LEDGER.md merge=union\n");
  });

  it("appends the attribute to an existing .gitattributes without a trailing newline (#361)", () => {
    const d = dir();
    mkdirSync(join(d, ".cairn/plans"), { recursive: true });
    const attrs = join(d, ".cairn/plans/.gitattributes");
    writeFileSync(attrs, "*.md text");
    expect(scaffoldPhase(d, 1, "Core").gitattributes).toBe("added");
    expect(readFileSync(attrs, "utf8")).toBe("*.md text\n**/LEDGER.md merge=union\n");
  });

  it("plan_check flags a ledger without the attribute as minor, with the fix (#361)", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "LEDGER.md"), "# Ledger\n");
    expect(planCheck(d).findings.filter((f) => f.type === "ledger-attribute-missing")).toEqual([]);
    rmSync(join(d, ".cairn/plans/.gitattributes"));
    const hit = planCheck(d).findings.filter((f) => f.type === "ledger-attribute-missing");
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe("minor");
    expect(hit[0].detail).toContain("**/LEDGER.md merge=union");
  });

  it("creates a phase dir with CONTEXT + PLAN (+ RESEARCH when asked)", () => {
    const d = dir();
    const r = scaffoldPhase(d, 2, "Planning Engine", { research: true });
    expect(r.dir).toBe("02-planning-engine");
    const base = join(d, ".cairn/plans/phases/02-planning-engine");
    for (const f of ["CONTEXT.md", "PLAN.md", "RESEARCH.md"]) {
      expect(existsSync(join(base, f))).toBe(true);
    }
    expect(readFileSync(join(base, "PLAN.md"), "utf8")).toContain("issues: []");
    // Phase 23: the context scaffold names the approaches block, as a
    // comment-only skeleton — present to guide, unfilled so it can't
    // satisfy plan_check's gate by accident.
    const ctx = readFileSync(join(base, "CONTEXT.md"), "utf8");
    expect(ctx).toContain("## Approaches considered");
    expect(ctx).not.toMatch(/^### /m);
  });
});

describe("plan issue round-trip", () => {
  it("reads [] when absent, writes and re-reads issues preserving body", () => {
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    expect(readPlanIssues(d, pd)).toEqual([]);
    writePlanIssues(d, pd, ["PROJ-7", "PROJ-8"]);
    expect(readPlanIssues(d, pd)).toEqual(["PROJ-7", "PROJ-8"]);
    const raw = readFileSync(
      join(d, ".cairn/plans/phases", pd, "PLAN.md"), "utf8");
    expect(raw).toContain("# Phase 1: Core — Plan"); // template body survived
  });

  it("rejects issue ids with frontmatter-breaking characters, leaving PLAN.md untouched", () => {
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    const planPath = join(d, ".cairn/plans/phases", pd, "PLAN.md");
    const before = readFileSync(planPath, "utf8");

    expect(() => writePlanIssues(d, pd, ["A,B"])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(readFileSync(planPath, "utf8")).toBe(before);

    expect(() => writePlanIssues(d, pd, ["A\nB"])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(readFileSync(planPath, "utf8")).toBe(before);
  });
});

describe("plan meta (waves/tdd)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-meta-"));
    scaffoldPhase(dir, 1, "core");
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3"]);
  });

  it("write + read round-trips waves and tdd", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2"], ["GH-3"]], tdd: ["GH-2"] });
    expect(readPlanMeta(dir, "01-core")).toEqual({
      issues: ["GH-1", "GH-2", "GH-3"],
      waves: [["GH-1", "GH-2"], ["GH-3"]],
      tdd: ["GH-2"],
    });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2]");
    expect(raw).toContain("wave_2: [GH-3]");
    expect(raw).toContain("tdd: [GH-2]");
  });

  it("re-writing waves replaces stale wave_N keys", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-2"], ["GH-3"]] });
    writePlanMeta(dir, "01-core", { waves: [["GH-1", "GH-2", "GH-3"]] });
    const raw = readFileSync(join(dir, ".cairn/plans/phases/01-core/PLAN.md"), "utf8");
    expect(raw).toContain("wave_1: [GH-1, GH-2, GH-3]");
    expect(raw).not.toContain("wave_2");
  });

  it("rejects unknown ids, duplicates across waves, and empty waves", () => {
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-9"]] }))
      .toThrowError(/GH-9/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [["GH-1"], ["GH-1"]] }))
      .toThrowError(/more than one wave/);
    expect(() => writePlanMeta(dir, "01-core", { waves: [[]] }))
      .toThrowError(/empty/);
    expect(() => writePlanMeta(dir, "01-core", { tdd: ["GH-9"] }))
      .toThrowError(/GH-9/);
  });

  it("issues writes preserve meta keys (writePlanIssues keeps wave_*/tdd)", () => {
    writePlanMeta(dir, "01-core", { waves: [["GH-1"]], tdd: ["GH-1"] });
    writePlanIssues(dir, "01-core", ["GH-1", "GH-2", "GH-3", "GH-4"]);
    expect(readPlanMeta(dir, "01-core").waves).toEqual([["GH-1"]]);
  });
});
