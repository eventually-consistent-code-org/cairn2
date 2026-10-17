// Eval verdicts (#209): scripts/eval-verdicts.mjs turns a `claude plugin
// eval` aggregate-result.json into per-case PASS / FAIL / INCONCLUSIVE
// verdicts, gating only the regression tier (pass^k). Runs the real script
// against fixture aggregate JSON in a temp dir — never the paid suite.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "eval-verdicts.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One aggregate case: frontmatter tags + a with-arm of pass/fail runs. */
function kase(name: string, tags: string[], runs: boolean[]): unknown {
  return {
    name,
    promptMarkdown: `---\nname: ${name}\ntags: [${tags.join(", ")}]\nruns: ${runs.length}\n---\nprompt body\n`,
    arms: {
      with: runs.map((passed) => ({ passed, graders: [] })),
      without: runs.map(() => ({ passed: false, graders: [] })),
    },
  };
}

/** Write an aggregate-result.json under a fresh temp dir; returns the dir. */
function fixture(cases: unknown[], sub?: string): string {
  const root = mkdtempSync(join(tmpdir(), "cairn-eval-verdicts-"));
  dirs.push(root);
  const dir = sub ? join(root, sub) : root;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "aggregate-result.json"), JSON.stringify({ cases, aggregates: {} }));
  return root;
}

function run(target: string, json = true) {
  const r = spawnSync(process.execPath, [SCRIPT, target, ...(json ? ["--json"] : [])], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: json && r.status !== 2 ? JSON.parse(r.stdout) : null };
}

