import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema } from "../src/config.js";
import { scanRuleCoverage } from "../src/audit/rule-coverage.js";
import { projectKey } from "../src/planning/run-manifest.js";

/**
 * The write guard (#454): a fourth PreToolUse guard that reads the hook
 * payload's `agent_type` and refuses Edit / Write / NotebookEdit and
 * redirect-shaped shell writes under the project from an agent type the
 * policy lists as read-only, or limits to a set of path globs. Every
 * test here drives the script with a synthetic payload: the field's
 * presence inside a real subagent is a dated claim about the harness
 * (hooks docs read 2026-11-03), never something this file can assert.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = join(ROOT, "hooks", "scripts");
const WRITEGUARD = join(SCRIPTS, "pretooluse-writeguard.mjs");
// spelled apart so no line of this file reads as a planning-folder path to
// the commit leak guard that scans it
const DRAFT_DIR = ".cairn" + "/draft";

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Ctx = { root: string; cwd: string; rel: string; home: string; cairnHome: string };
type Cwd = "root" | "nested";

/** A committed project with a cairn.json, a src file, a draft folder and a nested pkg/lib; a home and a cairn home. */
function fixture(config: Record<string, unknown> | string = { tracker: { type: "github", config: { repo: "o/r" } } }): Omit<Ctx, "cwd" | "rel"> {
  const root = freshDir("cairn-writeguard-");
  const home = freshDir("cairn-writeguard-home-");
  const cairnHome = freshDir("cairn-writeguard-cairnhome-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "pkg", "lib"), { recursive: true });
  mkdirSync(join(root, DRAFT_DIR, "d1"), { recursive: true });
  writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "seed.txt", "src/x.ts"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init", "--no-gpg-sign"], { cwd: root });
  writeFileSync(join(root, "cairn.json"), typeof config === "string" ? config : JSON.stringify(config));
  return { root, home, cairnHome };
}

/** The fixture seen from one cwd: the project root, or two folders down. */
function at(f: Omit<Ctx, "cwd" | "rel">, where: Cwd): Ctx {
  return where === "root"
    ? { ...f, cwd: f.root, rel: "" }
    : { ...f, cwd: join(f.root, "pkg", "lib"), rel: "../../" };
}

/**
 * One call. CLAUDE_PROJECT_DIR is the project root whatever the cwd, as the
 * platform sets it -- or, with `withVar` false (#459), absent, so the guard
 * finds the root above pkg/lib by itself. Every CAIRN_* escape and git
 * location variable the runner carries is stripped.
 */
function judge(c: Ctx, payload: Record<string, unknown>, withVar = true, script = WRITEGUARD) {
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: c.home, CLAUDE_PROJECT_DIR: c.root, CAIRN_HOME: c.cairnHome, GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const k of Object.keys(env)) {
    const strip = (k.startsWith("CAIRN_") && k !== "CAIRN_HOME") || k === "CDPATH" || k === "CLAUDE_PLUGIN_ROOT"
      || k === "GIT_DIR" || k === "GIT_WORK_TREE" || k === "GIT_CONFIG_GLOBAL" || (k === "CLAUDE_PROJECT_DIR" && !withVar);
    if (strip) delete env[k];
  }
  const r = spawnSync(process.execPath, [script], {
    cwd: c.cwd, env, encoding: "utf8", timeout: 5000, input: JSON.stringify({ cwd: c.cwd, ...payload }),
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

// Payload builders. `agent_type` is what the harness sends inside a subagent.
const UAT = "cairn-uat";
const DESIGNER = "cairn-designer";
const file = (tool: string, path: string, type: string | null = UAT, field = "file_path") =>
  ({ tool_name: tool, tool_input: { [field]: path, content: "x" }, session_id: "sess-run", ...(type === null ? {} : { agent_type: type }) });
const sh = (command: string, type: string | null = UAT) =>
  ({ tool_name: "Bash", tool_input: { command }, session_id: "sess-run", ...(type === null ? {} : { agent_type: type }) });

describe("write guard refuses by agent type (#454)", () => {
  it("a read-only type's Edit on a source file is refused, naming the type, the path and the key that would allow it", () => {
    const c = at(fixture(), "root");
    const r = judge(c, file("Edit", join(c.root, "src", "x.ts")));
    expect(r.status, r.stderr).toBe(2);
    const first = r.stderr.split("\n")[0];
    expect(first).toContain("cairn write guard:");
    expect(first).toContain("'cairn-uat'");
    expect(first).toContain("src/x.ts");
    expect(r.stderr).toContain("guards.writers.readOnly");
    expect(r.stderr).toContain("cairn.json");
    // no raw payload, no stack trace: the refusal is prose a reader acts on
    expect(r.stderr).not.toMatch(/at .*\.mjs:\d+|tool_input|\{"/);
  });

  it("the same payload with no agent_type is allowed: the main session, and a harness that sends no field, are unchanged", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Edit", join(c.root, "src", "x.ts"), null)).status).toBe(0);
    for (const bad of ["", 7, null, { name: UAT }, [UAT]]) {
      const payload = { ...file("Edit", join(c.root, "src", "x.ts"), null), agent_type: bad };
      expect(judge(c, payload).status, JSON.stringify(bad)).toBe(0);
    }
  });

  it("a malformed cairn.json, and none at all, allow: the guard fails open on its own ground", () => {
    const broken = at(fixture("{ not json"), "root");
    expect(judge(broken, file("Edit", join(broken.root, "src", "x.ts"))).status).toBe(0);
    const none = at(fixture(), "root");
    rmSync(join(none.root, "cairn.json"));
    expect(judge(none, file("Edit", join(none.root, "src", "x.ts"))).status).toBe(0);
  });

  it("Write and NotebookEdit are refused like Edit; Read, Glob and Grep never are", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Write", join(c.root, "src", "y.ts"))).status).toBe(2);
    expect(judge(c, file("NotebookEdit", join(c.root, "src", "n.ipynb"), UAT, "notebook_path")).status).toBe(2);
    for (const tool of ["Read", "Glob", "Grep"]) expect(judge(c, file(tool, join(c.root, "src", "x.ts"))).status, tool).toBe(0);
  });

  it("an unknown type, and a read-only type writing outside the project, are allowed (the harness guard owns what lies outside)", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Edit", join(c.root, "src", "x.ts"), "general-purpose")).status).toBe(0);
    expect(judge(c, file("Write", join(c.home, "notes.md"))).status).toBe(0);
    expect(judge(c, sh(`echo x > ${c.home}/notes.md`)).status).toBe(0);
  });

  it("cairn.json's guards.writers replaces the shipped default per key: a listed type (or a glob over types) is refused, cairn-uat no longer is", () => {
    const c = at(fixture({ tracker: { type: "github", config: { repo: "o/r" } },
      guards: { writers: { readOnly: ["my-verifier", "seat-*"] } } }), "root");
    const path = join(c.root, "src", "x.ts");
    expect(judge(c, file("Edit", path, "my-verifier")).status).toBe(2);
    expect(judge(c, file("Edit", path, "seat-security")).status).toBe(2);
    expect(judge(c, file("Edit", path, "seat")).status).toBe(0);
    expect(judge(c, file("Edit", path, UAT)).status).toBe(0);
    // the designer's default path grant stood, since `paths` was not given
    expect(judge(c, file("Write", join(c.root, "src", "x.ts"), DESIGNER)).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, DRAFT_DIR, "d1", "001-a.html"), DESIGNER)).status).toBe(0);
  });

  it("an empty readOnly list is the owner's call: cairn-uat may then write", () => {
    const c = at(fixture({ tracker: { type: "github", config: { repo: "o/r" } }, guards: { writers: { readOnly: [] } } }), "root");
    expect(judge(c, file("Edit", join(c.root, "src", "x.ts"))).status).toBe(0);
  });

  it("a guards.writers that is not an object, or a readOnly that is not a list, leaves the shipped default standing", () => {
    for (const guards of [{ writers: "cairn-uat" }, { writers: { readOnly: "cairn-uat" } }, { writers: { readOnly: { "cairn-uat": true } } }, 7]) {
      const c = at(fixture({ tracker: { type: "github", config: { repo: "o/r" } }, guards }), "root");
      expect(judge(c, file("Edit", join(c.root, "src", "x.ts"))).status, JSON.stringify(guards)).toBe(2);
      expect(judge(c, file("Edit", join(c.root, "src", "x.ts"), "my-verifier")).status, JSON.stringify(guards)).toBe(0);
    }
  });
});

