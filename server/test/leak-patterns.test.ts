import { describe, it, expect } from "vitest";
// @ts-expect-error untyped hook module
import { buildPatterns, scanLines, isAllowedPath, patternsForFile } from "../../hooks/scripts/leak-patterns.mjs";
import { buildLeakPatterns, scanForLeaks, type LeakScanConfig } from "../src/peers/leak-scan.js";
import { PEER_ENV_DROP } from "../src/peers/run.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const jiraCfg = { tracker: { type: "jira", config: { projectKey: "DRILL" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };
const ghCfg = { tracker: { type: "github", config: { repo: "o/r" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };

describe("leak patterns", () => {
  it("hits every default class", () => {
    const pats = buildPatterns(jiraCfg);
    const hits = scanLines([
      'const p = ".cairn/plans/roadmap.md";',
      "// see phases/03-switchback for context",
      "// archived in milestones/v1",
      'label: "cairn:seed",',
      "// tracked as DRILL-42",
      "const clean = true;",
    ], pats);
    expect(hits.map((h) => h.name).sort())
      .toEqual(["cairn-label", "cairn-path", "phase-ref", "phase-ref", "tracker-id"].sort());
    expect(hits.some((h) => h.line === 6)).toBe(false);
  });

  it("github config gets NO tracker-id pattern — #N never matches", () => {
    const pats = buildPatterns(ghCfg);
    expect(scanLines(["// fixes #123 properly"], pats)).toEqual([]);
  });

  it("extraPatterns extend; invalid regexes are skipped silently", () => {
    const pats = buildPatterns({ ...ghCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["SECRET_PLAN", "(["] } });
    expect(scanLines(["// SECRET_PLAN here"], pats).some((h) => h.name === "extra")).toBe(true);
  });

  // #140 path-scoped exemption -- fixture strings are concatenated so this
  // file's own diff never trips the live guard when committed.
  describe("patternsForFile: server-source cairn-path exemption (#140)", () => {
    const cairnRef = 'const dir = ".cairn' + '/plans/x";';
    const trackerRef = "// tracked as DRILL" + "-42";
    const labelRef = 'label: "cairn' + ':seed",';

    it("server/src and server/dist skip cairn-path ONLY — other patterns intact", () => {
      const pats = buildPatterns(jiraCfg);
      for (const p of ["server/src/planning/ledger.ts", "server/dist/planning/ledger.js"]) {
        const active = patternsForFile(p, pats);
        expect(scanLines([cairnRef], active)).toEqual([]);
        expect(scanLines([trackerRef], active).map((h: { name: string }) => h.name)).toEqual(["tracker-id"]);
        expect(scanLines([labelRef], active).map((h: { name: string }) => h.name)).toEqual(["cairn-label"]);
      }
    });

    it("every other path keeps cairn-path at full strength", () => {
      const pats = buildPatterns(jiraCfg);
      for (const p of ["src/thing.ts", "hooks/scripts/x.mjs", "server/test/fixture.ts", "serverx/src/a.ts"]) {
        expect(scanLines([cairnRef], patternsForFile(p, pats)).map((h: { name: string }) => h.name))
          .toEqual(["cairn-path"]);
      }
    });

    it("absolute paths containing /server/src/ are exempt too (CLI mode)", () => {
      const pats = buildPatterns(ghCfg);
      expect(scanLines([cairnRef], patternsForFile("/Users/x/repo/server/src/a.ts", pats))).toEqual([]);
    });
  });

  // #268: the server screens outbound peer input with its own TS port of
  // this pattern set — it ships dist only and cannot import the hook module
  // at runtime. These tests are the tether: change the hook's set without
  // the port (or the reverse) and they go red.
  describe("server port parity (#268)", () => {
    const configs: Array<[string, unknown]> = [
      ["no config", null],
      ["empty config", {}],
      ["github", ghCfg],
      ["jira with a key", jiraCfg],
      ["jira with a non-identifier key", { tracker: { type: "jira", config: { projectKey: "bad key" } } }],
      ["jira with a non-string key", { tracker: { type: "jira", config: { projectKey: 42 } } }],
      ["github carrying a projectKey", { tracker: { type: "github", config: { projectKey: "DRILL" } } }],
      ["extras, one invalid", { ...ghCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["SECRET_PLAN", "([", "^AKIA"] } }],
      ["jira + extras", { ...jiraCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["foo\\d+"] } }],
    ];
    const shape = (pats: Array<{ name: string; re: RegExp }>) =>
      pats.map(({ name, re }) => ({ name, source: re.source, flags: re.flags }));

    it.each(configs)("same pattern names, sources and flags — %s", (_label, cfg) => {
      expect(shape(buildLeakPatterns(cfg as LeakScanConfig))).toEqual(shape(buildPatterns(cfg)));
    });

    // The one deliberate difference: the hook exempts server source from
    // cairn-path (#140); outbound text is no repo file, so the port has no
    // exemption. Pin that the hook's ONLY exemption is that one — a new
    // exemption in the hook needs a decision about outbound text too.
    it("the hook's only path exemption is cairn-path — the port carries none", () => {
      const exempt = buildPatterns(jiraCfg)
        .filter((p: { exemptPrefixes?: string[] }) => p.exemptPrefixes)
        .map((p: { name: string }) => p.name);
      expect(exempt).toEqual(["cairn-path"]);
      for (const p of buildLeakPatterns(jiraCfg)) expect(p).not.toHaveProperty("exemptPrefixes");
    });

    // Same lines, same verdicts: the port's scan agrees with scanLines hit
    // for hit (line + kind) on a corpus that trips every class.
    it("scanForLeaks agrees with scanLines hit for hit", () => {
      const corpus = [
        'const p = ".cairn' + '/plans/roadmap.md";',
        "// see phases" + "/03-switchback for context",
        "// archived in milestones" + "/v1",
        'label: "cairn' + ':backlog",',
        "// tracked as DRILL" + "-42",
        "// SECRET_PLAN rides along",
        "const clean = true;",
      ].join("\n");
      const cfg = { ...jiraCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["SECRET_PLAN"] } };
      const hook = scanLines(corpus.split("\n"), buildPatterns(cfg))
        .map(({ line, name }: { line: number; name: string }) => ({ line, name }));
      expect(hook).toHaveLength(6);
      expect(scanForLeaks(corpus, cfg)).toEqual(hook);
    });

    it("leakGuard.enabled === false switches the port's scan off; absent keeps it on", () => {
      const leak = "see .cairn" + "/plans/x";
      expect(scanForLeaks(leak, { leakGuard: { enabled: false } })).toEqual([]);
      expect(scanForLeaks(leak, { leakGuard: {} })).toHaveLength(1);
      expect(scanForLeaks(leak, null)).toHaveLength(1);
    });

    it("hits carry line + kind only — never the matched text", () => {
      const [hit] = scanForLeaks("x\nlabel cairn" + ":seed", null);
      expect(hit).toEqual({ line: 2, name: "cairn-label" });
    });
  });

  it("allowlist: defaults + trailing-/** config globs", () => {
    expect(isAllowedPath(".cairn/plans/PLAN.md", [])).toBe(true);
    expect(isAllowedPath("docs/adr/0001-x.md", [])).toBe(true);
    expect(isAllowedPath("notes.md", [])).toBe(true);
    expect(isAllowedPath("src/thing.ts", [])).toBe(false);
    expect(isAllowedPath("generated/deep/file.ts", ["generated/**"])).toBe(true);
    expect(isAllowedPath("src/one.ts", ["src/one.ts"])).toBe(true);
  });
});


