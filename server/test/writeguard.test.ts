import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("a redirect inside a nested shell is read like one typed directly (#511)", () => {
  const BOTH: readonly Cwd[] = ["root", "nested"];
  type Line = (c: Ctx) => string;
  type Row = { shape: string; refused: Line; twin: Line };
  /** A shell string nested `n` levels: each level hands the next to `sh -c` with its quotes escaped. */
  const nestShells = (line: string, n: number): string =>
    n === 0 ? line : `sh -c "${nestShells(line, n - 1).replace(/(["\\$`])/g, "\\$1")}"`;

  const TABLE: readonly Row[] = [
    { shape: "sh -c", refused: (c) => `sh -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "sh -c 'echo hi'" },
    { shape: "bash -lc", refused: (c) => `bash -lc 'echo x > ${c.rel}src/a.ts'`, twin: (c) => `bash -lc 'echo x > ${c.home}/out.txt'` },
    { shape: "a path to the shell, in any case", refused: (c) => `/BIN/SH -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "/BIN/SH -c 'echo hi'" },
    { shape: "eval, one word", refused: (c) => `eval 'echo x > ${c.rel}src/a.ts'`, twin: () => "eval 'echo hi'" },
    { shape: "eval, its words joined", refused: (c) => `eval 'echo x' '>' '${c.rel}src/a.ts'`, twin: (c) => `eval 'echo x' '>' '${c.home}/out.txt'` },
    { shape: "su -c", refused: (c) => `su -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "su -c 'echo hi'" },
    { shape: "tee in a nested shell", refused: (c) => `sh -c 'echo x | tee ${c.rel}src/a.ts'`, twin: () => "sh -c 'echo x | tee /dev/null'" },
    { shape: "a substitution in a nested shell", refused: (c) => `sh -c 'echo $(echo x > ${c.rel}src/a.ts)'`, twin: (c) => `sh -c 'echo $(cat ${c.rel}seed.txt)'` },
    { shape: "a shell in a shell", refused: (c) => `sh -c "bash -c 'eval \\"echo x > ${c.rel}src/a.ts\\"'"`, twin: () => `sh -c "bash -c 'eval \\"echo hi\\"'"` },
    { shape: "a wrapper in front of the shell", refused: (c) => `nohup timeout 5 sh -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "nohup timeout 5 sh -c 'echo hi'" },
    { shape: "a wrapper handing a shell its line", refused: (c) => `flock /tmp/l -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "flock /tmp/l -c 'echo hi'" },
    { shape: "a heredoc fed to a shell", refused: (c) => `sh <<'EOF'\necho x > ${c.rel}src/a.ts\nEOF`, twin: () => "sh <<'EOF'\necho hi\nEOF" },
    { shape: "a heredoc piped to a shell", refused: (c) => `cat <<'EOF' | bash\necho x > ${c.rel}src/a.ts\nEOF`, twin: () => "cat <<'EOF' | wc -l\necho x > src/a.ts\nEOF" },
    { shape: "a here-string fed to a shell", refused: (c) => `bash <<< 'echo x > ${c.rel}src/a.ts'`, twin: () => "wc -l <<< 'echo x > src/a.ts'" },
    { shape: "a runner's shell", refused: (c) => `op run -- sh -c 'echo x > ${c.rel}src/a.ts'`, twin: () => "op run -- sh -c 'echo hi'" },
    { shape: "a runner's quoted line", refused: (c) => `tmux new-session -d 'echo x > ${c.rel}src/a.ts'`, twin: (c) => `tmux new-session -d 'echo x > ${c.home}/out.txt'` },
    { shape: "a runner's tee", refused: (c) => `echo x | bundle exec tee ${c.rel}src/a.ts`, twin: () => "echo x | bundle exec tee /dev/null" },
    { shape: "find -exec", refused: (c) => `find ${c.rel}src -exec sh -c 'echo x > ${c.rel}src/a.ts' \\;`, twin: (c) => `find ${c.rel}src -exec sh -c 'cat "$0"' {} \\;` },
    { shape: "a trap's line", refused: (c) => `trap 'echo x > ${c.rel}src/a.ts' EXIT`, twin: () => "trap 'echo bye' EXIT" },
    { shape: "a pager variable", refused: (c) => `GIT_PAGER='echo x > ${c.rel}src/a.ts' git log`, twin: () => "GIT_PAGER=cat git log" },
    { shape: "an option that runs a program", refused: (c) => `man -P 'echo x > ${c.rel}src/a.ts' ls`, twin: () => "man -P cat ls" },
    { shape: "a cd inside the nested shell", refused: (c) => `sh -c 'cd ${c.rel}src && echo x > a.ts'`, twin: (c) => `sh -c 'cd ${c.rel}src && cat x.ts'` },
    { shape: "a cd before the nested shell", refused: (c) => `cd ${c.rel}pkg/lib && sh -c 'echo x > ../../src/a.ts'`, twin: (c) => `cd ${c.rel}src && sh -c 'cat x.ts'` },
    { shape: "a folder a wrapper hands the nested shell", refused: (c) => `env -C ${c.rel}pkg/lib sh -c 'echo x > ../../src/a.ts'`, twin: (c) => `env -C ${c.rel}pkg/lib sh -c 'cat ../../seed.txt'` },
    { shape: "a cd the guard can't read, in the nested shell", refused: () => `sh -c 'cd "$DIR" && echo x > a.ts'`, twin: (c) => `sh -c 'cd "$DIR" && echo x > ${c.home}/out.txt'` },
    { shape: "a line spelled in a variable: sh -c", refused: (c) => `C='echo x > ${c.rel}src/a.ts'; sh -c "$C"`, twin: () => `C='echo hi'; sh -c "$C"` },
    { shape: "a line spelled in a variable: eval", refused: (c) => `C='echo x > ${c.rel}src/a.ts'; eval "$C"`, twin: () => `C='echo hi'; eval "$C"` },
    { shape: "the shell spelled in a variable", refused: (c) => `S=sh; $S -c 'echo x > ${c.rel}src/a.ts'`, twin: () => `S=sh; $S -c 'echo hi'` },
    { shape: "eval spelled in a variable", refused: (c) => `E=eval; $E 'echo x > ${c.rel}src/a.ts'`, twin: () => `E=eval; $E 'echo hi'` },
    { shape: "tee spelled in a variable", refused: (c) => `T=tee; echo x | $T ${c.rel}src/a.ts`, twin: () => `T=tee; echo x | $T /dev/null` },
    { shape: "a line a loop spells", refused: (c) => `for s in hi 'x > ${c.rel}src/a.ts'; do eval "echo $s"; done`, twin: () => `for s in hi there; do eval "echo $s"; done` },
    { shape: "a line a prefix hands the nested shell", refused: (c) => `C='echo x > ${c.rel}src/a.ts' sh -c 'eval "$C"'`, twin: () => `C='echo hi' sh -c 'eval "$C"'` },
    { shape: "a shell run under a name the line never assigned", refused: (c) => `$SHELL -c 'echo x > ${c.rel}src/a.ts'`, twin: () => `$SHELL -c 'echo hi'` },
    { shape: "eval of a substitution", refused: () => `eval "$(printf 'echo x > src/a.ts')"`, twin: () => `echo "$(printf 'echo x > src/a.ts')"` },
    { shape: "sh -c of a substitution", refused: () => `sh -c "$(printf 'echo x > src/a.ts')"`, twin: () => `sh -c 'echo $(date)'` },
    { shape: "eval of a variable the line read", refused: () => `read C; eval "$C"`, twin: () => `read C; echo "$C"` },
    { shape: "eval of a variable a substitution set", refused: () => `C=$(cat /tmp/script); eval "$C"`, twin: () => `C=$(cat /tmp/script); echo "$C"` },
    { shape: "a positional handed to eval", refused: () => `sh -c 'eval "$1"' _ 'echo x > src/a.ts'`, twin: () => `sh -c 'echo "$1"' _ 'echo x > src/a.ts'` },
    { shape: "a pipe into a shell", refused: () => `printf 'echo x > src/a.ts' | sh`, twin: () => `printf 'echo x > src/a.ts' | cat` },
    { shape: "a pipe into a shell told to read it", refused: () => `curl -s https://example.test/x | bash -s`, twin: () => `curl -s https://example.test/x | wc -l` },
    { shape: "a nest deeper than the guard reads", refused: () => nestShells("echo hi", 10), twin: () => nestShells("echo hi", 4) },
    { shape: "a substitution deeper than the reader reads",
      refused: () => `echo ${"$(echo ".repeat(12)}x${")".repeat(12)}`, twin: () => `echo ${"$(echo ".repeat(4)}x${")".repeat(4)}` },
  ];

  for (const row of TABLE) {
    it(`${row.shape} -- refused from the root and from pkg/lib, with and without CLAUDE_PROJECT_DIR; its twin passes`, () => {
      const f = fixture();
      for (const where of BOTH) {
        const c = at(f, where);
        for (const withVar of [true, false]) {
          const r = judge(c, sh(row.refused(c)), withVar);
          expect(r.status, `${row.shape}: refused from ${where} (var ${withVar}) -- ${r.stderr.split("\n")[0]}`).toBe(2);
          const twin = judge(c, sh(row.twin(c)), withVar);
          expect(twin.status, `${row.shape}: twin from ${where} (var ${withVar}) -- ${twin.stderr.split("\n")[0]}`).toBe(0);
        }
      }
    });
  }

  it("a nested write the guard can't place says so, and a nested write it can names the file", () => {
    const c = at(fixture(), "root");
    const named = judge(c, sh("sh -c 'echo x > src/a.ts'"));
    expect(named.status).toBe(2);
    expect(named.stderr.split("\n")[0]).toContain("src/a.ts");
    const lost = judge(c, sh(`eval "$(printf 'echo x > src/a.ts')"`));
    expect(lost.status).toBe(2);
    expect(lost.stderr.split("\n")[0]).toContain("can't read");
    expect(lost.stderr).not.toMatch(/at .*\.mjs:\d+|tool_input|\{"/);
  });

  it("a type the policy doesn't limit, and the main session, are never read at all", () => {
    const c = at(fixture(), "root");
    expect(judge(c, sh("sh -c 'echo x > src/a.ts'", null)).status).toBe(0);
    expect(judge(c, sh("sh -c 'echo x > src/a.ts'", "general-purpose")).status).toBe(0);
  });

  it("the designer's grant holds inside a nested shell: its draft folder passes, anything else is refused", () => {
    const c = at(fixture(), "root");
    expect(judge(c, sh(`sh -c 'echo x > ${DRAFT_DIR}/d1/a.html'`, DESIGNER)).status).toBe(0);
    expect(judge(c, sh(`eval 'cd ${DRAFT_DIR}/d1 && cat a.html'`, DESIGNER)).status).toBe(0);
    expect(judge(c, sh("sh -c 'echo x > src/a.ts'", DESIGNER)).status).toBe(2);
    expect(judge(c, sh(`sh -c 'echo x > ${DRAFT_DIR}/../../src/a.ts'`, DESIGNER)).status).toBe(2);
  });

  it("eval runs in this shell, so its cd moves the next redirect; a nested shell's cd dies with it", () => {
    const c = at(fixture(), "root");
    // from the root this climb leaves the project, so only eval's cd puts it back inside
    expect(judge(c, sh("eval 'cd pkg/lib'; echo x > ../../src/a.ts")).status).toBe(2);
    expect(judge(c, sh("eval 'cd \"$DIR\"'; echo x > a.ts")).stderr).toContain("can't read");
    expect(judge(c, sh("sh -c 'cd pkg/lib'; echo x > ../../out.txt")).status).toBe(0);
    // eval's assignment is this shell's too
    expect(judge(c, sh("eval 'D=src'; sh -c \"echo x > $D/a.ts\"")).status).toBe(2);
  });

  it("a program's own text is no line: code and patterns with a > in them pass, each named so the list can't rot", () => {
    const c = at(fixture(), "root");
    for (const line of [
      "awk '$1 > 5 {print}' seed.txt",
      "python3 -c 'print(1 > 2)'",
      "python3.12 -c 'print(1 > 2)'",
      "node -e 'if (1 > 2) { console.log(3) }'",
      "ruby -e 'puts 1 > 2'",
      "perl -e 'print 1 > 2'",
      "sed -n '/a > b/p' seed.txt",
      "git log --grep 'a > b'",
      "git commit -m 'a > b'",
      "curl -d 'a > b' https://example.test",
      "psql -c 'select 1 > 2'",
      "sqlite3 x.db 'select 1 > 2'",
      "grep -E 'a > b' seed.txt",
      "jq '.a > 1' x.json",
      "gh issue view 1 --jq '.a > 1'",
      "echo 'sh -c \"echo x > src/a.ts\"'",
      "export M='a > b'",
      "[ 'a b' = 'c > d' ]",
      // a bare mention of a shell runs none: nothing is reading a pipe
      "command -v sh", "which bash", "pgrep sh", "ps aux | grep bash", "man bash", "type eval",
      // a script by name is the Not seen block's
      "sh ./run.sh", "bash scripts/test.sh > /dev/null",
    ]) {
      const r = judge(c, sh(line));
      expect(r.status, `${line} -- ${r.stderr.split("\n")[0]}`).toBe(0);
    }
  });

  it("an unknown program's quoted argument reads as a line, so a > in it is refused: the over-refusal this guard takes by decision", () => {
    const c = at(fixture(), "root");
    const r = judge(c, sh("npx playwright test -g 'a > b'"));
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")[0]).toContain("'cairn-uat'");
    expect(judge(c, sh("npx playwright test -g 'a b'")).status).toBe(0);
  });

  it("the one option that runs a program is still read on a program whose words are text", () => {
    const c = at(fixture(), "root");
    expect(judge(c, sh("rg --pre 'echo x > src/a.ts' needle")).status).toBe(2);
    expect(judge(c, sh("sort --compress-program='echo x > src/a.ts' seed.txt")).status).toBe(2);
  });

  it("the Not seen shapes stay passing, so a change in what the guard reads shows up here: eval of a name only the session holds, an interpreter's write, a script by name", () => {
    const c = at(fixture(), "root");
    for (const line of [
      'eval "$CMD"', 'sh -c "$CMD"',
      "python3 -c 'open(\"src/a.ts\", \"w\").write(\"x\")'",
      "sh ./write-it.sh", "source ./write-it.sh", "bash <(echo 'echo x > src/a.ts')", "sh < ./write-it.sh",
      "$(which tee) src/a.ts", "git -c alias.x='!echo x > src/a.ts' x",
    ]) {
      const r = judge(c, sh(line));
      expect(r.status, `${line} -- ${r.stderr.split("\n")[0]}`).toBe(0);
    }
  });

  it("a line built to run the guard out of time is refused inside the hook's timeout: nothing in these writes, only their cost does it", () => {
    const c = at(fixture(), "root");
    const long = Array.from({ length: 1700 }, (_, i) => `sh -c 'echo ${"pad".repeat(200)} ${i}'`).join(";");
    const wide = Array.from({ length: 5000 }, (_, i) => `A${i}=1`).join(";");
    for (const line of [long, wide]) {
      const started = Date.now();
      const r = judge(c, sh(line));
      expect(r.status, r.stderr.split("\n")[0]).toBe(2);
      expect(r.stderr.split("\n")[0]).toContain("can't read");
      expect(Date.now() - started, "stays inside the hook's 3000ms").toBeLessThan(3000);
    }
    // the twin: a long ordinary line is read, whole
    expect(judge(c, sh(Array.from({ length: 200 }, (_, i) => `sh -c 'echo ${i}'`).join(";"))).status).toBe(0);
  });

  it("tee fed its file names by xargs writes what the pipe says, which the guard can't read: refused", () => {
    const c = at(fixture(), "root");
    const r = judge(c, sh("printf 'src/a.ts' | xargs tee"));
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")[0]).toContain("can't read");
    expect(judge(c, sh("printf 'x' | xargs echo")).status).toBe(0);
  });
});

describe("a target is spelled through the reader before it is judged, and a head the guard can't spell is unreadable (#512)", () => {
  const BOTH: readonly Cwd[] = ["root", "nested"];
  type Line = (c: Ctx) => string;
  type Row = { shape: string; refused: Line; twin: Line };
  /** The project root spelled from the fixture's home, which sits beside it. */
  const climb = (c: Ctx) => `../${basename(c.root)}`;

  const TABLE: readonly Row[] = [
    { shape: "a leading slash before $PWD", refused: (c) => `echo x > /$PWD/${c.rel}src/a.ts`, twin: () => "echo x > /tmp/x" },
    { shape: "a leading slash before ${PWD}", refused: (c) => `echo x > /\${PWD}/${c.rel}src/a.ts`, twin: () => "echo x > /tmp/x" },
    { shape: "two slashes before $PWD", refused: (c) => `echo x > //$PWD/${c.rel}src/a.ts`, twin: () => "echo x > //tmp/x" },
    { shape: "a dot folder before $PWD", refused: (c) => `echo x > /./$PWD/${c.rel}src/a.ts`, twin: () => "echo x > /./tmp/x" },
    { shape: "a quoted $PWD behind a slash", refused: (c) => `echo x > /"$PWD"/${c.rel}src/a.ts`, twin: (c) => `echo x > /"$PWD"/${c.rel}../../out.txt` },
    { shape: "$PWD in the middle of a path", refused: (c) => `echo x > /tmp/../$PWD/${c.rel}src/a.ts`, twin: () => "echo x > /tmp/../tmp/x" },
    { shape: "a leading slash before $HOME", refused: (c) => `echo x > /$HOME/${climb(c)}/src/a.ts`, twin: () => "echo x > /$HOME/notes.md" },
    { shape: "a leading slash before ${HOME}", refused: (c) => `echo x > /\${HOME}/${climb(c)}/src/a.ts`, twin: () => "echo x > /${HOME}/notes.md" },
    { shape: "$HOME with no slash", refused: (c) => `echo x > $HOME/${climb(c)}/src/a.ts`, twin: () => "echo x > $HOME/notes.md" },
    { shape: "~ climbing back", refused: (c) => `echo x > ~/${climb(c)}/src/a.ts`, twin: () => "echo x > ~/notes.md" },
    { shape: "tee's operand behind a slash", refused: (c) => `echo x | tee /$PWD/${c.rel}src/a.ts`, twin: () => "echo x | tee /tmp/x" },
    { shape: "tee's operand with a quoted name", refused: (c) => `echo x | tee "/$PWD"/${c.rel}src/a.ts`, twin: () => `echo x | tee "/tmp"/x` },
    { shape: "a nested shell's target", refused: (c) => `sh -c 'echo x > /$PWD/${c.rel}src/a.ts'`, twin: () => "sh -c 'echo x > /tmp/x'" },
    { shape: "eval's target", refused: (c) => `eval 'echo x > /$PWD/${c.rel}src/a.ts'`, twin: () => "eval 'echo x > /tmp/x'" },
    { shape: "a variable holding $PWD", refused: (c) => `D=$PWD/${c.rel}src; echo x > /$D/a.ts`, twin: () => "D=/tmp; echo x > $D/x" },
    { shape: "a variable holding the slash", refused: (c) => `B=/; echo x > \${B}$PWD/${c.rel}src/a.ts`, twin: () => "B=/; echo x > ${B}tmp/x" },
    { shape: "a variable a prefix hands a nested shell", refused: (c) => `D=$PWD/${c.rel}src sh -c 'echo x > /$D/a.ts'`, twin: () => `D=/tmp sh -c 'echo x > /$D/a.ts'` },
    { shape: "a variable holding the folder, read after a cd", refused: (c) => `D=$PWD; cd /tmp; echo x > /$D/${c.rel}src/a.ts`, twin: () => "D=/opt; cd /tmp; echo x > /$D/a.ts" },
    { shape: "HOME reassigned, then ~", refused: (c) => `HOME=$PWD; echo x > ~/${c.rel}src/a.ts`, twin: () => "HOME=/tmp; echo x > ~/x" },
    { shape: "HOME reassigned, then $HOME", refused: (c) => `HOME=$PWD; echo x > /$HOME/${c.rel}src/a.ts`, twin: () => "HOME=/tmp; echo x > /$HOME/x" },
    { shape: "a name the line never assigned, at the head", refused: () => "echo x > /$X/src/a.ts", twin: () => "echo x > /opt/$X/y" },
    { shape: "a braced name the line never assigned, at the head", refused: () => "echo x > /${X}/src/a.ts", twin: () => "echo x > /opt/${X}/y" },
    { shape: "two slashes before a name", refused: () => "echo x > //$X/src/a.ts", twin: () => "echo x > //opt/$X/y" },
    { shape: "a climb back to / before a name", refused: () => "echo x > /opt/../$X/src/a.ts", twin: () => "echo x > /opt/../opt/$X/y" },
    { shape: "a substitution at the head", refused: () => "echo x > /$(pwd)/src/a.ts", twin: () => "echo x > /opt/$(date +%s).log" },
    { shape: "a backtick at the head", refused: () => "echo x > /`pwd`/src/a.ts", twin: () => "echo x > /opt/`date +%s`.log" },
    { shape: "a positional at the head", refused: () => `sh -c 'echo x > /$1/src/a.ts' _ "$PWD"`, twin: () => `sh -c 'echo x > /opt/$1.log' _ y` },
    { shape: "an operator on $PWD at the head", refused: () => "echo x > /${PWD%/}/src/a.ts", twin: () => "echo x > /opt/${PWD##*/}.log" },
    { shape: "a variable a substitution set, at the head", refused: () => "F=$(pwd); echo x > /$F/src/a.ts", twin: () => "F=$(date); echo x > /opt/$F" },
    { shape: "a variable the line read, at the head", refused: () => "read D; echo x > /$D/src/a.ts", twin: () => "read D; echo x > /opt/y" },
    { shape: "a name in a folder above the project", refused: (c) => `echo x > ${dirname(c.root)}/$X/src/a.ts`, twin: (c) => `echo x > ${c.home}/$X/y` },
    { shape: "a name partway through a folder above the project", refused: (c) => `echo x > ${dirname(c.root)}/x$X/src/a.ts`, twin: (c) => `echo x > ${c.home}/x$X/y` },
    { shape: "a relative climb, then a name", refused: (c) => `echo x > ${c.rel}../$X/src/a.ts`, twin: (c) => `echo x > ${c.home}/$X.log` },
    { shape: "a glob in a folder above the project", refused: (c) => `echo x > ${dirname(c.root)}/*/src/a.ts`, twin: (c) => `echo x > ${c.home}/*.log` },
    { shape: "a ? at the head", refused: () => "echo x > /?*/src/a.ts", twin: () => "echo x > /opt/?.log" },
    { shape: "a brace spelling the project", refused: (c) => `echo x > /{opt,${c.root.slice(1)}}/src/a.ts`, twin: () => "echo x > /{opt,srv}/x" },
    { shape: "a folder name that starts with two dots", refused: (c) => `echo x > ${c.rel}..foo/a.ts`, twin: (c) => `echo x > ${c.home}/..foo/a.ts` },
    { shape: "a file name that starts with two dots", refused: (c) => `echo x > ${c.rel}..a.ts`, twin: (c) => `echo x > ${c.home}/..a.ts` },
    { shape: "the same nested line with the variable moved", refused: (c) => `D=/tmp; sh -c 'echo x > /$D/a.ts'; D=$PWD/${c.rel}src; sh -c 'echo x > /$D/a.ts'`,
      twin: () => `D=/tmp; sh -c 'echo x > /$D/a.ts'; D=/opt; sh -c 'echo x > /$D/a.ts'` },
    { shape: "a default in the word", refused: (c) => `echo x > /\${X:-$PWD}/${c.rel}src/a.ts`, twin: () => "echo x > /opt/${X:-y}/z" },
  ];

  for (const row of TABLE) {
    it(`${row.shape} -- refused from the root and from pkg/lib, with and without CLAUDE_PROJECT_DIR; its twin passes`, () => {
      const f = fixture();
      for (const where of BOTH) {
        const c = at(f, where);
        for (const withVar of [true, false]) {
          const r = judge(c, sh(row.refused(c)), withVar);
          expect(r.status, `${row.shape}: refused from ${where} (var ${withVar}) -- ${r.stderr.split("\n")[0]}`).toBe(2);
          const twin = judge(c, sh(row.twin(c)), withVar);
          expect(twin.status, `${row.shape}: twin from ${where} (var ${withVar}) -- ${twin.stderr.split("\n")[0]}`).toBe(0);
        }
      }
    });
  }

  it("$PWD is every folder the shell may stand in: a cd moves it, and only that reading lands inside", () => {
    const c = at(fixture(), "root");
    // read from the root alone, this climb leaves the project
    expect(judge(c, sh("cd pkg/lib && echo x > /$PWD/../../src/a.ts")).status).toBe(2);
    expect(judge(c, sh("cd pkg/lib && sh -c 'echo x > /$PWD/../../src/a.ts'")).status).toBe(2);
    expect(judge(c, sh("env -C pkg/lib sh -c 'echo x > /$PWD/../../src/a.ts'")).status).toBe(2);
    // after a cd it can't read, $PWD is no folder at all, with or without the slash
    for (const line of ['cd "$X" && echo x > $PWD/a.ts', 'cd "$X" && echo x > /$PWD/a.ts']) {
      const r = judge(c, sh(line));
      expect(r.status, line).toBe(2);
      expect(r.stderr.split("\n")[0], line).toContain("can't read");
    }
  });

  it("a cd spelled through a variable the guard can read is followed, not called lost", () => {
    const c = at(fixture(), "root");
    expect(judge(c, sh("D=pkg/lib; cd $D && echo x > ../../src/a.ts")).status).toBe(2);
    expect(judge(c, sh("cd $PWD/pkg/lib && echo x > ../../src/a.ts")).status).toBe(2);
    expect(judge(c, sh(`cd "$HOME" && echo x > /tmp/x`)).status).toBe(0);
    expect(judge(c, sh("HOME=$(pwd); cd ~ && echo x > y.ts")).stderr.split("\n")[0]).toContain("can't read");
  });

  it("the designer's grant is judged on the spelled path: a variable or $PWD into its draft folder passes, one out of it is refused", () => {
    const c = at(fixture(), "root");
    expect(judge(c, sh(`D=${DRAFT_DIR}/d1; echo x > $D/a.html`, DESIGNER)).status).toBe(0);
    expect(judge(c, sh(`echo x > /$PWD/${DRAFT_DIR}/d1/a.html`, DESIGNER)).status).toBe(0);
    expect(judge(c, sh(`echo x > $PWD/${DRAFT_DIR}/d1/a.html`, DESIGNER)).status).toBe(0);
    expect(judge(c, sh("D=src; echo x > $D/a.ts", DESIGNER)).status).toBe(2);
    expect(judge(c, sh("echo x > /$PWD/src/a.ts", DESIGNER)).status).toBe(2);
    expect(judge(c, sh(`echo x > ${DRAFT_DIR}/\${X:-../../src}/a.ts`, DESIGNER)).status).toBe(2);
    expect(judge(c, sh(`echo x > ${DRAFT_DIR}/$X/../../../src/a.ts`, DESIGNER)).status).toBe(2);
  });

  it("the tools' own paths: a name starting with two dots under the project is the project's", () => {
    const c = at(fixture(), "root");
    expect(judge(c, file("Write", join(c.root, "..a.ts"))).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, "..foo", "a.ts"))).status).toBe(2);
    expect(judge(c, file("Write", join(c.root, "..", "out.txt"))).status).toBe(0);
  });

  it("the Not seen shapes stay passing, so a change in what the guard reads shows up here", () => {
    const c = at(fixture(), "root");
    // a link's written spelling is judged, not the inode (the /tmp spelling of a project under /private/tmp is this one)
    symlinkSync(c.root, join(c.home, "link"));
    for (const line of [
      `echo x > ${c.home}/link/src/x.ts`,
      // a value only the run knows, in the middle of a path whose head sits outside
      "echo x > /opt/$X/y", "echo x > /opt/$(cat where)/src/a.ts", "F=$(cat where); echo x > /opt/$F/src/a.ts",
      // the reader takes this as a descriptor (see the block): a test that goes red the day it stops
      "echo x >& src/a.ts", "echo x >&src/a.ts",
    ]) {
      const r = judge(c, sh(line));
      expect(r.status, `${line} -- ${r.stderr.split("\n")[0]}`).toBe(0);
    }
    // a quoted name is literal to the shell, and the reader's target carries no quoting: read as spelled
    expect(judge(c, sh("echo x > '$HOME/notes.md'")).status).toBe(0);
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
    writeFileSync(join(copy, "scripts", "shell-words.mjs"), "export function shellSegments() { throw new Error('broken reader'); }\n"
      + "export const SHELLS = new Set();\n"
      + ["argCommands", "assignVars", "commandName", "evalCommandString", "expandAssigned", "lineVars", "pagerCommands", "runnerCommands", "seedVars",
        "shellCommandString", "shellReadsStdin", "spellWords", "suCommandString", "tooDeep", "unwrap", "braceExpand"].map((n) => `export function ${n}() {}\n`).join(""));
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
      "dated 2026-11-05 (#511)",
      "a shell's script from a file",
      "a line in a name only the session holds",
      "a command word the shell computes",
      "a git alias that runs a shell",
      "dated 2026-11-05 (#512)",
      "a value only the run knows",
      "`>&` onto a file",
      "a quoted",
    ]) expect(block, phrase).toContain(phrase);
    expect(block.split("\n").length, block).toBe(32);
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
