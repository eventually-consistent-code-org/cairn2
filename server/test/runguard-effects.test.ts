/**
 * Purpose: #359 -- the run guard classifies a git invocation by effect and
 *   derives its refusals from the effects. Pins the classifier directly
 *   (one test per effect, three spellings each: long flag, short flag,
 *   abbreviated as git reads it), a negative corpus of everyday git that
 *   stays allowed, and end to end that each refusal names its effect and
 *   the flag that caused it. runguard-guards.test.ts stays the per-issue
 *   regression corpus; commands here are only fed to the hook as JSON.
 * Author(s): John Reed
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  DISCARDS_WORK, MOVES_SHARED_REF, TOUCHES_OWNER_CHECKOUT, READ_ONLY, EFFECTS, EFFECT_TABLE,
  classify, effectsOf, parseInvocation,
// @ts-expect-error untyped hook module
} from "../../hooks/scripts/git-effects.mjs";

// Constants

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-runguard.mjs");

type Cause = { effect: string; flag: string; what: string; why: string };

// Variables

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A plain command (no quoting) as the parsed invocation the guard builds. */
const inv = (command: string) => parseInvocation(command.trim().split(/\s+/));

/** The effect names a command carries, statically (no repository asked). */
const effects = (command: string): string[] => effectsOf(inv(command));

/** The causes of one effect, in table order. */
const causes = (command: string, only: string, probe = {}): Cause[] => classify(inv(command), probe, { only });

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (proj: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: proj, encoding: "utf8", env: { ...process.env, ...GIT_IDENT } }).trim();