describe("write guard limits a type to its path globs (#454)", () => {
  it("the designer writes its draft folder and nothing else; the refusal names the paths key", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Write", join(c.root, DRAFT_DIR, "d1", "001-a.html"), DESIGNER)).status).toBe(0);
    expect(judge(c, file("Write", join(c.root, DRAFT_DIR, "themes", "default.css"), DESIGNER)).status).toBe(0);
    expect(judge(c, sh(`echo x > ${DRAFT_DIR}/d1/002-b.html`, DESIGNER)).status).toBe(0);
    const r = judge(c, file("Write", join(c.root, "src", "x.ts"), DESIGNER));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("'cairn-designer'");
    expect(r.stderr).toContain('guards.writers.paths["cairn-designer"]');
    expect(r.stderr).toContain("src/x.ts");
  });

  it("the hostile spellings: a climb out of the draft folder, and a sibling folder whose name starts the same way, are refused", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Write", join(c.root, DRAFT_DIR, "d1", "..", "..", "..", "src", "x.ts"), DESIGNER)).status).toBe(2);
    expect(judge(c, sh(`echo x > ${DRAFT_DIR}/../../src/x.ts`, DESIGNER)).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, DRAFT_DIR + "s", "x.html"), DESIGNER)).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, "cairn.json"), DESIGNER)).status).toBe(2); // the policy file is not in its grant
  });

  it("an owner's grant from cairn.json: a type glob to path globs, a folder glob covering everything under it", () => {
    const c = at(fixture({ tracker: { type: "github", config: { repo: "o/r" } },
      guards: { writers: { paths: { "builder-*": ["src/**", "docs/notes"] } } } }), "root");
    expect(judge(c, file("Edit", join(c.root, "src", "x.ts"), "builder-a")).status).toBe(0);
    expect(judge(c, file("Write", join(c.root, "src", "deep", "er", "y.ts"), "builder-a")).status).toBe(0);
    expect(judge(c, file("Write", join(c.root, "docs", "notes", "a.md"), "builder-a")).status).toBe(0);
    expect(judge(c, file("Write", join(c.root, "docs", "x.md"), "builder-a")).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, "README.md"), "builder-a")).status).toBe(2);
    // the shipped readOnly default stood beside the owner's paths
    expect(judge(c, file("Edit", join(c.root, "src", "x.ts"), UAT)).status).toBe(2);
    // readOnly wins over a paths grant for the same type
    const both = at(fixture({ tracker: { type: "github", config: { repo: "o/r" } },
      guards: { writers: { readOnly: ["builder-a"], paths: { "builder-*": ["src/**"] } } } }), "root");
    expect(judge(both, file("Edit", join(both.root, "src", "x.ts"), "builder-a")).status).toBe(2);
  });
});

