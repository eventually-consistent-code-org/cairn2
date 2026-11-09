// The git layer's home (#558): the pre-push hook and the script it runs live
// under the git common directory, where no checkout, merge, restore or pull
// writes, and every linked worktree finds the same pair. Each scenario that
// broke the old layout (.cairn/githooks + .cairn/harness/scripts in the
// working tree) is a real git run here, in throwaway repositories: a
// contributor's branch adding a post-checkout, a branch carrying its own
// gate script checked out and back, and a fresh linked worktree.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectKey } from "../src/planning/run-manifest.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SETUP = join(REPO, "setup", "cairn-setup.mjs");
const HARNESSGUARD = join(REPO, "hooks", "scripts", "pretooluse-harnessguard.mjs");
const PREPUSH_SRC = join(REPO, "hooks", "scripts", "pre-push.mjs");

// Built, never spelled: the leak guard refuses the planning folder's path as a literal.
const CAIRN = ".cairn";
const OLD_HOOKS = join(CAIRN, "githooks");
const OLD_SCRIPT = join(CAIRN, "harness", "scripts", "pre-push.mjs");
const REFUSED = "cairn run guard: this push lands on the default branch";
const UNJUDGED = "this push was not judged";

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A plain shell's environment: every harness and cairn variable stripped, the fake home. */
function plainEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_") && !k.startsWith("CAIRN_") && !k.startsWith("GIT_")) env[k] = v;
  }
  return { ...env, ...GIT_IDENT, HOME: home, GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

/** git as a plain shell runs it; throws when git says no. */
function git(cwd: string, home: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", env: plainEnv(home) }).trim();
}

/** git that may say no: status and both streams. */
function tryGit(cwd: string, home: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 20000, env: plainEnv(home, extra) });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

type Attempt = { status: number | null; stdout: string; stderr: string; out: string };

/** cairn-setup for codex: `project` passes --project, `cwd` runs bare from that folder. */
function setup(home: string, at: { project?: string; cwd?: string }, ...extra: string[]): Attempt {
  const flags = at.project ? ["--project", at.project] : [];
  const r = spawnSync(process.execPath, [SETUP, "codex", ...flags, ...extra], {
    cwd: at.cwd, encoding: "utf8", env: { ...plainEnv(home), CAIRN_SETUP_OFFLINE: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The gate's folder git's common directory holds, by git's own answer. */
function gateOf(cwd: string, home: string): string {
  const common = git(cwd, home, "rev-parse", "--git-common-dir");
  return join(realpathSync(isAbsolute(common) ? common : join(cwd, common)), "cairn");
}

/**
 * The issue's arrangement: the owner's repository ignores the planning folder
 * and has main on a bare remote; `pushed` puts main there before any hook.
 */
function repo(prefix = "cairn-gl-proj-"): { proj: string; home: string; bare: string } {
  const proj = fresh(prefix);
  const home = fresh("cairn-gl-home-");
  const bare = fresh("cairn-gl-remote-");
  git(bare, home, "init", "-q", "--bare", "-b", "main");
  git(proj, home, "init", "-q", "-b", "main");
  mkdirSync(join(proj, "src"));
  writeFileSync(join(proj, "src", "a.txt"), "a\n");
  writeFileSync(join(proj, ".gitignore"), `${CAIRN}/\n`);
  git(proj, home, "add", "-A");
  git(proj, home, "commit", "-q", "-m", "init", "--no-gpg-sign");
  git(proj, home, "remote", "add", "origin", bare);
  git(proj, home, "push", "-q", "origin", "main");
  return { proj, home, bare };
}

/** A commit on whatever the owner has checked out. */
function commit(proj: string, home: string, name: string): string {
  writeFileSync(join(proj, "src", name), `${name}\n`);
  git(proj, home, "add", "-A");
  git(proj, home, "commit", "-q", "-m", name, "--no-gpg-sign");
  return git(proj, home, "rev-parse", "HEAD");
}

/** The stamp plan_drift leaves, in the home the plain shell's hook reads. */
function stamp(proj: string, home: string, head: string): void {
  mkdirSync(join(home, ".cairn", "ship-gate"), { recursive: true });
  writeFileSync(join(home, ".cairn", "ship-gate", `${projectKey(proj)}.json`),
    JSON.stringify({ head, clean: true, at: "2026-11-09T00:00:00Z" }));
}

/**
 * A contributor, in a clone of their own, pushes branch `pr` carrying `files`
 * (force-added past the ignore, executable), as a pull request does.
 */
function contributor(bare: string, home: string, files: Record<string, string>): void {
  const clone = join(fresh("cairn-gl-contrib-"), "c");
  git(dirname(clone), home, "clone", "-q", bare, clone);
  git(clone, home, "checkout", "-q", "-b", "pr");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(clone, rel)), { recursive: true });
    writeFileSync(join(clone, rel), body);
    chmodSync(join(clone, rel), 0o755);
    git(clone, home, "add", "-f", rel);
  }
  git(clone, home, "commit", "-q", "-m", "a helpful change", "--no-gpg-sign");
  git(clone, home, "push", "-q", "origin", "pr");
}

/** A node script that leaves a mark and lets the push through: what a hostile copy of the gate does. */
const payloadScript = (mark: string) =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(mark)}, "payload ran\\n");\nprocess.exit(0);\n`;
const payloadHook = (mark: string) => `#!/bin/sh\necho "hook ran as $(id -un)" > '${mark}'\nexit 0\n`;

