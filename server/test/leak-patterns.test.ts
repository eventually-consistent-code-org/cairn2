import { describe, it, expect } from "vitest";
// @ts-expect-error untyped hook module
import { buildPatterns, scanLines, isAllowedPath, patternsForFile } from "../../hooks/scripts/leak-patterns.mjs";
import { buildLeakPatterns, redactLeaks, scanForLeaks, type LeakScanConfig } from "../src/peers/leak-scan.js";
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

    // #374 -- the redacting form the server's own tracker comments go
    // through: the whole token around a hit becomes a placeholder naming the
    // KIND, never the text, and the kinds come back once each.
    describe("redactLeaks", () => {
      it("replaces the token around every hit with a kind-named placeholder", () => {
        const text = "Declared verify: `cat .cairn" + "/plans/phases/01-core/PLAN.md && npm test`\n"
          + "see phases" + "/03-switchback and DRILL" + "-42 too";
        const out = redactLeaks(text, jiraCfg);
        expect(out.text).toBe(
          "Declared verify: `cat [redacted cairn-path] && npm test`\n"
          + "see [redacted phase-ref] and [redacted tracker-id] too");
        expect(out.redacted).toEqual(["cairn-path", "phase-ref", "tracker-id"]);
        expect(scanForLeaks(out.text, jiraCfg)).toEqual([]);
      });

      it("clean text comes back byte-identical with nothing redacted", () => {
        const text = "evidence: `npm test` → 1 passed";
        expect(redactLeaks(text, jiraCfg)).toEqual({ text, redacted: [] });
      });

      it("leakGuard.enabled === false leaves the text alone, like scanForLeaks", () => {
        const text = "see .cairn" + "/plans/x";
        expect(redactLeaks(text, { leakGuard: { enabled: false } })).toEqual({ text, redacted: [] });
      });

      it("a hit that survives redaction is still a hit on the re-scan -- the caller refuses", () => {
        // a user pattern that matches the placeholder itself can never be
        // redacted away; redactLeaks replaces, scanForLeaks on the result
        // is what the server posts on (index.ts screenComment)
        const cfg = { leakGuard: { extraPatterns: ["redacted"] } };
        const out = redactLeaks("fully unredacted", cfg);
        expect(out.redacted).toEqual(["extra"]);
        expect(scanForLeaks(out.text, cfg)).toEqual([{ line: 1, name: "extra" }]);
      });
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


// #280: key-shaped secrets join the shared pattern set -- a well-known
// token prefix, a private-key header, or a key|secret|token assignment
// whose value is long, opaque and carries both letters and digits. Every
// fixture below is spelled in pieces so this file's own diff never trips
// the live commit guard; every refused shape sits beside its harmless
// twin (the same characters that must pass), and the hostile spellings
// the issue never named (a token in a URL's userinfo, a JSON-quoted key,
// a Go walrus) are judged here too.
describe("secret shapes in the shared pattern set (#280)", () => {
  const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
  const GH = "ghp_" + "0123456789abcdefghijABCDEFGHIJklmnopqr";
  const GH_PAT = "github_pat_" + "11ABCDEFG0abcdefghijklmnop";
  const SLACK = "xoxb-" + "1234567890-abcdefghij";
  const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";
  const OPAQUE = "a1b2c3d4e5f6a7b8c9d0e1f2";

  const refused: Array<[string, string]> = [
    ["secret-aws-key", `const id = "${AWS}";`],
    ["secret-github-token", `GITHUB_TOKEN=${GH}`],
    ["secret-github-token", `const pat = "${GH_PAT}";`],
    ["secret-slack-token", `slack: "${SLACK}",`],
    ["secret-private-key", PEM],
    ["secret-private-key", "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----"],
    ["secret-private-key", "-----BEGIN " + "PRIVATE KEY-----"],
    ["secret-assignment", `const token = "${OPAQUE}";`],
    ["secret-assignment", `client_secret: ${OPAQUE}`],
    ["secret-assignment", `API_KEY=${OPAQUE}`],
    ["secret-assignment", `password = '${OPAQUE}'`],
    // the spellings the issue never named
    ["secret-github-token", `url: https://${GH}@github.com/o/r.git`],
    ["secret-assignment", `{"api_key": "${OPAQUE}"}`],
    ["secret-assignment", `token := "${OPAQUE}"`],
    ["secret-aws-key", `  id: ${AWS}\r`],
  ];

  // the harmless twins: the same characters, short of a secret
  const twins: string[] = [
    'const note = "AKIA is the Amazon key prefix";',
    'const low = "akia' + 'iosfodnn7example";',
    'const fake = "ghp_' + 'short123";',
    'const name = "ghp_token_placeholder";',
    'const ch = "xoxb-' + 'example";',
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
    "const token = process.env.GITHUB_TOKEN;",
    "const tokenCount = 20000;",
    "secret: true",
    'password: "hunter2"',
    'const secret_key = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";',
    'tokenEnv: z.string().default("GITHUB_TOKEN"),',
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    'expect(out).toContain("COPILOT_GITHUB_TOKEN=secret-copilot_github_token");',
    "const sha = a3f5c9e1b2d4f6a8c0e2b4d6f8a0c2e4;",
  ];

  it("every secret shape is refused by the hook's set, under its own kind", () => {
    const pats = buildPatterns(ghCfg);
    for (const [kind, line] of refused) {
      // a line can be two shapes at once (GITHUB_TOKEN=ghp_... is a GitHub
      // token AND a token assignment); every hit is a secret kind, and the
      // named one is among them
      const names = scanLines([line], pats).map((h: { name: string }) => h.name);
      expect(names, line).toContain(kind);
      expect(names.every((n: string) => n.startsWith("secret-")), line).toBe(true);
    }
  });

  it("every harmless twin passes the hook's set", () => {
    const pats = buildPatterns(ghCfg);
    for (const line of twins) expect(scanLines([line], pats), line).toEqual([]);
  });

  it("a secret hit withholds the value: the match names the kind, never the text", () => {
    const pats = buildPatterns(ghCfg);
    let seen = 0;
    for (const [, line] of refused) {
      for (const h of scanLines([line], pats)) {
        seen++;
        expect(h.match, line).toBe("(value withheld)");
        for (const value of [AWS, GH, GH_PAT, SLACK, OPAQUE, "PRIVATE KEY"]) expect(JSON.stringify(h), line).not.toContain(value);
      }
    }
    // zero hits would pass the loop above by saying nothing -- an empty
    // match is a failure here, never a pass
    expect(seen).toBeGreaterThanOrEqual(refused.length);
    // the planning-path kinds still carry their match, as the guard's
    // listing and the CLI mode always did
    const [hit] = scanLines(['label: "cairn' + ':seed",'], pats);
    expect(hit.match).toBe("cairn" + ":seed");
  });

  it("server source is exempt from cairn-path only -- a secret there is still refused", () => {
    const pats = buildPatterns(ghCfg);
    for (const p of ["server/src/config.ts", "server/dist/config.js"]) {
      expect(scanLines([`const id = "${AWS}";`], patternsForFile(p, pats)).map((h: { name: string }) => h.name))
        .toEqual(["secret-aws-key"]);
    }
  });

  it("the server port refuses and passes the same lines, hit for hit", () => {
    const corpus = [...refused.map(([, l]) => l), ...twins].join("\n");
    const hook = scanLines(corpus.split("\n"), buildPatterns(ghCfg))
      .map(({ line, name }: { line: number; name: string }) => ({ line, name }));
    // at least one hit per refused line, none on a twin line -- an empty
    // match would be a failure here, never a pass
    expect(hook.length).toBeGreaterThanOrEqual(refused.length);
    expect(hook.every((h) => h.line <= refused.length)).toBe(true);
    expect(scanForLeaks(corpus, ghCfg)).toEqual(hook);
  });

  it("the server's redacting form swaps the secret's token for a kind-named placeholder", () => {
    const out = redactLeaks(`evidence: GITHUB_TOKEN=${GH} npm test`, ghCfg);
    expect(out.text).toBe("evidence: [redacted secret-github-token] npm test");
    expect(out.redacted).toEqual(["secret-github-token"]);
    expect(out.text).not.toContain(GH);
    expect(scanForLeaks(out.text, ghCfg)).toEqual([]);
  });

  it("leakGuard.enabled === false switches the secret scan off with the rest, in both places", () => {
    const off = { leakGuard: { enabled: false } };
    expect(scanForLeaks(PEM, off)).toEqual([]);
    expect(redactLeaks(PEM, off)).toEqual({ text: PEM, redacted: [] });
  });
});