describe("every refused shape has an allowed twin, and holds from a subfolder (#454, the #383 discipline)", () => {
  type Side = { payload: (c: Ctx) => Record<string, unknown> };
  type Row = { shape: string; refused: Side; twin: Side | null; cwds: readonly Cwd[] };
  const BOTH: readonly Cwd[] = ["root", "nested"];
  const bash = (line: (c: Ctx) => string, type = UAT): Side => ({ payload: (c) => sh(line(c), type) });
  const tool = (name: string, path: (c: Ctx) => string, type = UAT): Side => ({ payload: (c) => file(name, path(c), type) });

  const TABLE: readonly Row[] = [
    { shape: "an Edit on a source file", cwds: BOTH,
      refused: tool("Edit", (c) => join(c.root, "src", "x.ts")), twin: tool("Edit", (c) => join(c.home, "x.ts")) },
    { shape: "a Write by a relative path", cwds: BOTH,
      refused: tool("Write", (c) => `${c.rel}src/y.ts`), twin: tool("Write", (c) => `${c.home}/y.ts`) },
    { shape: "a NotebookEdit", cwds: BOTH,
      refused: { payload: (c) => file("NotebookEdit", join(c.root, "src", "n.ipynb"), UAT, "notebook_path") },
      twin: { payload: (c) => file("NotebookEdit", join(c.home, "n.ipynb"), UAT, "notebook_path") } },
    { shape: "a redirect into a project file", cwds: BOTH,
      refused: bash((c) => `echo x > ${c.rel}src/x.ts`), twin: bash((c) => `cat ${c.rel}src/x.ts`) },
    { shape: "an append redirect", cwds: BOTH,
      refused: bash((c) => `echo x >> ${c.rel}src/x.ts`), twin: bash(() => "echo x 2>&1") },
    { shape: "a redirect of both streams", cwds: BOTH,
      refused: bash((c) => `make &> ${c.rel}src/build.log`), twin: bash(() => "make &> /dev/null") },
    { shape: "a redirect after a cd", cwds: BOTH,
      refused: bash((c) => `cd ${c.rel}src && echo x > x.ts`), twin: bash((c) => `cd ${c.rel}src && cat x.ts`) },
    { shape: "a redirect after a cd the guard can't read", cwds: BOTH,
      refused: bash(() => 'cd "$DIR" && echo x > x.ts'), twin: bash((c) => `cd "$DIR" && echo x > ${c.home}/out.txt`) },
    { shape: "tee onto a project file", cwds: BOTH,
      refused: bash((c) => `cat ${c.rel}seed.txt | tee ${c.rel}src/x.ts`), twin: bash((c) => `cat ${c.rel}seed.txt | tee /dev/null`) },
    { shape: "a redirect inside a substitution", cwds: BOTH,
      refused: bash((c) => `echo $(echo x > ${c.rel}src/x.ts)`), twin: bash((c) => `echo $(cat ${c.rel}src/x.ts)`) },
    { shape: "a quoted > is text, an unquoted one is not", cwds: BOTH,
      refused: bash((c) => `printf "a > b" > ${c.rel}src/x.ts`), twin: bash(() => 'printf "a > src/x.ts"') },
    { shape: "a heredoc redirected onto a project file", cwds: BOTH,
      refused: bash((c) => `cat <<'EOF' > ${c.rel}src/x.ts\nx\nEOF`), twin: bash(() => "cat <<'EOF'\nx > src/x.ts\nEOF") },
    { shape: "the designer outside its draft folder", cwds: BOTH,
      refused: tool("Write", (c) => join(c.root, "src", "x.ts"), DESIGNER),
      twin: tool("Write", (c) => join(c.root, DRAFT_DIR, "d1", "001-a.html"), DESIGNER) },
    { shape: "the designer's redirect outside its draft folder", cwds: BOTH,
      refused: bash((c) => `echo x > ${c.rel}src/x.ts`, DESIGNER), twin: bash((c) => `echo x > ${c.rel}${DRAFT_DIR}/d1/002-b.html`, DESIGNER) },
  ];

  for (const row of TABLE) {
    it(`${row.shape} -- refused from the root and from pkg/lib (with and without CLAUDE_PROJECT_DIR); its twin passes from both`, () => {
      if (row.twin === null) return; // the meta-test reports the gap
      const f = fixture();
      for (const where of row.cwds) {
        const c = at(f, where);
        const r = judge(c, row.refused.payload(c));
        expect(r.status, `${row.shape}: refused payload from ${where} -- ${r.stderr.split("\n")[0]}`).toBe(2);
        if (where === "nested") {
          const bare = judge(c, row.refused.payload(c), false);
          expect(bare.status, `${row.shape}: refused payload from pkg/lib with CLAUDE_PROJECT_DIR unset -- ${bare.stderr.split("\n")[0]}`).toBe(2);
        }
      }
      for (const where of row.cwds) {
        const c = at(f, where);
        const r = judge(c, row.twin.payload(c));
        expect(r.status, `${row.shape}: allowed twin from ${where} -- ${r.stderr.split("\n")[0]}`).toBe(0);
        if (where === "nested") {
          const bare = judge(c, row.twin.payload(c), false);
          expect(bare.status, `${row.shape}: allowed twin from pkg/lib with CLAUDE_PROJECT_DIR unset -- ${bare.stderr.split("\n")[0]}`).toBe(0);
        }
      }
    });
  }

  it("meta: every refused shape row carries an allowed twin and a subfolder entry", () => {
    expect(TABLE.length).toBeGreaterThan(0);
    expect(TABLE.filter((r) => r.twin === null).map((r) => r.shape), "refused shapes with no allowed twin").toEqual([]);
    expect(TABLE.filter((r) => !r.cwds.includes("root") || !r.cwds.includes("nested")).map((r) => r.shape),
      "refused shapes not run from both the root and a subfolder").toEqual([]);
    const names = TABLE.map((r) => r.shape);
    expect(new Set(names).size, "duplicate shape names").toBe(names.length);
  });
});

