import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureLedgerUnion } from "../src/planning/artifacts.js";
import { judgeApproaches, judgeVerifyDeclarations, planCheck } from "../src/planning/check.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-plancheck-"));
const plan = (dir: string, phaseDir: string, body: string) => {
  const base = join(dir, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "PLAN.md"), body);
};
const context = (dir: string, phaseDir: string, body: string) => {
  const base = join(dir, ".cairn", "plans", "phases", phaseDir);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "CONTEXT.md"), body);
};
// Task lines carry a `verify:` clause so these fixtures exercise the
// approaches gate alone; the declared-verification gate has its own block
// below, and a fixture that trips two gates tests neither clearly.
const PLANNED = (depth?: string) =>
  `---\nissues: [7]\n${depth ? `depth: ${depth}\n` : ""}---\n# Phase 1\n\n## Tasks\n- #7 do it \`verify: npm test\`\n`;
const GOOD_BLOCK = [
  "# Phase 1 — Context", "", "## Locked decisions", "", "- x", "",
  "## Approaches considered", "",
  "### A — the obvious one", "Trade-offs: cheap, brittle", "",
  "### B — the careful one", "Trade-offs: slower, survives change", "",
  "chosen: B — because the next change is already on the roadmap", "",
  "## Constraints", "", "- none", "",
].join("\n");

describe("planCheck — contract drift", () => {
  it("flags a consumer whose contract text differs from the producer, naming both ends", () => {
    const dir = fresh();
    plan(dir, "01-api", [
      "# Phase 1", "",
      "- Produces: `exportRows(filter: Filter): Stream` — streaming, no buffering", "",
    ].join("\n"));
    plan(dir, "02-ui", [
      "# Phase 2", "",
      "- Consumes: `exportRows(filter: Filter, limit: number): Stream`", "",
    ].join("\n"));
    const { findings, scanned } = planCheck(dir);
    expect(scanned).toBe(2);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("contract-drift");
    expect(findings[0].plan).toContain("02-ui");
    expect(findings[0].counterpart?.plan).toContain("01-api");
  });

  it("is silent when both plans reference a shared fixture", () => {
    const dir = fresh();
    plan(dir, "01-api", [
      "- Produces: `exportRows(filter: Filter): Stream`",
      "  contract pinned in test/fixtures/export-contract.json", "",
    ].join("\n"));
    plan(dir, "02-ui", [
      "- Consumes: `exportRows(filter: Filter, limit: number): Stream`",
      "  contract pinned in test/fixtures/export-contract.json", "",
    ].join("\n"));
    expect(planCheck(dir).findings).toHaveLength(0);
  });

  it("is silent when contract texts match after whitespace normalization", () => {
    const dir = fresh();
    plan(dir, "01-a", "- Produces: `run(x: number): void`\n");
    plan(dir, "02-b", "- Consumes:   `run(x: number): void`\n");
    expect(planCheck(dir).findings).toHaveLength(0);
  });
});

describe("planCheck — unanchored thresholds", () => {
  it("flags a bare threshold and stays silent on an anchored one", () => {
    const dir = fresh();
    plan(dir, "01-perf", [
      "Response must be < 100ms for the dashboard.",
      "Throughput at least 500 rps per benchmark results in perf/baseline.json.", "",
    ].join("\n"));
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("unanchored-threshold");
    expect(findings[0].line).toBe(1);
    expect(findings[0].detail).toContain("< 100ms");
  });

  it("phase filter narrows the scan and output is byte-stable", () => {
    const dir = fresh();
    plan(dir, "01-perf", "Latency < 100ms.\n");
    plan(dir, "02-other", "Latency < 200ms.\n");
    const one = planCheck(dir, 1);
    expect(one.scanned).toBe(1);
    expect(one.findings).toHaveLength(1);
    expect(JSON.stringify(planCheck(dir))).toBe(JSON.stringify(planCheck(dir)));
  });

  it("empty project: zero findings, zero scanned", () => {
    expect(planCheck(fresh())).toEqual({ findings: [], scanned: 0 });
  });
});

