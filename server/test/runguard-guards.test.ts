import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectKey } from "../src/planning/run-manifest.js";

// The always-on destructive-git refusals (#249, #250) and the live-run push
// authority gate (#252) in the PreToolUse run guard. Commands are only ever
// fed to the hook as JSON on stdin -- nothing here runs them.

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-runguard.mjs");

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Hook run with a clean override env so the host shell can't leak one in. */
function guard(proj: string, home: string, command: string, extraEnv: Record<string, string> = {},
  cwd: string = proj): { status: number | null; stderr: string; stdout: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home, ...extraEnv,
  };
  if (!("CAIRN_ALLOW_DESTRUCTIVE_GIT" in extraEnv)) delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
  if (!("CAIRN_ALLOW_UNSHIPPED_PUSH" in extraEnv)) delete env.CAIRN_ALLOW_UNSHIPPED_PUSH;
  const r = spawnSync(process.execPath, [RUNGUARD], {
    cwd: proj, env, encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
  });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

/**
 * The refusal tail (#262): the owner's ways to approve (`!`, the session
 * env when there is one), the harness guard's where-did-this-come-from
 * line, and never a copy-paste NAME=1 prefix.
 */
function expectOwnerTail(stderr: string, label: string, env?: string): void {
  expect(stderr, label).toContain("needs the owner's go-ahead");
  expect(stderr, label).toContain("`!` in your prompt");
  expect(stderr, label).toContain("check where the");
  expect(stderr, label).toContain("not the owner asking");
  expect(stderr, label).not.toMatch(/[A-Z_]+=1/);
  expect(stderr, label).not.toMatch(/prefix/i);
  if (env) expect(stderr, label).toContain(`start the session with ${env} set to 1`);
}

/** The project key the guard derives from CLAUDE_PROJECT_DIR -- the
 *  repository's, read through git (#362); the server's definition. */
function projKey(proj: string): string {
  return projectKey(proj);
}

// A fixed identity for every temp repo: a fresh clone inherits no user.* config, and a CI runner has none (#306).
const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (proj: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: proj, encoding: "utf8", env: { ...process.env, ...GIT_IDENT } }).trim();

/** Writes the ship-gate stamp plan_drift would leave (#251). */
function stamp(proj: string, home: string, s: { head?: string; clean?: boolean } = {}): void {
  mkdirSync(join(home, "ship-gate"), { recursive: true });
  writeFileSync(join(home, "ship-gate", `${projKey(proj)}.json`), JSON.stringify({
    head: s.head ?? git(proj, "rev-parse", "HEAD"), clean: s.clean ?? true,
    at: "2026-10-02T00:00:00Z",
  }));
}

/**
 * A committed git repo on `main` plus an isolated cairn home, optionally
 * with one run manifest. A clean ship-gate stamp at HEAD is written unless
 * `stamped` is false, so the older push tests aren't about the gate.
 */
function fixture(manifest?: Record<string, unknown>, stamped = true): { proj: string; home: string } {
  const proj = freshDir("cairn-runguard-proj-");
  git(proj, "init", "-q", "-b", "main");
  git(proj, "config", "user.email", "t@t");
  git(proj, "config", "user.name", "t");
  writeFileSync(join(proj, "seed.txt"), "seed\n");
  git(proj, "add", "seed.txt");
  git(proj, "commit", "-q", "-m", "init", "--no-gpg-sign");
  const home = freshDir("cairn-runguard-home-");
  if (manifest) {
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", `${projKey(proj)}-run-x.json`),
      JSON.stringify({ version: 1, runId: "run-x", ...manifest }));
    breakerOff(proj);
  }
  if (stamped) stamp(proj, home);
  return { proj, home };
}

/**
 * These tests judge one rule per command, many commands to a fixture; the
 * circuit breaker (#358) would freeze a live run three refusals in and
 * every later mid-run check would read a stopped run. Its own tests are in
 * hooks.test.ts ("circuit breaker").
 */
function breakerOff(proj: string): void {
  writeFileSync(join(proj, "cairn.json"), JSON.stringify({ auto: { breaker: 0 } }));
}

