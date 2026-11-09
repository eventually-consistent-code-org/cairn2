// The opt-in Claude Code sandbox recipe (#567): `cairn-setup claude --sandbox`
// writes the sandbox block, `--check` reads it back. Runs the real script
// against temp repositories with a fake HOME. What the sandbox then does at the
// OS is the drill's (server/drills/drill-sandbox.mjs); this file asserts what
// cairn writes and reports.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SETUP = join(ROOT, "setup", "cairn-setup.mjs");
const SANDBOX = join(ROOT, "setup", "sandbox.mjs");
const LOCAL = join(".claude", "settings.local.json");

const dirs: string[] = [];
function fresh(prefix: string): string {
  // realpath: macOS hands out /var/... for /private/var/..., and git answers in the real spelling
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A fresh repository with one commit, so worktrees can hang off it. */
function repo(): string {
  const p = fresh("cairn-sandbox-proj-");
  git(p, "init", "-q");
  git(p, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return p;
}

type Run = { status: number | null; stdout: string; stderr: string; out: string };
function setup(harness: string, home: string, at: { project?: string; cwd?: string }, ...extra: string[]): Run {
  const flags = at.project ? ["--project", at.project] : [];
  const r = spawnSync(process.execPath, [SETUP, harness, ...flags, ...extra], {
    cwd: at.cwd, encoding: "utf8", env: { ...process.env, HOME: home, CAIRN_SETUP_OFFLINE: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const settingsAt = (root: string) => JSON.parse(readFileSync(join(root, LOCAL), "utf8"));
const lib = async () => import(SANDBOX) as Promise<{
  CAIRN_DENY: readonly { at: string; rel: string; why: string }[];
  denyPaths: (where: object, opts?: object) => string[];
  locate: (p: string) => { root: string; top: string; common: string | null; hooksDir: string | null; file: string };
  recipeStatus: (s: object, deny: string[]) => { state: string; detail: string };
}>;

describe("cairn-setup claude --sandbox writes the recipe (#567)", () => {
  it("turns the sandbox on with the retry off and cairn's folders write-denied, in the root's local settings", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    const r = setup("claude", home, { project: p }, "--sandbox");
    expect(r.status, r.out).toBe(0);
    const s = settingsAt(p).sandbox;
    expect(s.enabled).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    expect(s.failIfUnavailable).toBe(true);
    expect(s.autoAllowBashIfSandboxed).toBe(false);
    const deny: string[] = s.filesystem.denyWrite;
    for (const rel of [".cairn/harness", ".cairn/githooks", ".cairn/state/approvals", "cairn.json"]) {
      expect(deny).toContain(join(p, rel));
      expect(deny).toContain(`./${rel}`);
    }
    for (const rel of ["hooks", "config", "config.worktree"]) expect(deny).toContain(join(p, ".git", rel));
    // the committed project settings are left alone: the block is one owner's
    expect(existsSync(join(p, ".claude", "settings.json"))).toBe(false);
    expect(r.stdout).toContain("its file tools, MCP servers, your own ! commands and the other harnesses stay under the guards");
  });

  it("is byte-identical on a re-run, and keeps every key and entry the owner had", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    mkdirSync(join(p, ".claude"), { recursive: true });
    const owner = {
      permissions: { allow: ["Bash(npm test)"] },
      sandbox: { allowUnsandboxedCommands: true, excludedCommands: ["docker compose *"], filesystem: { denyWrite: ["~/secrets"] } },
    };
    writeFileSync(join(p, LOCAL), JSON.stringify(owner, null, 2) + "\n");
    const r = setup("claude", home, { project: p }, "--sandbox");
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("changed: allowUnsandboxedCommands true -> false");
    const first = readFileSync(join(p, LOCAL), "utf8");
    const s = JSON.parse(first);
    expect(s.permissions).toEqual(owner.permissions);
    expect(s.sandbox.excludedCommands).toEqual(["docker compose *"]);
    expect(s.sandbox.filesystem.denyWrite[0]).toBe("~/secrets");
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    const again = setup("claude", home, { project: p }, "--sandbox");
    expect(again.status, again.out).toBe(0);
    expect(again.stdout).toContain("sandbox recipe already current");
    expect(readFileSync(join(p, LOCAL), "utf8")).toBe(first);
  });

  it("from a folder below the root (the nested-cwd variant), lands at the root, where Claude Code reads it", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    mkdirSync(join(p, "pkg", "lib"), { recursive: true });
    const r = setup("claude", home, { cwd: join(p, "pkg", "lib") }, "--sandbox");
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(p, "pkg", "lib", LOCAL))).toBe(false);
    expect(settingsAt(p).sandbox.filesystem.denyWrite).toContain(join(p, ".cairn", "harness"));
  });

  it("from a linked worktree, lands at the main checkout and denies the worktree's git pointers", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    const wt = join(fresh("cairn-sandbox-wt-"), "wt");
    git(p, "worktree", "add", "-q", wt, "-b", "side");
    const r = setup("claude", home, { project: wt }, "--sandbox");
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(wt, LOCAL))).toBe(false);
    const deny: string[] = settingsAt(p).sandbox.filesystem.denyWrite;
    // both checkouts' own folders, and every file that moves git elsewhere
    expect(deny).toContain(join(p, ".cairn", "harness"));
    expect(deny).toContain(join(wt, ".cairn", "harness"));
    expect(deny).toContain(join(wt, ".git"));
    expect(deny).toContain(join(p, ".git", "worktrees", "wt", "commondir"));
    expect(deny).toContain(join(p, ".git", "worktrees", "wt", "gitdir"));
  });

  it("refuses for any harness but claude, and writes nothing", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    const r = setup("codex", home, { project: p }, "--sandbox");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the recipe is Claude Code's sandbox, and codex has none");
    expect(existsSync(join(p, ".claude"))).toBe(false);
    expect(existsSync(join(p, ".mcp.json"))).toBe(false);
  });

  it("refuses a settings file that doesn't parse, and leaves it as written", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    mkdirSync(join(p, ".claude"), { recursive: true });
    writeFileSync(join(p, LOCAL), "{ not json");
    const r = setup("claude", home, { project: p }, "--sandbox");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("exists but is not valid JSON -- refusing to touch it");
    expect(readFileSync(join(p, LOCAL), "utf8")).toBe("{ not json");
  });

  // Hostile: the settings file is a link out of the project, so the write would
  // land in a file the owner keeps somewhere else (cairn-setup's #498 check).
  it("refuses a settings file that links out of the project, and leaves the far file untouched", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    const far = join(fresh("cairn-sandbox-far-"), "elsewhere.json");
    writeFileSync(far, "{}\n");
    mkdirSync(join(p, ".claude"), { recursive: true });
    symlinkSync(far, join(p, LOCAL));
    const r = setup("claude", home, { project: p }, "--sandbox");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resolves outside the project");
    expect(readFileSync(far, "utf8")).toBe("{}\n");
  });

  // A session inside the sandbox can't write its own settings file; a folder
  // the OS won't let setup write stands in for that refusal here.
  it("a write the OS refuses is a one-line refusal, not a stack trace", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    mkdirSync(join(p, ".claude"), { recursive: true });
    chmodSync(join(p, ".claude"), 0o500);
    try {
      const r = setup("claude", home, { project: p }, "--sandbox");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/the write was refused \((EACCES|EPERM)\) -- a session inside the sandbox can't change its own settings/);
      expect(r.stderr).not.toContain("    at ");
    } finally {
      chmodSync(join(p, ".claude"), 0o700);
    }
  });

  it("without the flag, writes no sandbox block (opt-in)", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    const r = setup("claude", home, { project: p });
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(p, LOCAL))).toBe(false);
  });
});