describe("planCheck — approaches considered (phase 23)", () => {
  it("flags a planned standard-depth phase whose CONTEXT.md has no block, anchored on CONTEXT.md", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED());
    context(dir, "01-core", "# Phase 1 — Context\n\n## Locked decisions\n\n- x\n");
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "missing-approaches", line: 1 });
    expect(findings[0].plan).toContain("01-core/CONTEXT.md");
    expect(findings[0].detail).toMatch(/no '## Approaches considered' block/);
  });

  it("names what's incomplete: one candidate, or no chosen line", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED("deep"));
    context(dir, "01-core", "# C\n\n## Approaches considered\n\n### A — only one\nTrade-offs: none\n\nchosen: A — because\n");
    expect(planCheck(dir).findings[0].detail).toMatch(/1 candidate heading \(needs 2\+/);
    context(dir, "01-core", "# C\n\n## Approaches considered\n\n### A — one\n\n### B — two\n\n## Constraints\n\nchosen: B — too late, wrong section\n");
    expect(planCheck(dir).findings[0].detail).toMatch(/no 'chosen:' line/);
  });

  it("passes with two candidates and a chosen line; the fresh scaffold's comment-only skeleton does NOT pass", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED());
    context(dir, "01-core", GOOD_BLOCK);
    expect(planCheck(dir).findings).toEqual([]);
    expect(judgeApproaches([
      "## Approaches considered", "", "<!-- ### A — <name>", "     ### B — <name>", "     chosen: <letter> -->",
    ])).not.toBeNull();
  });

  it("never gates a quick-depth phase, an unplanned (issue-less) phase, or a missing CONTEXT.md on an unplanned phase", () => {
    const dir = fresh();
    plan(dir, "01-quick", PLANNED("quick"));
    context(dir, "01-quick", "# C\n");
    plan(dir, "02-scaffold", "---\nissues: []\n---\n# Phase 2\n");
    context(dir, "02-scaffold", "# C\n");
    plan(dir, "03-noctx", "---\nissues: []\n---\n# Phase 3\n");
    expect(planCheck(dir).findings).toEqual([]);
    // ...but a PLANNED phase with no CONTEXT.md at all is flagged.
    plan(dir, "04-planned-noctx", PLANNED());
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].plan).toContain("04-planned-noctx/CONTEXT.md");
  });

  it("a verified phase is exempt — it already passed its gate", () => {
    const dir = fresh();
    plan(dir, "01-core", PLANNED());
    context(dir, "01-core", "# Phase 1 — Context\n\n## Locked decisions\n\n- x\n");
    expect(planCheck(dir).findings).toHaveLength(1);
    writeFileSync(join(dir, ".cairn", "plans", "phases", "01-core", "VERIFICATION.md"), "# done\n");
    expect(planCheck(dir).findings).toEqual([]);
  });

  it("output stays byte-stable and sorts with the other finding types", () => {
    const dir = fresh();
    plan(dir, "01-core", `---\nissues: [7]\n---\n# Phase 1\n\nLatency < 100ms.\n`);
    context(dir, "01-core", "# C\n");
    const a = planCheck(dir);
    expect(a.findings.map((f) => f.type)).toEqual(["missing-approaches", "unanchored-threshold"]);
    expect(JSON.stringify(planCheck(dir))).toBe(JSON.stringify(a));
  });

  it("phase filter matches a decimal phase dir (01.5-slug), not just integer dirs (CRN-40)", () => {
    const dir = fresh();
    plan(dir, "01.5-perf", "Latency < 100ms.\n");
    plan(dir, "02-other", "Latency < 200ms.\n");
    const one = planCheck(dir, 1.5);
    expect(one.scanned).toBe(1);
    expect(one.findings).toHaveLength(1);
    expect(one.findings[0].plan).toContain("01.5-perf");
  });

  it("phase filter rejects an over-precise decimal (1.55) as CONFIG_INVALID", () => {
    const dir = fresh();
    plan(dir, "01.5-perf", "Latency < 100ms.\n");
    expect(() => planCheck(dir, 1.55)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("adjacent independent thresholds do not anchor each other", () => {
    const dir = fresh();
    plan(dir, "01-perf", [
      "Response must be < 100ms per perf/baseline.json.",
      "Throughput at least 500 rps for the same run.", "",
    ].join("\n"));
    const { findings } = planCheck(dir);
    // Line 1 is anchored by its own path token. Line 2 is a separate,
    // self-contained threshold statement — it does not inherit line 1's
    // anchor just for being adjacent, so it (and only it) gets flagged.
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("unanchored-threshold");
    expect(findings[0].line).toBe(2);
  });
});

describe("planCheck — declared verification (phase 24.5)", () => {
  const TASKS = (body: string) =>
    `---\nissues: [7]\n---\n# Phase 1\n\n## Tasks\n${body}`;

  it("flags a task that never says how it will be proved, naming the issue", () => {
    const dir = fresh();
    plan(dir, "01-core", TASKS("- **#7 — the thing** (2pt). Does the thing.\n"));
    context(dir, "01-core", GOOD_BLOCK);
    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "missing-verify", line: 7 });
    expect(findings[0].plan).toContain("01-core/PLAN.md");
    expect(findings[0].detail).toContain("#7");
    expect(findings[0].detail).toContain("verify:");
  });

  it("accepts a declaration anywhere in the task's own paragraph", () => {
    const dir = fresh();
    context(dir, "01-core", GOOD_BLOCK);
    // On the bullet itself...
    plan(dir, "01-core", TASKS("- **#7 — thing** `verify: npm test`\n"));
    expect(planCheck(dir).findings).toEqual([]);
    // ...or on a continuation line, because plan prose wraps.
    plan(dir, "01-core", TASKS(
      "- **#7 — thing** (2pt). A longer description that runs\n  onto another line.\n  `verify: node scripts/check-surface.mjs`\n"));
    expect(planCheck(dir).findings).toEqual([]);
  });

  it("a declaration on the NEXT task does not cover this one", () => {
    const dir = fresh();
    context(dir, "01-core", GOOD_BLOCK);
    plan(dir, "01-core", TASKS(
      "- **#7 — undeclared**\n- **#8 — declared** `verify: npm test`\n"));
    const findings = planCheck(dir).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("#7");
  });

  it("a verified phase is exempt — its proving already happened", () => {
    const dir = fresh();
    plan(dir, "01-core", TASKS("- **#7 — the thing**\n"));
    context(dir, "01-core", GOOD_BLOCK);
    expect(planCheck(dir).findings).toHaveLength(1);
    writeFileSync(join(dir, ".cairn", "plans", "phases", "01-core", "VERIFICATION.md"), "# done\n");
    expect(planCheck(dir).findings).toEqual([]);
  });

  it("quick-depth and unplanned phases are never gated, as with approaches", () => {
    const dir = fresh();
    context(dir, "01-core", GOOD_BLOCK);
    plan(dir, "01-core", `---\nissues: [7]\ndepth: quick\n---\n## Tasks\n- **#7 — thing**\n`);
    expect(planCheck(dir).findings).toEqual([]);
    plan(dir, "01-core", `---\nissues: []\n---\n## Tasks\n- **#7 — thing**\n`);
    expect(planCheck(dir).findings).toEqual([]);
  });

  it("narrative bullets are not tasks and owe nothing", () => {
    expect(judgeVerifyDeclarations([
      "- 5 things to watch for here",
      "- a plain bullet",
      "  - nested note",
    ])).toEqual([]);
  });

  it("reads bold and plain task lines alike", () => {
    expect(judgeVerifyDeclarations(["- **#7 — bold**"])).toEqual([{ line: 1, issue: "7" }]);
    expect(judgeVerifyDeclarations(["- #7 plain"])).toEqual([{ line: 1, issue: "7" }]);
    expect(judgeVerifyDeclarations(["- **12.5 — decimal**"])).toEqual([{ line: 1, issue: "12.5" }]);
  });
});