describe("the gate lives under the git common directory, out of every checkout's reach (#558)", () => {
  it("installs the hook and its script under the common directory, names one absolute path, writes nothing of the layer into the working tree; re-run byte-identical; --check reached", () => {
    const { proj, home } = repo();
    const r = setup(home, { project: proj }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    const gate = gateOf(proj, home);
    const hook = readFileSync(join(gate, "hooks", "pre-push"), "utf8");
    expect(hook).toContain("# cairn:begin");
    expect(hook).toContain(`cairn_prepush='${join(gate, "scripts", "pre-push.mjs")}'`);
    // the old block looked in the worktree git ran it from first
    expect(hook).not.toContain("$PWD");
    expect(hook).not.toContain(CAIRN + "/");
    for (const f of ["pre-push.mjs", "lib.mjs", "git-effects.mjs"]) {
      expect(existsSync(join(gate, "scripts", f)), f).toBe(true);
    }
    expect(readFileSync(join(gate, "scripts", "pre-push.mjs"), "utf8")).toBe(readFileSync(PREPUSH_SRC, "utf8"));
    expect(git(proj, home, "config", "--local", "--get", "core.hooksPath")).toBe(join(gate, "hooks"));
    expect(existsSync(join(proj, OLD_HOOKS))).toBe(false);
    expect(existsSync(join(proj, OLD_SCRIPT))).toBe(false);

    const again = setup(home, { project: proj }, "--git-hooks");
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain("pre-push hook already current");
    expect(readFileSync(join(gate, "hooks", "pre-push"), "utf8")).toBe(hook);

    const check = setup(home, { project: proj }, "--check");
    expect(check.status, check.out).toBe(0);
    expect(check.stdout).toContain(`git hooks (pre-push): installed at ${join(gate, "hooks")}; git runs hooks from there`);
  });

  it("the issue's scenario: a contributor's branch carrying its own gate script, checked out and pushed, runs the common directory's gate; the payload never runs", () => {
    const { proj, home, bare } = repo();
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    const gate = gateOf(proj, home);
    const before = readFileSync(join(gate, "scripts", "pre-push.mjs"), "utf8");
    const mark = join(fresh("cairn-gl-mark-"), "pwned");
    contributor(bare, home, { [OLD_SCRIPT]: payloadScript(mark) });

    git(proj, home, "fetch", "-q", "origin");
    git(proj, home, "checkout", "-q", "pr");
    // git overwrote nothing of the gate: the branch's file is just a file in the tree
    expect(readFileSync(join(proj, OLD_SCRIPT), "utf8")).toContain("payload ran");
    const p = tryGit(proj, home, ["push", "origin", "HEAD:main"]);
    expect(p.status, p.out).not.toBe(0);
    expect(p.stderr).toContain(REFUSED);
    expect(existsSync(mark)).toBe(false);
    expect(readFileSync(join(gate, "scripts", "pre-push.mjs"), "utf8")).toBe(before);
  });

  it("checked out and back: the branch's script leaves the tree, the gate does not, and the next unstamped push is still refused, never unjudged", () => {
    const { proj, home, bare } = repo();
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    const gate = gateOf(proj, home);
    const mark = join(fresh("cairn-gl-mark-"), "pwned");
    contributor(bare, home, { [OLD_SCRIPT]: payloadScript(mark) });
    git(proj, home, "fetch", "-q", "origin");
    git(proj, home, "checkout", "-q", "pr");
    git(proj, home, "checkout", "-q", "main");
    // the round trip deleted the branch's file, as it deleted the gate's in the old layout
    expect(existsSync(join(proj, OLD_SCRIPT))).toBe(false);
    expect(existsSync(join(gate, "scripts", "pre-push.mjs"))).toBe(true);

    commit(proj, home, "b.txt");
    const p = tryGit(proj, home, ["push", "origin", "main"]);
    expect(p.status, p.out).not.toBe(0);
    expect(p.stderr).toContain(REFUSED);
    expect(p.stderr).not.toContain(UNJUDGED);
    expect(git(proj, home, "ls-remote", "origin", "main")).not.toContain(git(proj, home, "rev-parse", "HEAD"));

    // the harmless twin: a clean stamp at that commit lets it through, the gate ran and judged it
    stamp(proj, home, git(proj, home, "rev-parse", "HEAD"));
    const ok = tryGit(proj, home, ["push", "origin", "main"]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.stderr).not.toContain(UNJUDGED);
    expect(existsSync(mark)).toBe(false);
  });

  it("a contributor's branch adding a post-checkout (and its own pre-push) where the old hooks folder was never runs either, either way round", () => {
    const { proj, home, bare } = repo();
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    const mark = join(fresh("cairn-gl-mark-"), "pwned");
    const pushMark = join(dirname(mark), "push-pwned");
    contributor(bare, home, {
      [join(OLD_HOOKS, "post-checkout")]: payloadHook(mark),
      [join(OLD_HOOKS, "pre-push")]: payloadHook(pushMark),
    });
    git(proj, home, "fetch", "-q", "origin");
    const co = tryGit(proj, home, ["checkout", "-q", "pr"]);
    expect(co.status, co.out).toBe(0);
    expect(existsSync(join(proj, OLD_HOOKS, "post-checkout"))).toBe(true);
    expect(existsSync(mark)).toBe(false);
    expect(tryGit(proj, home, ["checkout", "-q", "main"]).status).toBe(0);
    expect(tryGit(proj, home, ["checkout", "-q", "pr"]).status).toBe(0);
    expect(existsSync(mark)).toBe(false);

    const p = tryGit(proj, home, ["push", "origin", "HEAD:main"]);
    expect(p.status, p.out).not.toBe(0);
    expect(p.stderr).toContain(REFUSED);
    expect(existsSync(pushMark)).toBe(false);
  });

  it("a fresh linked worktree of the branch runs the same gate: refused, the branch's script never runs; stamped, it passes", () => {
    const { proj, home, bare } = repo();
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    const mark = join(fresh("cairn-gl-mark-"), "pwned");
    contributor(bare, home, { [OLD_SCRIPT]: payloadScript(mark) });
    git(proj, home, "fetch", "-q", "origin");
    const wt = join(fresh("cairn-gl-wt-"), "review");
    git(proj, home, "worktree", "add", "-q", wt, "pr");
    expect(existsSync(join(wt, OLD_SCRIPT))).toBe(true);
    // the linked worktree reads the same common directory, so the same pair
    expect(gateOf(wt, home)).toBe(gateOf(proj, home));

    const p = tryGit(wt, home, ["push", "origin", "HEAD:main"]);
    expect(p.status, p.out).not.toBe(0);
    expect(p.stderr).toContain(REFUSED);
    expect(existsSync(mark)).toBe(false);

    stamp(wt, home, git(wt, home, "rev-parse", "HEAD"));
    const ok = tryGit(wt, home, ["push", "origin", "HEAD:main"]);
    expect(ok.status, ok.out).toBe(0);
    expect(existsSync(mark)).toBe(false);
  });

  it("the nested-cwd variant: setup run bare from a folder below the root, and for a project below it, lands in the one common directory; a push from below is refused", () => {
    const { proj, home } = repo();
    const below = join(proj, "src");
    const r = setup(home, { cwd: below }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    const gate = gateOf(proj, home);
    expect(existsSync(join(gate, "hooks", "pre-push"))).toBe(true);
    expect(existsSync(join(below, OLD_HOOKS))).toBe(false);
    commit(proj, home, "c.txt");
    expect(tryGit(below, home, ["push", "origin", "main"]).stderr).toContain(REFUSED);

    const pkg = join(proj, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    const again = setup(home, { project: pkg }, "--git-hooks");
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain("pre-push hook already current");
    expect(existsSync(join(pkg, OLD_HOOKS))).toBe(false);
    expect(tryGit(pkg, home, ["push", "origin", "main"]).stderr).toContain(REFUSED);
  });

  it("run from a linked worktree, setup installs into the shared common directory, and the main checkout is gated by it too", () => {
    const { proj, home } = repo();
    const wt = join(fresh("cairn-gl-wt-"), "side");
    git(proj, home, "worktree", "add", "-q", "-b", "side", wt);
    const r = setup(home, { project: wt }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(gateOf(proj, home), "hooks", "pre-push"))).toBe(true);
    expect(existsSync(join(wt, OLD_HOOKS))).toBe(false);
    commit(proj, home, "d.txt");
    expect(tryGit(proj, home, ["push", "origin", "main"]).stderr).toContain(REFUSED);
    commit(wt, home, "side.txt");
    expect(tryGit(wt, home, ["push", "origin", "side:main"]).stderr).toContain(REFUSED);
  });

  it("hostile: a project folder whose name is shell ($(...), a quote, a space) is a path in the hook, never a command; the push is still refused", () => {
    const parent = fresh("cairn-gl-quoted-");
    // run, the substitution would touch the file in the folder git runs the hook in
    const odd = join(parent, "it's $(touch pwned) a repo");
    const mark = join(odd, "pwned");
    mkdirSync(odd);
    const home = fresh("cairn-gl-home-");
    const bare = fresh("cairn-gl-remote-");
    git(bare, home, "init", "-q", "--bare", "-b", "main");
    git(odd, home, "init", "-q", "-b", "main");
    writeFileSync(join(odd, "f.txt"), "f\n");
    git(odd, home, "add", "-A");
    git(odd, home, "commit", "-q", "-m", "init", "--no-gpg-sign");
    git(odd, home, "remote", "add", "origin", bare);
    const r = setup(home, { project: odd }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    const p = tryGit(odd, home, ["push", "origin", "main:main"]);
    expect(p.stderr, p.out).toContain(REFUSED);
    expect(p.stderr).not.toContain(UNJUDGED);
    expect(existsSync(mark)).toBe(false);
  });

  it("hostile: the gate's folder under .git swapped for a link into the working tree is refused, nothing written through it; --check names a link swapped in later", () => {
    const { proj, home } = repo();
    const common = join(realpathSync(proj), ".git");
    mkdirSync(join(proj, "decoy"));
    symlinkSync(join(realpathSync(proj), "decoy"), join(common, "cairn"));
    const r = setup(home, { project: proj }, "--git-hooks");
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("refusing to write through it");
    expect(readdirSync(join(proj, "decoy"))).toEqual([]);
    expect(tryGit(proj, home, ["config", "--get", "core.hooksPath"]).stdout.trim()).toBe("");

    // installed first, then the script swapped for a link into the tree
    const later = repo();
    expect(setup(later.home, { project: later.proj }, "--git-hooks").status).toBe(0);
    const gate = gateOf(later.proj, later.home);
    writeFileSync(join(later.proj, "evil.mjs"), "process.exit(0);\n");
    rmSync(join(gate, "scripts", "pre-push.mjs"));
    symlinkSync(join(realpathSync(later.proj), "evil.mjs"), join(gate, "scripts", "pre-push.mjs"));
    const check = setup(later.home, { project: later.proj }, "--check");
    expect(check.status, check.out).toBe(1);
    expect(check.stdout).toContain("leads out of the git folder");
  });
});

describe("a re-run moves an older install off the working tree, and deletes nothing (#558)", () => {
  /** What an install before #558 left: the block in .cairn/githooks, looking in $PWD first, the script in .cairn/harness/scripts, the pointer at the folder. */
  function oldInstall(proj: string, home: string, pointer = join(proj, OLD_HOOKS)): { hook: string; script: string } {
    mkdirSync(join(proj, OLD_HOOKS), { recursive: true });
    mkdirSync(dirname(join(proj, OLD_SCRIPT)), { recursive: true });
    const hook = [
      "#!/bin/sh",
      "# cairn:begin -- managed by cairn-setup --git-hooks; do not edit inside markers",
      `cairn_prepush="$PWD/${CAIRN}/harness/scripts/pre-push.mjs"`,
      `[ -f "$cairn_prepush" ] || cairn_prepush="${join(proj, OLD_SCRIPT)}"`,
      'if command -v node >/dev/null 2>&1 && [ -f "$cairn_prepush" ]; then',
      '  node "$cairn_prepush" "$@"; cairn_rc=$?',
      '  [ "$cairn_rc" -ne 2 ] || exit 1',
      "else",
      '  echo "cairn pre-push: node or $cairn_prepush not found -- this push was not judged" >&2',
      "fi",
      "# cairn:end",
      "",
    ].join("\n");
    writeFileSync(join(proj, OLD_HOOKS, "pre-push"), hook);
    chmodSync(join(proj, OLD_HOOKS, "pre-push"), 0o755);
    const script = "// the old copy\n";
    writeFileSync(join(proj, OLD_SCRIPT), script);
    git(proj, home, "config", "core.hooksPath", pointer);
    return { hook, script };
  }

  it("--check reports the old layout as lagging, and writes nothing", () => {
    const { proj, home } = repo();
    oldInstall(proj, home);
    const check = setup(home, { project: proj }, "--check");
    expect(check.status, check.out).toBe(1);
    expect(check.stdout).toContain(`installed at ${join(proj, OLD_HOOKS)}, inside the working tree`);
    expect(check.stdout).toContain("re-run with --git-hooks to move it");
    expect(git(proj, home, "config", "--get", "core.hooksPath")).toBe(join(proj, OLD_HOOKS));
  });

  it("the re-run moves the pointer to the common directory, leaves every old file byte-identical, and the gate holds; --check is current after", () => {
    const { proj, home } = repo();
    const old = oldInstall(proj, home);
    const r = setup(home, { project: proj }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    const gate = gateOf(proj, home);
    expect(r.stdout).toContain(`core.hooksPath: moved from ${join(proj, OLD_HOOKS)}`);
    expect(r.stdout).toContain("the old folder is left as it was");
    expect(git(proj, home, "config", "--get", "core.hooksPath")).toBe(join(gate, "hooks"));
    expect(readFileSync(join(proj, OLD_HOOKS, "pre-push"), "utf8")).toBe(old.hook);
    expect(readFileSync(join(proj, OLD_SCRIPT), "utf8")).toBe(old.script);
    expect(readFileSync(join(gate, "hooks", "pre-push"), "utf8")).not.toContain("$PWD");

    commit(proj, home, "e.txt");
    expect(tryGit(proj, home, ["push", "origin", "main"]).stderr).toContain(REFUSED);
    const check = setup(home, { project: proj }, "--check");
    expect(check.status, check.out).toBe(0);
    expect(check.stdout).toContain("git runs hooks from there");

    const again = setup(home, { project: proj }, "--git-hooks");
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain("pre-push hook already current");
    expect(again.stdout).not.toContain("moved from");
  });

  it("hostile: a hook planted beside the old block is named, never copied across, and no longer runs at a checkout", () => {
    const { proj, home, bare } = repo();
    oldInstall(proj, home);
    const mark = join(fresh("cairn-gl-mark-"), "pwned");
    writeFileSync(join(proj, OLD_HOOKS, "post-checkout"), payloadHook(mark));
    chmodSync(join(proj, OLD_HOOKS, "post-checkout"), 0o755);
    const r = setup(home, { project: proj }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("no longer runs post-checkout");
    const gate = gateOf(proj, home);
    expect(readdirSync(join(gate, "hooks"))).toEqual(["pre-push"]);
    expect(existsSync(join(proj, OLD_HOOKS, "post-checkout"))).toBe(true);
    contributor(bare, home, { "src/x.txt": "x\n" });
    git(proj, home, "fetch", "-q", "origin");
    expect(tryGit(proj, home, ["checkout", "-q", "pr"]).status).toBe(0);
    expect(existsSync(mark)).toBe(false);
  });

  it("the old pointer spelled relative, and the move made from a folder below the root, move the same way", () => {
    const { proj, home } = repo();
    oldInstall(proj, home, OLD_HOOKS);
    const r = setup(home, { cwd: join(proj, "src") }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("moved from");
    expect(git(proj, home, "config", "--get", "core.hooksPath")).toBe(join(gateOf(proj, home), "hooks"));
    expect(existsSync(join(proj, OLD_HOOKS, "pre-push"))).toBe(true);
  });

  it("an older block in the owner's own hooks folder lags at --check; a re-run splices the current block in and --check is current", () => {
    const { proj, home } = repo();
    const hooks = join(proj, "scripts", "hooks");
    mkdirSync(hooks, { recursive: true });
    const old = oldInstall(proj, home, "scripts/hooks");
    writeFileSync(join(hooks, "pre-push"), old.hook);
    const check = setup(home, { project: proj }, "--check");
    expect(check.status, check.out).toBe(1);
    expect(check.stdout).toContain("its block is an older one, which looks for the script in the working tree");
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).not.toContain("$PWD");
    expect(git(proj, home, "config", "--get", "core.hooksPath")).toBe("scripts/hooks");
    expect(setup(home, { project: proj }, "--check").status).toBe(0);
  });
});

describe("Not seen: an owner's own core.hooksPath inside the working tree is respected (#558)", () => {
  it("the hook goes into that folder and setup says a checkout can change it; the script stays in the common directory; a branch replacing the tracked hook file walks past, measured", () => {
    const { proj, home, bare } = repo();
    const hooks = join(proj, "scripts", "hooks");
    mkdirSync(hooks, { recursive: true });
    git(proj, home, "config", "core.hooksPath", "scripts/hooks");
    const r = setup(home, { project: proj }, "--git-hooks");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("is inside the working tree, so a checkout can change the hook file there");
    const gate = gateOf(proj, home);
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toContain(`cairn_prepush='${join(gate, "scripts", "pre-push.mjs")}'`);
    const check = setup(home, { project: proj }, "--check");
    expect(check.status, check.out).toBe(0);
    expect(check.stdout).toContain("a folder inside the working tree, by your core.hooksPath");

    // the owner tracks the folder; a branch replaces the hook file: that is the layout's limit
    git(proj, home, "add", "-f", "scripts/hooks/pre-push");
    git(proj, home, "commit", "-q", "-m", "hooks", "--no-gpg-sign");
    git(proj, home, "push", "-q", "--no-verify", "origin", "main");
    contributor(bare, home, { "scripts/hooks/pre-push": "#!/bin/sh\nexit 0\n" });
    git(proj, home, "fetch", "-q", "origin");
    git(proj, home, "checkout", "-q", "pr");
    const p = tryGit(proj, home, ["push", "origin", "HEAD:main"]);
    expect(p.status, p.out).toBe(0);
    expect(readFileSync(join(gate, "scripts", "pre-push.mjs"), "utf8")).toBe(readFileSync(PREPUSH_SRC, "utf8"));

    expect(readFileSync(SETUP, "utf8")).toContain("a local core.hooksPath the owner points inside the working tree");
    expect(readFileSync(PREPUSH_SRC, "utf8")).toContain("own local core.hooksPath naming a folder inside the working tree");
  });
});

describe("the harness guard zones the gate's folder under the git common directory (#558)", () => {
  const WHAT = "the ship gate's git hook and the script it runs";

  function fixture() {
    const { proj, home } = repo();
    expect(setup(home, { project: proj }, "--git-hooks").status).toBe(0);
    mkdirSync(join(proj, "pkg", "lib"), { recursive: true });
    return { proj, home, gate: gateOf(proj, home) };
  }

  function guard(home: string, root: string, tool: string, input: Record<string, unknown>, opts: { cwd?: string; bare?: boolean } = {}) {
    const cwd = opts.cwd ?? root;
    const env: Record<string, string> = { ...plainEnv(home) };
    if (!opts.bare) env.CLAUDE_PROJECT_DIR = root;
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd, env, encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses a write onto the script or into the folder, by tool and by shell; reading and running it passes; the rest of .git stays ordinary", () => {
    const { proj, home, gate } = fixture();
    const script = join(gate, "scripts", "pre-push.mjs");
    for (const [tool, input] of [
      ["Edit", { file_path: script, old_string: "a", new_string: "b" }],
      ["Write", { file_path: join(gate, "scripts", "lib.mjs"), content: "x" }],
      ["Bash", { command: `echo x >> ${script}` }],
      ["Bash", { command: "cp /tmp/evil.mjs .git/cairn/scripts/git-effects.mjs" }],
      ["Bash", { command: "rm -rf .git/cairn" }],
      ["Bash", { command: "ln -sfn /tmp/evil .git/cairn" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = guard(home, proj, tool, input);
      expect(r.status, `${tool} ${JSON.stringify(input)}`).toBe(2);
    }
    expect(guard(home, proj, "Bash", { command: `echo x >> ${script}` }).stderr).toContain(WHAT);
    for (const c of [`cat ${script}`, `node ${script} origin < /dev/null`, "git status", "echo x >> .git/info/exclude"]) {
      expect(guard(home, proj, "Bash", { command: c }).status, c).toBe(0);
    }
  });

  it("holds from a nested working directory, with and without CLAUDE_PROJECT_DIR, and from a linked worktree whose common directory lies outside it", () => {
    const { proj, home, gate } = fixture();
    const nested = join(proj, "pkg", "lib");
    for (const bare of [false, true]) {
      const r = guard(home, proj, "Bash", { command: "echo x >> ../../.git/cairn/scripts/pre-push.mjs" }, { cwd: nested, bare });
      expect(r.status, `bare=${bare}`).toBe(2);
      expect(r.stderr).toContain(WHAT);
    }
    const wt = join(fresh("cairn-gl-wt-"), "w");
    git(proj, home, "worktree", "add", "-q", "-b", "w", wt);
    const fromWt = guard(home, wt, "Bash", { command: `echo x >> ${join(gate, "scripts", "pre-push.mjs")}` }, { cwd: wt, bare: true });
    expect(fromWt.status).toBe(2);
    expect(fromWt.stderr).toContain(WHAT);
    expect(guard(home, wt, "Bash", { command: "echo x > notes.txt" }, { cwd: wt, bare: true }).status).toBe(0);
  });
});