describe("run guard: hard reset refused in every session (#249)", () => {
  it("refuses git reset --hard with no run, naming the owner's ways to approve (#262)", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git reset --hard",
      "git reset --hard HEAD~1",
      "git reset HEAD~1 --hard",
      "git -C . reset --hard origin/main",
      "git -C sub -c core.x=1 reset -q --hard",
      "cd x && git reset --hard",
      "sudo git reset --hard",
      "bash -c 'git reset --hard'",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("a non-running manifest changes nothing -- still refused", () => {
    const { proj, home } = fixture({ status: "complete", phases: [], pushAuth: { granted: false } });
    expect(guard(proj, home, "git reset --hard").status).toBe(2);
  });

  it("quoted mentions and soft resets pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      'git commit -m "explain git reset --hard"',
      "git commit -m 'git reset --hard'",
      "echo git reset --hard",
      "git reset --soft HEAD~1",
      "git reset HEAD -- --hard",
      "git log --oneline # git reset --hard",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("command substitution inside double quotes is a command, not text (#257)", () => {
    const { proj, home } = fixture();
    for (const c of [
      'echo "$(git reset --hard)"',
      'echo "result: $(git reset --hard HEAD~1) done"',
      'echo "`git reset --hard`"',
      'git commit -m "$(git reset --hard)"',
      'echo "$(echo "$(git reset --hard)")"',
      'echo "$(cd sub && (true) && git reset --hard)"',
      'echo "$(echo ")" ; git reset --hard)"',
      'echo "$(git push --force)"',
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("literal text that only looks like a substitution still passes (#257)", () => {
    const { proj, home } = fixture();
    for (const c of [
      'git commit -m "explain git reset --hard"',
      "git commit -m '$(git reset --hard)'",
      'git commit -m "escaped \\$(git reset --hard) is text"',
      'git commit -m "escaped \\`git reset --hard\\` is text"',
      'echo "$(git log --oneline -1) says git reset --hard"',
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("CAIRN_ALLOW_DESTRUCTIVE_GIT=1 overrides from env or as the leading assignment only", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git reset --hard", { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status)
      .toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard").status).toBe(0);
    expect(guard(proj, home, 'git reset --hard -m "CAIRN_ALLOW_DESTRUCTIVE_GIT=1"').status)
      .toBe(2);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && git reset --hard").status)
      .toBe(2);
  });

  it("overridden hard reset still meets the live-run owner-checkout refusal", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
  });

  it("checkout/switch stay live-run-only", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git checkout main").status).toBe(0);
    expect(guard(proj, home, "git switch -c feature").status).toBe(0);
  });

  it("garbage stdin fails open", () => {
    const r = spawnSync(process.execPath, [RUNGUARD], { input: "{ nope", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

describe("run guard: force-push refused in every session (#250)", () => {
  it("refuses every force shape with no run, naming the owner's ways to approve (#262)", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git push --force",
      "git push origin main --force",
      "git push -f",
      "git push -fu origin main",
      "git push -uf origin main",
      "git push --force-with-lease",
      "git push --force-with-lease=main:abc123 origin main",
      "git push --force-if-includes origin main",
      "git push origin +main",
      "git push origin +HEAD:refs/heads/main",
      "git -C . push -f",
      "git fetch && git push --force",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("plain pushes and quoted mentions pass outside a run", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git push",
      "git push origin main",
      "git push -u origin feature",
      "git push -o ci.skip origin main",
      "git push --follow-tags",
      'git commit -m "never git push --force"',
      "echo git push -f",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("CAIRN_ALLOW_DESTRUCTIVE_GIT=1 overrides from env or as the leading assignment", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git push --force", { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status)
      .toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git push origin +main").status)
      .toBe(0);
    expect(guard(proj, home, "git push -f -m CAIRN_ALLOW_DESTRUCTIVE_GIT=1").status).toBe(2);
  });
});

describe("run guard: work-destroying equivalents refused in every session (#264)", () => {
  // Each row: [refused, its allowed everyday neighbour]. The refused form
  // throws work away with no undo; the neighbour is routine or recoverable
  // (a single path, the index only, a dry run, a feature branch).
  const pairs: Array<[refused: string, allowed: string]> = [
    ["git checkout -- .", "git checkout -- seed.txt"],
    ["git checkout .", "git checkout seed.txt"],
    ["git checkout HEAD -- .", "git checkout HEAD -- seed.txt"],
    ["git checkout -- :/", "git checkout -- :/src"],
    ["git checkout HEAD~1 ./", "git checkout HEAD~1 -- ./seed.txt"],
    ["git checkout :/", "git checkout main"],
    ["git checkout -- '.'", "git checkout -- 'seed.txt'"],
    ["git checkout -- '*'", "git checkout -- '*.ts'"],
    ["git checkout -- '**'", "git checkout -- 'src/**'"],
    ["git checkout --pathspec-from-file=paths.txt", "git checkout -b paths"],
    ["git restore './*'", "git restore './src'"],
    ["git restore --pathspec-from-file paths.txt", "git restore --staged --pathspec-from-file paths.txt"],
    ["git checkout -f", "git checkout main"],
    ["git checkout --force main", "git checkout -b feature"],
    ["git checkout -fb x", "git checkout -b fx"],
    ["git restore .", "git restore seed.txt"],
    ["git restore --staged --worktree .", "git restore --staged ."],
    ["git restore -SW :/", "git restore -S :/"],
    ["git restore -- .", "git restore -- seed.txt"],
    ["git restore --source=HEAD~1 .", "git restore --source HEAD~1 seed.txt"],
    ["git restore -s HEAD ../..", "git restore -s HEAD .gitignore"],
    ["git switch --discard-changes main", "git switch main"],
    ["git switch -f main", "git switch -c feature"],
    ["git switch --force main", "git switch -C feature"],
    ["git clean -f", "git clean -n"],
    ["git clean -fd", "git clean -nd"],
    ["git clean -fdx", "git clean -fdxn"],
    ["git clean -xdf", "git clean --dry-run -xdf"],
    ["git clean --force -d", "git clean -e '*.log' -n"],
    ["git -c clean.requireForce=false clean -d", "git clean -d --dry-run"],
    ["git stash clear", "git stash drop"],
    ["git -C . stash clear", "git stash drop stash@{0}"],
    ["git reflog expire --expire=now --all", "git reflog show"],
    ["git push --mirror origin", "git push origin feature"],
    ["git push --prune origin 'refs/heads/*:refs/heads/*'", "git push origin feature"],
    ["git push origin --delete main", "git push origin --delete feature"],
    ["git push origin -d master", "git push origin -d feature"],
    ["git push origin :main", "git push origin :feature"],
    ["git push origin :refs/heads/master", "git push origin :refs/heads/feature"],
    ["git push origin -- :main", "git push origin -- :feature"],
    ["git push origin -- +main", "git push origin -- feature"],
    ["git -c remote.origin.mirror=true push origin", "git -c remote.origin.mirror=false push origin feature"],
    ["sudo -u root git clean -fdx", "sudo -u root git clean -n"],
    ["timeout 5 git stash clear", "timeout 5 git stash drop"],
    ['echo "$(git checkout -- .)"', 'echo "$(git checkout -- seed.txt)"'],
  ];

  it("each refused form exits 2, naming the escape; its everyday neighbour exits 0", () => {
    const { proj, home } = fixture();
    for (const [refused, allowed] of pairs) {
      const r = guard(proj, home, refused);
      expect(r.status, refused).toBe(2);
      expect(r.stderr, refused).toContain("refused in every session");
      expect(r.stderr, refused).toContain("CAIRN_ALLOW_DESTRUCTIVE_GIT");
      expect(guard(proj, home, allowed).status, allowed).toBe(0);
    }
  });

  it("branch -D and other routine commands stay allowed", () => {
    const { proj, home } = fixture();
    git(proj, "branch", "feature");
    for (const c of [
      "git branch -D feature",
      "git branch -d feature",
      // one worktree here; with a second, pop is refused (#363)
      "git stash",
      "git stash pop",
      "git checkout -",
      "git restore --staged -- .",
      "git reflog",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("quoted mentions pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      'git commit -m "never git checkout -- ."',
      "git commit -m 'git clean -fdx'",
      "echo git stash clear",
      'git commit -m "git push --mirror origin"',
      "git log --oneline # git reflog expire --all",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("a remote already configured to mirror turns a plain push into a refused one", () => {
    const { proj, home } = fixture();
    git(proj, "config", "remote.origin.mirror", "true");
    for (const c of ["git push origin", "git push", "git push origin main"]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("git push --mirror");
    }
    // ...a different remote is a plain push
    expect(guard(proj, home, "git push upstream feature").status).toBe(0);
  });

  it("CAIRN_ALLOW_DESTRUCTIVE_GIT=1 unlocks the table from env or as the leading assignment only", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git checkout -- .", "git restore .", "git switch -f main", "git clean -fdx",
      "git stash clear", "git reflog expire --all", "git push --mirror origin",
      "git push --prune origin",
    ]) {
      expect(guard(proj, home, c, { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status, c).toBe(0);
      expect(guard(proj, home, `CAIRN_ALLOW_DESTRUCTIVE_GIT=1 ${c}`).status, c).toBe(0);
      expect(guard(proj, home, `CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && ${c}`).status, c).toBe(2);
    }
  });

  it("deleting the default branch still meets the ship gate once the table is unlocked", () => {
    const { proj, home } = fixture();
    const r = guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git push origin --delete main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("deletes the default branch");
    expect(guard(proj, home, "git push origin --delete main", {
      CAIRN_ALLOW_DESTRUCTIVE_GIT: "1", CAIRN_ALLOW_UNSHIPPED_PUSH: "1",
    }).status).toBe(0);
  });

  it("the remote's HEAD branch counts as default for a deleting push", () => {
    const { proj, home } = fixture();
    git(proj, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(proj, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(guard(proj, home, "git push origin --delete trunk").status).toBe(2);
    expect(guard(proj, home, "git push origin --delete feature").status).toBe(0);
  });
});

describe("run guard: a shortened long option is the option git reads it as (#296)", () => {
  // git's option parser takes any unique start of a long option, so each
  // row is [shortened, full spelling, an everyday shortened option]. Before
  // #296 the table matched exact spellings only, and every shortened form
  // below exited 0 while git threw the work away. An ambiguous start
  // (`push --f`) is refused too -- git rejects it before doing anything.
  const rows: Array<[shortened: string, full: string, everyday: string]> = [
    ["git reset --har", "git reset --hard", "git reset --so HEAD~1"],
    ["git reset --h HEAD~1", "git reset --hard HEAD~1", "git reset --mi HEAD~1"],
    ["git reset HEAD~1 --ha", "git reset HEAD~1 --hard", "git reset --qu HEAD~1"],
    ["sudo -u root git reset --har", "sudo -u root git reset --hard", "sudo -u root git reset --so"],
    ["git checkout --forc main", "git checkout --force main", "git checkout --det HEAD"],
    ["git checkout --f", "git checkout -f", "git checkout --orp fresh"],
    ["git checkout --pathspec-fr=paths.txt", "git checkout --pathspec-from-file=paths.txt",
      "git checkout --conf=merge seed.txt"],
    ["git switch --discard main", "git switch --discard-changes main", "git switch --cr feature"],
    ["git switch --di main", "git switch -f main", "git switch --force-c feature"],
    ["git switch --forc main", "git switch --force main", "git switch --det HEAD~1"],
    ["git restore --wor --st .", "git restore --worktree --staged .", "git restore --st ."],
    ["git restore -S --no-st .", "git restore -S --no-staged .", "git restore -S ."],
    ["git restore --sou=HEAD .", "git restore --source=HEAD .", "git restore --sou HEAD seed.txt"],
    ["git clean -n --no-d", "git clean -n --no-dry-run", "git clean --dr -x"],
    ["git clean --forc -d", "git clean --force -d", "git clean --d -fdx"],
    ["git push --force-w origin feature", "git push --force-with-lease origin feature",
      "git push --set-u origin feature"],
    ["git push --force-w=feature:abc origin feature", "git push --force-with-lease=feature:abc origin feature",
      "git push --foll origin feature"],
    ["git push --force-i origin feature", "git push --force-if-includes origin feature",
      "git push --porc origin feature"],
    ["git push --f origin feature", "git push --force origin feature", "git push --no-v origin feature"],
    ["git push --force-w origin main", "git push --force-with-lease origin main", "git push --ato origin main"],
    ["git push --mirr origin", "git push --mirror origin", "git push --dry origin feature"],
    ["git push --pru origin", "git push --prune origin", "git push --pro origin feature"],
    ["git push origin --del main", "git push origin --delete main", "git push origin --del feature"],
  ];

  it("each shortened form is refused like its full spelling; the everyday shortened option passes", () => {
    const { proj, home } = fixture();
    for (const [shortened, full, everyday] of rows) {
      const s = guard(proj, home, shortened);
      expect(s.status, shortened).toBe(2);
      expect(s.stderr, shortened).toContain("refused in every session");
      expectOwnerTail(s.stderr, shortened, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
      expect(guard(proj, home, full).status, full).toBe(2);
      expect(guard(proj, home, everyday).status, everyday).toBe(0);
    }
  });

  it("everyday shortened options of commands outside the table pass", () => {
    const { proj, home } = fixture();
    for (const c of ["git status --shor", "git log --onel -1", "git commit --allow-e -m x", "git stash --keep"]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("a shortened hard reset still meets the live-run owner-checkout refusal once overridden", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --har");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
    expect(r.stderr).toContain("git reset --hard");
  });

  it("a push option's value is read the way git reads it -- not as the remote", () => {
    // --recurse-submodules takes the next word: `no` is its value and
    // `origin` the remote, so this pushes the current branch, main. Read
    // as remote `no` and refspec `origin`, it passed the ship gate.
    const { proj, home } = fixture(undefined, false);
    for (const c of [
      "git push --recurse-submodules no origin",
      "git push --recurse-s check origin",
      "git push --push-o ci.skip origin",
      "git push --ex /usr/bin/receive origin",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("/cairn:ship");
    }
    for (const c of [
      "git push --recurse-submodules no origin feature",
      "git push --recurse-submodules=no origin feature",
      "git push --push-o ci.skip origin feature",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });
});

describe("run guard: refusals name the owner's ways, never the override prefix (#262)", () => {
  it("destructive, unshipped-push and mid-run refusals all carry the owner tail", () => {
    const { proj, home } = fixture(undefined, false);
    const reset = guard(proj, home, "git reset --hard");
    expect(reset.status).toBe(2);
    expectOwnerTail(reset.stderr, "reset", "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    const clean = guard(proj, home, "git clean -fdx");
    expect(clean.status).toBe(2);
    expectOwnerTail(clean.stderr, "clean", "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    const ship = guard(proj, home, "git push origin main");
    expect(ship.status).toBe(2);
    expect(ship.stderr).toContain("/cairn:ship");
    expectOwnerTail(ship.stderr, "ship", "CAIRN_ALLOW_UNSHIPPED_PUSH");

    // mid-run has no session env to name -- `!` and the run's own worktree
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const mid = guard(live.proj, live.home, "git checkout main");
    expect(mid.status).toBe(2);
    expect(mid.stderr).toContain("run's own worktree");
    expectOwnerTail(mid.stderr, "mid-run");
    expect(mid.stderr).not.toContain("CAIRN_RUN_OK");
  });

  it("the inline overrides the refusals no longer teach are still honoured", () => {
    const { proj, home } = fixture(undefined, false);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard").status).toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_UNSHIPPED_PUSH=1 git push origin main").status).toBe(0);
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    expect(guard(live.proj, live.home, "CAIRN_RUN_OK=1 git checkout main").status).toBe(0);
  });
});

describe("run guard: a wrapper's flags and their values don't hide git (#270)", () => {
  // Each row: [wrapped form, plain form]. The wrapper must change nothing --
  // refused exactly where the plain form is. Before #270 the run guard
  // skipped a wrapper's flags but not their values, so `root` / `5` read as
  // the command, and timeout, nice, stdbuf, doas, xargs and a full-path
  // sudo were not wrappers at all.
  const resets: Array<[wrapped: string, plain: string]> = [
    ["sudo -u root git reset --hard", "git reset --hard"],
    ["timeout 5 git reset --hard HEAD~1", "git reset --hard HEAD~1"],
    ["nice -n 5 git reset --hard", "git reset --hard"],
    ["env -u FOO git reset HEAD~1 --hard", "git reset HEAD~1 --hard"],
    ["stdbuf -o0 git -C . reset --hard", "git -C . reset --hard"],
    ["doas -u root git reset --hard", "git reset --hard"],
    ["echo | xargs git reset --hard", "echo | git reset --hard"],
    ["/usr/bin/sudo git reset --hard", "git reset --hard"],
    ["timeout -s KILL -k 2 5s git reset --hard", "git reset --hard"],
    ["nohup sudo -u root env -i nice -n 1 git reset --hard", "git reset --hard"],
    ["sudo -u root bash -c 'git reset --hard'", "bash -c 'git reset --hard'"],
  ];
  const forces: Array<[wrapped: string, plain: string]> = [
    ["nice git push --force", "git push --force"],
    ["sudo -u root git push --force origin x", "git push --force origin x"],
    ["timeout 5 git push -f", "git push -f"],
    ["env -u FOO git push origin +main", "git push origin +main"],
    ["/usr/bin/sudo -n git push --force-with-lease", "git push --force-with-lease"],
    ["xargs -n 1 git push --force", "git push --force"],
    ["stdbuf -oL git push -fu origin main", "git push -fu origin main"],
  ];

  it("a wrapped hard reset is refused next to its plain form", () => {
    const { proj, home } = fixture();
    for (const [wrapped, plain] of resets) {
      const w = guard(proj, home, wrapped);
      expect(w.status, wrapped).toBe(2);
      expect(w.stderr, wrapped).toContain("git reset --hard");
      expect(guard(proj, home, plain).status, plain).toBe(2);
    }
  });

  it("a wrapped force-push is refused next to its plain form", () => {
    const { proj, home } = fixture();
    for (const [wrapped, plain] of forces) {
      const w = guard(proj, home, wrapped);
      expect(w.status, wrapped).toBe(2);
      expect(w.stderr, wrapped).toContain("git push --force");
      expect(guard(proj, home, plain).status, plain).toBe(2);
    }
  });

  it("mid-run, a wrapped checkout or switch of the owner's checkout is refused next to its plain form", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const rows: Array<[wrapped: string, plain: string]> = [
      ["sudo -u me git checkout main", "git checkout main"],
      ["timeout 5 git switch main", "git switch main"],
      ["nice -n 5 git checkout -b x", "git checkout -b x"],
      ["/usr/bin/sudo git switch -c y", "git switch -c y"],
      ["env -u FOO git checkout main", "git checkout main"],
    ];
    for (const [wrapped, plain] of rows) {
      const w = guard(proj, home, wrapped);
      expect(w.status, wrapped).toBe(2);
      expect(w.stderr, wrapped).toContain("run-x");
      expect(guard(proj, home, plain).status, plain).toBe(2);
    }
    // ...and from the run's own worktree, wrapped or not, it is left alone
    const wt = join(freshDir("cairn-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    expect(guard(proj, home, "timeout 5 git switch main", {}, wt).status).toBe(0);
    expect(guard(proj, home, "git switch main", {}, wt).status).toBe(0);
  });

  it("quoted text behind a wrapper still passes", () => {
    const { proj, home } = fixture();
    for (const c of [
      'sudo -u root git commit -m "explain git reset --hard"',
      "timeout 5 git commit -m 'git push --force'",
      "nice -n 5 echo git reset --hard",
      "env -u FOO git log --oneline # git reset --hard",
      "sudo -u root git reset --soft HEAD~1",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("a shell's -c string is found the way the harness guard finds it", () => {
    const { proj, home } = fixture();
    // The string is the first bare word after the shell's options -- not
    // whatever word follows the first -c-looking flag
    for (const c of [
      "bash -c -x 'git reset --hard'",
      "bash -c -- 'git reset --hard'",
      "bash -Bc 'git reset --hard'",
      "sh -o pipefail -c 'git push --force'",
      "bash -O extglob -c 'git reset --hard'",
      "bash --norc -lc 'git reset --hard'",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(2);
    }
    // ...and a script path's arguments are not a command string
    for (const c of [
      "bash script.sh -c 'git reset --hard'",
      "sh -x check.sh 'git push --force'",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("the leading override still unlocks exactly one wrapped command; a flag value is no override", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 timeout 5 git reset --hard").status).toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && timeout 5 git reset --hard").status)
      .toBe(2);
    expect(guard(proj, home, "sudo -u CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard").status).toBe(2);
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    expect(guard(live.proj, live.home, "CAIRN_RUN_OK=1 nice -n 5 git checkout main").status).toBe(0);
  });
});

describe("run guard: a shell keyword or grouping word doesn't hide git (#285)", () => {
  // Each row: [refused form, its plain allowed neighbour]. Before #285 the
  // first word of each was read as the command -- `if`, `{`, `!`, `do` --
  // so none of these reached the table.
  const rows: Array<[refused: string, allowed: string]> = [
    ["if git reset --hard; then :; fi", "if git status; then :; fi"],
    ["{ git reset --hard; }", "{ git status; }"],
    ["! git reset --hard", "! git status"],
    ["while git reset --hard; do :; done", "while git status; do :; done"],
    ["until git reset --hard; do :; done", "until git status; do :; done"],
    ["if true; then git reset --hard; fi", "if true; then git reset --soft; fi"],
    ["if a; then :; elif b; then :; else git reset --hard; fi", "if a; then :; elif b; then :; else git log; fi"],
    ["for i in 1; do git reset --hard; done", "for f in *; do cat \"$f\"; done"],
    ["case x in x) git reset --hard;; esac", "case x in x) git status;; esac"],
    ["true && { git push --force origin x; }", "true && { git push origin x; }"],
    ["function f { git reset --hard; }; f", "function f { git status; }; f"],
    ["f() { git clean -fd; }", "f() { git clean -n; }"],
    ["time { git reset --hard; }", "time { git status; }"],
    ["coproc git reset --hard", "coproc git fetch"],
    ["echo | xargs --replace git reset --hard", "xargs --replace echo {}"],
    ["echo | xargs -i git push --force", "echo | xargs -i git push"],
    ["echo | xargs --eof git reset --hard", "echo | xargs --eof git status"],
  ];

  it("each refused form exits 2 with the table's refusal; its neighbour exits 0", () => {
    const { proj, home } = fixture();
    for (const [refused, allowed] of rows) {
      const r = guard(proj, home, refused);
      expect(r.status, refused).toBe(2);
      expect(r.stderr, refused).toContain("refused in every session");
      expect(guard(proj, home, allowed).status, allowed).toBe(0);
    }
  });

  it("a loop's word list is data, and the override still prefixes the one command", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "for w in git reset --hard; do echo $w; done").status).toBe(0);
    expect(guard(proj, home, "if true; then CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard; fi").status).toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true; { git reset --hard; }").status).toBe(2);
  });
});

describe("run guard: macOS env -P and zsh's prefix words don't hide git (#258)", () => {
  it("each refused form exits 2 with the table's refusal; its neighbour exits 0", () => {
    const { proj, home } = fixture();
    const rows: Array<[refused: string, allowed: string]> = [
      ["env -P /usr/bin git reset --hard", "env -P /usr/bin git status"],
      ["env -i -P/usr/bin git push --force origin x", "env -i -P/usr/bin git push origin x"],
      ["noglob git reset --hard", "noglob git status"],
      ["nocorrect git clean -fd", "nocorrect git clean -n"],
      ["repeat 2 git reset --hard", "repeat 2 git status"],
      ["repeat 2 do git stash clear; done", "repeat 2 do git stash list; done"],
      ["repeat 2 { git checkout -- .; }", "repeat 2 { git checkout -- a.txt; }"],
    ];
    for (const [refused, allowed] of rows) {
      const r = guard(proj, home, refused);
      expect(r.status, refused).toBe(2);
      expect(r.stderr, refused).toContain("refused in every session");
      expect(guard(proj, home, allowed).status, allowed).toBe(0);
    }
  });
});

describe("run guard: a program runner doesn't hide git (#307)", () => {
  // Each row: [refused form, the same runner around a harmless command].
  // Before #307 these runners weren't in the shared wrapper table, so the
  // runner's name read as the command and the git it ran met no rule; the
  // first six are the forms the audit ran for real in a throwaway repo.
  const rows: Array<[refused: string, allowed: string]> = [
    ["xcrun git reset --hard", "xcrun git status"],
    ["arch -arm64 git reset --hard", "arch -arm64 git status"],
    ["caffeinate -i git reset --hard", "caffeinate -i git status"],
    ["script -q /dev/null git reset --hard", "script -q /dev/null git status"],
    ["gtimeout 10 git reset --hard", "gtimeout 10 git status"],
    ["flock /tmp/l git reset --hard", "flock /tmp/l git status"],
    ["xcrun --sdk macosx git push --force origin x", "xcrun --sdk macosx git push origin x"],
    ["arch -arch x86_64 -e FOO=1 git clean -fd", "arch -arch x86_64 -e FOO=1 git clean -n"],
    ["caffeinate -t 60 git checkout -- .", "caffeinate -t 60 git checkout -- a.txt"],
    ["script -a -t 30 /tmp/log git stash clear", "script -a -t 30 /tmp/log git stash list"],
    ["script -q -c 'git reset --hard' /dev/null", "script -q -c 'git status' /dev/null"],
    ["flock -w 5 /tmp/l -c 'git reset --hard'", "flock -w 5 /tmp/l -c 'git status'"],
    ["gtimeout -s KILL 10 git push -f", "gtimeout -s KILL 10 git push"],
    ["taskpolicy -b git reset --hard", "taskpolicy -b git status"],
    ["sandbox-exec -f prof.sb git reset --hard", "sandbox-exec -f prof.sb git status"],
    ["unbuffer git reset --hard", "unbuffer git status"],
    ["ionice -c 3 git reset --hard", "ionice -c 3 git status"],
    ["watch -n 1 'git reset --hard'", "watch -n 1 'git status'"],
    ["XCRUN Arch -arm64 GIT reset --hard", "XCRUN Arch -arm64 GIT status"],
  ];

  it("each refused form exits 2 with the table's refusal; its harmless twin exits 0", () => {
    const { proj, home } = fixture();
    for (const [refused, allowed] of rows) {
      const r = guard(proj, home, refused);
      expect(r.status, refused).toBe(2);
      expect(r.stderr, refused).toContain("refused in every session");
      expect(guard(proj, home, allowed).status, allowed).toBe(0);
    }
  });

  it("a runner meets the ship gate and the live-run rule too", () => {
    const bare = fixture(undefined, false);
    expect(guard(bare.proj, bare.home, "xcrun git push origin main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "caffeinate -i git push origin HEAD:main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "caffeinate -i git push origin main:feature").status).toBe(0);
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    for (const c of ["arch -arm64 git checkout main", "script -q /dev/null git switch main"]) {
      const r = guard(live.proj, live.home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
    }
  });
});

describe("run guard: a program runner off the table doesn't hide git (#311)", () => {
  // The runners #307 left out. Each must refuse the destructive git it runs,
  // and let its harmless twin through. The forms are the audit's pass-3 list.
  const refused = [
    "strace -f git reset --hard",
    "op run -- git reset --hard",
    "uv run git reset --hard",
    "poetry run git reset --hard",
    "bundle exec git reset --hard",
    "bunx git reset --hard",
    "npm exec -- git reset --hard",
    "npm exec -c 'git reset --hard'",
    "npm x -- git reset --hard",
    "pnpm exec git reset --hard",
    "pnpm dlx -c 'git reset --hard'",
    "yarn exec git reset --hard",
    "bun exec 'git reset --hard'",
    "direnv exec . git reset --hard",
    "mise exec -- git reset --hard",
    "dotenv -- git reset --hard",
    "busybox sh -c 'git reset --hard'",
    "toybox sh -c 'git reset --hard'",
    "ltrace git reset --hard",
    "valgrind git reset --hard",
    "gdb -batch -ex run --args git reset --hard",
    "lldb -b -o run -- git reset --hard",
    "runuser -u me -- git reset --hard",
    "pkexec git reset --hard",
    "sg staff -c 'git reset --hard'",
    "systemd-run --user git reset --hard",
    "nsenter -t 1 git reset --hard",
    "unshare git reset --hard",
    "firejail git reset --hard",
    "bwrap --bind / / git reset --hard",
    "tmux new-session -d 'git reset --hard'",
    "screen -dm git reset --hard",
    "parallel ::: 'git reset --hard'",
    "hyperfine --runs 1 'git reset --hard'",
    "osascript -e 'do shell script \"git reset --hard\"'",
    "npx -c 'git reset --hard'",
  ];
  // Over-refusal pairs: an ordinary runner line, or a line that only mentions
  // a destructive command, stays allowed.
  const allowed = [
    "npx vitest run",
    "npm exec -- tsc --noEmit",
    "pnpm exec tsc",
    "uv run pytest",
    "poetry run pytest -q",
    "bundle exec rake test",
    "op run -- npm publish --dry-run",
    "tmux new-session -d 'npm test'",
    "echo git reset --hard",
    'grep -rn "git reset --hard" docs',
    'gh issue create --title "git reset --hard is refused"',
    "strace -f ls",
    "npx -c 'git status'",
    "hyperfine 'git status'",
  ];

  it("each off-table runner of a destructive git is refused in every session", () => {
    const { proj, home } = fixture();
    for (const c of refused) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("refused in every session");
    }
  });

  it("ordinary runner lines, and lines that only mention git, pass", () => {
    const { proj, home } = fixture();
    for (const c of allowed) expect(guard(proj, home, c).status, c).toBe(0);
  });

  it("a runner meets the ship gate too — `op run -- git push` lands on main unstamped", () => {
    const bare = fixture(undefined, false);
    expect(guard(bare.proj, bare.home, "op run -- git push origin feature:main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "bundle exec git push origin HEAD:main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "op run -- git push origin main:feature").status).toBe(0);
  });

  it("an off-table runner reaches the guard through an MCP tool too (#310)", () => {
    const { proj, home } = fixture();
    const START = "mcp__plugin_desktop-commander_desktop-commander__start_process";
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home };
    delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
    delete env.CAIRN_ALLOW_UNSHIPPED_PUSH;
    const run = (command: string) => spawnSync(process.execPath, [RUNGUARD], {
      cwd: proj, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: START, tool_input: { command }, cwd: proj }),
    });
    expect(run("op run -- git reset --hard").status).toBe(2);
    expect(run("op run -- npm publish --dry-run").status).toBe(0);
  });
});

// #315: ARG_SAFE exempted man and gh whole, but `man -P '<cmd>'` runs its
// pager, `gh alias set --shell` and `gh extension exec` run programs, and a
// PAGER= / GIT_PAGER= assignment runs on the next git or man. Each is read
// per option now; dropping gh would bring back the `gh pr create --body`
// over-refusal.
describe("run guard: a reading program's one program-running option is read as a command (#315)", () => {
  const R = "git reset --hard";
  const refused = [
    `man -P '${R}' ls`,
    `man -P'${R}' ls`,
    `man --pager='${R}' ls`,
    `man --pager '${R}' ls`,
    `man -aP '${R}' ls`,
    `MANPAGER='${R}' man ls`,
    `PAGER='${R}' man ls`,
    `GIT_PAGER='${R}' git log`,
    `PAGER='${R}' git log`,
    `export GIT_PAGER='${R}'; git log`,
    `GIT_PAGER='${R}' git -C /tmp log`,
    `gh alias set --shell r '${R}'`,
    `gh alias set -s r '${R}'`,
    `gh alias set r --shell '${R}'`,
    `gh alias set r '!${R}'`,
    `gh config set pager '${R}'`,
    `gh config set editor '${R}'`,
    `gh extension exec evil -- ${R}`,
    `gh ext exec evil ${R}`,
    `gh evil -- ${R}`,
    `rg --pre '${R}' foo`,
    `rg --pre='${R}' foo`,
    `ag --pager '${R}' foo`,
    `sort --compress-program='${R}' x`,
    `sudo man -P '${R}' ls`, // through a wrapper
    `bash -c "man -P '${R}' ls"`, // and a nested shell
  ];
  const allowed = [
    "man git-reset",
    "man -k reset",
    "man -P less git",
    "man -M /opt/man ls",
    `man -S 1:P ls`,
    "PAGER=less man git",
    "GIT_PAGER=cat git log",
    "MANPAGER='less -R' man git-reset",
    "GIT_PAGER=cat git log --oneline -5",
    `gh pr create --body "never run ${R}"`,
    `gh issue create --title "${R} is refused"`,
    "gh alias set co 'pr checkout'",
    `gh alias set rs '${R}'`, // no --shell: gh runs it as a gh command, which has no reset
    "gh alias list",
    "gh config get pager",
    `gh config set git_protocol '${R}'`,
    "gh extension list",
    "gh extension install owner/gh-x",
    "gh pr checkout 5",
    "rg --pre-glob '*.gz' foo",
    `rg -n "${R}" docs`,
    "rg --pre unzip x",
    "sort -k 2 x",
    `echo -P '${R}'`,
  ];

  it("each program-running option carrying a destructive git is refused", () => {
    const { proj, home } = fixture();
    for (const c of refused) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("refused in every session");
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("the same programs reading, printing or searching stay allowed", () => {
    const { proj, home } = fixture();
    for (const c of allowed) expect(guard(proj, home, c).status, c).toBe(0);
  });

  it("a pager that pushes meets the ship gate, and one before a push on the line isn't an earlier step (#305)", () => {
    const bare = fixture(undefined, false);
    expect(guard(bare.proj, bare.home, "GIT_PAGER='git push origin feature:main' git log").status).toBe(2);
    expect(guard(bare.proj, bare.home, "gh alias set --shell p 'git push origin HEAD:main'").status).toBe(2);
    const { proj, home } = fixture();
    // a harmless pager rides the git log before a stamped push: not a commit or ref move ahead of it
    expect(guard(proj, home, "GIT_PAGER=cat git log -1 && git push origin main").status).toBe(0);
    expect(guard(proj, home, "GIT_PAGER='git commit --allow-empty -m x' git log && git push origin main").status).toBe(2);
    // rg --pre runs its program on every file: an unknown script there is an
    // earlier step that can commit, like `./x.sh && git push` is; a reader isn't
    const pre = guard(proj, home, "rg --pre ./x.sh foo seed.txt && git push origin main");
    expect(pre.status).toBe(2);
    expect(pre.stderr).toContain("push as its own step");
    expect(guard(proj, home, "rg --pre cat foo seed.txt && git push origin main").status).toBe(0);
  });

  it("reaches the guard through an MCP tool's command line too (#310)", () => {
    const { proj, home } = fixture();
    const START = "mcp__plugin_desktop-commander_desktop-commander__start_process";
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home };
    delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
    delete env.CAIRN_ALLOW_UNSHIPPED_PUSH;
    const run = (command: string) => spawnSync(process.execPath, [RUNGUARD], {
      cwd: proj, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name: START, tool_input: { command }, cwd: proj }),
    });
    expect(run(`man -P '${R}' ls`).status).toBe(2);
    expect(run(`gh alias set --shell r '${R}'`).status).toBe(2);
    expect(run("man git-reset").status).toBe(0);
    expect(run(`gh pr create --body "${R}"`).status).toBe(0);
  });
});

describe("run guard: a capitalised command name is the program a Mac runs (#300)", () => {
  // Each row: [capitalised, lowercase, capitalised harmless]. A Mac's
  // case-insensitive volume runs `GIT` as git and `SUDO` as sudo, so before
  // #300 the capitalised form ran the real tool while both names were
  // compared lowercase-exact -- it reached no rule at all.
  const rows: Array<[upper: string, lower: string, harmless: string]> = [
    ["GIT reset --hard", "git reset --hard", "GIT status"],
    ["Git reset --hard", "git reset --hard", "Git log --oneline"],
    ["/usr/bin/GIT reset --hard", "/usr/bin/git reset --hard", "/usr/bin/GIT status"],
    ["SUDO git reset --hard", "sudo git reset --hard", "SUDO git status"],
    ["SUDO -u root GIT push --force origin x", "sudo -u root git push --force origin x", "SUDO -u root GIT push origin x"],
    ["ENV -i git reset --hard", "env -i git reset --hard", "ENV -i git status"],
    ["Env -u FOO git clean -fd", "env -u FOO git clean -fd", "Env -u FOO git clean -n"],
    ["echo | XARGS git reset --hard", "echo | xargs git reset --hard", "echo | XARGS git status"],
    ["TIMEOUT 5 git stash clear", "timeout 5 git stash clear", "TIMEOUT 5 git stash list"],
    ["NICE -n 5 GIT checkout -- .", "nice -n 5 git checkout -- .", "NICE -n 5 GIT checkout -- a.txt"],
    ["NOHUP DOAS -u root git reset --hard", "nohup doas -u root git reset --hard", "NOHUP DOAS -u root git status"],
    ["ſudo git reset --hard", "sudo git reset --hard", "ſudo git status"],
    ["BASH -c 'git reset --hard'", "bash -c 'git reset --hard'", "BASH -c 'git status'"],
    ["/bin/SH -c 'GIT reset --hard'", "/bin/sh -c 'git reset --hard'", "/bin/SH -c 'GIT status'"],
  ];

  it("each capitalised form is refused like its lowercase form; the capitalised harmless one passes", () => {
    const { proj, home } = fixture();
    for (const [upper, lower, harmless] of rows) {
      const r = guard(proj, home, upper);
      expect(r.status, upper).toBe(2);
      expect(r.stderr, upper).toContain("refused in every session");
      expect(guard(proj, home, lower).status, lower).toBe(2);
      expect(guard(proj, home, harmless).status, harmless).toBe(0);
    }
  });

  it("a capitalised push meets the ship gate, and a capitalised checkout the live-run rule", () => {
    const bare = fixture(undefined, false);
    expect(guard(bare.proj, bare.home, "GIT push origin main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "SUDO Git push origin HEAD:main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "GIT push origin main:feature").status).toBe(0);
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    for (const c of ["GIT checkout main", "ENV git switch main", "GIT push origin x"]) {
      const r = guard(live.proj, live.home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
    }
  });

  it("the leading override still unlocks exactly the one capitalised command", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 GIT reset --hard").status).toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && SUDO GIT reset --hard").status).toBe(2);
  });
});

describe("run guard: a git top-level option's separate value is not the subcommand (#301)", () => {
  // Each row: [separate value, `=` form, separate value before a harmless
  // subcommand]. Before #301 only -C, -c, --git-dir, --work-tree,
  // --namespace and --config-env took the next word, so `HEAD` in
  // `git --attr-source HEAD reset --hard` read as the subcommand.
  const rows: Array<[separate: string, joined: string, harmless: string]> = [
    ["git --attr-source HEAD reset --hard", "git --attr-source=HEAD reset --hard", "git --attr-source HEAD status"],
    ["git --shallow-file x clean -fd", "git --shallow-file=x clean -fd", "git --shallow-file x clean -n"],
    ["git --super-prefix sub/ stash clear", "git --super-prefix=sub/ stash clear", "git --super-prefix sub/ stash list"],
    ["git --list-cmds main reset --hard", "git --list-cmds=main reset --hard", "git --list-cmds main status"],
    ["git --git-dir .git checkout -- .", "git --git-dir=.git checkout -- .", "git --git-dir .git checkout -- a.txt"],
    ["git --work-tree . restore .", "git --work-tree=. restore .", "git --work-tree . restore --staged ."],
    ["git --namespace ns push --force origin x", "git --namespace=ns push --force origin x", "git --namespace ns push origin x"],
    ["git --config-env core.editor=E reset --hard", "git --config-env=core.editor=E reset --hard",
      "git --config-env core.editor=E status"],
    ["git -C . --attr-source HEAD --no-pager reflog expire", "git -C . --attr-source=HEAD --no-pager reflog expire",
      "git -C . --attr-source HEAD --no-pager reflog"],
    ["SUDO GIT --attr-source HEAD reset --hard", "SUDO GIT --attr-source=HEAD reset --hard", "SUDO GIT --attr-source HEAD log"],
  ];

  it("each form is refused like the `=` form; the harmless subcommand behind the value passes", () => {
    const { proj, home } = fixture();
    for (const [separate, joined, harmless] of rows) {
      const r = guard(proj, home, separate);
      expect(r.status, separate).toBe(2);
      expect(r.stderr, separate).toContain("refused in every session");
      expect(guard(proj, home, joined).status, joined).toBe(2);
      expect(guard(proj, home, harmless).status, harmless).toBe(0);
    }
  });

  it("--exec-path takes a value only after `=`, so the word after it is the subcommand", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git --exec-path=/x reset --hard").status).toBe(2);
    expect(guard(proj, home, "git --exec-path reset --hard").status).toBe(2);
    expect(guard(proj, home, "git --exec-path=/x status").status).toBe(0);
  });

  it("a value-taking option before push and checkout still meets the ship gate and the live-run rule", () => {
    const bare = fixture(undefined, false);
    expect(guard(bare.proj, bare.home, "git --attr-source HEAD push origin main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "git --shallow-file x push origin HEAD:main").status).toBe(2);
    expect(guard(bare.proj, bare.home, "git --attr-source HEAD push origin main:feature").status).toBe(0);
    const live = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    for (const c of ["git --attr-source HEAD checkout main", "git --shallow-file x switch main"]) {
      const r = guard(live.proj, live.home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
    }
  });
});

describe("run guard: mid-run push needs manifest push authority (#252)", () => {
  const phases = [{ number: 3, name: "p3", estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } }];
  const granted = { granted: true, scope: "manifest-phases", grantedAt: "2026-10-01T00:00:00Z" };

  it("refuses git push while running without granted authority, naming the run", () => {
    const { proj, home } = fixture({
      status: "running", phases, pushAuth: { granted: false, scope: "manifest-phases" },
    });
    for (const c of ["git push", "git push origin main", "git -C . push -u origin run-branch"]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
      expect(r.stderr, c).toContain("push");
    }
  });

  it("refuses from the run's own worktree too -- that is where a run pushes", () => {
    const { proj, home } = fixture({
      status: "running", phases, pushAuth: { granted: false, scope: "manifest-phases" },
    });
    const wt = join(freshDir("cairn-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    expect(guard(proj, home, "git push origin runbranch", {}, wt).status).toBe(2);
  });

  it("allows git push while running when authority is granted and a manifest phase is in flight", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted, currentPhase: 3 });
    expect(guard(proj, home, "git push origin main").status).toBe(0);
  });

  it("granted authority over no phases, or a foreign scope, covers nothing", () => {
    const empty = fixture({ status: "running", phases: [], pushAuth: granted, currentPhase: 3 });
    expect(guard(empty.proj, empty.home, "git push").status).toBe(2);
    const wide = fixture({
      status: "running", phases, pushAuth: { ...granted, scope: "all" }, currentPhase: 3,
    });
    expect(guard(wide.proj, wide.home, "git push").status).toBe(2);
    const missing = fixture({ status: "running", phases, currentPhase: 3 });
    expect(guard(missing.proj, missing.home, "git push").status).toBe(2);
  });

  it("granted authority does not license a force-push", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted, currentPhase: 3 });
    expect(guard(proj, home, "git push --force-with-lease").status).toBe(2);
  });

  it("no running manifest: plain push passes; quoted mention passes mid-run", () => {
    for (const status of ["staged", "complete", "stopped"]) {
      const { proj, home } = fixture({ status, phases, pushAuth: { granted: false } });
      expect(guard(proj, home, "git push").status, status).toBe(0);
    }
    const { proj, home } = fixture({ status: "running", phases, pushAuth: { granted: false } });
    expect(guard(proj, home, 'git commit -m "git push later"').status).toBe(0);
  });
});

describe("run guard: push authority needs the phase in flight (#260)", () => {
  const phase = (number: number) =>
    ({ number, name: `p${number}`, estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } });
  const phases = [phase(3), phase(4)];
  const granted = { granted: true, scope: "manifest-phases", grantedAt: "2026-10-01T00:00:00Z" };

  it("a running manifest with no currentPhase refuses pushes -- older manifests included", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted });
    const r = guard(proj, home, "git push origin main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
    expect(r.stderr).toContain("set_phase");
  });

  it("a currentPhase outside the manifest's phases refuses, naming it", () => {
    const { proj, home } = fixture({ status: "running", phases, pushAuth: granted, currentPhase: 9 });
    const r = guard(proj, home, "git push origin main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("phase 9");
    const odd = fixture({ status: "running", phases, pushAuth: granted, currentPhase: "3" });
    expect(guard(odd.proj, odd.home, "git push origin main").status).toBe(2);
  });

  it("each manifest phase in flight carries the grant", () => {
    for (const currentPhase of [3, 4]) {
      const { proj, home } = fixture({ status: "running", phases, pushAuth: granted, currentPhase });
      expect(guard(proj, home, "git push origin main").status, String(currentPhase)).toBe(0);
    }
  });

  it("a phase in flight does not grant what staging withheld", () => {
    const { proj, home } = fixture({
      status: "running", phases, pushAuth: { granted: false, scope: "manifest-phases" }, currentPhase: 3,
    });
    expect(guard(proj, home, "git push origin main").status).toBe(2);
  });
});

describe("run guard: default-branch push needs a clean drift stamp (#251)", () => {
  /** Unstamped repo with a `feature` branch one commit ahead of main. */
  function branched(): { proj: string; home: string } {
    const f = fixture(undefined, false);
    git(f.proj, "checkout", "-q", "-b", "feature");
    writeFileSync(join(f.proj, "f.txt"), "f\n");
    git(f.proj, "add", "f.txt");
    git(f.proj, "commit", "-q", "-m", "feature", "--no-gpg-sign");
    git(f.proj, "checkout", "-q", "main");
    return f;
  }

  it("missing stamp: every default-branch push shape is refused, naming ship and the owner's ways to approve", () => {
    const { proj, home } = branched();
    for (const c of [
      "git push",
      "git push origin",
      "git push origin main",
      "git push -u origin main",
      "git push origin HEAD",
      "git push origin HEAD:main",
      "git push origin feature:refs/heads/main",
      "git push origin master",
      "git push --all origin",
      "git push origin -- main",
      'echo "$(git push origin main)"',
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("/cairn:ship");
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_UNSHIPPED_PUSH");
    }
  });

  it("stale head or a dirty stamp is refused", () => {
    const { proj, home } = branched();
    stamp(proj, home, { head: git(proj, "rev-parse", "feature") });
    const stale = guard(proj, home, "git push origin main");
    expect(stale.status).toBe(2);
    expect(stale.stderr).toContain("not the commit being pushed");
    stamp(proj, home, { clean: false });
    const dirty = guard(proj, home, "git push origin main");
    expect(dirty.status).toBe(2);
    expect(dirty.stderr).toContain("flagged drift");
  });

  it("a clean stamp at the pushed commit passes -- and checks the source, not just HEAD", () => {
    const { proj, home } = branched();
    stamp(proj, home);
    for (const c of ["git push", "git push origin main", "git push origin HEAD:main"]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
    // the stamp is for main's tip; pushing feature onto main is another commit
    expect(guard(proj, home, "git push origin feature:main").status).toBe(2);
  });

  it("pushes to any other branch, and tags, are untouched with no stamp", () => {
    const { proj, home } = branched();
    for (const c of [
      "git push origin feature",
      "git push -u origin feature",
      "git push origin main:feature",
      "git push origin v1.0.0",
      "git push --tags",
      "git push origin --tags",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
    git(proj, "checkout", "-q", "feature");
    expect(guard(proj, home, "git push").status).toBe(0);
    expect(guard(proj, home, "git push origin HEAD").status).toBe(0);
  });

  it("the remote's HEAD branch counts as default when git knows it", () => {
    const { proj, home } = branched();
    git(proj, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(proj, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(guard(proj, home, "git push origin feature:trunk").status).toBe(2);
  });

  it("CAIRN_ALLOW_UNSHIPPED_PUSH=1 overrides from env or as the leading assignment only", () => {
    const { proj, home } = branched();
    expect(guard(proj, home, "git push origin main", { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status)
      .toBe(0);
    expect(guard(proj, home, "CAIRN_ALLOW_UNSHIPPED_PUSH=1 git push origin main").status).toBe(0);
    expect(guard(proj, home, "git push origin main -o CAIRN_ALLOW_UNSHIPPED_PUSH=1").status)
      .toBe(2);
  });

  it("the live-run push-authority rule still applies on top of a clean stamp", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = guard(proj, home, "git push origin main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
    expect(guard(proj, home, "git push origin main", { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status)
      .toBe(2);
  });

  it("a shortened --all or --branches pushes every branch, the default one included", () => {
    const { proj, home } = branched();
    git(proj, "checkout", "-q", "feature");
    for (const c of ["git push --al origin", "git push --bra origin", "git push --branches origin"]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("/cairn:ship");
    }
  });

  it("a stamp dir that can't be read refuses (#299); so does a corrupt stamp", () => {
    const { proj, home } = branched();
    writeFileSync(join(home, "ship-gate"), "a file where the dir should be");
    expect(guard(proj, home, "git push origin main").status).toBe(2);
    rmSync(join(home, "ship-gate"));
    mkdirSync(join(home, "ship-gate"));
    writeFileSync(join(home, "ship-gate", `${projKey(proj)}.json`), "{ nope");
    expect(guard(proj, home, "git push origin main").status).toBe(2);
  });
});

describe("run guard: glob, matching and push-everything pushes meet the ship gate (#297)", () => {
  /**
   * Unstamped repo checked out on `feature`, one commit ahead of main, plus
   * `xn` at the same commit -- so a bare push lands nothing on main by itself.
   */
  function onFeature(): { proj: string; home: string } {
    const f = fixture(undefined, false);
    git(f.proj, "checkout", "-q", "-b", "feature");
    writeFileSync(join(f.proj, "f.txt"), "f\n");
    git(f.proj, "add", "f.txt");
    git(f.proj, "commit", "-q", "-m", "feature", "--no-gpg-sign");
    git(f.proj, "branch", "xn");
    return f;
  }

  // The host's own push.default must not decide these -- the hook's git
  // reads only the fixture repo's config here
  const push = (proj: string, home: string, command: string) =>
    guard(proj, home, command, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" });

  // Each row: [lands main with no drift check, its ordinary feature-branch
  // neighbour]. Before #297 the destination was compared literally, so a
  // glob (`*` reads as no branch) and the bare `:` (an empty destination)
  // carried local main to the remote's main with no stamp at all.
  const rows: Array<[lands: string, feature: string]> = [
    ["git push origin 'refs/heads/*:refs/heads/*'", "git push origin 'refs/heads/feat*:refs/heads/feat*'"],
    ["git push origin refs/heads/*:refs/heads/*", "git push origin refs/heads/feature:refs/heads/feature"],
    ["git push origin 'refs/heads/*'", "git push origin 'refs/heads/feat*'"],
    ["git push origin 'refs/heads/ma*:refs/heads/ma*'", "git push origin 'refs/tags/*:refs/tags/*'"],
    ["git push origin 'ma*:ma*'", "git push origin 'fe*:fe*'"],
    ["git push origin '*:*'", "git push origin feature:feature"],
    ["git push origin :", "git push origin feature"],
    ["git push origin -- :", "git push origin -- feature"],
    ["git push --all origin", "git push --tags origin"],
    ["git push --branches origin", "git push -u origin feature"],
    ["git -c push.default=matching push origin", "git -c push.default=matching push origin feature"],
    ["git -c push.default=matching push", "git -c push.default=current push"],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push",
      "GIT_TRACE=0 git push"],
    ["MODE=matching git --config-env=push.default=MODE push origin", "git push origin"],
    // config set earlier in the same line: nothing has run when the guard reads it
    ["git config push.default matching && git push", "git config user.name x && git push"],
    ["git config set push.default matching; git push origin", "git config --get user.name; git push origin"],
    ["export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching; git push",
      "export GIT_TRACE=0; git push"],
    ["bash -c 'git config push.default matching && git push'", "bash -c 'git status && git push'"],
  ];

  it("each lands main without a drift check and is refused; its feature-branch neighbour passes", () => {
    const { proj, home } = onFeature();
    for (const [lands, feature] of rows) {
      const r = push(proj, home, lands);
      expect(r.status, lands).toBe(2);
      expect(r.stderr, lands).toContain("/cairn:ship");
      expectOwnerTail(r.stderr, lands, "CAIRN_ALLOW_UNSHIPPED_PUSH");
      expect(push(proj, home, feature).status, feature).toBe(0);
    }
  });

  it("push.default=matching in the repo's config makes a bare push one of them", () => {
    const { proj, home } = onFeature();
    expect(push(proj, home, "git push").status).toBe(0);
    git(proj, "config", "push.default", "matching");
    expect(push(proj, home, "git push").status).toBe(2);
    expect(push(proj, home, "git push origin").status).toBe(2);
    expect(push(proj, home, "git push origin feature").status).toBe(0);
    expect(push(proj, home, "git push --tags").status).toBe(0);
  });

  it("a clean stamp at main's tip lets them through -- they land the commit it checked", () => {
    const { proj, home } = onFeature();
    stamp(proj, home, { head: git(proj, "rev-parse", "main") });
    for (const c of [
      "git push origin 'refs/heads/*:refs/heads/*'", "git push origin :", "git push --all origin",
      "git -c push.default=matching push",
    ]) {
      expect(push(proj, home, c).status, c).toBe(0);
    }
  });

  it("a glob landing another branch on main is checked against that branch's commit", () => {
    const { proj, home } = onFeature();
    stamp(proj, home, { head: git(proj, "rev-parse", "main") });
    // refs/heads/x* maps xn onto refs/heads/mai* + "n" -- main
    const r = push(proj, home, "git push origin 'refs/heads/x*:refs/heads/mai*'");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not the commit being pushed");
    expect(push(proj, home, "git push origin 'refs/heads/x*:refs/heads/y*'").status).toBe(0);
  });

  it("a tag spelled like the default branch can't stand in for the branch an --all push lands", () => {
    const { proj, home } = onFeature();
    git(proj, "tag", "main", "main");
    stamp(proj, home, { head: git(proj, "rev-parse", "refs/tags/main") });
    git(proj, "checkout", "-q", "main");
    git(proj, "merge", "-q", "--ff-only", "feature");
    git(proj, "checkout", "-q", "feature");
    const r = push(proj, home, "git push --all origin");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not the commit being pushed");
  });

  it("mid-run, a glob or matching push still needs the run's push authority", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    for (const c of ["git push origin 'refs/heads/*:refs/heads/*'", "git push origin :"]) {
      const r = push(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
    }
  });
});

describe("run guard: short destinations and the push settings meet the ship gate (#302)", () => {
  /**
   * Unstamped repo checked out on `feature`, one commit ahead of main, with
   * `origin` and `backup` remotes that exist only as config -- nothing here
   * pushes. Each row was confirmed by a dry-run push to a throwaway remote.
   */
  function onFeature(): { proj: string; home: string } {
    const f = fixture(undefined, false);
    git(f.proj, "checkout", "-q", "-b", "feature");
    writeFileSync(join(f.proj, "f.txt"), "f\n");
    git(f.proj, "add", "f.txt");
    git(f.proj, "commit", "-q", "-m", "feature", "--no-gpg-sign");
    git(f.proj, "remote", "add", "origin", join(f.proj, "no-such-remote.git"));
    git(f.proj, "remote", "add", "backup", join(f.proj, "no-such-backup.git"));
    return f;
  }

  /** feature tracks origin/main, the way `git checkout -b feature origin/main` leaves it. */
  function tracksMain(proj: string): void {
    git(proj, "config", "branch.feature.remote", "origin");
    git(proj, "config", "branch.feature.merge", "refs/heads/main");
  }

  // The host's own push settings must not decide these
  const push = (proj: string, home: string, command: string) =>
    guard(proj, home, command, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" });

  /** Each command exits 2 at the ship gate. */
  function expectGated(proj: string, home: string, commands: string[]): void {
    for (const c of commands) {
      const r = push(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("/cairn:ship");
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_UNSHIPPED_PUSH");
    }
  }

  /** Each command exits 0. */
  function expectPasses(proj: string, home: string, commands: string[]): void {
    for (const c of commands) expect(push(proj, home, c).status, c).toBe(0);
  }

  it("each short spelling of the default branch is refused; its feature-branch neighbour passes", () => {
    const { proj, home } = onFeature();
    // Each row: [lands main with no drift check, the same spelling landing a feature branch].
    // Before #302 only `main` and `refs/heads/main` were read as main.
    const rows: Array<[lands: string, feature: string]> = [
      ["git push origin feature:heads/main", "git push origin feature:heads/feature"],
      ["git push origin HEAD:heads/main", "git push origin HEAD:heads/feature"],
      ["git push origin heads/main", "git push origin heads/feature"],
      ["git push origin refs/heads/main", "git push origin refs/heads/feature"],
      ["git push origin feature:heads/master", "git push origin feature:heads/mainline"],
      ["git push origin -- heads/main", "git push origin -- heads/feature"],
      ["git push origin 'refs/heads/*:heads/*'", "git push origin 'refs/heads/feat*:heads/feat*'"],
      ["SUDO GIT push origin feature:heads/main", "SUDO GIT push origin feature:heads/feature"],
    ];
    for (const [lands, feature] of rows) {
      expectGated(proj, home, [lands]);
      expectPasses(proj, home, [feature]);
    }
  });

  it("a short destination that deletes the default branch is the table's refusal", () => {
    const { proj, home } = onFeature();
    for (const c of ["git push origin :heads/main", "git push origin --delete heads/main"]) {
      const r = push(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("deleting the default branch");
    }
    expectPasses(proj, home, ["git push origin :heads/feature", "git push origin --delete heads/feature"]);
  });

  it("a symbolic branch pointing at main lands on main, the way git resolves it", () => {
    const { proj, home } = onFeature();
    git(proj, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    expectGated(proj, home, ["git push origin alias", "git push origin heads/alias"]);
    expectPasses(proj, home, ["git push origin alias:other", "git push origin feature"]);
  });

  it("a clean stamp at main's tip lets a short spelling through; another commit is refused", () => {
    const { proj, home } = onFeature();
    stamp(proj, home, { head: git(proj, "rev-parse", "main") });
    expectPasses(proj, home, ["git push origin heads/main", "git push origin main:heads/main"]);
    const r = push(proj, home, "git push origin feature:heads/main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not the commit being pushed");
  });

  it("push.default=upstream or tracking sends a bare push, or the branch typed alone, to its upstream", () => {
    for (const mode of ["upstream", "tracking"]) {
      const { proj, home } = onFeature();
      git(proj, "config", "push.default", mode);
      tracksMain(proj);
      expectGated(proj, home, [
        "git push",
        "git push origin",
        "git push origin feature",
        "git push origin heads/feature",
        "git push origin refs/heads/feature",
        "git push -u origin feature",
      ]);
      // git maps a branch it finds by name, never HEAD; an explicit
      // destination, or tags alone, aren't mapped at all
      expectPasses(proj, home, ["git push origin HEAD", "git push origin feature:feature", "git push --tags"]);
      // a short upstream name is main too
      git(proj, "config", "branch.feature.merge", "main");
      expectGated(proj, home, ["git push", "git push origin feature"]);
      // ...and a branch tracking another branch is its own neighbour
      git(proj, "config", "branch.feature.merge", "refs/heads/feature");
      expectPasses(proj, home, ["git push", "git push origin", "git push origin feature"]);
    }
  });

  it("the command's own -c counts; simple and current keep the branch's name", () => {
    const { proj, home } = onFeature();
    tracksMain(proj);
    expectGated(proj, home, [
      "git -c push.default=upstream push",
      "git -c push.default=tracking push origin feature",
      "git -c Push.Default=upstream push origin",
    ]);
    // simple refuses a branch tracking another name itself; current pushes it to its own name
    expectPasses(proj, home, ["git push", "git push origin feature", "git -c push.default=current push"]);
    // an upstream set on the command line is read the same way
    git(proj, "config", "--unset", "branch.feature.merge");
    git(proj, "config", "push.default", "upstream");
    expectGated(proj, home, ["git -c branch.feature.merge=refs/heads/main push"]);
    expectPasses(proj, home, ["git -c branch.feature.merge=refs/heads/other push"]);
  });

  it("a clean stamp at the pushed commit lets an upstream push through; another commit is refused", () => {
    const { proj, home } = onFeature();
    git(proj, "config", "push.default", "upstream");
    tracksMain(proj);
    stamp(proj, home, { head: git(proj, "rev-parse", "feature") });
    expectPasses(proj, home, ["git push", "git push origin feature"]);
    stamp(proj, home, { head: git(proj, "rev-parse", "main") });
    const r = push(proj, home, "git push");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not the commit being pushed");
  });

  it("a remote's own push refspecs are what a bare push pushes, and map a branch typed alone", () => {
    const { proj, home } = onFeature();
    git(proj, "config", "remote.origin.push", "refs/heads/feature:refs/heads/main");
    expectGated(proj, home, [
      "git push",
      "git push origin",
      "git push origin feature",
      "git push origin heads/feature",
      "git push --repo=origin",
    ]);
    // an explicit destination, tags alone, or a remote without the setting, push as typed
    expectPasses(proj, home, ["git push origin feature:feature", "git push --tags", "git push backup",
      "git push backup feature", "git push --repo=backup"]);
    // the bare push follows the branch's remote: backup has the setting, origin doesn't
    git(proj, "config", "--unset", "remote.origin.push");
    git(proj, "config", "remote.backup.push", "refs/heads/feature:refs/heads/main");
    expectPasses(proj, home, ["git push", "git push origin feature"]);
    git(proj, "config", "branch.feature.pushRemote", "backup");
    expectGated(proj, home, ["git push", "git push backup feature"]);
    // a glob maps through its `*`: refs/heads/x* sends xn to refs/heads/mai* + "n"
    const g = onFeature();
    git(g.proj, "branch", "xn");
    git(g.proj, "config", "remote.origin.push", "refs/heads/x*:refs/heads/mai*");
    expectGated(g.proj, g.home, ["git push origin xn"]);
    expectPasses(g.proj, g.home, ["git push origin feature"]);
    // ...and set on the command line it is read the same way
    const c = onFeature();
    expectGated(c.proj, c.home, ["git -c remote.origin.push=refs/heads/feature:refs/heads/main push"]);
    expectPasses(c.proj, c.home, ["git -c remote.origin.push=refs/heads/feature:refs/heads/feature push"]);
  });

  it("settings the line changes first, or can't show, refuse what they decide -- even under a clean stamp", () => {
    const { proj, home } = onFeature();
    stamp(proj, home, { head: git(proj, "rev-parse", "main") });
    // Each row: [follows settings the guard can't read, its neighbour]
    const rows: Array<[unknown: string, neighbour: string]> = [
      ["git config push.default upstream && git push", "git config user.name x && git push"],
      ["git config branch.feature.merge refs/heads/main && git push", "git config core.pager cat && git push"],
      ["git config remote.origin.push refs/heads/feature:refs/heads/main; git push origin feature",
        "git config user.email x; git push origin feature"],
      ["git branch -u origin/main && git push", "git branch -v && git push"],
      ["git branch --set-upstream-to=origin/main && git push origin feature", "git branch --list && git push origin feature"],
      ["git remote rename backup origin && git push", "git remote -v && git push"],
      ["git -c include.path=elsewhere.cfg push", "git -c user.name=x push"],
      // HOME and XDG_CONFIG_HOME move the user config git reads
      ["HOME=/tmp/elsewhere git push origin feature", "LANG=C git push origin feature"],
      ["export XDG_CONFIG_HOME=/tmp/elsewhere; git push", "export PAGER=cat; git push"],
      ["E=upstream git --config-env=push.default=E push origin feature", "git --config-env=core.pager=E push origin feature"],
    ];
    for (const [unknown, neighbour] of rows) {
      const r = push(proj, home, unknown);
      expect(r.status, unknown).toBe(2);
      expect(r.stderr, unknown).toContain("may land on the default branch");
      expect(r.stderr, unknown).toContain("command of its own");
      expectOwnerTail(r.stderr, unknown, "CAIRN_ALLOW_UNSHIPPED_PUSH");
      expect(push(proj, home, neighbour).status, neighbour).toBe(0);
    }
    // an explicit destination doesn't follow the settings, so it is checked as typed
    expectPasses(proj, home, ["git config push.default upstream && git push origin main:main"]);
    expectGated(proj, home, ["git config push.default upstream && git push origin feature:main"]);
  });

  it("mid-run, an upstream push still needs the run's push authority", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = push(proj, home, "git -c push.default=upstream push origin heads/main");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
  });
});

describe("run guard: a stamp or run list that exists but can't be read refuses (#299)", () => {
  // chmod takes no read access from root, and Windows has no mode bits
  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;

  /** Runs `fn` with `path` chmodded to 000, restoring `back` after so cleanup can remove it. */
  function locked<T>(path: string, back: number, fn: () => T): T {
    chmodSync(path, 0o000);
    try {
      return fn();
    } finally {
      chmodSync(path, back);
    }
  }

  /** The refusal names what can't be read and the owner's ways, never an override prefix. */
  function expectUnreadable(r: { status: number | null; stderr: string }, label: string,
    code: string, env?: string): void {
    expect(r.status, label).toBe(2);
    expect(r.stderr, label).toMatch(/can't be read|can't read/);
    expect(r.stderr, label).toContain(code);
    expect(r.stderr, label).toContain("restore read access");
    expectOwnerTail(r.stderr, label, env);
  }

  it("a ship-gate path that can't be read refuses a default-branch push; other pushes pass", () => {
    const { proj, home } = fixture(undefined, false);
    writeFileSync(join(home, "ship-gate"), "a file where the dir should be");
    const r = guard(proj, home, "git push origin main");
    expectUnreadable(r, "push main", "ENOTDIR", "CAIRN_ALLOW_UNSHIPPED_PUSH");
    expect(r.stderr).not.toContain("/cairn:ship");
    expect(guard(proj, home, "git push origin feature").status).toBe(0);
    expect(guard(proj, home, "git push origin main", { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status).toBe(0);
  });

  it.skipIf(!canChmod)("a stamp folder or stamp file chmodded unreadable refuses; restored, it passes", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "git push origin main").status).toBe(0);
    locked(join(home, "ship-gate"), 0o755, () => {
      expectUnreadable(guard(proj, home, "git push origin main"), "dir", "EACCES", "CAIRN_ALLOW_UNSHIPPED_PUSH");
      expect(guard(proj, home, "git push origin feature").status).toBe(0);
    });
    locked(join(home, "ship-gate", `${projKey(proj)}.json`), 0o644, () => {
      expectUnreadable(guard(proj, home, "git push origin main"), "file", "EACCES", "CAIRN_ALLOW_UNSHIPPED_PUSH");
    });
    expect(guard(proj, home, "git push origin main").status).toBe(0);
  });

  it("a runs folder that can't be read refuses every push, with no override to name", () => {
    const { proj, home } = fixture();
    writeFileSync(join(home, "runs"), "a file where the dir should be");
    for (const c of ["git push origin feature", "git push origin main", "git push"]) {
      const r = guard(proj, home, c);
      expectUnreadable(r, c, "ENOTDIR");
      expect(r.stderr, c).toContain("batch-run list");
      expect(r.stderr, c).not.toContain("CAIRN_");
    }
    // ...and the session-wide ship-gate escape doesn't reach it
    expect(guard(proj, home, "git push origin feature", { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status).toBe(2);
    expect(guard(proj, home, "git status").status).toBe(0);
  });

  it("a runs folder that can't be read refuses checkout and switch of the owner's checkout only", () => {
    const { proj, home } = fixture();
    writeFileSync(join(home, "runs"), "a file where the dir should be");
    for (const c of ["git checkout main", "git switch -c x", "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard"]) {
      const r = guard(proj, home, c);
      expectUnreadable(r, c, "ENOTDIR");
      expect(r.stderr, c).not.toContain("CAIRN_RUN_OK");
    }
    expect(guard(proj, home, "CAIRN_RUN_OK=1 git checkout main").status).toBe(0);
    const wt = join(freshDir("cairn-runguard-wt-"), "tree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "runbranch", wt], { cwd: proj });
    expect(guard(proj, home, "git switch main", {}, wt).status).toBe(0);
  });

  it.skipIf(!canChmod)("a runs folder, manifest or cairn home chmodded unreadable refuses the push", () => {
    const { proj, home } = fixture({ status: "complete", phases: [], pushAuth: { granted: false } });
    expect(guard(proj, home, "git push origin feature").status).toBe(0);
    locked(join(home, "runs"), 0o755, () => {
      expectUnreadable(guard(proj, home, "git push origin feature"), "runs dir", "EACCES");
    });
    locked(join(home, "runs", `${projKey(proj)}-run-x.json`), 0o644, () => {
      expectUnreadable(guard(proj, home, "git push origin feature"), "manifest", "EACCES");
    });
    // the audit's shape: the whole cairn home locked takes both gates' files away
    locked(home, 0o755, () => {
      expectUnreadable(guard(proj, home, "git push origin feature"), "home, feature", "EACCES");
      expectUnreadable(guard(proj, home, "git push origin main"), "home, main", "EACCES",
        "CAIRN_ALLOW_UNSHIPPED_PUSH");
    });
    expect(guard(proj, home, "git push origin feature").status).toBe(0);
  });

  it("a missing stamp or runs folder keeps its meaning; a corrupt manifest is still no live run", () => {
    const { proj, home } = fixture(undefined, false);
    const none = guard(proj, home, "git push origin main");
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("no drift check has been recorded");
    expect(guard(proj, home, "git push origin feature").status).toBe(0);
    mkdirSync(join(home, "runs"));
    writeFileSync(join(home, "runs", `${projKey(proj)}-broken.json`), "{ nope");
    expect(guard(proj, home, "git push origin feature").status).toBe(0);
    expect(guard(proj, home, "git checkout main").status).toBe(0);
  });
});

describe("run guard: a commit or ref move earlier in the line can't slip past the ship gate (#305)", () => {
  /**
   * Repo on main with a `feature` branch one commit ahead, and a clean
   * stamp at main's tip -- so a push of main on its own passes, and only
   * what runs ahead of it on the line can change what lands.
   */
  function stampedMain(): { proj: string; home: string } {
    const f = fixture(undefined, false);
    git(f.proj, "checkout", "-q", "-b", "feature");
    writeFileSync(join(f.proj, "f.txt"), "f\n");
    git(f.proj, "add", "f.txt");
    git(f.proj, "commit", "-q", "-m", "feature", "--no-gpg-sign");
    git(f.proj, "checkout", "-q", "main");
    stamp(f.proj, f.home, { head: git(f.proj, "rev-parse", "main") });
    return f;
  }

  // The host's own push settings must not decide these
  const push = (proj: string, home: string, command: string, env: Record<string, string> = {}) =>
    guard(proj, home, command, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", ...env });

  // Each row: [a commit or ref move runs first, then the push -- the push on its own].
  // Before #305 the guard resolved the pushed commit before the line ran, so
  // each one passed under the clean stamp and landed an unchecked commit.
  const rows: Array<[moved: string, alone: string]> = [
    ["git commit --allow-empty -m x && git push origin HEAD:main", "git push origin HEAD:main"],
    ["git commit -am fix && git push", "git push"],
    ["git merge feature && git push origin main", "git push origin main"],
    ["git branch -f main feature && git push origin main", "git push origin main"],
    ["git reset --soft HEAD~1; git push origin main", "git push origin main"],
    ["git cherry-pick feature && git push origin main", "git push origin main"],
    ["git rebase feature && git push origin main", "git push origin main"],
    ["git revert --no-edit HEAD && git push origin main", "git push origin main"],
    ["git pull && git push origin main", "git push origin main"],
    ["git fetch origin && git push origin FETCH_HEAD:main", "git push origin main"],
    ["git am fix.patch && git push origin main", "git push origin main"],
    ["git update-ref refs/heads/main feature && git push origin main", "git push origin main"],
    ["git checkout feature && git push origin HEAD:main", "git push origin HEAD:main"],
    ["git checkout -B main feature && git push origin main", "git push origin main"],
    ["git switch -C main feature && git push origin main", "git push origin main"],
    ["git stash pop && git push origin main", "git push origin main"],
    ["git tag -f v1 feature && git push origin v1:main", "git push origin main"],
    ["git tag v2 feature && git push origin v2:main", "git push origin main"],
    ["git push origin feature && git push origin origin/feature:main", "git push origin main"],
    // an alias, a wrapper, a nested shell, another program, a write into the ref store
    ["git ci -m x && git push origin main", "git push origin main"],
    ["sudo -u me git commit -am x && git push origin main", "git push origin main"],
    ["bash -c 'git commit -am x' && git push origin main", "git push origin main"],
    ["npm version patch && git push origin main", "git push origin main"],
    ["echo abc > .git/refs/heads/main && git push origin main", "git push origin main"],
    // order the guard can't trust: a substitution, a loop, a function, the background
    ['echo "$(git commit -am x)" && git push origin main', "git push origin main"],
    ["for i in 1 2; do git push origin main; git commit --allow-empty -m x; done", "git push origin main"],
    ["f() { git push origin main; }; git commit --allow-empty -m x; f", "git push origin main"],
    ["git push origin main & git commit --allow-empty -m x", "git push origin main"],
  ];

  it("each is refused even under a clean stamp, saying push alone; the push on its own passes", () => {
    const { proj, home } = stampedMain();
    for (const [moved, alone] of rows) {
      const r = push(proj, home, moved);
      expect(r.status, moved).toBe(2);
      expect(r.stderr, moved).toContain("earlier command on this line");
      expect(r.stderr, moved).toContain("push as its own step");
      expectOwnerTail(r.stderr, moved, "CAIRN_ALLOW_UNSHIPPED_PUSH");
      expect(push(proj, home, alone).status, alone).toBe(0);
    }
  });

  it("read-only commands before the push, and anything after it, keep today's answer", () => {
    const { proj, home } = stampedMain();
    for (const c of [
      "git status && git push origin main",
      "git log --oneline -3; git push origin main",
      "git diff --stat 2>&1 && git push origin main",
      "git rev-parse HEAD >/dev/null; git push origin main",
      "git add -A && git push origin main",
      "git branch -a && git branch --list 'f*' && git tag -l && git push origin main",
      "git remote -v && git stash list && git push origin main",
      "git config user.name x && git push origin main",
      "cd . && echo pushing && git push origin main",
      "git push origin main && git commit --allow-empty -m next",
      "git push origin main; git checkout -b next",
      "git push origin main && git tag v3",
    ]) {
      expect(push(proj, home, c).status, c).toBe(0);
    }
  });

  it("a push the gate never checks keeps today's answer, and its override still lifts it", () => {
    const { proj, home } = stampedMain();
    for (const c of [
      "git commit --allow-empty -m x && git push origin feature",
      "git merge main && git push -u origin feature",
      "git tag v1 && git push origin v1",
    ]) {
      expect(push(proj, home, c).status, c).toBe(0);
    }
    const moved = "git commit --allow-empty -m x && git push origin main";
    expect(push(proj, home, moved, { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status).toBe(0);
    expect(push(proj, home, `git commit --allow-empty -m x && CAIRN_ALLOW_UNSHIPPED_PUSH=1 ${moved.split("&& ")[1]}`)
      .status).toBe(0);
    // ...and with no stamp at all it is still refused, by whichever reason comes first
    rmSync(join(home, "ship-gate"), { recursive: true });
    expect(push(proj, home, moved).status).toBe(2);
  });

  it("mid-run, a push with a commit ahead of it is refused even with authority; on its own it passes", () => {
    const phases = [{ number: 3, name: "p3", estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } }];
    const pushAuth = { granted: true, scope: "manifest-phases", grantedAt: "2026-10-01T00:00:00Z" };
    const { proj, home } = fixture({ status: "running", phases, pushAuth, currentPhase: 3 });
    for (const c of [
      "git commit -am x && git push origin runbranch",
      "git rebase main; git push -u origin runbranch",
      "make release && git push origin runbranch",
    ]) {
      const r = push(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain("run-x");
      expect(r.stderr, c).toContain("push as its own step");
      expectOwnerTail(r.stderr, c);
    }
    for (const c of [
      "git push origin runbranch",
      "git status && git push origin runbranch",
      "git push origin runbranch && git commit --allow-empty -m next",
    ]) {
      expect(push(proj, home, c).status, c).toBe(0);
    }
  });
});

describe("run guard: each git command is judged in the repository it acts on (#306)", () => {
  /**
   * Side-by-side folders under one root: the project on main with a clean
   * stamp at its tip and a `sub` folder, `other` -- a clone one commit
   * ahead -- and two linked worktrees of the project: `wt` on runbranch,
   * one commit ahead, and `wt2` on side, at main's tip.
   */
  function repos(manifest?: Record<string, unknown>) {
    const root = freshDir("cairn-runguard-repos-");
    const proj = join(root, "proj");
    const other = join(root, "other");
    const wt = join(root, "wt");
    const wt2 = join(root, "wt2");
    execFileSync("git", ["init", "-q", "-b", "main", proj]);
    git(proj, "config", "user.email", "t@t");
    git(proj, "config", "user.name", "t");
    writeFileSync(join(proj, "seed.txt"), "seed\n");
    git(proj, "add", "seed.txt");
    git(proj, "commit", "-q", "-m", "init", "--no-gpg-sign");
    mkdirSync(join(proj, "sub"));
    execFileSync("git", ["clone", "-q", proj, other]);
    git(other, "commit", "-q", "--allow-empty", "-m", "other", "--no-gpg-sign", "--author", "t <t@t>");
    git(proj, "worktree", "add", "-q", "-b", "runbranch", wt);
    git(wt, "commit", "-q", "--allow-empty", "-m", "wt", "--no-gpg-sign");
    git(proj, "worktree", "add", "-q", "-b", "side", wt2);
    const home = freshDir("cairn-runguard-home-");
    if (manifest) {
      mkdirSync(join(home, "runs"), { recursive: true });
      writeFileSync(join(home, "runs", `${projKey(proj)}-run-x.json`),
        JSON.stringify({ version: 1, runId: "run-x", ...manifest }));
      breakerOff(proj);
    }
    stamp(proj, home);
    return { root, proj, other, wt, wt2, home };
  }

  // The host's own push settings, and any GIT_DIR the host runs under, must not decide these
  const at = (r: { proj: string; home: string }, command: string, cwd = r.proj, env: Record<string, string> = {}) =>
    guard(r.proj, r.home, command, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", ...env }, cwd);

  it("a push leaving another repository needs that repository's own stamp; each shape is refused like its -C pair", () => {
    const r = repos();
    const P = "git push origin main";
    // Each row: [where the line sends git, the -C form refused since before #306].
    // Before #306 only -C moved the guard, so each left form read the
    // project's main -- the stamped commit -- while git pushed other's.
    const rows: Array<[form: string, pair: string]> = [
      [`cd ${r.other} && ${P}`, `git -C ${r.other} push origin main`],
      [`cd ../other && ${P}`, "git -C ../other push origin main"],
      [`pushd ../other; ${P}`, "git -C ../other push origin main"],
      [`CDPATH=${r.root} cd other && ${P}`, "git -C ../other push origin main"],
      [`env -C ${r.other} ${P}`, `git -C ${r.other} push origin main`],
      [`GIT_DIR=${r.other}/.git ${P}`, `git -C ${r.other} push origin main`],
      [`GIT_DIR=../other/.git ${P}`, "git -C ../other push origin main"],
      [`git --git-dir=${r.other}/.git push origin main`, `git -C ${r.other} push origin main`],
      ["git --git-dir ../other/.git push origin main", "git -C ../other push origin main"],
      [`export GIT_DIR=${r.other}/.git; ${P}`, `git -C ${r.other} push origin main`],
      [`GIT_DIR=${r.other}/.git bash -c '${P}'`, `bash -c 'git -C ${r.other} push origin main'`],
    ];
    for (const [form, pair] of rows) {
      for (const c of [form, pair]) {
        const res = at(r, c);
        expect(res.status, c).toBe(2);
        expect(res.stderr, c).toContain("another repository");
        expectOwnerTail(res.stderr, c, "CAIRN_ALLOW_UNSHIPPED_PUSH");
      }
    }
    // ...and with its own clean stamp, that repository's push passes
    mkdirSync(join(r.home, "ship-gate"), { recursive: true });
    const real = realpathSync(r.other);
    writeFileSync(join(r.home, "ship-gate", `${projKey(real)}.json`), JSON.stringify({
      head: git(r.other, "rev-parse", "main"), clean: true, at: "2026-10-02T00:00:00Z" }));
    expect(at(r, `cd ${r.other} && ${P}`).status).toBe(0);
    expect(at(r, `GIT_DIR=${r.other}/.git ${P}`).status).toBe(0);
  });

  it("a linked worktree is the project's repository, with its own HEAD checked against the project's stamp", () => {
    const r = repos();
    for (const c of [`cd ${r.wt} && git push origin HEAD:main`, `git -C ${r.wt} push origin HEAD:main`,
      "cd ../wt && git push origin HEAD:main"]) {
      const res = at(r, c);
      expect(res.status, c).toBe(2);
      expect(res.stderr, c).toContain("not the commit being pushed");
    }
    // wt2 sits at main's tip -- the commit the stamp saw
    for (const c of [`cd ${r.wt2} && git push origin HEAD:main`, `git -C ${r.wt2} push origin HEAD:main`]) {
      expect(at(r, c).status, c).toBe(0);
    }
  });

  it("the project's own push passes however the line names it", () => {
    const r = repos();
    for (const c of [
      "git push origin main",
      "cd sub && git push origin main",
      `cd ${r.proj} && git push origin main`,
      `GIT_DIR=${r.proj}/.git git push origin main`,
      "git --git-dir=.git push origin main",
      "cd /nonexistent-cairn-dir; git push origin main",
      `cd ${r.other} && git push origin feature`,
    ]) {
      expect(at(r, c).status, c).toBe(0);
    }
  });

  it("a folder or git setting only the shell can work out refuses any push; named plainly it passes", () => {
    const r = repos();
    // Each row: [where the guard can't follow, the same push with the folder named plainly]
    const rows: Array<[lost: string, plain: string]> = [
      ['cd "$X" && git push origin feature', "cd sub && git push origin feature"],
      ["cd - && git push origin main", "git push origin main"],
      ['cd "$(git rev-parse --show-toplevel)" && git push origin main', `cd ${r.proj} && git push origin main`],
      ['git -C "$D" push origin feature', "git -C sub push origin feature"],
      ["GIT_DIR=$G git push origin main", `GIT_DIR=${r.proj}/.git git push origin main`],
      ["git --git-dir=~someone/.git push origin main", "git --git-dir=.git push origin main"],
      ["for d in a b; do cd sub; done; git push origin main", "for d in a b; do cd /; done; git push origin main"],
    ];
    for (const [lost, plain] of rows) {
      const res = at(r, lost);
      expect(res.status, lost).toBe(2);
      expect(res.stderr, lost).toContain("can't tell which repository");
      expectOwnerTail(res.stderr, lost, "CAIRN_ALLOW_UNSHIPPED_PUSH");
      expect(at(r, plain).status, plain).toBe(0);
    }
    expect(at(r, 'cd "$X" && git push origin feature', r.proj, { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" }).status).toBe(0);
  });

  it("mid-run, a checkout reaching the owner's checkout by cd, --git-dir/--work-tree or GIT_DIR is refused like its -C form", () => {
    const r = repos({ status: "running", phases: [], pushAuth: { granted: false } });
    // From the run's own worktree. Each row: [the form, its -C pair]
    const rows: Array<[form: string, pair: string]> = [
      [`cd ${r.proj} && git checkout runbranch`, `git -C ${r.proj} checkout runbranch`],
      ["cd ../proj && git switch side", "git -C ../proj switch side"],
      [`git --git-dir=${r.proj}/.git --work-tree=${r.proj} checkout side`, `git -C ${r.proj} checkout side`],
      [`GIT_DIR=${r.proj}/.git GIT_WORK_TREE=${r.proj} git switch side`, `git -C ${r.proj} switch side`],
      [`git --work-tree=${r.proj} checkout runbranch`, `git -C ${r.proj} checkout runbranch`],
      [`git -c core.worktree=${r.proj} checkout side`, `git -C ${r.proj} checkout side`],
      [`CAIRN_ALLOW_DESTRUCTIVE_GIT=1 GIT_WORK_TREE=${r.proj} git reset --hard`,
        `CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git -C ${r.proj} reset --hard`],
    ];
    for (const [form, pair] of rows) {
      for (const c of [form, pair]) {
        const res = at(r, c, r.wt);
        expect(res.status, c).toBe(2);
        expect(res.stderr, c).toContain("run-x");
        expect(res.stderr, c).toContain("the checkout you work in");
      }
    }
    // ...the run's own worktrees stay its own, however they are reached
    for (const c of ["git checkout -b mine", `cd ${r.wt} && git switch -c y`, `git -C ${r.wt2} checkout -b z`,
      `GIT_DIR=${r.proj}/.git/worktrees/wt git checkout -b w`]) {
      expect(at(r, c, r.wt).status, c).toBe(0);
    }
  });

  it("mid-run, a folder only the shell can work out refuses checkout and switch; CAIRN_RUN_OK still lifts it", () => {
    const r = repos({ status: "running", phases: [], pushAuth: { granted: false } });
    for (const c of ['cd "$OWNER" && git checkout side', 'git -C "$D" switch side', "GIT_DIR=$G git checkout side"]) {
      const res = at(r, c, r.wt);
      expect(res.status, c).toBe(2);
      expect(res.stderr, c).toContain("goes somewhere the guard can't tell");
      expectOwnerTail(res.stderr, c);
    }
    expect(at(r, 'cd "$OWNER" && CAIRN_RUN_OK=1 git checkout side', r.wt).status).toBe(0);
    expect(at(r, "cd sub && git status", r.proj).status).toBe(0);
  });
});

describe("run guard: an MCP tool's command line is judged like a Bash line (#310)", () => {
  const START = "mcp__plugin_desktop-commander_desktop-commander__start_process";
  const EXECUTE = "mcp__plugin_context-mode_context-mode__ctx_execute";
  const BATCH = "mcp__plugin_context-mode_context-mode__ctx_batch_execute";

  /** The hook fed a non-Bash tool call, with the same clean override env as guard(). */
  function tool(proj: string, home: string, tool_name: string, tool_input: Record<string, unknown>,
    cwd: string = proj): { status: number | null; stderr: string } {
    const env: Record<string, string | undefined> = {
      ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home,
      GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
    };
    delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
    delete env.CAIRN_ALLOW_UNSHIPPED_PUSH;
    const r = spawnSync(process.execPath, [RUNGUARD], {
      cwd: proj, env, encoding: "utf8", timeout: 5000,
      input: JSON.stringify({ tool_name, tool_input, cwd }),
    });
    return { status: r.status, stderr: r.stderr ?? "" };
  }

  it("start_process running `git reset --hard` is refused; running `git status` passes", () => {
    const { proj, home } = fixture();
    const reset = tool(proj, home, START, { command: "git reset --hard", timeout_ms: 5000 });
    expect(reset.status).toBe(2);
    expect(reset.stderr).toContain("git reset --hard");
    expectOwnerTail(reset.stderr, "start_process", "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    expect(tool(proj, home, START, { command: "git status", timeout_ms: 5000 }).status).toBe(0);
  });

  it("every field shape the header lists is read; its harmless neighbour passes", () => {
    const { proj, home } = fixture();
    // Each row: [a tool input carrying `git reset --hard`, the same shape carrying `git status`]
    const rows: Array<[name: string, refused: Record<string, unknown>, allowed: Record<string, unknown>]> = [
      ["mcp__x__run", { cmd: "git reset --hard" }, { cmd: "git status" }],
      ["mcp__x__run", { shell_command: "git reset --hard" }, { shell_command: "git status" }],
      ["mcp__x__exec", { command: ["git", "reset", "--hard"] }, { command: ["git", "status"] }],
      ["mcp__x__exec", { command: "git", args: ["reset", "--hard"] }, { command: "git", args: ["status"] }],
      ["mcp__x__exec", { cmd: "git", arguments: ["reset", "--hard"] }, { cmd: "git", arguments: ["status"] }],
      ["mcp__x__script", { script: "git reset --hard" }, { script: "git status" }],
      ["mcp__x__script", { script: "git reset --hard", interpreter: "/bin/bash" }, { script: "git status", interpreter: "/bin/bash" }],
      [EXECUTE, { language: "shell", code: "git reset --hard" }, { language: "shell", code: "git status" }],
      [START, { command: "git reset --hard", shell: "zsh", timeout_ms: 1 }, { command: "git status", shell: "zsh", timeout_ms: 1 }],
      [BATCH, { commands: [{ label: "a", command: "git status" }, { label: "b", command: "git reset --hard" }], queries: ["x"] },
        { commands: [{ label: "a", command: "git status" }], queries: ["x"] }],
      ["mcp__x__batch", { commands: ["git log -1", "git reset --hard"] }, { commands: ["git log -1"] }],
    ];
    for (const [name, refused, allowed] of rows) {
      const label = JSON.stringify(refused);
      const r = tool(proj, home, name, refused);
      expect(r.status, label).toBe(2);
      expect(r.stderr, label).toContain("git reset --hard");
      expect(tool(proj, home, name, allowed).status, JSON.stringify(allowed)).toBe(0);
    }
  });

  it("what the header puts out of scope, and words that only mention git, pass", () => {
    const { proj, home } = fixture();
    for (const [name, input] of [
      [EXECUTE, { language: "python", code: "git reset --hard" }],
      ["mcp__x__script", { script: "git reset --hard", language: "javascript" }],
      ["mcp__plugin_desktop-commander_desktop-commander__interact_with_process", { pid: 1, input: "git reset --hard" }],
      ["mcp__x__exec", { command: ["echo", "git reset --hard"] }],
      ["mcp__x__exec", { command: "echo", args: ["git reset --hard"] }],
      ["mcp__x__exec", { command: "echo", args: ["it's git reset --hard"] }],
      ["mcp__x__write_file", { path: "notes.md", content: "git reset --hard" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(tool(proj, home, name, input).status, JSON.stringify(input)).toBe(0);
    }
  });

  it("the overrides keep their two shapes: the session env, or the one command's leading assignment", () => {
    const { proj, home } = fixture();
    expect(tool(proj, home, START, { command: "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard" }).status).toBe(0);
    expect(tool(proj, home, START, { command: "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 true && git reset --hard" }).status).toBe(2);
    expect(tool(proj, home, START, { command: "git commit -m 'CAIRN_ALLOW_DESTRUCTIVE_GIT=1' && git reset --hard" }).status)
      .toBe(2);
  });

  it("an MCP push meets the ship gate, from the folder the tool names, and a batch's earlier commit counts (#305)", () => {
    const { proj, home } = fixture();
    const other = freshDir("cairn-runguard-other-");
    execFileSync("git", ["clone", "-q", proj, other]);
    const push = { label: "p", command: "git push origin main" };
    const commit = { label: "c", command: "git commit --allow-empty -m x" };
    expect(tool(proj, home, START, { command: "git push origin main" }).status).toBe(0);
    expect(tool(proj, home, BATCH, { commands: [push], queries: ["x"] }).status).toBe(0);
    expect(tool(proj, home, BATCH, { commands: [push, commit], queries: ["x"] }).status).toBe(0);
    const moved: Array<Record<string, unknown>> = [
      { commands: [commit, push], queries: ["x"] },
      { commands: [push, commit], queries: ["x"], concurrency: 4 },
      { command: "git commit --allow-empty -m x && git push origin main" },
    ];
    for (const input of moved) {
      const r = tool(proj, home, input.command ? START : BATCH, input);
      expect(r.status, JSON.stringify(input)).toBe(2);
      expect(r.stderr, JSON.stringify(input)).toContain("push as its own step");
    }
    // the folder the tool names is where the line starts (#306)
    const there = tool(proj, home, BATCH, { commands: [push], queries: ["x"], cwd: other });
    expect(there.status).toBe(2);
    expect(there.stderr).toContain("another repository");
    expect(tool(proj, home, BATCH, { commands: [push], queries: ["x"], cwd: proj }).status).toBe(0);
    expect(tool(proj, home, BATCH, { commands: [push], queries: ["x"], cwd: "$WHERE" }).status).toBe(2);
    // ...and a cd in one of a batch's commands may carry into the next, if they share a shell
    const moved2 = tool(proj, home, BATCH, { commands: [{ label: "d", command: `cd ${other}` }, push], queries: ["x"] });
    expect(moved2.status).toBe(2);
    expect(moved2.stderr).toContain("another repository");
  });

  it("mid-run, an MCP checkout of the owner's checkout is refused like the Bash one", () => {
    const { proj, home } = fixture({ status: "running", phases: [], pushAuth: { granted: false } });
    const r = tool(proj, home, START, { command: "git checkout main" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("run-x");
    expect(guard(proj, home, "git checkout main").status).toBe(2);
    expect(tool(proj, home, START, { command: "git log --oneline" }).status).toBe(0);
  });
});

// #319: the shared reader ended a segment at an unquoted `(`, `)` or
// backtick, so `git reset $(git rev-parse HEAD~1) --hard` read its --hard
// as a command of its own and the reset looked soft. A substitution is one
// word of its command now.
describe("run guard: an unquoted substitution never cuts a destructive flag off its command (#319)", () => {
  it("the flag after a $(...) or backtick is the command's, and refused", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git reset $(git rev-parse HEAD~1) --hard",
      "git reset `git rev-parse HEAD~1` --hard",
      "git checkout $(git rev-parse HEAD~1) -f",
      "git clean $(true) -fdx",
      "git push origin $(git rev-parse HEAD):main -f", // the stamp is clean; the -f alone refuses
      "echo $(git reset --hard)", // the body still runs, quoted or not (#257)
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("the everyday substitutions pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      "echo $(date)",
      "export V=$(git rev-parse HEAD)",
      'git commit -m "$(cat msg)"',
      "cd $(git rev-parse --show-toplevel) && npm test",
      "git log $(git merge-base HEAD main)..HEAD",
      "git diff $(git rev-parse HEAD~1)",
      "(cd server && npm test)",
      "echo $((1+2))",
      "diff <(sort a) <(sort b)",
      "git commit -m '$(git reset --hard)'",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });
});

// #320: #319 queued no body for `<(...)`, `>(...)` or `$((...))`, so a
// destructive command inside one ran unseen. Before #319 the split at `(`
// surfaced it by accident; now each body is read as a line of its own.
describe("run guard: a command inside a process substitution or arithmetic is seen (#320)", () => {
  it("each reported form is refused", () => {
    const { proj, home } = fixture();
    for (const c of [
      "diff <(git reset --hard) /dev/null",
      "<(git push --force)",
      "cat <(git push --force origin main)",
      "echo $(( $(git reset --hard) ))",
      "echo $((1 + $(git clean -fdx | wc -c)))",
      "tee >(git reset --hard) < a.txt",
      "diff <(sort <(git reset --hard)) b",
      // a `$((` that isn't arithmetic is a command substitution holding a subshell in some shells
      "echo $((git reset --hard))",
      "echo $( (git reset --hard) )",
      "echo $( (cd x && git reset --hard) )",
      "echo $((`git reset --hard`))",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("the everyday process substitutions and arithmetic pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      "diff <(sort a) <(sort b)",
      "comm <(ls a) <(ls b)",
      "echo $((1+2))",
      "while read l; do echo $l; done < <(git log --oneline)",
      "paste <(cut -f1 a) <(cut -f2 b) > out.txt",
      "diff <(git show HEAD:a) <(git show HEAD~1:a)",
      "echo $(( $(git rev-list --count HEAD) + 1 ))",
      "echo $(( x * 2 ))",
      "n=$((n + 1)); git status",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });
});

// #321: every substitution body was re-read without limit, and the guard's
// own re-reads of a runner's inner line multiplied that, so a line nested
// 120 deep took six seconds. Bodies nest eight levels now; deeper is
// refused unread, since what runs there was never seen.
describe("run guard: a line nested deeper than the reader reads is refused unread (#321)", () => {
  const nested = (d: number, inner: string) => "echo " + "$(a ".repeat(d) + inner + ")".repeat(d);

  it("eight levels are read; nine are refused whatever is inside, naming the owner's ways", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, nested(8, "git status")).status).toBe(0);
    const r8 = guard(proj, home, nested(8, "git reset --hard"));
    expect(r8.status).toBe(2);
    expect(r8.stderr).toContain("git reset --hard");
    for (const c of [nested(9, "git status"), nested(9, "git reset --hard"),
      "echo " + "$(a ".repeat(9) + "git status", "bash -c '" + nested(9, "ls") + "'",
      "git log $(" + nested(9, "ls") + ")"]) {
      const r = guard(proj, home, c);
      expect(r.status, c.slice(0, 40)).toBe(2);
      expect(r.stderr, c.slice(0, 40)).toContain("deeper than the guard reads");
      expectOwnerTail(r.stderr, c.slice(0, 40));
    }
  });

  it("a pathological nesting is refused in bounded time", () => {
    const { proj, home } = fixture();
    for (const c of [nested(120, "git reset --hard"), "echo " + "$(a ".repeat(120) + "git reset --hard"]) {
      const t0 = Date.now();
      expect(guard(proj, home, c).status).toBe(2);
      expect(Date.now() - t0).toBeLessThan(1500); // ~6 s before the cap; a generous ceiling, not a benchmark
    }
  });

  it("the everyday computed folders still pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      "cd $(git rev-parse --show-toplevel) && npm test",
      'cd "$(git rev-parse --show-toplevel)" && git status',
      "echo x > $(pwd)/notes.txt",
      "git -C $(git rev-parse --show-toplevel) log --oneline",
      // the harness guard's computed-folder writes: no git command in them, nothing to say
      "cd hooks && echo x > $(pwd)/hooks.json",
      `cd .. && rm -rf $(pwd)/${basename(proj)}/hooks`,
      "cd /tmp && echo x > $(pwd)/notes.txt",
      "cd server && cp a $(git rev-parse --show-toplevel)/.mcp.json",
      "cd $(mktemp -d) && echo x > $(pwd)/x",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
    // a cd the guard can't follow still loses the push after it, and a destructive git is refused anywhere
    expect(guard(proj, home, "cd $(mktemp -d) && git push origin main").status).toBe(2);
    expect(guard(proj, home, "cd $(pwd)/sub && git reset --hard").status).toBe(2);
  });
});

// #322: heredocs were not modelled here, so every body line read as a
// command of its own -- `cat > README.md <<'EOF'` with "never run git
// reset --hard" as prose was refused -- while the $(...) an unquoted body
// runs was only caught by that same accident. A body is data now, in
// both guards: only the substitutions an unquoted body runs are read,
// and a heredoc fed to a shell reading stdin is still that shell's script.
describe("run guard: a heredoc body is data, and the substitutions it runs are commands (#322)", () => {
  it("the $(...) or backtick an unquoted body runs is the destructive git it is", () => {
    const { proj, home } = fixture();
    for (const [c, tag] of [
      ["cat <<EOF\n$(git reset --hard)\nEOF", "git reset --hard"],
      ["cat <<EOF\n$(git push --force origin main)\nEOF", "git push --force"],
      ["cat > notes.md <<EOF\ntitle $(git reset --hard)\nEOF", "git reset --hard"],
      ["tee notes.md <<EOF\n`git reset --hard`\nEOF", "git reset --hard"],
      ["cat <<-EOF\n\t$(git reset --hard)\n\tEOF", "git reset --hard"],
      ["cat <<EOF | wc -l\n$(git reset --hard)\nEOF", "git reset --hard"],
      ["cat <<EOF\n$((1 + $(git reset --hard | wc -c)))\nEOF", "git reset --hard"],
      ["cat <<EOF\n$(cat <<X\n$(git reset --hard)\nX\n)\nEOF", "git reset --hard"],
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain(tag);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("body text is prose, quoted delimiter or not: a README naming a hard reset passes", () => {
    const { proj, home } = fixture();
    for (const c of [
      "cat > README.md <<'EOF'\nNever run git reset --hard here.\nEOF",
      "cat > README.md <<EOF\nNever run git reset --hard here.\nEOF",
      "cat > docs/x.md <<'EOF'\n```\ngit reset --hard\n```\nEOF",
      "cat > docs/x.md <<'EOF'\n    git push --force\nEOF",
      "cat <<'EOF'\n$(git reset --hard)\nEOF", // a quoted delimiter: the $(...) is text
      "cat <<EOF\n\\$(git reset --hard)\nEOF", // an escaped `$` never expands
      "cat <<EOF\n$(cat <<X\ngit reset --hard\nX\n)\nEOF", // the inner heredoc's text is data too
      "bash -c 'git status' <<EOF\ngit reset --hard\nEOF", // a shell with a -c string ignores its stdin
      "git commit -F - <<'EOF'\ndocs: say never to git reset --hard\nEOF",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });

  it("a shell reading stdin runs the heredoc fed to it, its own or the one piped in", () => {
    const { proj, home } = fixture();
    for (const c of [
      "sh <<EOF\ngit reset --hard\nEOF",
      "sh <<'EOF'\ngit reset --hard\nEOF",
      "bash -s <<EOF\ngit push --force origin main\nEOF",
      "cat <<'EOF' | sh\ngit reset --hard\nEOF",
      "sh <<EOF\necho $(git reset --hard)\nEOF",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toMatch(/git (reset --hard|push --force)/);
    }
    expect(guard(proj, home, "sh <<EOF\ngit status\nEOF").status).toBe(0);
    // ...and a heredoc that isn't a script never moves a ref ahead of a push
    expect(guard(proj, home, "cat <<'EOF' > notes.md && git push origin feature\nhello\nEOF").status).toBe(0);
  });

  it("the shapes around a heredoc are unchanged: a $(...) on the line and a here-string", () => {
    const { proj, home } = fixture();
    expect(guard(proj, home, "echo $(git reset --hard)").status).toBe(2);
    expect(guard(proj, home, 'cat <<< "$(git reset --hard)"').status).toBe(2);
    expect(guard(proj, home, "echo $(git status)").status).toBe(0);
    expect(guard(proj, home, "cat <<< 'never git reset --hard'").status).toBe(0);
  });
});

describe("run guard: forced worktree remove refused in every session (#414)", () => {
  it("refuses git worktree remove --force, naming the owner's ways to approve", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git worktree remove --force .claude/worktrees/x",
      "git worktree remove -f wt",
      "git -C . worktree remove --force wt",
      "cd x && git worktree remove --force wt",
    ]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expectOwnerTail(r.stderr, c, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
    }
  });

  it("a plain remove (git refuses a dirty tree itself), list, add, prune and branch -D pass", () => {
    const { proj, home } = fixture();
    for (const c of [
      "git worktree remove wt",
      "git worktree list",
      "git worktree add --detach /tmp/wt HEAD",
      "git worktree prune",
      "git branch -D feature-x",
    ]) {
      expect(guard(proj, home, c).status, c).toBe(0);
    }
  });
});

describe("run guard: no stash across linked worktrees (#363)", () => {
  /** The fixture repository plus one linked worktree beside it -- two entries in `git worktree list`. */
  function twoWorktrees(): { proj: string; home: string; linked: string } {
    const { proj, home } = fixture();
    const linked = join(freshDir("cairn-runguard-linked-"), "wt");
    git(proj, "worktree", "add", "-q", "-b", "side", linked);
    return { proj, home, linked };
  }

  for (const action of ["pop", "apply", "drop"]) {
    it(`\`git stash ${action}\` passes with one worktree and is refused with two, naming the shared stash`, () => {
      const c = `git stash ${action}`;
      const single = fixture();
      const r1 = guard(single.proj, single.home, c);
      expect(r1.status, `${c}\n${r1.stderr}`).toBe(0);
      expect(r1.stderr, c).toBe("");
      expect(r1.stdout, c).toBe("");

      const { proj, home, linked } = twoWorktrees();
      for (const [label, cmd, cwd] of [["main checkout", c, proj], ["linked worktree", c, linked],
        ["-C into the linked worktree", `git -C ${linked} stash ${action}`, proj]]) {
        const r = guard(proj, home, cmd, {}, cwd);
        expect(r.status, `${label}: ${cmd}`).toBe(2);
        expect(r.stderr, label).toContain(`\`git stash ${action}\` is refused`);
        expect(r.stderr, label).toContain("shared by every worktree");
        expect(r.stderr, label).toContain("WIP commit");
        expect(r.stderr, label).toContain("effect: discards-work, from `more than one worktree`.");
        expectOwnerTail(r.stderr, label, "CAIRN_ALLOW_DESTRUCTIVE_GIT");
      }
    });
  }

  it("stash list and show pass with one worktree or two, and say nothing", () => {
    const single = fixture();
    const { proj, home } = twoWorktrees();
    for (const c of ["git stash list", "git stash show -p"]) {
      for (const [p, h] of [[single.proj, single.home], [proj, home]]) {
        const r = guard(p, h, c);
        expect(r.status, c).toBe(0);
        expect(r.stdout, c).toBe("");
      }
    }
  });

  it("stash push with two worktrees proceeds with an advisory; with one, nothing is said", () => {
    const single = fixture();
    const { proj, home } = twoWorktrees();
    for (const c of ["git stash", "git stash push -m wip", "git stash save wip", "git stash -u"]) {
      const quiet = guard(single.proj, single.home, c);
      expect(quiet.status, c).toBe(0);
      expect(quiet.stdout, c).toBe("");

      const r = guard(proj, home, c);
      expect(r.status, `${c}\n${r.stderr}`).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.hookEventName, c).toBe("PreToolUse");
      expect(out.hookSpecificOutput.additionalContext, c).toContain("shared by every worktree");
      expect(out.hookSpecificOutput.additionalContext, c).toContain("WIP commit");
      expect(out.hookSpecificOutput, c).not.toHaveProperty("permissionDecision");
    }
  });

  it("the owner's escape still lets a pop through with two worktrees", () => {
    const { proj, home } = twoWorktrees();
    expect(guard(proj, home, "git stash pop", { CAIRN_ALLOW_DESTRUCTIVE_GIT: "1" }).status).toBe(0);
  });
});
