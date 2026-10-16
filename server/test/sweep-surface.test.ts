import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, pairRule, type Control, type RuleLine } from "../src/audit/rule-coverage.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";

/**
 * Phase 25 surface gaps — the pieces of the sweep that live in prose and
 * module headers (#210, #179) plus the per-rule candidate cap (#207).
 * Each assertion fails if the thing it names is deleted or renamed.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("sunset clauses (#210)", () => {
  it("every docs/adr/0*.md carries a removeWhen: line", () => {
    const adrs = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^0.*\.md$/.test(f));
    expect(adrs.length).toBeGreaterThan(0);
    const missing = adrs.filter((f) => !/^removeWhen:/m.test(read(`docs/adr/${f}`)));
    expect(missing).toEqual([]);
  });

  it("server gates and gate-shaped hook scripts state removeWhen in their module header", () => {
    const gates = [
      "server/src/context/threshold.ts",
      "server/src/seats/schema.ts",
      "server/src/seats/yield.ts",
      "server/src/seats/dedup.ts",
      "server/src/planning/close-receipt.ts",
      "server/src/planning/check.ts",
      "server/src/planning/budget-ledger.ts",
      "server/src/planning/run-manifest.ts",
      "server/src/audit/record.ts",
      "hooks/scripts/pretooluse-leakguard.mjs",
      "hooks/scripts/pretooluse-runguard.mjs",
      "hooks/scripts/shell-words.mjs",
      "hooks/scripts/posttooluse-loopcheck.mjs",
      "hooks/scripts/stop-costtracker.mjs",
      "hooks/scripts/sessionstart-continuity.mjs",
    ];
    const missing = gates.filter((g) => !existsSync(join(ROOT, g)) || !/removeWhen:/.test(read(g).split("\n").slice(0, 40).join("\n")));
    expect(missing).toEqual([]);
  });

  it("audit milestone lists components whose removal condition has arrived", () => {
    expect(read("skills/cairn-trailhead/verbs/audit.md")).toMatch(/Milestone sunset sweep[\s\S]*removeWhen/);
  });
});

describe("audit sweep mode (#179)", () => {
  const audit = read("skills/cairn-trailhead/verbs/audit.md");
  const section = audit.slice(audit.indexOf("## Sweep"));

  it("the sweep section names the shared label, the manifest scope, the delta classes and --fix", () => {
    expect(section).toContain("cairn:sweep");
    expect(section).toMatch(/audit_record\(scope: "sweep-<YYYY-MM-DD>"/);
    for (const cls of ["new", "persisting", "fixed", "regressed", "unchecked", "uncoveredLegs"]) expect(section).toContain(cls);
    expect(section).toContain("sweep --fix");
    expect(section).toContain("outlook_emit");
  });

  it("legs run in the stated order, milestone last", () => {
    const order = ["`security`", "`tests`", "`docs`", "`plans`", "`simplify`", "`memory`", "`milestone` last"];
    const at = order.map((o) => section.indexOf(o));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("the do router sends sweep / rescan / whole-project wording to audit sweep", () => {
    const route = read("skills/cairn-trailhead/verbs/do.md");
    expect(route).toMatch(/[Rr]escan this project/);
    expect(route).toContain('"sweep"');
    expect(route).toContain("/cairn:audit");
    for (const f of ["commands/audit.md", "skills/cairn-trailhead/SKILL.md", "harness/AGENTS-cairn.md"]) {
      expect(read(f), f).toContain("sweep (whole-project rescan)");
    }
  });

  // The prose wraps; compare on collapsed whitespace.
  const flat = section.replace(/\s+/g, " ");

  it("the report is one prioritized backlog, then the eval table, then spend, then the outlook emit", () => {
    expect(flat).toContain("regressed critical → new critical → persisting critical → " +
      "regressed important → new important → persisting important. Minors as counts only");
    expect(flat).toContain("fixed since the baseline: N");
    // #266: findings whose leg didn't re-run get their own line, never the fixed one.
    expect(flat).toContain('"unchecked: N — legs not re-run: <uncoveredLegs>"; never fold those into fixed');
    const at =["Backlog, in exactly this order", "Eval table", "Spend:", "`outlook_emit(tracker:"]
      .map((s) => flat.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Spend sums the cost report per filed issue — the flag must exist.
    expect(flat).toContain('hooks/scripts/cost-report.mjs" --issue <id>');
    expect(read("hooks/scripts/cost-report.mjs")).toContain('flag("--issue")');
  });

  it("the eval table reads eval-verdicts --json, and every field it leads with is one the script emits", () => {
    expect(flat).toContain("node scripts/eval-verdicts.mjs <that file> --json");
    const dir = mkdtempSync(join(tmpdir(), "cairn-sweep-evals-"));
    writeFileSync(join(dir, "aggregate-result.json"), JSON.stringify({ cases: [{
      name: "a", promptMarkdown: "---\ntags: [regression]\n---\n", arms: { with: [{ passed: false }] } }] }));
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "eval-verdicts.mjs"), dir, "--json"], { encoding: "utf8" });
    const row = JSON.parse(r.stdout).cases[0];
    // "Lead with any row whose `gate` is true and `gateOk` false" — a failing regression row is exactly that.
    expect(flat).toMatch(/whose `gate` is true and `gateOk` false/);
    expect(row).toMatchObject({ gate: true, gateOk: false });
    for (const col of ["case", "tier", "passed", "runs", "verdict"]) expect(row, col).toHaveProperty(col);
  });

  it("the outlook emit names only tracker keys the tool's schema accepts", async () => {
    const keys = /`outlook_emit\(tracker: \{([^}]*)\}\)`/.exec(flat)?.[1].split(",").map((k) => k.trim()) ?? [];
    expect(keys).toEqual(["open", "inProgress", "blocked", "nextVerb", "asOf"]);
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-sweep-outlook-"));
    writeFileSync(join(projectDir, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const server = buildServer({ projectDir, tracker: new FakeTracker(), fetchLatestVersion: async () => "9.9.9" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "outlook_emit");
    const tracker = (tool?.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>)?.tracker;
    const accepted = Object.keys(tracker?.properties ?? {});
    // Unknown keys are stripped, not refused — a misnamed one would vanish from the board silently.
    for (const k of keys) expect(accepted, k).toContain(k);
    await client.close();
  });

  it("--fix runs leg by leg, and a skipped leg is one line, never a stand-in record", () => {
    expect(flat).toContain("`fix/<leg-scope>-<date>/`");
    expect(flat).toContain("Never one patch spanning two legs' findings, never one ask across legs");
    expect(flat).toContain('"leg skipped: memory — no card store here"');
    expect(flat).toContain("never write a stand-in record for a leg that didn't run");
  });
});

describe("verify's straggler check (#272)", () => {
  // Step 3 runs from its numeral to step 4's, both at column 0.
  const verify = read("skills/cairn-trailhead/verbs/verify.md");
  const from = verify.indexOf("\n3. ");
  const to = verify.indexOf("\n4. ");
  const step3 = verify.slice(from, to).replace(/\s+/g, " ");

  it("step 3 exists where the verb says it does", () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
  });

  it("lists the phase's issues by cairn number with no state filter", () => {
    // state: "open" never matched an in_progress issue, so one slipped through
    expect(step3).toContain('`issue_list(phase: "<N>")`');
    expect(step3).not.toMatch(/state:/);
  });

  it("requires every issue closed, fails open and in_progress alike, and reports stragglers", () => {
    expect(step3).toMatch(/every issue[^.;]*closed/i);
    expect(step3).toContain("open");
    expect(step3).toContain("in_progress");
    expect(step3).toMatch(/fail/i);
    expect(step3).toContain("straggler");
  });
});

describe("rule coverage candidate cap (#207)", () => {
  it(`a rule matching more controls than MAX_CANDIDATES (${MAX_CANDIDATES}) lists only the cap`, () => {
    const rule: RuleLine = { file: "CLAUDE.md", line: 1, text: "Never commit secrets to the repo.", keyword: "never", polarity: "prohibition", sourceKind: "instructions" };
    const controls: Control[] = Array.from({ length: MAX_CANDIDATES + 2 }, (_, i) => ({
      type: "hook", id: `hook-${i}`, source: "hooks/hooks.json", detail: "", tokens: ["commit", "secrets"],
    }));
    const cov = pairRule(rule, controls);
    expect(cov.status).toBe("candidate");
    expect(cov.candidates).toHaveLength(MAX_CANDIDATES);
  });
});

describe("axioms (#356)", () => {
  // Pinned on purpose, like the tool count: a clause added or dropped without
  // moving this number fails here. Later issues cite the clauses by number, so
  // the numbering is stable and an edit to it is a decision someone records.
  const AXIOM_COUNT = 6;

  const arch = read("docs/ARCHITECTURE.md");
  const at = arch.indexOf("\n## Axioms\n");
  const next = at < 0 ? -1 : arch.indexOf("\n##", at + "\n## Axioms\n".length);
  const block = at < 0 ? "" : arch.slice(at, next < 0 ? undefined : next);
  const clauseNumbers = (text: string) => [...text.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  const clauseTitles = [...block.matchAll(/^\d+\. \*\*([^*]+)\*\*/gm)].map((m) => m[1]);

  const adrs = readdirSync(join(ROOT, "docs/adr")).filter((f) => /^00\d\d-.*\.md$/.test(f));
  const hooks = [
    "pretooluse-runguard", "pretooluse-harnessguard", "pretooluse-leakguard",
    "posttooluse-loopcheck", "posttooluse-observe", "stop-costtracker",
    "sessionstart-continuity", "posttooluse-breadcrumb",
  ].map((h) => `hooks/scripts/${h}.mjs`);
  /** The first block comment of a hook script -- its header. */
  const header = (rel: string) => /\/\*\*[\s\S]*?\*\//.exec(read(rel))?.[0] ?? "";
  const derivesLine = (text: string) => /^\s*(?:\*\s*)?derives:\s*(.+)$/m.exec(text)?.[1];
  const cited = (line: string) => [...line.matchAll(/\baxiom\s+(\d+)\b/g)].map((m) => Number(m[1]));

  it(`ARCHITECTURE.md opens with exactly ${AXIOM_COUNT} numbered axioms`, () => {
    expect(at).toBeGreaterThan(-1);
    expect(clauseNumbers(block)).toEqual(Array.from({ length: AXIOM_COUNT }, (_, i) => i + 1));
    expect(clauseTitles).toHaveLength(AXIOM_COUNT);
  });

  it("every ADR carries derives: directly after its removeWhen: line", () => {
    expect(adrs.length).toBeGreaterThan(0);
    const missing = adrs.filter((f) => {
      const lines = read(`docs/adr/${f}`).split("\n");
      const i = lines.findIndex((l) => l.startsWith("removeWhen:"));
      return i < 0 || !/^derives: \S/.test(lines[i + 1] ?? "");
    });
    expect(missing).toEqual([]);
  });

  it("every hook script header carries derives:", () => {
    const missing = hooks.filter((h) => !existsSync(join(ROOT, h)) || !derivesLine(header(h)));
    expect(missing).toEqual([]);
  });

  it("every derives: line names an existing axiom, or says convention and why", () => {
    const bad: string[] = [];
    for (const f of [...adrs.map((a) => `docs/adr/${a}`), ...hooks]) {
      const line = derivesLine(f.startsWith("hooks/") ? header(f) : read(f)) ?? "";
      const nums = cited(line);
      const convention = /^convention\s+[—-]\s+\S/.test(line);
      if (convention ? nums.length > 0 : nums.length === 0) bad.push(`${f}: ${line}`);
      if (nums.some((n) => n < 1 || n > AXIOM_COUNT)) bad.push(`${f}: ${line}`);
    }
    expect(bad).toEqual([]);
  });

  it("every axiom is cited at least once, by an ADR or a hook", () => {
    const seen = new Set<number>();
    for (const f of adrs) for (const n of cited(derivesLine(read(`docs/adr/${f}`)) ?? "")) seen.add(n);
    for (const h of hooks) for (const n of cited(derivesLine(header(h)) ?? "")) seen.add(n);
    const uncited = Array.from({ length: AXIOM_COUNT }, (_, i) => i + 1).filter((n) => !seen.has(n));
    expect(uncited).toEqual([]);
  });

  it("the harness spine carries the same axioms under Shared rules", () => {
    const spine = read("harness/AGENTS-cairn.md");
    const shared = spine.slice(spine.indexOf("## Shared rules"));
    expect(shared).toContain("### Axioms");
    expect(clauseNumbers(shared)).toEqual(clauseNumbers(block));
    for (const title of clauseTitles) expect(shared, title).toContain(`**${title}**`);
    // The plumbing paragraph is ARCHITECTURE.md's alone.
    expect(shared).not.toContain("### Deriving from them");
  });

  it("the shared rules carry the claims rule, in the skill and in the spine (#394)", () => {
    const title = "**A sentence is not a mechanism.**";
    const skill = read("skills/cairn-trailhead/SKILL.md");
    expect(skill.slice(skill.indexOf("## Shared rules"))).toContain(title);
    const spine = read("harness/AGENTS-cairn.md");
    expect(spine.slice(spine.indexOf("## Shared rules"))).toContain(title);
  });
});

