import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
  cwd: string = proj): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home, ...extraEnv,
  };
  if (!("CAIRN_ALLOW_DESTRUCTIVE_GIT" in extraEnv)) delete env.CAIRN_ALLOW_DESTRUCTIVE_GIT;
  if (!("CAIRN_ALLOW_UNSHIPPED_PUSH" in extraEnv)) delete env.CAIRN_ALLOW_UNSHIPPED_PUSH;
  const r = spawnSync(process.execPath, [RUNGUARD], {
    cwd: proj, env, encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
  });
  return { status: r.status, stderr: r.stderr ?? "" };
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

/** Same plain-resolve() project hash the guard derives from CLAUDE_PROJECT_DIR. */
function projKey(proj: string): string {
  const abs = resolve(proj);
  return `${basename(abs)}-${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
}

const git = (proj: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: proj, encoding: "utf8" }).trim();

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
  }
  if (stamped) stamp(proj, home);
  return { proj, home };
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

  it("an unreadable stamp dir fails open; a corrupt stamp refuses", () => {
    const { proj, home } = branched();
    writeFileSync(join(home, "ship-gate"), "a file where the dir should be");
    expect(guard(proj, home, "git push origin main").status).toBe(0);
    rmSync(join(home, "ship-gate"));
    mkdirSync(join(home, "ship-gate"));
    writeFileSync(join(home, "ship-gate", `${projKey(proj)}.json`), "{ nope");
    expect(guard(proj, home, "git push origin main").status).toBe(2);
  });
});
