import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { MAX_CANDIDATES, pairRule, type Control, type RuleLine } from "../src/audit/rule-coverage.js";
import { ConfigSchema } from "../src/config.js";
import { outlookMirrorPath } from "../src/core/outlook.js";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { IMPORT_BLOCK, READERS, reachFrom, scanImport } from "../../setup/spine-reach.mjs";
import { overlapFiles, overlapLead } from "../../scripts/lib/merge-overlap.mjs";
import { formatReaders, mechanismLeg, parseHarnesses, projectLeg } from "../../scripts/lib/readers-leg.mjs";

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

  it("the report is one prioritized backlog, then the eval table, then spend and the snapshot", () => {
    expect(flat).toContain("regressed critical → new critical → persisting critical → " +
      "regressed important → new important → persisting important. Minors as counts only");
    expect(flat).toContain("fixed since the baseline: N");
    // #266: findings whose leg didn't re-run get their own line, never the fixed one.
    expect(flat).toContain('"unchecked: N — legs not re-run: <uncoveredLegs>"; never fold those into fixed');
    const at =["Backlog, in exactly this order", "Eval table", "Spend:", "`agentCostUsd`", "`outlook`"]
      .map((s) => flat.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // #368: the manifest's file: true sums the cost log itself — no shell call per issue.
    expect(flat).not.toContain("cost-report.mjs");
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

  it("the outlook snapshot rides the manifest's file: true, with only tracker keys outlook_emit accepts (#368)", async () => {
    // The verb no longer hand-writes the emit; the manifest call does it.
    expect(flat).not.toMatch(/`outlook_emit\(tracker:/);
    expect(flat).toContain('audit_record(scope: "sweep-<YYYY-MM-DD>", verdict, findings, legs, file: true)');
    const projectDir = mkdtempSync(join(tmpdir(), "cairn-sweep-outlook-"));
    writeFileSync(join(projectDir, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const server = buildServer({ projectDir, tracker: new FakeTracker(), fetchLatestVersion: async () => "9.9.9" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const res = await client.callTool({ name: "audit_record",
        arguments: { scope: "sweep-2026-03-01", verdict: "pass", findings: [], file: true } });
      expect(JSON.parse((res.content as Array<{ text: string }>)[0].text).outlook).toEqual({ emitted: true });
      const keys = Object.keys(JSON.parse(readFileSync(outlookMirrorPath(projectDir), "utf8")).tracker ?? {});
      expect(keys.length).toBeGreaterThan(0);
      const tool = (await client.listTools()).tools.find((t) => t.name === "outlook_emit");
      const tracker = (tool?.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>)?.tracker;
      const accepted = Object.keys(tracker?.properties ?? {});
      // A key the emit schema doesn't know is one a plain emit could never write or read back.
      for (const k of keys) expect(accepted, k).toContain(k);
    } finally {
      rmSync(outlookMirrorPath(projectDir), { force: true });
      await client.close();
    }
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
    // The plumbing paragraph and the docs writer's marker are ARCHITECTURE.md's alone.
    expect(shared).not.toContain("### Deriving from them");
    expect(shared).not.toContain("<!-- docs:");
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
    // #406: synthesis splits by model, not by effort class alone
    expect(skill).toMatch(/\| mechanical \|.*\| low \|/);
    expect(skill).toMatch(/\| routine synthesis \|.*\| medium \|/);
    expect(skill).toMatch(/\| complex synthesis \|.*\| high \|/);
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

describe("model routing names concrete tiers and reaches work waves (#406)", () => {
  const skill = read("skills/cairn-planning/SKILL.md");
  // The rubric's rows: class → routed model (raw cell, and backticks stripped).
  const rubric = [...skill.matchAll(/^\| ([a-z ]+) \| [^|\n]+ \| ([^|\n]+) \| (?:low|medium|high) \|$/gm)]
    .map((m) => ({ cls: m[1], raw: m[2].trim(), model: m[2].trim().replace(/`/g, "") }));

  // work.md step 2 runs from its numeral to step 3's, both at column 0.
  const work = read("skills/cairn-trailhead/verbs/work.md");
  const step2 = work.slice(work.indexOf("\n2. "), work.indexOf("\n3. "));
  const flat2 = step2.replace(/\s+/g, " ");
  const annotation = "`` `model: <auto|haiku|sonnet|opus>` ``";

  it("the rubric has its four work classes, each routed to a named tier, never the session", () => {
    expect(rubric.map((r) => r.cls)).toEqual(
      ["mechanical", "routine synthesis", "complex synthesis", "judgment gates"]);
    expect(rubric.map((r) => r.model)).toEqual(["haiku", "sonnet", "opus", "strongest available"]);
    // A Fable session sits above opus, so "session" names no tier at all
    for (const r of rubric) expect(r.model, r.cls).not.toMatch(/session|inherit/i);
  });

  it("the rubric's scope sentence names work wave dispatch beside the research verbs", () => {
    expect(skill.replace(/\s+/g, " ")).toMatch(/The rubric governs ALL research fan-out[^.]*and `work` wave dispatch/);
  });

  it("work step 2 resolves every issue's model in the stated order", () => {
    expect(step2.length).toBeGreaterThan(0);
    expect(flat2).toContain("agents.model");
    expect(flat2).toContain("Resolution order, first match wins: the `agents.model` pin > " +
      "the task's `model:` annotation > the rubric by work class > inherit.");
  });

  it("work's copy of the tiers matches the rubric table, row for row", () => {
    expect(rubric).toHaveLength(4);
    for (const r of rubric) expect(flat2, r.cls).toContain(`${r.cls} → ${r.raw}`);
  });

  it("both dispatch paths carry the resolved model", () => {
    const primary = flat2.slice(flat2.indexOf("**Primary"), flat2.indexOf("**Fallback"));
    const fallback = flat2.slice(flat2.indexOf("**Fallback"));
    expect(primary).toMatch(/agent\(brief, \{[^}]*\bmodel\b[^}]*\}\)/);
    expect(fallback).toContain("resolved model");
  });

  it("the wave report prints the per-issue resolution table, and the brief's {{model}} slot is filled", () => {
    expect(step2).toContain("| issue | class | model | by |");
    expect(flat2).toContain("`{{model}}`");
  });

  it("plan's task grammar carries the model: annotation beside seat:, with tiers agents.model accepts", () => {
    const plan = read("skills/cairn-trailhead/verbs/plan.md").replace(/\s+/g, " ");
    const at = plan.indexOf(annotation);
    expect(at).toBeGreaterThan(plan.indexOf("`` `seat: <name>` ``"));
    const tiers = /model: <([a-z|]+)>/.exec(annotation)![1].split("|");
    const accepted = ConfigSchema.shape.agents.unwrap().shape.model.options as readonly string[];
    for (const t of tiers) expect(accepted, t).toContain(t);
    // inherit is the pin's word, not a per-task one
    expect(tiers).not.toContain("inherit");
  });
});