// #340: the outbound packet scan (above) and the child-env credential drop
// are the two halves of one containment claim -- what a peer can SEE in
// its input and what it can READ from its own process. They live in one
// test file on purpose, so neither can drift without the other noticing.
// The parity check is a source scan, not an import: every credential
// variable an adapter declares as its default (`tokenEnv`/`patEnv`/
// `apiKeyEnv: z.string().default("X")`) or reads literally
// (`process.env.X`) must be on PEER_ENV_DROP. A new adapter that forgets
// fails here, not in a reviewer's shell.
describe("peer child env drop covers every adapter credential default (#340)", () => {
  const adaptersDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tracker", "adapters");
  const declared = new Set<string>();
  for (const f of readdirSync(adaptersDir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(adaptersDir, f), "utf8");
    for (const m of src.matchAll(/(?:tokenEnv|patEnv|apiKeyEnv):\s*z\.string\(\)\.default\("([A-Z0-9_]+)"\)/g)) declared.add(m[1]);
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*TOKEN[A-Z0-9_]*)/g)) declared.add(m[1]);
  }

  it("scans at least the eight shipped adapters' defaults", () => {
    expect(declared.size).toBeGreaterThanOrEqual(7);
  });

  it("every declared credential default is on the drop list", () => {
    const missing = [...declared].filter((name) => !PEER_ENV_DROP.includes(name));
    expect(missing).toEqual([]);
  });

  it("the drop list keeps the Copilot seat's own credential", () => {
    expect(PEER_ENV_DROP).not.toContain("COPILOT_GITHUB_TOKEN");
    expect(PEER_ENV_DROP).toContain("GH_TOKEN");
  });
});