/** Same plain-resolve() project hash the guard derives from CLAUDE_PROJECT_DIR. */
function projKey(proj: string): string {
  const abs = resolve(proj);
  return `${basename(abs)}-${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
}

/** A committed repo on `main` and an isolated cairn home, optionally with a live run and no stamp. */
function fixture(live = false): { proj: string; home: string } {
  const proj = freshDir("cairn-effects-proj-");
  git(proj, "init", "-q", "-b", "main");
  writeFileSync(join(proj, "seed.txt"), "seed\n");
  git(proj, "add", "seed.txt");
  git(proj, "commit", "-q", "-m", "init", "--no-gpg-sign");
  const home = freshDir("cairn-effects-home-");
  if (live) {
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", `${projKey(proj)}-run-x.json`), JSON.stringify({
      version: 1, runId: "run-x", status: "running", phases: [{ number: 1 }],
      pushAuth: { granted: false }, currentPhase: 1,
    }));
  }
  return { proj, home };
}

/** The hook, fed one Bash command, with no override in its environment. */
function guard(proj: string, home: string, command: string): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home };
  for (const k of ["CAIRN_ALLOW_DESTRUCTIVE_GIT", "CAIRN_ALLOW_UNSHIPPED_PUSH", "GIT_DIR", "GIT_WORK_TREE"]) delete env[k];
  const r = spawnSync(process.execPath, [RUNGUARD], {
    cwd: proj, env, encoding: "utf8", timeout: 5000,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: proj }),
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

// Main

describe("git effects: the three classifications, declared once (#359)", () => {
  it("names exactly three effects, read-only the default, and every table row uses one of them", () => {
    expect(EFFECTS).toEqual(["discards-work", "moves-shared-ref", "touches-owner-checkout"]);
    expect(READ_ONLY).toBe("read-only");
    expect(EFFECT_TABLE.length).toBeGreaterThan(0);
    for (const row of EFFECT_TABLE) expect(EFFECTS, JSON.stringify(row)).toContain(row.effect);
    expect(effects("git status")).toEqual([READ_ONLY]);
  });
});

describe("git effects: discards-work, three spellings (#359)", () => {
  it("a forced checkout, spelled --force, -f and --forc, discards work and names the flag", () => {
    for (const [c, flag] of [["git checkout --force main", "--force"], ["git checkout -f main", "-f"],
      ["git checkout --forc main", "--forc"]]) {
      const hit = causes(c, DISCARDS_WORK);
      expect(hit.map((h) => h.flag), c).toEqual([flag]);
      expect(effects(c), c).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
    }
  });

  it("a force push, spelled --force, -fu and --force-w, discards work and moves a shared ref", () => {
    for (const [c, flag] of [["git push --force origin topic", "--force"], ["git push -fu origin topic", "-fu"],
      ["git push --force-w origin topic", "--force-w"]]) {
      expect(causes(c, DISCARDS_WORK).map((h) => h.flag), c).toEqual([flag]);
      expect(effects(c), c).toEqual([DISCARDS_WORK, MOVES_SHARED_REF]);
    }
    // a +refspec forces that ref, no flag at all
    expect(causes("git push origin +topic", DISCARDS_WORK).map((h) => h.flag)).toEqual(["+topic"]);
  });

  it("the rows only the repository can answer match only when the probe says so", () => {
    expect(causes("git push origin topic", DISCARDS_WORK)).toEqual([]);
    expect(causes("git push origin topic", DISCARDS_WORK, { mirrorConfigured: () => true }).map((h) => h.what))
      .toEqual(["`git push --mirror`"]);
    expect(causes("git push origin :main", DISCARDS_WORK, { deletesDefaultBranch: () => true })
      .map((h) => h.what)).toEqual(["a push deleting the default branch"]);
  });
});

describe("git effects: moves-shared-ref, three spellings (#359)", () => {
  it("a push of every branch, spelled --all, -u with main, and --branc, moves a shared ref", () => {
    for (const [c, flag] of [["git push --all origin", "push --all origin"],
      ["git push -u origin main", "push origin main"], ["git push --branc origin", "push --branc origin"]]) {
      expect(causes(c, MOVES_SHARED_REF).map((h) => h.flag), c).toEqual([flag]);
      expect(effects(c), c).toEqual([MOVES_SHARED_REF]);
    }
  });
});

describe("git effects: touches-owner-checkout, three spellings (#359)", () => {
  it("a switch, spelled --create, -c and --cre, touches the checkout it runs in", () => {
    for (const c of ["git switch --create topic", "git switch -c topic", "git switch --cre topic"]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT).map((h) => h.flag), c).toEqual(["switch"]);
      expect(effects(c), c).toEqual([TOUCHES_OWNER_CHECKOUT]);
    }
  });

  it("a hard reset, spelled --hard and --har, carries both discards-work and touches-owner-checkout", () => {
    for (const [c, flag] of [["git reset --hard HEAD~1", "--hard"], ["git reset --har", "--har"],
      ["git reset -q --ha", "--ha"]]) {
      expect(effects(c), c).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
      expect(causes(c, TOUCHES_OWNER_CHECKOUT).map((h) => h.flag), c).toEqual([flag]);
      expect(causes(c, DISCARDS_WORK).map((h) => h.flag), c).toEqual([flag]);
    }
  });
});

describe("git effects: everyday git stays allowed (#359)", () => {
  // command -> the effects it carries; none of them discards work
  const corpus: Array<[string, string[]]> = [
    ["git status", [READ_ONLY]],
    ["git log --oneline -5", [READ_ONLY]],
    ["git diff HEAD", [READ_ONLY]],
    ["git add -A", [READ_ONLY]],
    ["git commit -m wip", [READ_ONLY]],
    ["git fetch origin", [READ_ONLY]],
    ["git pull --ff-only", [READ_ONLY]],
    ["git branch", [READ_ONLY]],
    ["git branch -D topic", [READ_ONLY]],
    ["git worktree list", [READ_ONLY]],
    ["git stash push -m wip", [READ_ONLY]],
    ["git stash pop", [READ_ONLY]],
    ["git stash drop", [READ_ONLY]],
    ["git push origin topic", [MOVES_SHARED_REF]],
    ["git reset --soft HEAD~1", [READ_ONLY]],
    ["git reset", [READ_ONLY]],
    ["git checkout -b topic", [TOUCHES_OWNER_CHECKOUT]],
    ["git restore --staged src/a.ts", [READ_ONLY]],
    ["git restore --staged .", [READ_ONLY]],
    ["git clean -n", [READ_ONLY]],
    ["git reflog", [READ_ONLY]],
  ];

  it("the classifier finds no discards-work in any of them", () => {
    for (const [c, want] of corpus) {
      expect(effects(c), c).toEqual(want);
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
    }
  });

  it("the hook lets every one through when no run is live", () => {
    const { proj, home } = fixture();
    for (const [c] of corpus) {
      const r = guard(proj, home, c);
      expect(r.status, `${c}\n${r.stderr}`).toBe(0);
    }
  });
});

describe("run guard: each refusal names its effect and the flag that caused it (#359)", () => {
  it("discards-work: a shortened hard reset is refused, naming --har and the checkout it also touches", () => {
    const { proj, home } = fixture();
    const r = guard(proj, home, "git reset --har HEAD~1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: discards-work, from `--har`; also touches-owner-checkout.");
  });

  it("discards-work: a clustered force push names its cluster", () => {
    const { proj, home } = fixture();
    const r = guard(proj, home, "git push -fu origin topic");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: discards-work, from `-fu`; also moves-shared-ref.");
  });

  it("moves-shared-ref: a push onto main with no drift stamp is refused, naming what lands", () => {
    const { proj, home } = fixture();
    for (const [c, flag] of [["git push origin main", "push origin main"], ["git push --branc origin", "push --branc origin"]]) {
      const r = guard(proj, home, c);
      expect(r.status, c).toBe(2);
      expect(r.stderr, c).toContain(`effect: moves-shared-ref, from \`${flag}\`.`);
    }
  });

  it("moves-shared-ref mid-run: a feature-branch push without the grant is refused, naming the effect", () => {
    const { proj, home } = fixture(true);
    const r = guard(proj, home, "git push origin topic");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: moves-shared-ref, from `push origin topic`.");
  });

  it("touches-owner-checkout mid-run: a switch in the owner's checkout is refused, naming the effect", () => {
    const { proj, home } = fixture(true);
    const r = guard(proj, home, "git switch -c topic");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: touches-owner-checkout, from `switch`.");
  });

  it("a hard reset of the owner's checkout mid-run, discards-work overridden, still names both effects", () => {
    const { proj, home } = fixture(true);
    const r = guard(proj, home, "CAIRN_ALLOW_DESTRUCTIVE_GIT=1 git reset --hard");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: touches-owner-checkout, from `--hard`; also discards-work.");
  });

  it("fails open: a payload the guard can't read never blocks", () => {
    const { proj, home } = fixture();
    const r = spawnSync(process.execPath, [RUNGUARD], {
      cwd: proj, encoding: "utf8", timeout: 5000, input: "not json",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CAIRN_HOME: home },
    });
    expect(r.status).toBe(0);
  });
});