describe("command shim allowed-tools (#400)", () => {
  // The portal holds a bare `Bash` in a command's allowed-tools as
  // ALLOWED_TOOLS_BROAD: any shell line runs unasked while the verb is
  // active. Every shim is generated from one constant in
  // scripts/gen-commands.mjs, so one slip there lands in all 39 at once.
  const shims = readdirSync(join(ROOT, "commands")).filter((f) => f.endsWith(".md"));

  const allowedTools = (file: string): string[] => {
    const m = /^allowed-tools:\s*(.+)$/m.exec(read(`commands/${file}`));
    if (!m) return [];
    let raw = m[1].trim();
    if (raw.startsWith('"')) raw = JSON.parse(raw);
    return raw.split(",").map((t) => t.trim()).filter(Boolean);
  };

  // Bare Bash, the catch-all, and any interpreter or runner left wide open —
  // `Bash(node:*)` is `Bash` with extra steps.
  const BROAD = /^Bash(\(\*\))?$|^Bash\((node|npx|npm|sh|bash|zsh|python3?|curl|wget)(:\*)?\)$/;

  it("there are shims to check", () => {
    expect(shims.length).toBeGreaterThan(0);
  });

  it("no shim carries bare Bash, Bash(*) or an interpreter/runner wildcard", () => {
    const offenders = shims.flatMap((f) =>
      allowedTools(f).filter((t) => BROAD.test(t)).map((t) => `commands/${f}: ${t}`));
    expect(offenders).toEqual([]);
  });

  it("every shim pre-approves exactly the read-only git family (#414: worktree list only, no branch)", () => {
    const expected = ["status", "log", "diff", "rev-parse", "describe", "worktree list"]
      .map((sub) => `Bash(git ${sub}:*)`);
    for (const f of shims) {
      const bash = allowedTools(f).filter((t) => t.startsWith("Bash"));
      expect(bash, `commands/${f}`).toEqual(expected);
    }
  });
});