describe("cairn-setup claude --check reports the recipe (#567)", () => {
  it("absent is opt-in and passes; installed is current; a stale block lags", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    expect(setup("claude", home, { project: p }).status).toBe(0);
    let c = setup("claude", home, { project: p }, "--check");
    expect(c.stdout).toContain("sandbox (.claude/settings.local.json): not installed (opt-in: --sandbox");
    expect(c.status, c.out).toBe(0);

    expect(setup("claude", home, { project: p }, "--sandbox").status).toBe(0);
    c = setup("claude", home, { project: p }, "--check");
    expect(c.stdout).toMatch(/sandbox \(\.claude\/settings\.local\.json\): on; \d+ write-deny entries, retry outside the sandbox off/);
    expect(c.status, c.out).toBe(0);

    const s = settingsAt(p);
    s.sandbox.allowUnsandboxedCommands = true;
    s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((x: string) => x !== join(p, ".cairn", "state", "approvals"));
    writeFileSync(join(p, LOCAL), JSON.stringify(s, null, 2));
    c = setup("claude", home, { project: p }, "--check");
    expect(c.status).toBe(1);
    expect(c.stdout).toContain("allowUnsandboxedCommands is true, not false");
    expect(c.stdout).toContain(`1 deny entry missing (${join(p, ".cairn", "state", "approvals")})`);
  });

  it("a worktree made after the install lags until the owner re-runs", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    expect(setup("claude", home, { project: p }, "--sandbox").status).toBe(0);
    git(p, "worktree", "add", "-q", join(fresh("cairn-sandbox-wt-"), "late"), "-b", "late");
    const c = setup("claude", home, { project: p }, "--check");
    expect(c.status).toBe(1);
    expect(c.stdout).toMatch(/sandbox \(\.claude\/settings\.local\.json\): \d+ deny entries missing/);
  });

  // Hostile: a branch commits project settings that run commands outside the
  // sandbox; they merge in unless the sandbox is admin-required.
  it("a committed settings file that loosens the sandbox lags, naming the key", () => {
    const p = repo();
    const home = fresh("cairn-sandbox-home-");
    expect(setup("claude", home, { project: p }, "--sandbox").status).toBe(0);
    writeFileSync(join(p, ".claude", "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["node *"] } }));
    const c = setup("claude", home, { project: p }, "--check");
    expect(c.status).toBe(1);
    expect(c.stdout).toContain("sandbox (.claude/settings.json): sets excludedCommands, which loosens the sandbox");
  });
});