describe("eval-verdicts", () => {
  it("all runs passed → PASS", () => {
    const r = run(fixture([kase("a", ["do", "regression"], [true, true, true])]));
    expect(r.status).toBe(0);
    expect(r.out.cases[0]).toMatchObject({ verdict: "PASS", runs: 3, passed: 3, gate: true, gateOk: true });
  });

  it("no runs passed → FAIL", () => {
    const r = run(fixture([kase("a", ["capability"], [false, false, false])]));
    expect(r.out.cases[0]).toMatchObject({ verdict: "FAIL", passed: 0 });
  });

  it("split runs (2/3) → INCONCLUSIVE, not a fraction", () => {
    const r = run(fixture([kase("a", ["capability"], [true, false, true])]));
    expect(r.out.cases[0]).toMatchObject({ verdict: "INCONCLUSIVE", runs: 3, passed: 2 });
  });

  it("a split regression case closes the gate → gateOk false, exit 1", () => {
    const r = run(fixture([
      kase("guard", ["ship", "regression"], [true, true, false]),
      kase("target", ["trigger", "capability"], [true, true, true]),
    ]));
    expect(r.status).toBe(1);
    expect(r.out.cases[0]).toMatchObject({ case: "guard", verdict: "INCONCLUSIVE", gate: true, gateOk: false });
    expect(r.out.gateOk).toBe(false);
  });

  it("a failing capability case never gates → gateOk true, exit 0", () => {
    const r = run(fixture([
      kase("target", ["trigger", "capability"], [false, false, false]),
      kase("guard", ["regression"], [true, true, true]),
    ]));
    expect(r.status).toBe(0);
    expect(r.out.cases[0]).toMatchObject({ verdict: "FAIL", gate: false, gateOk: true });
    expect(r.out.gateOk).toBe(true);
  });

  it("a case with no tier tag is a load error naming the case → exit 2", () => {
    const r = run(fixture([kase("fine", ["regression"], [true]), kase("untiered-case", ["do"], [true])]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("untiered-case");
  });

  it("a pre-tier result takes its tier from the case's current definition", () => {
    // Every result recorded before tiers existed embeds an untiered prompt.
    // The tier is a property of the case, so the live prompt.md decides —
    // found here through the run's recorded suite root.
    const repo = mkdtempSync(join(tmpdir(), "cairn-eval-verdicts-repo-"));
    dirs.push(repo);
    mkdirSync(join(repo, "evals", "01-old"), { recursive: true });
    writeFileSync(join(repo, "evals", "01-old", "prompt.md"),
      "---\nname: old\ntags: [do, regression]\nruns: 3\n---\nprompt body\n");
    const stale = { ...(kase("old", ["do"], [true, true, false]) as object), dir: "evals/01-old" };
    const results = mkdtempSync(join(tmpdir(), "cairn-eval-verdicts-"));
    dirs.push(results);
    writeFileSync(join(results, "aggregate-result.json"),
      JSON.stringify({ suite: { root: repo }, cases: [stale], aggregates: {} }));
    const r = run(results);
    expect(r.status).toBe(1);
    expect(r.out.cases[0]).toMatchObject({ case: "old", tier: "regression", verdict: "INCONCLUSIVE", gateOk: false });
  });

  it("a case carrying both tiers is a load error too", () => {
    const r = run(fixture([kase("both-case", ["regression", "capability"], [true])]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("both-case");
  });

  it("no cases → exit 2", () => {
    expect(run(fixture([])).status).toBe(2);
  });

  it("a results parent resolves to the newest timestamped subdir", () => {
    const root = fixture([kase("old", ["capability"], [false])], "2026-09-01T00-00-00");
    mkdirSync(join(root, "2026-09-20T06-17-00"));
    writeFileSync(
      join(root, "2026-09-20T06-17-00", "aggregate-result.json"),
      JSON.stringify({ cases: [kase("new", ["capability"], [true])] }),
    );
    const r = run(root);
    expect(r.out.source).toBe(join(root, "2026-09-20T06-17-00", "aggregate-result.json"));
    expect(r.out.cases.map((c: { case: string }) => c.case)).toEqual(["new"]);
  });

  it("--json prints exactly { source, cases: [{ case, tier, runs, passed, verdict, gate, gateOk }], gateOk }", () => {
    const root = fixture([kase("a", ["regression"], [true, true])]);
    const r = run(join(root, "aggregate-result.json"));
    expect(Object.keys(r.out).sort()).toEqual(["cases", "gateOk", "source"]);
    expect(Object.keys(r.out.cases[0]).sort()).toEqual(
      ["case", "gate", "gateOk", "passed", "runs", "tier", "verdict"],
    );
    expect(r.out.cases[0]).toEqual({ case: "a", tier: "regression", runs: 2, passed: 2, verdict: "PASS", gate: true, gateOk: true });
  });

  it("without --json prints a table and a one-line summary", () => {
    const r = run(fixture([kase("a", ["regression"], [true, false])]), false);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/a\s+regression\s+1\/2\s+INCONCLUSIVE\s+BLOCK/);
    expect(r.stdout).toMatch(/regression gate NOT ok/);
  });

  it("reads block-form frontmatter tags", () => {
    const c = kase("blocky", [], [true]) as { promptMarkdown: string };
    c.promptMarkdown = "---\nname: blocky\ntags:\n  - do\n  - capability\n---\nbody\n";
    expect(run(fixture([c])).out.cases[0].tier).toBe("capability");
  });
});

describe("eval-verdicts over the live suite (#209)", () => {
  const ROOT = join(dirname(SCRIPT), "..");
  // The suite lives on the orphan branch `evals-archive` (#403), checked out
  // beside the repo root (`git worktree add evals-archive evals-archive`,
  // gitignored) or wherever CAIRN_EVALS_ARCHIVE points. Without it this
  // agreement check skips — the table in docs/EVALS.md is still the doc.
  const ARCHIVE = process.env.CAIRN_EVALS_ARCHIVE ?? join(ROOT, "evals-archive");
  const SUITE = join(ARCHIVE, "evals");

  it.skipIf(!existsSync(SUITE))("every archived evals/ case loads with exactly one tier, and docs/EVALS.md's per-case table agrees", () => {
    const names = readdirSync(SUITE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name)).map((d) => d.name).sort();
    expect(names.length).toBeGreaterThan(0);

    // One run per case, embedded prompt untiered: only the live prompt.md
    // (found through suite.root) can supply the tier, so an untiered or
    // double-tiered case in evals/ is an exit-2 load error here.
    const results = mkdtempSync(join(tmpdir(), "cairn-eval-verdicts-"));
    dirs.push(results);
    writeFileSync(join(results, "aggregate-result.json"), JSON.stringify({
      suite: { root: ARCHIVE },
      cases: names.map((name) => ({ name, dir: `evals/${name}`, promptMarkdown: "---\nname: x\n---\n",
        arms: { with: [{ passed: true, graders: [] }], without: [] } })),
    }));
    const r = run(results);
    expect(r.status, r.stderr).toBe(0);
    const live = Object.fromEntries(r.out.cases.map((c: { case: string; tier: string }) => [c.case, c.tier]));

    // The documented tier for each case: one row per case, plus range rows ("10–19 trigger-*").
    const docs = readFileSync(join(ROOT, "docs", "EVALS.md"), "utf8");
    const documented: Record<string, string> = {};
    for (const m of docs.matchAll(/^\| (\d\d) ([a-z0-9-]+) \| (regression|capability) \|/gm)) {
      documented[`${m[1]}-${m[2]}`] = m[3];
    }
    for (const m of docs.matchAll(/^\| (\d\d)[–-](\d\d) ([a-z0-9-]+)-\* \| (regression|capability) \|/gm)) {
      for (const n of names) {
        const num = Number(n.slice(0, 2));
        if (num >= Number(m[1]) && num <= Number(m[2]) && n.slice(3).startsWith(`${m[3]}-`)) documented[n] = m[4];
      }
    }
    expect(live).toEqual(documented);
    // The suite keeps at least one gate — a tier flip can't silently empty it.
    expect(Object.values(live)).toContain("regression");
  });
});