describe("the spine's readers (#398)", () => {
  // Claude Code reads AGENTS.md only when no CLAUDE.md is in scope (a claim,
  // as of 2026-10, per the Claude Code memory docs), so the spine reached
  // every harness but the one the plugin targets. These pin the fix: setup
  // installs an @AGENTS.md import and --check sees it; the readers leg is red
  // when any harness has no load path to the fragment.
  const SETUP = join(ROOT, "setup", "cairn-setup.mjs");
  const FRAGMENT = read("harness/AGENTS-cairn.md");
  type Row = { harness: string; loadFile: string; via: string; path: string; claim: string };
  const TABLE = READERS as Row[];

  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "cairn-398-"));
    mkdirSync(join(d, "p"));
    mkdirSync(join(d, "h"));
    return { dir: d, proj: join(d, "p"), home: join(d, "h") };
  };
  const setup = (home: string, ...args: string[]) => spawnSync(process.execPath, [SETUP, ...args], {
    encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_SETUP_OFFLINE: "1" },
  });

  it("setup claude --check is red on a CLAUDE.md without the import, green after install", () => {
    const s = scratch();
    try {
      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n\nnotes\n");
      writeFileSync(join(s.proj, "AGENTS.md"), FRAGMENT);
      const red = setup(s.home, "claude", "--project", s.proj, "--check");
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("CLAUDE.md has no @AGENTS.md import");

      expect(setup(s.home, "claude", "--project", s.proj).status).toBe(0);
      const claude = readFileSync(join(s.proj, "CLAUDE.md"), "utf8");
      expect(claude.startsWith(IMPORT_BLOCK)).toBe(true);
      expect(claude.split("\n").slice(0, 3)).toContain("@AGENTS.md");
      expect(claude).toContain("# my project\n\nnotes\n");

      const green = setup(s.home, "claude", "--project", s.proj, "--check");
      expect(green.status).toBe(0);
      expect(green.stdout).toContain("CLAUDE.md imports AGENTS.md (line 2)");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("a second install changes nothing", () => {
    const s = scratch();
    try {
      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n");
      setup(s.home, "claude", "--project", s.proj);
      const once = readFileSync(join(s.proj, "CLAUDE.md"), "utf8");
      const again = setup(s.home, "claude", "--project", s.proj);
      expect(again.stdout).toContain("import already current");
      expect(readFileSync(join(s.proj, "CLAUDE.md"), "utf8")).toBe(once);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("an import inside a code fence or HTML comment does not count", () => {
    const s = scratch();
    try {
      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n\n```md\n@AGENTS.md\n```\n");
      writeFileSync(join(s.proj, "AGENTS.md"), FRAGMENT);
      const red = setup(s.home, "claude", "--project", s.proj, "--check");
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("line 4 sits inside a code fence");
      expect(scanImport("~~~\n@AGENTS.md\n~~~\n@AGENTS.md\n")).toEqual({ line: 4, hidden: 2 });
      expect(scanImport("<!--\n@AGENTS.md\n-->\n")).toEqual({ line: null, hidden: 2 });
      expect(scanImport("    @AGENTS.md\n")).toEqual({ line: null, hidden: null });
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("with no CLAUDE.md, claude --check is green when AGENTS.md carries the fragment, and says why", () => {
    const s = scratch();
    try {
      writeFileSync(join(s.proj, "AGENTS.md"), FRAGMENT);
      const r = setup(s.home, "claude", "--project", s.proj, "--check");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("AGENTS.md read directly");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("every other target adds the import to a CLAUDE.md already present, and creates none", () => {
    const s = scratch();
    const bare = scratch();
    try {
      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n");
      expect(setup(s.home, "grok", "--project", s.proj).status).toBe(0);
      expect(readFileSync(join(s.proj, "CLAUDE.md"), "utf8").startsWith(IMPORT_BLOCK)).toBe(true);
      expect(setup(bare.home, "grok", "--project", bare.proj).status).toBe(0);
      expect(existsSync(join(bare.proj, "CLAUDE.md"))).toBe(false);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
      rmSync(bare.dir, { recursive: true, force: true });
    }
  });

  it("every readers row is a dated claim", () => {
    expect(TABLE.length).toBeGreaterThan(0);
    for (const r of TABLE) expect(r.claim, r.harness).toMatch(/^as of \d{4}-\d{2}, per /);
  });

  it("mechanism leg: green on the real table, one printed line per harness", () => {
    const harnesses = parseHarnesses(read("setup/cairn-setup.mjs"));
    expect(harnesses.length).toBe(8);
    const mech = mechanismLeg({ table: TABLE, harnesses, setupPath: SETUP });
    expect(mech.failures).toEqual([]);
    const lines: string[] = formatReaders(mech, { rows: [] });
    expect(lines).toHaveLength(harnesses.length);
    for (const h of harnesses) expect(lines.some((l) => l.trimStart().startsWith(`${h} `))).toBe(true);
  });

  it("mechanism leg: red on a missing row, an empty table, or a load file setup never writes", () => {
    const harnesses = parseHarnesses(read("setup/cairn-setup.mjs"));
    const noZed = mechanismLeg({ table: TABLE.filter((r) => r.harness !== "zed"), harnesses, setupPath: SETUP });
    expect(noZed.failures).toEqual(["zed: no readers row — add one naming the file zed loads at session start"]);

    expect(mechanismLeg({ table: [], harnesses: [], setupPath: SETUP }).failures)
      .toEqual(["readers table is empty", "no harness list parsed from setup/cairn-setup.mjs"]);

    const gemini = { ...TABLE.find((r) => r.harness === "gemini")!, loadFile: "GEMINI-elsewhere.md" };
    expect(mechanismLeg({ table: [gemini], harnesses: ["gemini"], setupPath: SETUP }).failures)
      .toEqual(["gemini: setup gemini never writes GEMINI-elsewhere.md"]);
  });

  it("project leg: red when a present load file misses the fragment, absent is not installed", () => {
    const s = scratch();
    const legFailures = () => projectLeg({ table: TABLE, projectDir: s.proj, fragment: FRAGMENT }).failures;
    try {
      // nothing present: every row is "not installed here", nothing red
      const none = projectLeg({ table: TABLE, projectDir: s.proj, fragment: FRAGMENT });
      expect(none.failures).toEqual([]);
      expect(none.rows.every((r: { state: string }) => r.state === "absent")).toBe(true);

      writeFileSync(join(s.proj, "AGENTS.md"), FRAGMENT);
      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n");
      expect(legFailures()).toEqual(["claude: CLAUDE.md has no @AGENTS.md import"]);

      writeFileSync(join(s.proj, "CLAUDE.md"), "# my project\n\n\n@AGENTS.md\n");
      expect(legFailures()).toEqual(["claude: CLAUDE.md imports AGENTS.md at line 4, not within the first three lines"]);

      writeFileSync(join(s.proj, "CLAUDE.md"), `${IMPORT_BLOCK}\n# my project\n`);
      expect(legFailures()).toEqual([]);

      writeFileSync(join(s.proj, "AGENTS.md"), "# just notes\n");
      expect(legFailures()).toContain("codex: AGENTS.md carries no cairn section");
      expect(legFailures()).toContain("claude: CLAUDE.md imports AGENTS.md, but AGENTS.md carries no cairn section");

      writeFileSync(join(s.proj, "AGENTS.md"), FRAGMENT.replace("# cairn", "# cairn (old)"));
      expect(legFailures()).toContain("codex: AGENTS.md cairn section is stale vs harness/AGENTS-cairn.md");
      expect(projectLeg({ table: [], projectDir: s.proj, fragment: FRAGMENT }).failures)
        .toEqual(["readers table is empty"]);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("this checkout carries the dogfood AGENTS.md, fresh, for every direct reader", () => {
    const codex = TABLE.find((r) => r.harness === "codex")!;
    expect(reachFrom(ROOT, codex, { fragment: FRAGMENT }))
      .toEqual({ state: "reaches", detail: "AGENTS.md carries the fragment" });
  });
});

describe("review target includes untracked files (#360)", () => {
  const review = () => read("skills/cairn-trailhead/verbs/review.md");

  it("the default-target row names untracked files git does not ignore", () => {
    expect(review()).toContain("working diff, staged, and untracked files git does not ignore");
    expect(review()).toContain("git ls-files --others --exclude-standard");
    expect(review()).toContain("git diff --no-index /dev/null");
  });

  it("the review record notes how many untracked files the pass included", () => {
    expect(review()).toContain("untracked files included: <n>");
  });

  it("peers review and audit simplify inherit by reference, no second table", () => {
    expect(read("skills/cairn-trailhead/verbs/peers.md")).toMatch(/untracked/);
    expect(read("skills/cairn-trailhead/verbs/audit.md")).toMatch(/untracked/);
  });

  it("the documented recipe resolves modified, staged and untracked, never ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-untracked-"));
    const git = (...a: string[]) => {
      const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0 && r.status !== 1) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(dir, "tracked.txt"), "one\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      writeFileSync(join(dir, "tracked.txt"), "two\n");
      writeFileSync(join(dir, "staged.txt"), "staged\n");
      git("add", "staged.txt");
      writeFileSync(join(dir, "fresh.txt"), "fresh\n");
      writeFileSync(join(dir, "ignored.txt"), "ignored\n");

      const tracked = git("diff", "HEAD");
      const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
      const rendered = untracked.map((p) => git("diff", "--no-index", "/dev/null", p)).join("");
      const target = tracked + rendered;

      expect(untracked).toEqual(["fresh.txt"]);
      expect(target).toContain("tracked.txt");
      expect(target).toContain("staged.txt");
      expect(target).toContain("+fresh");
      expect(target).not.toContain("ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("merge leads with file overlap (#223)", () => {
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-overlap-"));
    const git = (...a: string[]) => {
      const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    const put = (f: string, body: string) => {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), body);
    };
    const commit = (msg: string) => {
      git("add", "-A");
      git("commit", "-qm", msg);
    };
    put("shared.ts", "base\n");
    commit("base");
    return { dir, git, put, commit };
  };

  it("two branches touching one shared file produce a lead naming it", () => {
    const { dir, git, put, commit } = scratch();
    try {
      git("checkout", "-q", "-b", "a");
      put("shared.ts", "a\n");
      put("a-only.ts", "a\n");
      commit("a");
      git("checkout", "-q", "main");
      git("checkout", "-q", "-b", "b");
      put("shared.ts", "b\n");
      put("b-only.ts", "b\n");
      commit("b");
      expect(overlapFiles(dir, "a", "b")).toEqual(["shared.ts"]);
      expect(overlapLead(dir, "a", "b")).toBe("overlap: 1 file — shared.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disjoint branches produce overlap: none", () => {
    const { dir, git, put, commit } = scratch();
    try {
      git("checkout", "-q", "-b", "a");
      put("a-only.ts", "a\n");
      commit("a");
      git("checkout", "-q", "main");
      git("checkout", "-q", "-b", "b");
      put("b-only.ts", "b\n");
      commit("b");
      expect(overlapLead(dir, "a", "b")).toBe("overlap: none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a bad ref is an error, never a quiet none", () => {
    const { dir } = scratch();
    try {
      expect(() => overlapLead(dir, "main", "no-such-ref")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("work.md and ship.md carry the lead and name the helper", () => {
    for (const verb of ["work", "ship"]) {
      const t = read(`skills/cairn-trailhead/verbs/${verb}.md`);
      expect(t).toContain("overlap: none");
      expect(t).toContain("scripts/lib/merge-overlap.mjs");
    }
  });
});