describe("free dials (#332)", () => {
  it("the routing rubric carries an effort column and a rule against the workflow model override", () => {
    const skill = read("skills/cairn-planning/SKILL.md");
    expect(skill).toMatch(/\| work class \| signals \| routed model \| effort \|/);
    expect(skill).toMatch(/\| mechanical \|.*\| low \|/);
    expect(skill).toMatch(/\| synthesis \|.*\| medium \|/);
    expect(skill).toMatch(/\| judgment gates \|.*\| high \|/);
    expect(skill).toContain("Never set `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`");
  });

  it("every fan-out verb passes the effort dial on dispatch", () => {
    for (const verb of ["survey", "scout", "plan", "review", "work"]) {
      expect(read(`skills/cairn-trailhead/verbs/${verb}.md`), verb).toMatch(/`effort`|effort: high/);
    }
  });

  it("both plugin agents declare their compaction window", () => {
    for (const agent of ["agents/cairn-designer.md", "agents/cairn-uat.md"]) {
      const front = read(agent).split("\n---")[0];
      expect(front, agent).toMatch(/^autoCompactWindow: \d+$/m);
    }
  });

  it("the runbook states the effort dial and the never-set variable", () => {
    const runbook = read("docs/01-runbook.md");
    expect(runbook).toContain("CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL");
    expect(runbook).toMatch(/`effort` dial/);
  });
});