describe("the deny rows are one list a later change extends (#567, #558)", () => {
  it("every row yields a path, an added row reaches the list, and an empty list is an error", async () => {
    const { CAIRN_DENY, denyPaths, locate } = await lib();
    const p = repo();
    const where = locate(p);
    expect(CAIRN_DENY.length).toBeGreaterThan(0);
    const base = denyPaths(where, { platform: "linux" });
    for (const row of CAIRN_DENY) {
      expect(base.some((x) => x.endsWith(row.rel)), row.rel).toBe(true);
    }
    // the gate's folder (#558): the row and setup's GATE_REL name one folder,
    // so moving the gate without moving the deny fails here
    const gate = /^const GATE_REL = "([^"]+)";$/m.exec(readFileSync(SETUP, "utf8"));
    expect(gate, "setup's GATE_REL").not.toBeNull();
    expect(CAIRN_DENY.some((r) => r.at === "common" && r.rel === gate![1]), `a common row for ${gate![1]}`).toBe(true);
    expect(base).toContain(join(p, ".git", gate![1]));
    const more = denyPaths(where, { platform: "linux", rows: [...CAIRN_DENY, { at: "common", rel: "cairn-gate", why: "test" }] });
    expect(more).toContain(join(p, ".git", "cairn-gate"));
    // outside a repository the git rows have nowhere to hang; with no rows at all, nothing to write is an error
    const loose = locate(fresh("cairn-sandbox-norepo-"));
    expect(() => denyPaths(loose, { rows: [{ at: "common", rel: "x", why: "t" }] })).toThrow(/named no path/);
    expect(() => denyPaths(where, { rows: [{ at: "elsewhere", rel: "x", why: "t" }] })).toThrow(/unknown base/);
  });

  it("darwin adds the wildcard rows; Linux, where a mid-path wildcard covers nothing, does not (the Not seen line)", async () => {
    const { denyPaths, locate } = await lib();
    const p = repo();
    const where = locate(p);
    const mac = denyPaths(where, { platform: "darwin" });
    const linux = denyPaths(where, { platform: "linux" });
    expect(mac.some((x) => x.endsWith(join("worktrees", "*", "commondir")))).toBe(true);
    // a package folder or a worktree inside the checkout (#559's same-line worktree)
    expect(mac).toContain(join(p, "**", ".cairn", "harness"));
    expect(mac).not.toContain(join(p, "**", "cairn.json"));
    expect(linux.some((x) => x.includes("*"))).toBe(false);
    const header = readFileSync(SANDBOX, "utf8");
    expect(header).toContain("a worktree or submodule made after the install has no rows of its own");
    expect(header).toContain("a relative row anchors at the session's working directory");
    expect(header).toContain("a package folder or a worktree inside the checkout holding its own");
  });
});