describe("planCheck — ledger gates (#366)", () => {
  // Phase 28: past the evidence gate, so nothing here is exempt unless a
  // test says so. Tasks declare verify and CONTEXT.md carries the block, so
  // only the ledger gates can speak.
  const LEDGER_PLAN = `---\nissues: [7, 8]\ntdd: [7]\n---\n# Phase 28\n\n## Tasks\n`
    + "- #7 red first `verify: npm test`\n- #8 docs `verify: npm test`\n";
  const HEAD = ["# Phase 28 — Ledger", "", "<!-- append-only -->", ""]; // entries start at line 5
  const close = (id: string, seg: { tdd?: boolean; ev?: boolean; waived?: boolean } = {}) =>
    `- [x] T${id} — did ${id} — commits aaaaaaa..bbbbbbb — `
    + (seg.tdd ? "tdd ccccccc..ddddddd — " : "")
    + (seg.ev ? "evidence npm test => 3 passed — " : "")
    + (seg.waived ? "waived docs only — " : "")
    + `${id} closed 2026-10-18`;
  const fixUp = (id: string) => `- [ ] T${id} — wrong close — commits aaaaaaa..bbbbbbb — evidence for ${id} 2026-10-18`;
  const setup = (phaseDir: string, entries: string[], verified = false) => {
    const dir = fresh();
    ensureLedgerUnion(dir); // scaffolded projects ship the attribute (#361)
    plan(dir, phaseDir, LEDGER_PLAN);
    context(dir, phaseDir, GOOD_BLOCK);
    const base = join(dir, ".cairn", "plans", "phases", phaseDir);
    writeFileSync(join(base, "LEDGER.md"), [...HEAD, ...entries, ""].join("\n"));
    if (verified) writeFileSync(join(base, "VERIFICATION.md"), "# done\n");
    return dir;
  };

  it("a clean ledger reports nothing", () => {
    const dir = setup("28-x", [close("7", { tdd: true, ev: true }), close("8", { waived: true })]);
    expect(planCheck(dir, 28).findings).toEqual([]);
  });

  it("tdd-missing: a tdd: id whose closing line has no red..green pair, on that line", () => {
    const dir = setup("28-x", [close("7", { ev: true }), close("8", { waived: true })]);
    const { findings } = planCheck(dir, 28);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "tdd-missing", line: 5 });
    expect(findings[0].plan).toContain("28-x/LEDGER.md");
    expect(findings[0].detail).toContain("#7");
  });

  it("evidence-missing: a closing line with neither evidence nor waived, on that line", () => {
    const dir = setup("28-x", [close("7", { tdd: true, ev: true }), close("8")]);
    const { findings } = planCheck(dir, 28);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: "evidence-missing", line: 6 });
    expect(findings[0].plan).toContain("28-x/LEDGER.md");
    expect(findings[0].detail).toContain("#8");
  });

  it("closure-superseded: a closure a later evidence-only line corrected, naming both lines; a fresh close clears it", () => {
    const lines = [close("7", { tdd: true, ev: true }), close("8", { waived: true }), fixUp("8")];
    const { findings } = planCheck(setup("28-x", lines), 28);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: "closure-superseded", line: 6, counterpart: { line: 7 },
    });
    expect(findings[0].plan).toContain("28-x/LEDGER.md");
    expect(findings[0].detail).toContain("#8");
    expect(planCheck(setup("28-x", [...lines, close("8", { waived: true })]), 28).findings).toEqual([]);
  });

  it("an id with no closing line is reported on the PLAN.md frontmatter that declared it; no ledger yet reports nothing", () => {
    const { findings } = planCheck(setup("28-x", [close("8", { waived: true })]), 28);
    expect(findings.map((f) => [f.type, f.line])).toEqual([["evidence-missing", 2], ["tdd-missing", 3]]);
    expect(findings.every((f) => f.plan.endsWith("28-x/PLAN.md") && f.detail.includes("#7"))).toBe(true);
    // Plan time: the phase has no LEDGER.md, so no gate has anything to read.
    const planning = fresh();
    plan(planning, "28-x", LEDGER_PLAN);
    context(planning, "28-x", GOOD_BLOCK);
    expect(planCheck(planning, 28).findings).toEqual([]);
  });

  it("the pre-phase-23 exemption: a verified phase numbered 23 or below owes no evidence segment, nothing else is spared", () => {
    const bare = [close("7", { tdd: true }), close("8")];
    expect(planCheck(setup("22-old", bare, true), 22).findings).toEqual([]);
    expect(planCheck(setup("23-gate", bare, true), 23).findings).toEqual([]);
    // Unverified: held to it whatever its number.
    expect(planCheck(setup("22-old", bare), 22).findings.map((f) => f.type))
      .toEqual(["evidence-missing", "evidence-missing"]);
    // Verified past the gate: still held to it.
    expect(planCheck(setup("24-new", bare, true), 24).findings.map((f) => f.type))
      .toEqual(["evidence-missing", "evidence-missing"]);
    // The tdd gate has no exemption.
    expect(planCheck(setup("22-old", [close("7"), close("8")], true), 22).findings.map((f) => f.type))
      .toEqual(["tdd-missing"]);
  });
});

describe("planCheck — determinism", () => {
  it("multi-producer drift onto one consumer is deterministically ordered", () => {
    const dir = fresh();
    plan(dir, "01-alpha", [
      "# Phase 1", "",
      "- Produces: `foo(x: number): string`", "",
    ].join("\n"));
    plan(dir, "02-beta", [
      "# Phase 2", "",
      "- Produces: `bar(y: number): boolean`", "",
    ].join("\n"));
    plan(dir, "03-gamma", [
      "# Phase 3", "",
      "- Consumes: `foo(x: number, extra: string): string` and `bar(y: number): string`", "",
    ].join("\n"));

    const { findings } = planCheck(dir);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.type === "contract-drift")).toBe(true);
    expect(findings.every((f) => f.plan.includes("03-gamma"))).toBe(true);

    // Same consumer plan/line for both findings — the tie-break must fall
    // through to counterpart.plan, and it must land in sorted order.
    expect(findings[0].counterpart?.plan).toContain("01-alpha");
    expect(findings[1].counterpart?.plan).toContain("02-beta");

    const first = JSON.stringify(planCheck(dir));
    const second = JSON.stringify(planCheck(dir));
    expect(first).toBe(second);
  });
});