describe("the write guard ships, counts toward the breaker, and fails open on its own error (#454)", () => {
  it("hooks.json registers it on exactly Edit|Write|NotebookEdit|Bash, and the manifest's description names it", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")) as {
      description: string;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> };
    };
    const entries = manifest.hooks.PreToolUse.filter((g) => g.hooks.some((h) => h.command.includes("pretooluse-writeguard.mjs")));
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("Edit|Write|NotebookEdit|Bash");
    expect(entries[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pretooluse-writeguard.mjs"');
    expect(entries[0].hooks[0].timeout).toBe(3000);
    expect(manifest.description).toContain("write guard");
    // four PreToolUse guards now: the count is the pin (#454)
    const scripts = new Set(manifest.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => basename(h.command.replace(/"$/, "")))));
    expect([...scripts].sort()).toEqual([
      "pretooluse-harnessguard.mjs", "pretooluse-leakguard.mjs", "pretooluse-runguard.mjs", "pretooluse-writeguard.mjs",
    ]);
  });

  const manifestPath = (home: string, proj: string, runId: string) => join(home, "runs", `${projectKey(proj)}-${runId}.json`);
  function writeRun(home: string, proj: string, runId: string, sessionId = "sess-run") {
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(manifestPath(home, proj, runId), JSON.stringify({
      version: 1, runId, project: basename(proj), created: "2026-11-04T00:00:00.000Z",
      phases: [{ number: 1, name: "one", estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } }],
      ceiling: null, pushAuth: { granted: true, scope: "manifest-phases", grantedAt: "2026-11-04T00:00:00.000Z" },
      status: "running", currentPhase: 1, sessionId, checkout: proj, breakerLimit: 3,
    }, null, 2));
  }
  const rows = (home: string, proj: string) => {
    const path = join(home, "refusals", `${projectKey(proj)}.jsonl`);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  it("three refusals from the run's own session freeze a live batch run; the rows name the guard and its effect, never the path", () => {
    const c = at(fixture(), "root");
    writeRun(c.cairnHome, c.root, "run-wg");
    for (let i = 1; i <= 2; i++) {
      const r = judge(c, file("Edit", join(c.root, "src", "x.ts")));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`refusal ${i} of 3 for batch run run-wg`);
    }
    const third = judge(c, file("Edit", join(c.root, "src", "x.ts")));
    expect(third.status).toBe(2);
    expect(third.stderr).toContain("batch run run-wg is frozen");
    const m = JSON.parse(readFileSync(manifestPath(c.cairnHome, c.root, "run-wg"), "utf8"));
    expect(m.status).toBe("stopped");
    expect(m.stop).toMatchObject({ reason: "breaker", count: 3 });
    for (const row of rows(c.cairnHome, c.root)) {
      expect(row).toMatchObject({ guard: "write", tool: "Edit", effect: "writes-outside-grant", run_id: "run-wg", session_id: "sess-run" });
      expect(JSON.stringify(row)).not.toContain("src/x.ts");
    }
  });

  it("a refusal from another session is logged with no run id and counts nothing (#431)", () => {
    const c = at(fixture(), "root");
    writeRun(c.cairnHome, c.root, "run-wg", "sess-other");
    const r = judge(c, file("Edit", join(c.root, "src", "x.ts")));
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain("circuit breaker");
    expect(rows(c.cairnHome, c.root)).toHaveLength(1);
    expect(rows(c.cairnHome, c.root)[0].run_id).toBeUndefined();
  });

  it("a breaker.mjs that is missing or throws at import leaves the guard refusing exactly as before (#432)", () => {
    const c = at(fixture(), "root");
    for (const breaker of [null, "throw new Error('broken breaker');\n", "export const recordRefusal = 1;\n"]) {
      const copy = freshDir("cairn-writeguard-plugin-");
      cpSync(SCRIPTS, join(copy, "scripts"), { recursive: true });
      if (breaker === null) rmSync(join(copy, "scripts", "breaker.mjs"));
      else writeFileSync(join(copy, "scripts", "breaker.mjs"), breaker);
      const r = judge(c, file("Edit", join(c.root, "src", "x.ts")), true, join(copy, "scripts", "pretooluse-writeguard.mjs"));
      expect(r.status, String(breaker)).toBe(2);
      expect(r.stderr).toContain("cairn write guard:");
    }
  });

  it("a lib.mjs that throws at import makes the guard exit 0, never a stack trace: the fail-open contract (ADR 0016)", () => {
    const c = at(fixture(), "root");
    const copy = freshDir("cairn-writeguard-plugin-");
    cpSync(SCRIPTS, join(copy, "scripts"), { recursive: true });
    writeFileSync(join(copy, "scripts", "shell-words.mjs"), "export function shellSegments() { throw new Error('broken reader'); }\nexport function unwrap() {}\nexport function commandName() {}\n");
    const r = judge(c, sh("echo x > src/x.ts"), true, join(copy, "scripts", "pretooluse-writeguard.mjs"));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("broken reader");
  });
});

describe("the write guard's header: Not seen block, sunset, axiom, and the rule it backs (#454)", () => {
  const source = () => readFileSync(WRITEGUARD, "utf8");
  const MARK = " *   Not seen, dated 2026-11-04 (#454";

  it("the Not seen block is dated, closes by decision, names each unseen shape, and its line count is the pin", () => {
    const start = source().indexOf(MARK);
    expect(start, "the Not-seen block opens with its date and issue").toBeGreaterThan(-1);
    const block = source().slice(start).split("\n *\n")[0];
    for (const phrase of [
      "by decision", "ADR 0016",
      "a program's own output file",
      "a write in an interpreter",
      "an MCP file tool",
      "a symlink inside the project",
      "a harness that sends no agent_type",
      "shares the dispatching session's type",
    ]) expect(block, phrase).toContain(phrase);
    expect(block.split("\n").length, block).toBe(20);
  });

  it("the header carries removeWhen: inside the 40-line window and derives: naming an axiom", () => {
    expect(source().split("\n").slice(0, 40).join("\n")).toContain("removeWhen:");
    expect(source()).toMatch(/^\s*\*\s*derives:.*axiom \d/m);
  });

  it("the read-only verifier sentences in the verbs pair with this guard as a candidate control (audit security --surface)", () => {
    const report = scanRuleCoverage(ROOT);
    const id = "PreToolUse[Edit|Write|NotebookEdit|Bash] pretooluse-writeguard.mjs";
    expect(report.controls.map((c) => c.id)).toContain(id);
    const verifierRules = report.coverage.filter((c) => /read-only (verifier|agent)/.test(c.rule.text));
    expect(verifierRules.length, "no verb sentence mentions a read-only verifier -- the regex matched nothing").toBeGreaterThan(0);
    for (const cov of verifierRules) {
      expect(cov.status, `${cov.rule.file}:${cov.rule.line}`).toBe("candidate");
      expect(cov.candidates.map((x) => x.controlId), `${cov.rule.file}:${cov.rule.line}`).toContain(id);
    }
  });
});

describe("cairn.json guards.writers is a typed block (#454)", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("accepts a readOnly list and a paths map, and an absent block", () => {
    expect(ConfigSchema.safeParse(base).success).toBe(true);
    const r = ConfigSchema.safeParse({ ...base, guards: { writers: { readOnly: ["cairn-uat", "seat-*"], paths: { "cairn-designer": ["x/**"] } } } });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.success && r.data.guards?.writers?.readOnly).toEqual(["cairn-uat", "seat-*"]);
  });

  it("refuses a readOnly that is not a list of names, a paths value that is not a list, and an unknown key under guards", () => {
    for (const guards of [
      { writers: { readOnly: "cairn-uat" } },
      { writers: { readOnly: [""] } },
      { writers: { paths: { "cairn-designer": "x/**" } } },
      { writers: { readonly: ["cairn-uat"] } },
      { writer: {} },
    ]) expect(ConfigSchema.safeParse({ ...base, guards }).success, JSON.stringify(guards)).toBe(false);
  });
});