describe("the docs page says what the recipe leaves uncovered, and what was measured (#567)", () => {
  const page = readFileSync(join(ROOT, "docs", "sandbox.md"), "utf8");
  it("names each thing the sandbox does not reach", () => {
    for (const item of ["Claude's built-in file tools", "Commands you type yourself", "`git reset --hard`",
      "Pushes, and anything else on the network", "The other seven harnesses", "A committed settings file that loosens it",
      "An agent running `--sandbox` itself"]) expect(page, item).toContain(item);
  });
  it("dates its claims and its drill run, and keeps the recipe arm a claim", () => {
    expect(page).toContain("read on 2026-11-06");
    expect(page).toContain("It ran on 2026-11-09, on macOS with Claude Code 2.1.319");
    expect(page).toContain("Whether the rows hold is still a\nclaim");
  });
});

// #568, the owner's decision of 2026-11-09: the four PreToolUse guards cancel
// at 30 seconds and still fail open. The hooks reference (dated claim, read
// 2026-11-06) reads `timeout` as "Seconds before canceling", and "On
// `PreToolUse`, a timed-out `command` ... hook doesn't block the tool call",
// so 3000 held a stalled session for 50 minutes before the same pass.
describe("the guards' hook timeout is 30 seconds, failing open (#568)", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8")) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number; onFailure?: string }[] }[]>;
  };
  const GUARDS = ["leakguard", "runguard", "harnessguard", "writeguard"];

  it("each of the four PreToolUse guards carries timeout 30 and no onFailure", () => {
    const pre = manifest.hooks.PreToolUse.flatMap((e) => e.hooks);
    expect(pre.length).toBe(GUARDS.length);
    for (const g of GUARDS) {
      const hits = pre.filter((h) => h.command.includes(`pretooluse-${g}.mjs`));
      expect(hits.length, g).toBe(1);
      expect(hits[0].timeout, g).toBe(30);
      expect(hits[0].onFailure, g).toBeUndefined();
    }
  });

  it("the other hooks keep their values: the decision was the guards' alone", () => {
    const rest = Object.entries(manifest.hooks).filter(([event]) => event !== "PreToolUse")
      .flatMap(([event, entries]) => entries.flatMap((e) => e.hooks.map((h) => `${event} ${h.command.split("/").pop()} ${h.timeout}`)));
    expect(rest).toEqual([
      'PostToolUse posttooluse-breadcrumb.mjs" 3000',
      'PostToolUse posttooluse-observe.mjs" 3000',
      'PostToolUse posttooluse-loopcheck.mjs" 3000',
      'PostToolUseFailure posttooluse-observe.mjs" 3000',
      'Stop stop-costtracker.mjs" 5000',
      'SessionStart sessionstart-continuity.mjs" 3000',
      'StopFailure notification-pause.mjs" 10000',
      'Notification notification-pause.mjs" 10000',
    ]);
  });
});
