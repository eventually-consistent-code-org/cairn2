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
  API_PROGRAMS, SIDE_DOOR_TABLE,
  apiPath, classify, effectsOf, envConfig, ghAliasSet, parseInvocation, readOpts, sideDoor, sideEffectLine, wholeTree,
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

describe("git effects: the stash is shared across linked worktrees (#363)", () => {
  const two = { linkedWorktrees: () => true };
  const one = { linkedWorktrees: () => false };

  // branch (#438) is pop plus a checkout: it takes the entry onto a new branch and drops it
  for (const [action, c] of [["pop", "git stash pop stash@{0}"], ["apply", "git stash apply stash@{0}"],
    ["drop", "git stash drop stash@{0}"], ["branch", "git stash branch topic stash@{0}"]]) {
    it(`\`git stash ${action}\` discards work with more than one worktree, and not with one`, () => {
      expect(causes(c, DISCARDS_WORK, one), c).toEqual([]);
      const [hit, ...rest] = causes(c, DISCARDS_WORK, two);
      expect(rest, c).toEqual([]);
      expect(hit.flag, c).toBe("more than one worktree");
      expect(hit.what, c).toBe(`\`git stash ${action}\``);
      expect(hit.why, c).toMatch(/shared by every worktree/);
      expect(hit.why, c).toMatch(/WIP commit/);
    });
  }

  it("the reads and the push half carry no row, whatever the worktree count", () => {
    for (const c of ["git stash list", "git stash show -p", "git stash", "git stash push -m wip",
      "git stash save wip", "git stash -u"]) {
      expect(causes(c, DISCARDS_WORK, two), c).toEqual([]);
    }
  });

  it("adds no fourth effect -- the stash rows are discards-work, or owner-checkout (#435)", () => {
    const stash = EFFECT_TABLE.filter((r: { sub: string }) => r.sub === "stash");
    for (const r of stash) expect([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]).toContain(r.effect);
    const rows = stash.filter((r: { effect: string }) => r.effect === DISCARDS_WORK);
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["clear", "pop", "apply", "drop", "branch"]);
    expect(rows.slice(1).every((r: { when: string; name: string }) =>
      r.when === "probe" && r.name === "linkedWorktrees")).toBe(true);
  });
});

describe("git effects: a forced whole-tree rm discards work (#434)", () => {
  // git itself refuses to remove a modified file unless forced, so the
  // forced whole-tree form is the one that throws edits away; each row is
  // [the command, the force word the refusal names]
  const refused: Array<[string, string]> = [
    ["git rm -rf .", "-rf"],
    ["git rm -r --force .", "--force"],
    ["git rm -r --forc :/", "--forc"],
    ["git rm -fr ./", "-fr"],
    ["git rm -f *", "-f"],
    ["git rm -rf -- .", "-rf"],
    ["git rm -q -r -f ../..", "-f"],
    ["git rm -rf --pathspec-from-file=paths.txt", "-rf"],
  ];

  it("each forced whole-tree spelling discards work and names the force word", () => {
    for (const [c, flag] of refused) {
      const [hit, ...rest] = causes(c, DISCARDS_WORK);
      expect(rest, c).toEqual([]);
      expect(hit?.flag, c).toBe(flag);
      expect(hit?.what, c).toBe("a forced whole-tree `git rm`");
      // ...and, since #468, deletes the files of the checkout it runs in
      expect(effects(c), c).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
    }
  });

  it("the unforced, cached, dry-run and single-path forms discard nothing; the ones that still delete files touch the checkout (#468)", () => {
    for (const c of ["git rm -r .", "git rm .", "git rm --cached -r .", "git rm -rf --cached .",
      "git rm -r -f --cached :/", "git rm -rfn .", "git rm -rf --dry-run .", "git rm -rf src/a.ts",
      "git rm -rf src", "git rm -f seed.txt", "git rm --cached seed.txt", "git rm -rf *.log"]) {
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
      const indexOnly = /--cached|-rfn|--dry-run/.test(c);
      expect(effects(c), c).toEqual(indexOnly ? [READ_ONLY] : [TOUCHES_OWNER_CHECKOUT]);
    }
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

  // #435 -- the effect covers every command its definition names: one that
  // rewrites the working files, or replaces the checked-out commit, of the
  // checkout it runs in. Each row: [the command, the word the cause names].
  it("merge, pull, rebase, cherry-pick, revert, am and mv touch the checkout they run in (#435)", () => {
    for (const [c, flag] of [["git merge topic", "merge"], ["git merge --abort", "merge"],
      ["git pull", "pull"], ["git pull --rebase origin main", "pull"], ["git rebase -i main", "rebase"],
      ["git rebase --continue", "rebase"], ["git cherry-pick abc123", "cherry-pick"],
      ["git revert --no-edit HEAD", "revert"], ["git am fix.patch", "am"], ["git mv a.ts b.ts", "mv"]]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT).map((h) => h.flag), c).toEqual([flag]);
      expect(effects(c), c).toEqual([TOUCHES_OWNER_CHECKOUT]);
    }
  });

  it("the stash actions that write the tree touch it: push, save, a bare stash, pop, apply, branch (#435)", () => {
    for (const [c, flag, what] of [["git stash", "stash", "`git stash push`"], ["git stash -u", "stash", "`git stash push`"],
      ["git stash push -m wip", "push", "`git stash push`"], ["git stash save wip", "save", "`git stash push`"],
      ["git stash pop", "pop", "`git stash pop`"], ["git stash apply stash@{0}", "apply", "`git stash apply`"],
      ["git stash branch topic", "branch", "`git stash branch`"]]) {
      const hits = causes(c, TOUCHES_OWNER_CHECKOUT);
      expect(hits.map((h) => h.flag), c).toEqual([flag]);
      expect(hits[0].what, c).toBe(what);
      expect(effects(c), c).toEqual([TOUCHES_OWNER_CHECKOUT]);
    }
    for (const c of ["git stash list", "git stash show -p", "git stash drop", "git stash clear"]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT), c).toEqual([]);
    }
  });

  it("reset --merge and --keep, spelled out and shortened, touch the checkout and discard nothing (#435)", () => {
    for (const [c, flag] of [["git reset --merge", "--merge"], ["git reset --keep HEAD~1", "--keep"],
      ["git reset --mer ORIG_HEAD", "--mer"], ["git reset -q --ke HEAD~1", "--ke"]]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT).map((h) => h.flag), c).toEqual([flag]);
      expect(effects(c), c).toEqual([TOUCHES_OWNER_CHECKOUT]);
    }
  });

  it("a commit, the index-only commands and the reads leave the checkout as the human left it (#435)", () => {
    for (const c of ["git commit -m wip", "git commit --amend --no-edit", "git add -A", "git rm --cached -r .",
      "git reset", "git reset --soft HEAD~1", "git reset --mixed HEAD~1", "git tag v1", "git branch -D topic",
      "git fetch origin", "git status", "git diff", "git log", "git merge-base HEAD main"]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT), c).toEqual([]);
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
    // a pull, like a merge, rewrites the checkout it runs in (#435): refused
    // only mid-run, in the owner's checkout
    ["git pull --ff-only", [TOUCHES_OWNER_CHECKOUT]],
    ["git branch", [READ_ONLY]],
    ["git branch -D topic", [READ_ONLY]],
    ["git worktree list", [READ_ONLY]],
    // statically, and in a repository with one worktree; a second worktree
    // makes pop/apply/drop discard work (#363, below). The ones that write
    // the tree touch the checkout (#435); drop leaves it alone
    ["git stash push -m wip", [TOUCHES_OWNER_CHECKOUT]],
    ["git stash pop", [TOUCHES_OWNER_CHECKOUT]],
    ["git stash apply", [TOUCHES_OWNER_CHECKOUT]],
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

describe("git effects: an alias is classified by what it runs (#430)", () => {
  /** A git command given as words, so an alias value may hold spaces and quotes. */
  const words = (...w: string[]) => parseInvocation(["git", ...w]);
  /** The flag the first cause of `only` names. */
  const flagOf = (i: ReturnType<typeof words>, only: string): string => classify(i, {}, { only })[0]?.flag;

  it("an inline -c alias resolves to the real subcommand before the table is read, one spelling each", () => {
    const hard = words("-c", "alias.hr=reset --hard", "hr", "HEAD~1");
    expect(effectsOf(hard)).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
    expect(flagOf(hard, DISCARDS_WORK)).toBe("--hard");
    expect([hard.sub, hard.args, hard.alias]).toEqual(["reset", ["--hard", "HEAD~1"], "hr"]);
    const force = words("-c", "alias.fp=push --force", "fp", "origin", "topic");
    expect(effectsOf(force)).toEqual([DISCARDS_WORK, MOVES_SHARED_REF]);
    expect(flagOf(force, DISCARDS_WORK)).toBe("--force");
    // a whole-tree checkout, the `--` in the value or typed after the name
    for (const tree of [words("-c", "alias.co=checkout -- .", "co"), words("-c", "alias.co=checkout", "co", "--", ".")]) {
      expect(effectsOf(tree)).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
      expect(flagOf(tree, DISCARDS_WORK)).toBe(".");
    }
    const main = words("-c", "alias.pm=push origin main", "pm");
    expect(effectsOf(main)).toEqual([MOVES_SHARED_REF]);
    expect(flagOf(main, MOVES_SHARED_REF)).toBe("push origin main");
  });

  it("a shell alias is refused outright: discards-work, from `!`, whatever follows it", () => {
    for (const value of ["!rm -rf .", "!git reset --hard", "!echo hi"]) {
      const sh = words("-c", `alias.tidy=${value}`, "tidy");
      expect(effectsOf(sh), value).toEqual([DISCARDS_WORK]);
      expect(flagOf(sh, DISCARDS_WORK), value).toBe("!");
      expect(sh.alias, value).toBe("tidy");
    }
  });

  it("reads the value as git does: the last -c wins, the key in any case, quoting, nesting, its own -c, a loop", () => {
    expect(words("-c", "alias.x=status", "-c", "alias.x=reset --hard", "x").sub).toBe("reset");
    expect(words("-c", "alias.x=reset --hard", "-c", "alias.x=status", "x").sub).toBe("status");
    expect(words("-c", "Alias.X=reset --hard", "x").sub).toBe("reset");
    const q = words("-c", `alias.x=commit -m 'two words' --author="A B" -m c\\ d`, "x");
    expect([q.sub, q.args]).toEqual(["commit", ["-m", "two words", "--author=A B", "-m", "c d"]]);
    expect(words("-c", "alias.a=b", "-c", "alias.b=reset --hard", "a").sub).toBe("reset");
    const own = words("-c", "alias.x=-c core.bare=false reset --hard", "x");
    expect([own.sub, own.configs]).toEqual(["reset", ["alias.x=-c core.bare=false reset --hard", "core.bare=false"]]);
    // git refuses an alias loop; the words stay as typed and carry no effect
    expect(effectsOf(words("-c", "alias.a=b", "-c", "alias.b=a", "a"))).toEqual([READ_ONLY]);
  });

  it("a builtin on the table wins over an alias of its own name, as in git -- an alias can't disguise one", () => {
    const reset = words("-c", "alias.reset=status", "reset", "--hard");
    expect(effectsOf(reset)).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
    expect(reset.alias).toBeUndefined();
    // an empty value, a bare -c alias.x (git refuses both) or no alias: the words stay as typed
    for (const w of [["-c", "alias.x=", "x"], ["-c", "alias.x", "x"], ["-c", "alias.y=reset --hard", "x"], ["x"]]) {
      const i = words(...w);
      expect([i.sub, i.alias], w.join(" ")).toEqual(["x", undefined]);
    }
    // an everyday alias is the everyday command
    expect(effectsOf(words("-c", "alias.st=status", "st"))).toEqual([READ_ONLY]);
    expect(effectsOf(words("-c", "alias.lg=log --oneline", "lg", "-3"))).toEqual([READ_ONLY]);
  });

  it("the hook: a refusal through an alias names the alias beside the flag", () => {
    const { proj, home } = fixture();
    const hard = guard(proj, home, "git -c 'alias.hr=reset --hard' hr HEAD~1");
    expect(hard.status).toBe(2);
    expect(hard.stderr).toContain("effect: discards-work, from `--hard`, via alias `hr`; also touches-owner-checkout.");
    const sh = guard(proj, home, "git -c 'alias.tidy=!rm -rf .' tidy");
    expect(sh.status).toBe(2);
    expect(sh.stderr).toContain("a `!` shell alias is refused in every session");
    expect(sh.stderr).toContain("effect: discards-work, from `!`, via alias `tidy`.");
  });

  it("the hook: an alias from the repository's configuration is asked of git once; nothing found leaves the words as typed", () => {
    const { proj, home } = fixture();
    git(proj, "config", "alias.hr", "reset --hard");
    const r = guard(proj, home, "git hr HEAD~1");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("effect: discards-work, from `--hard`, via alias `hr`; also touches-owner-checkout.");
    // no such alias: an unknown subcommand stays read-only (the guard fails open on what it can't see, ADR 0016)
    expect(guard(proj, home, "git frobnicate --hard").status).toBe(0);
    // a probe git can't answer -- a folder that is no repository -- leaves today's classification
    const r2 = guard(proj, home, `git -C ${join(proj, "nowhere")} hr HEAD~1`);
    expect(r2.status, r2.stderr).toBe(0);
  });
});

describe("git effects: a lone colon, the magic forms and the repository root are the whole tree (#464, #288)", () => {
  // git reads a pathspec of a colon and nothing after it as "everything"
  // (gitglossary; measured against git 2.56 on 2026-11-04: `git rm -rfn --
  // :` lists every tracked file), and so `::`, `:/:` and any long-form
  // magic with no path after it. Before #464 the matcher knew `:/` and
  // `:(top)` only, so `git rm -rf :` passed the guard and emptied the tree.
  it("the colon spellings name the whole tree; a colon-prefixed real path and the exclude forms stay paths", () => {
    for (const p of [":", "::", ":/", ":/:", ":/.", ":/*", ":(top)", ":(top,glob)", ":(glob,top)", ":(icase)", ":*"]) {
      expect(wholeTree(p), p).toBe(true);
    }
    // the exclude forms stay paths by decision (phase 31 CONTEXT, 2026-11-04)
    for (const p of [":/sub", ":/src/a.ts", ":(top)sub", "::sub", ":/:sub", ":!sub", ":!", ":(exclude)sub",
      ":(top,exclude)", ":(exclude,top)", "seed.txt", "src", "*.ts", ""]) {
      expect(wholeTree(p), p).toBe(false);
    }
  });

  it("the repository root as an absolute path is the whole tree when the root is known; a folder under it is not (#288)", () => {
    const root = "/work/repo";
    for (const p of ["/work/repo", "/work/repo/", "/work/repo/.", "/work/repo/*", "/work/repo/./", "/work/repo/**"]) {
      expect(wholeTree(p, root), p).toBe(true);
      expect(wholeTree(p, `${root}/`), p).toBe(true);
    }
    for (const p of ["/work/repo/src", "/work/repo/seed.txt", "/work/repo2", "/work", "repo", "/work/repo/*.ts"]) {
      expect(wholeTree(p, root), p).toBe(false);
    }
    // no root known: an absolute path is a path -- only the repository can say which one is its root
    expect(wholeTree("/work/repo")).toBe(false);
    expect(wholeTree("/work/repo", undefined)).toBe(false);
  });

  it("the rm, checkout and restore rows inherit every spelling and name it as the cause", () => {
    const rows: Array<[string, string, string]> = [
      ["git rm -rf :", "-rf", "a forced whole-tree `git rm`"],
      ["git rm -r --force -- ::", "--force", "a forced whole-tree `git rm`"],
      ["git checkout -- :", ":", "a whole-tree `git checkout`"],
      ["git checkout :", ":", "a whole-tree `git checkout`"],
      ["git checkout HEAD -- :/:", ":/:", "a whole-tree `git checkout`"],
      ["git restore :", ":", "a whole-tree `git restore`"],
      ["git restore -- ::", "::", "a whole-tree `git restore`"],
      ["git restore -s HEAD~1 :(glob,top)", ":(glob,top)", "a whole-tree `git restore`"],
      ["git restore --staged --worktree :", ":", "a whole-tree `git restore`"],
    ];
    for (const [c, flag, what] of rows) {
      const [hit, ...rest] = causes(c, DISCARDS_WORK);
      expect(rest, c).toEqual([]);
      expect(hit?.flag, c).toBe(flag);
      expect(hit?.what, c).toBe(what);
    }
    // the twins: a colon-prefixed real path, the exclude forms, and the index-only or dry-run colon
    for (const c of ["git rm -rf :/sub", "git rm -rf ::seed.txt", "git checkout -- :/sub", "git checkout -- :!sub",
      "git restore :/sub", "git restore :(exclude)sub", "git restore --staged :", "git rm --cached -r :",
      "git rm -rfn :", "git rm -r :"]) {
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
    }
  });

  it("the repository root comes in through the repoRoot probe, per word, in the word's own spelling (#288)", () => {
    // the guard's probe: the word, trailing slash, dot or glob dropped, when it resolves to the root
    const probe = { repoRoot: (w: string) => (/^\/work\/repo(?:\/\.|\/\*+|\/)*$/.test(w) ? "/work/repo" : undefined) };
    for (const [c, flag] of [["git checkout -- /work/repo", "/work/repo"], ["git checkout HEAD /work/repo/", "/work/repo/"],
      ["git restore /work/repo/.", "/work/repo/."], ["git rm -rf /work/repo/*", "-rf"]]) {
      expect(causes(c, DISCARDS_WORK, probe).map((h) => h.flag), c).toEqual([flag]);
    }
    for (const c of ["git checkout -- /work/repo/src", "git restore /work/repo/seed.txt", "git rm -rf /work/other"]) {
      expect(causes(c, DISCARDS_WORK, probe), c).toEqual([]);
    }
    // no probe (the server's line classifier, a test): an absolute path is a path
    expect(causes("git checkout -- /work/repo", DISCARDS_WORK)).toEqual([]);
  });
});

describe("git effects: the owner-checkout table meets its own definition (#468)", () => {
  // The definition: a command touches the checkout it runs in when it
  // rewrites the working files, or replaces the checked-out commit. Before
  // #468 every command here read read-only and ran in the owner's checkout
  // mid-run. Each row: [the command, the word the cause names, the row's name].
  const rows: Array<[command: string, flag: string, what: string]> = [
    ["git apply fix.patch", "apply", "`git apply`"],
    ["git apply --index fix.patch", "apply", "`git apply`"],
    ["git apply -R -p2 fix.patch", "apply", "`git apply`"],
    ["git apply --directory=src fix.patch", "apply", "`git apply`"],
    ["git bisect start", "start", "`git bisect`"],
    ["git bisect start HEAD HEAD~5", "start", "`git bisect`"],
    ["git bisect bad", "bad", "`git bisect`"],
    ["git bisect good abc123", "good", "`git bisect`"],
    ["git bisect new", "new", "`git bisect`"],
    ["git bisect old", "old", "`git bisect`"],
    ["git bisect skip", "skip", "`git bisect`"],
    ["git bisect reset", "reset", "`git bisect`"],
    ["git bisect replay bisect.log", "replay", "`git bisect`"],
    ["git bisect run npm test", "run", "`git bisect`"],
    ["git restore seed.txt", "restore", "`git restore`"],
    ["git restore --source=HEAD~1 src/a.ts", "restore", "`git restore`"],
    ["git restore --staged --worktree seed.txt", "restore", "`git restore`"],
    ["git restore -SW seed.txt", "restore", "`git restore`"],
    ["git checkout-index -f -a", "-f", "`git checkout-index --force`"],
    ["git checkout-index --force -- seed.txt", "--force", "`git checkout-index --force`"],
    ["git checkout-index -fu -a", "-fu", "`git checkout-index --force`"],
    ["git checkout-index --forc -a", "--forc", "`git checkout-index --force`"],
    ["git sparse-checkout set src", "set", "`git sparse-checkout`"],
    ["git sparse-checkout add docs", "add", "`git sparse-checkout`"],
    ["git sparse-checkout reapply", "reapply", "`git sparse-checkout`"],
    ["git sparse-checkout disable", "disable", "`git sparse-checkout`"],
    ["git sparse-checkout init --cone", "init", "`git sparse-checkout`"],
    ["git read-tree -u HEAD", "-u", "`git read-tree -u`"],
    ["git read-tree -mu HEAD topic", "-mu", "`git read-tree -u`"],
    ["git read-tree --reset -u HEAD", "-u", "`git read-tree -u`"],
    ["git submodule update --init --recursive", "update", "`git submodule update`"],
    ["git submodule deinit -f lib", "deinit", "`git submodule deinit`"],
    ["git rm -f seed.txt", "rm", "`git rm`"],
    ["git rm seed.txt", "rm", "`git rm`"],
    ["git rm -r src", "rm", "`git rm`"],
    ["git clean -f", "clean", "`git clean`"],
    ["git clean -fd", "clean", "`git clean`"],
    ["git -c clean.requireForce=false clean -d", "clean", "`git clean`"],
  ];

  it("each touches the checkout it runs in, naming the word that caused it and the row's name", () => {
    for (const [c, flag, what] of rows) {
      const hits = causes(c, TOUCHES_OWNER_CHECKOUT);
      expect(hits.map((h) => h.flag), c).toEqual([flag]);
      expect(hits[0].what, c).toBe(what);
      expect(hits[0].why, c).toMatch(/rewrites the files or HEAD/);
      expect(effects(c), c).toContain(TOUCHES_OWNER_CHECKOUT);
    }
  });

  it("the twins carry no row: the reads, the index-only forms, the dry runs, a write to temp files", () => {
    for (const c of ["git apply --check fix.patch", "git apply --stat fix.patch", "git apply --numstat fix.patch",
      "git apply --summary fix.patch", "git apply --cached fix.patch", "git apply --check --index fix.patch",
      "git apply --cached -R fix.patch",
      "git bisect log", "git bisect visualize", "git bisect view", "git bisect terms", "git bisect",
      "git restore --staged seed.txt", "git restore -S .", "git restore --staged -- .",
      "git checkout-index -a", "git checkout-index seed.txt", "git checkout-index -f --temp seed.txt",
      "git checkout-index -a --prefix=/tmp/export/",
      "git sparse-checkout list", "git sparse-checkout check-rules", "git sparse-checkout",
      "git read-tree HEAD", "git read-tree -m HEAD topic", "git read-tree -u -n HEAD", "git read-tree -un HEAD",
      "git read-tree --reset HEAD", "git read-tree --prefix=sub/ HEAD",
      "git submodule status", "git submodule init", "git submodule summary", "git submodule",
      "git rm --cached seed.txt", "git rm -n seed.txt", "git rm --dry-run -r .", "git rm -r --cached .",
      "git clean -n", "git clean -nd", "git clean --dry-run -fdx", "git clean -fd --dry-run"]) {
      expect(causes(c, TOUCHES_OWNER_CHECKOUT), c).toEqual([]);
      expect(effects(c), c).toEqual([READ_ONLY]);
    }
  });

  it("the #288 fold: a whole-tree restore, a clean and a forced whole-tree rm carry both effects, in table order", () => {
    for (const c of ["git restore .", "git restore :", "git clean -fd", "git rm -rf .", "git checkout -- ."]) {
      expect(effects(c), c).toEqual([DISCARDS_WORK, TOUCHES_OWNER_CHECKOUT]);
    }
    for (const c of ["git restore --staged .", "git clean -n", "git rm --cached -r ."]) {
      expect(effects(c), c).toEqual([READ_ONLY]);
    }
  });

  it("the table's owner-checkout rows name exactly the subcommands the definition lists, one effect per row", () => {
    const subs = new Set(EFFECT_TABLE.filter((r: { effect: string }) => r.effect === TOUCHES_OWNER_CHECKOUT)
      .map((r: { sub: string }) => r.sub));
    expect([...subs].sort()).toEqual(["am", "apply", "bisect", "checkout", "checkout-index", "cherry-pick", "clean",
      "merge", "mv", "pull", "read-tree", "rebase", "reset", "restore", "revert", "rm", "sparse-checkout", "stash",
      "submodule", "switch"]);
  });
});

describe("git effects: ref and reflog destruction discards work (#288)", () => {
  // A deleted branch is recoverable: HEAD's reflog and `git fsck
  // --lost-found` keep its commits -- until one of these runs. Each row:
  // [the command, the word the refusal names, what the row calls it].
  // Before #288 every one but `reflog expire` (#264) read read-only.
  const refused: Array<[command: string, flag: string, what: string]> = [
    ["git update-ref -d refs/heads/topic", "-d", "`git update-ref -d`"],
    ["git update-ref --delete refs/heads/topic", "--delete", "`git update-ref -d`"],
    ["git update-ref --del refs/remotes/origin/topic", "--del", "`git update-ref -d`"],
    ["git update-ref -d refs/tags/v1 abc123", "-d", "`git update-ref -d`"],
    ["git reflog delete HEAD@{1}", "delete", "`git reflog delete`"],
    ["git reflog delete --rewrite refs/heads/main@{0}", "delete", "`git reflog delete`"],
    ["git reflog expire --expire=now --all", "expire", "`git reflog expire`"],
    ["git reflog expire --expire-unreachable=now refs/heads/main", "expire", "`git reflog expire`"],
    ["git gc --prune=now", "--prune", "`git gc --prune=<date>`"],
    ["git gc --prune=all", "--prune", "`git gc --prune=<date>`"],
    ["git gc --aggressive --prune=1.minute.ago", "--prune", "`git gc --prune=<date>`"],
    ["git gc -q --prun=now", "--prun", "`git gc --prune=<date>`"],
    ["git prune", "prune", "`git prune`"],
    ["git prune --expire=now", "prune", "`git prune`"],
    ["git prune --expire now", "prune", "`git prune`"],
    ["git prune -v --expire=2.weeks.ago", "prune", "`git prune`"],
  ];

  it("each discards work, carries no other effect, and names the word that caused it", () => {
    for (const [c, flag, what] of refused) {
      const [hit, ...rest] = causes(c, DISCARDS_WORK);
      expect(rest, c).toEqual([]);
      expect(hit?.flag, c).toBe(flag);
      expect(hit?.what, c).toBe(what);
      expect(effects(c), c).toEqual([DISCARDS_WORK]);
    }
  });

  it("the twins carry no row: a ref written, the reflog read, the default gc, a dry-run prune, the other prunes, and branch -D", () => {
    for (const c of ["git update-ref refs/heads/topic HEAD", "git update-ref -m msg HEAD HEAD~1",
      "git update-ref --no-deref refs/heads/topic HEAD~1", "git update-ref --stdin", "git update-ref --create-reflog refs/x HEAD",
      "git reflog", "git reflog show", "git reflog show HEAD", "git reflog exists refs/heads/main",
      "git gc", "git gc --auto", "git gc --aggressive", "git gc --prune", "git gc --no-prune", "git gc --prune=never",
      "git gc --prune=false", "git gc -q",
      "git prune -n", "git prune --dry-run", "git prune --dry-run --expire=now", "git prune -nv",
      "git prune-packed", "git worktree prune", "git remote prune origin",
      "git branch -D topic", "git branch -d topic", "git branch --delete --force topic"]) {
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
      expect(effects(c), c).toEqual([READ_ONLY]);
    }
  });

  it("the hostile spelling: gc.pruneExpire set inline makes a bare gc the `now` prune; `never` keeps it the everyday one", () => {
    for (const c of ["git -c gc.pruneExpire=now gc", "git -c gc.pruneexpire=now gc --auto", "git -c gc.pruneExpire=1.hour.ago gc"]) {
      expect(causes(c, DISCARDS_WORK).map((h) => [h.flag, h.what]), c).toEqual([["-c gc.pruneExpire", "`git gc --prune=<date>`"]]
        .map(([f, w]) => [c.includes("pruneexpire") ? "-c gc.pruneexpire" : f, w]));
    }
    for (const c of ["git -c gc.pruneExpire=never gc", "git -c gc.pruneExpire=false gc", "git -c gc.auto=0 gc"]) {
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
    }
  });
});

describe("git effects: config from the environment channels is folded in git's order (#467)", () => {
  /** An environment of plain values; anything else is unreadable. */
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  /** A git command given as words, parsed under `vars`. */
  const under = (vars: Record<string, string>, ...w: string[]) => parseInvocation(["git", ...w], { env: env(vars) });

  it("a --config-env is read from the lookup at its place in line order, the last on a key winning as in git", () => {
    const hr = under({ HR: "reset --hard" }, "--config-env=alias.hr=HR", "hr", "HEAD~1");
    expect([hr.sub, hr.args, hr.alias, hr.configs, hr.unread]).toEqual(["reset", ["--hard", "HEAD~1"], "hr", ["alias.hr=reset --hard"], []]);
    // the separate-word spelling, and the hostile order: -c after --config-env wins, before it loses
    expect(under({ HR: "reset --hard" }, "--config-env", "alias.hr=HR", "hr").sub).toBe("reset");
    expect(under({ X: "status" }, "--config-env=alias.x=X", "-c", "alias.x=reset --hard", "x").sub).toBe("reset");
    expect(under({ X: "status" }, "-c", "alias.x=reset --hard", "--config-env=alias.x=X", "x").sub).toBe("status");
    // an alias value carrying a --config-env of its own is read under the same lookup
    const nested = under({ HR: "reset --hard" }, "-c", "alias.a=--config-env=alias.b=HR b", "a");
    expect([nested.sub, nested.alias]).toEqual(["reset", "a"]);
    // without a lookup the module reads none of it: the --config-env stays in configEnvs alone, as before #467
    const blind = parseInvocation(["git", "--config-env=alias.hr=HR", "hr"]);
    expect([blind.sub, blind.configs, blind.configEnvs, blind.unread]).toEqual(["hr", [], ["alias.hr=HR"], []]);
  });

  it("a value the lookup can't give, or the shell would still expand, is unread by key and named by its word", () => {
    expect(under({}, "--config-env=alias.hr=HR", "hr").unread).toEqual([{ key: "alias.hr", from: "--config-env=alias.hr=HR" }]);
    expect(under({ HR: "$X" }, "--config-env", "alias.hr=HR", "hr").unread).toEqual([{ key: "alias.hr", from: "--config-env alias.hr=HR" }]);
    // the rows: a setting the table reads refuses; one it never reads carries no effect
    expect(effectsOf(under({}, "--config-env=alias.hr=HR", "hr"))).toEqual([DISCARDS_WORK]);
    expect(effectsOf(under({}, "--config-env=remote.origin.mirror=M", "push", "origin"))).toContain(DISCARDS_WORK);
    expect(effectsOf(under({}, "--config-env=core.editor=E", "status"))).toEqual([READ_ONLY]);
    expect(classify(under({}, "--config-env=alias.hr=HR", "hr"), {}, { only: DISCARDS_WORK })[0].flag).toBe("--config-env=alias.hr=HR");
  });

  it("envConfig: GIT_CONFIG_COUNT entries become key=value in order; a bogus count, a missing or expanding entry, or GIT_CONFIG_PARAMETERS is unread", () => {
    expect(envConfig(env({}))).toEqual({ configs: [], unread: [] });
    expect(envConfig(env({ GIT_CONFIG_COUNT: "0" }))).toEqual({ configs: [], unread: [] });
    expect(envConfig(env({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "alias.a", GIT_CONFIG_VALUE_0: "b",
      GIT_CONFIG_KEY_1: "alias.b", GIT_CONFIG_VALUE_1: "reset --hard" })))
      .toEqual({ configs: ["alias.a=b", "alias.b=reset --hard"], unread: [] });
    expect(envConfig(env({ GIT_CONFIG_COUNT: "abc" })).unread).toEqual([{ key: "*", from: "GIT_CONFIG_COUNT" }]);
    expect(envConfig(env({ GIT_CONFIG_COUNT: "1000" })).unread).toEqual([{ key: "*", from: "GIT_CONFIG_COUNT" }]);
    expect(envConfig(env({ GIT_CONFIG_COUNT: "1" })).unread).toEqual([{ key: "*", from: "GIT_CONFIG_KEY_0" }]);
    expect(envConfig(env({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "alias.hr" })).unread)
      .toEqual([{ key: "alias.hr", from: "GIT_CONFIG_VALUE_0" }]);
    expect(envConfig(env({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "alias.hr", GIT_CONFIG_VALUE_0: "$V" })).unread)
      .toEqual([{ key: "alias.hr", from: "GIT_CONFIG_VALUE_0" }]);
    expect(envConfig(env({ GIT_CONFIG_PARAMETERS: "'alias.hr=reset --hard'" })).unread).toEqual([{ key: "*", from: "GIT_CONFIG_PARAMETERS" }]);
    // the include row and the unread row apply to every subcommand: no `sub`, and so not on the builtin list
    const anySub = EFFECT_TABLE.filter((r: { sub?: string }) => r.sub === undefined);
    expect(anySub.map((r: { when: string }) => r.when).sort()).toEqual(["config", "unread"]);
    expect(effectsOf(parseInvocation(["git", "-c", "include.path=/tmp/x.cfg", "status"]))).toEqual([DISCARDS_WORK]);
    expect(effectsOf(parseInvocation(["git", "-c", "includeIf.gitdir:/r/.path=/tmp/x.cfg", "hr"]))).toEqual([DISCARDS_WORK]);
    expect(effectsOf(parseInvocation(["git", "-c", "core.excludesFile=/tmp/x.cfg", "status"]))).toEqual([READ_ONLY]);
  });
});

describe("side doors to the push action: the non-git table, one test per row (#483)", () => {
  type Side = { effect: string; flag: string; what: string; why: string; branch?: string; deletes?: string; alias?: string };
  /** A plain command (no quoting) read as the guard reads it: program, then its words. */
  const side = (command: string, aliases = new Map<string, string[]>()): Side | null => {
    const [program, ...args] = command.trim().split(/\s+/);
    return sideDoor(program, args, aliases);
  };
  const MERGE = "https://api.github.com/repos/o/r/pulls/1/merge";
  /** The same API path reached by each program that can: gh api, curl and wget, with a write method. */
  const writes = (path: string, method = "PUT", ...fields: string[]) => [
    `gh api -X ${method} ${path} ${fields.map((f) => `-f ${f}`).join(" ")}`,
    `curl -X ${method} https://api.github.com${path} ${fields.map((f) => `--data-urlencode ${f}`).join(" ")}`,
    `wget --method=${method} https://api.github.com${path} ${fields.length ? `--post-data=${fields.join("&")}` : ""}`,
  ];
  const reads = (path: string) => [`gh api ${path}`, `curl https://api.github.com${path}`, `wget https://api.github.com${path}`];

  it("the table has the eight rows the issue names, every one a moves-shared-ref cause, and names its three programs", () => {
    expect(SIDE_DOOR_TABLE.map((r: { route: string }) => r.route)).toEqual([
      "gh pr merge", "gh release create", "gh repo delete",
      "pull request merge", "ref write", "branch merge", "release", "GraphQL mutation",
    ]);
    for (const row of SIDE_DOOR_TABLE) expect(typeof row.why, row.route).toBe("string");
    expect(API_PROGRAMS).toEqual(["gh api", "curl", "wget"]);
    expect(side("git push origin main")).toBeNull(); // git has its own table
    expect(side("ls -la")).toBeNull();
  });

  it("row: gh pr merge, any flags, with -R before or after; pr view, checks, create and comment are not", () => {
    for (const c of ["gh pr merge 1", "gh pr merge 1 --squash --delete-branch", "gh pr -R o/r merge 1",
      "gh pr --repo=o/r merge", "gh pr merge --auto --admin 1"]) {
      const hit = side(c);
      expect(hit?.effect, c).toBe(MOVES_SHARED_REF);
      expect(hit?.flag, c).toBe("gh pr merge");
      expect(hit?.branch, c).toBeUndefined(); // the PR's base is only known to the API
    }
    for (const c of ["gh pr view 1", "gh pr checks 1", "gh pr create --title merge", "gh pr comment 1 --body merge",
      "gh pr merge".replace("merge", "diff"), "gh issue close 1"]) expect(side(c), c).toBeNull();
  });

  it("row: gh release create names its --target branch, else none; list and view are not", () => {
    expect(side("gh release create v1.0 --notes x")?.branch).toBeUndefined();
    expect(side("gh release create v1.0 --target feature")?.branch).toBe("feature");
    expect(side("gh release create --target=main v1.0")?.branch).toBe("main");
    expect(side("gh release -R o/r create v1.0")?.flag).toBe("gh release create");
    for (const c of ["gh release list", "gh release view v1.0", "gh release download v1.0"]) expect(side(c), c).toBeNull();
  });

  it("row: gh repo delete deletes outright; view, clone and sync are not", () => {
    const hit = side("gh repo delete o/r --yes");
    expect(hit?.effect).toBe(MOVES_SHARED_REF);
    expect(hit?.deletes).toBe("the repository and every ref in it");
    for (const c of ["gh repo view o/r", "gh repo clone o/r", "gh repo sync"]) expect(side(c), c).toBeNull();
  });

  it("row: a pull request merge, by every program and write method, in every path spelling; a GET is a read", () => {
    for (const method of ["PUT", "put", "POST", "PATCH"]) {
      for (const c of writes("/repos/o/r/pulls/1/merge", method)) {
        const hit = side(c);
        expect(hit?.effect, c).toBe(MOVES_SHARED_REF);
        expect(hit?.flag, c).toBe(`${method.toUpperCase()} /repos/o/r/pulls/1/merge`);
        expect(hit?.what, c).toMatch(/^a `(gh api|curl|wget)` pull request merge$/);
      }
    }
    for (const c of ["gh api -XPUT repos/o/r/pulls/1/merge", "gh api --method=PUT /repos/o/r/pulls/1/merge",
      `gh api -X PUT ${MERGE}`, "gh api repos/o/r/pulls/1/merge -f commit_title=x", "gh api --input body.json repos/o/r/pulls/1/merge",
      `curl -sSXPUT ${MERGE}`, `curl --request PUT ${MERGE}`, `curl -d {} ${MERGE}`, `curl --json {} ${MERGE}`, `curl -T body ${MERGE}`,
      `curl -X PUT ${MERGE}?foo=bar`, "curl -X PUT https://ghe.example.com/api/v3/repos/o/r/pulls/1/merge",
      `wget --method PUT ${MERGE}`, `wget --post-data={} ${MERGE}`]) {
      expect(side(c)?.what, c).toMatch(/pull request merge$/);
    }
    for (const c of [...reads("/repos/o/r/pulls/1/merge"), "gh api -X GET repos/o/r/pulls/1/merge -f foo=bar",
      `curl -I ${MERGE}`, `curl -G -d a=b ${MERGE}`, "curl -X PUT https://example.com/repos/o/r/pulls/1/merge",
      "gh api -X PUT repos/o/r/pulls/1", "gh api -X PUT repos/o/r/pulls/1/merged"]) expect(side(c), c).toBeNull();
  });

  it("row: a ref write names the branch from its path or its `ref` field, a tag by its own name, and a DELETE of a branch deletes", () => {
    for (const c of writes("/repos/o/r/git/refs/heads/main", "PATCH", "sha=0123abc")) {
      const hit = side(c);
      expect(hit?.what, c).toMatch(/ref write$/);
      expect(hit?.branch, c).toBe("main");
      expect(hit?.deletes, c).toBeUndefined();
    }
    expect(side("gh api -X PATCH repos/o/r/git/refs/heads/feature%2Fx -f sha=0")?.branch).toBe("feature/x");
    expect(side("gh api -X POST repos/o/r/git/refs -f ref=refs/heads/topic -f sha=0")?.branch).toBe("topic");
    expect(side("curl -X POST -d {\"ref\":\"refs/heads/topic\",\"sha\":\"0\"} https://api.github.com/repos/o/r/git/refs")?.branch).toBe("topic");
    expect(side("gh api -X DELETE repos/o/r/git/refs/tags/v1")?.branch).toBe("tags/v1");
    const del = side("gh api -X DELETE repos/o/r/git/refs/heads/main");
    expect(del?.deletes).toBe("the default branch");
    expect(del?.flag).toBe("DELETE /repos/o/r/git/refs/heads/main");
    for (const c of [...reads("/repos/o/r/git/refs/heads/main"), "gh api repos/o/r/git/ref/heads/main",
      "gh api -X PATCH repos/o/r/git/blobs/0"]) expect(side(c), c).toBeNull();
  });

  it("row: a branch merge names its `base`, as a field, a form, urlencoded data or JSON", () => {
    for (const c of writes("/repos/o/r/merges", "POST", "base=main", "head=topic")) expect(side(c)?.branch, c).toBe("main");
    expect(side("curl -X POST -d {\"base\":\"release\",\"head\":\"topic\"} https://api.github.com/repos/o/r/merges")?.branch).toBe("release");
    expect(side("curl -F base=release -F head=topic https://api.github.com/repos/o/r/merges")?.branch).toBe("release");
    expect(side("gh api -X POST repos/o/r/merges -F base=@file")?.branch).toBeUndefined(); // unread: the default, fail closed
    expect(side("curl -d '' https://api.github.com/repos/o/r/merges".replace("''", "x=y"))?.branch).toBeUndefined();
    for (const c of reads("/repos/o/r/merges")) expect(side(c), c).toBeNull();
  });

  it("row: a release names its `target_commitish`, by id or by tag; the assets under one are not a release", () => {
    for (const c of writes("/repos/o/r/releases", "POST", "tag_name=v1")) expect(side(c)?.what, c).toMatch(/release$/);
    expect(side("gh api -X POST repos/o/r/releases -f tag_name=v1 -f target_commitish=feature")?.branch).toBe("feature");
    expect(side("gh api -X PATCH repos/o/r/releases/12 -f draft=false")?.what).toBe("a `gh api` release");
    expect(side("gh api -X DELETE repos/o/r/releases/tags/v1")?.deletes).toBeUndefined(); // the release, not the tag
    for (const c of [...reads("/repos/o/r/releases"), "gh api repos/o/r/releases/latest",
      "gh api -X POST repos/o/r/releases/12/assets?name=x --input a.tgz"]) expect(side(c), c).toBeNull();
  });

  it("row: a GraphQL mutation that merges or moves a ref, by name; a query or another mutation is not; a body from a file is refused unread", () => {
    for (const name of ["mergePullRequest", "enablePullRequestAutoMerge", "mergeBranch", "createRef", "updateRef", "updateRefs",
      "deleteRef", "createCommitOnBranch"]) {
      const c = `gh api graphql -f query=mutation{${name}(input:{}){clientMutationId}}`;
      const hit = side(c);
      expect(hit?.what, c).toBe("a `gh api` GraphQL mutation");
      expect(hit?.flag, c).toBe(name);
      expect(hit?.branch, c).toBeUndefined();
    }
    expect(side("curl -X POST https://api.github.com/graphql -d {\"query\":\"mutation{mergePullRequest(input:{}){clientMutationId}}\"}")?.flag)
      .toBe("mergePullRequest");
    for (const c of ["gh api graphql -F query=@merge.graphql", "gh api graphql --input q.json", "curl -d @body.json https://api.github.com/graphql",
      "wget --post-file=body.json https://api.github.com/graphql"]) {
      const hit = side(c);
      expect(hit?.what, c).toMatch(/GraphQL mutation request from a file$/);
      expect(hit?.flag, c).toMatch(/^(@|--input)/);
    }
    for (const c of ["gh api graphql -f query=query{repository(owner:\"o\",name:\"r\"){pullRequest(number:1){merged}}}",
      "gh api graphql -f query=mutation{addComment(input:{}){clientMutationId}}",
      "gh api graphql -f query=mutation{updateIssue(input:{}){clientMutationId}}",
      "gh api graphql", "curl https://api.github.com/graphql"]) expect(side(c), c).toBeNull();
  });

  it("a gh alias set on the line is expanded, named in the cause, and never shadows a builtin; a shell alias is left to the reader (#315)", () => {
    expect(ghAliasSet(["alias", "set", "m", "pr merge"])).toEqual(["m", ["pr", "merge"]]);
    expect(ghAliasSet(["alias", "set", "--clobber", "m", "pr merge --squash"])).toEqual(["m", ["pr", "merge", "--squash"]]);
    expect(ghAliasSet(["alias", "set", "-s", "m", "git push"])).toBeNull();
    expect(ghAliasSet(["alias", "set", "m", "!git push"])).toBeNull();
    expect(ghAliasSet(["alias", "list"])).toBeNull();
    expect(ghAliasSet(["alias", "set", "m"])).toBeNull();
    const aliases = new Map([["m", ["pr", "merge"]], ["v", ["pr", "view"]], ["pr", ["issue", "list"]], ["put", ["api", "-X", "PUT"]]]);
    const m = side("gh m 1", aliases);
    expect(m?.flag).toBe("gh pr merge");
    expect(m?.alias).toBe("m");
    expect(sideEffectLine(m)).toBe("  effect: moves-shared-ref, from `gh pr merge`, via gh alias `m` -- the push action by another route.");
    expect(side("gh v 1", aliases)).toBeNull();
    expect(side("gh pr merge 1", aliases)?.flag).toBe("gh pr merge"); // `pr` is gh's own, never the alias
    expect(side("gh pr view 1", aliases)).toBeNull();
    expect(side("gh put repos/o/r/pulls/1/merge", aliases)?.alias).toBe("put");
    expect(side("gh m 1")).toBeNull(); // not set on this line: the Not seen block
  });

  it("the readers: pflag and getopt options, joined and separate, and GitHub's API paths by program", () => {
    const r = readOpts(["-sSXPUT", "--data", "{}", "--json={}", "-H", "A: b", "--", "-X", "GET"],
      { valued: ["--request", "--data", "--json", "--header"], alias: { X: "--request", H: "--header" } });
    expect([...r.flags]).toEqual(["-s", "-S", "--request", "--data", "--json", "--header"]);
    expect(r.values.get("--request")).toEqual(["PUT"]);
    expect(r.values.get("--json")).toEqual(["{}"]);
    expect(r.words).toEqual(["-X", "GET"]);
    expect(apiPath("repos/o/r/pulls/1/merge")).toBe("/repos/o/r/pulls/1/merge");
    expect(apiPath("/repos/o/r/merges?x=1#f")).toBe("/repos/o/r/merges");
    expect(apiPath("https://api.github.com/repos/o/r/merges")).toBe("/repos/o/r/merges");
    expect(apiPath("https://ghe.example.com/api/v3/repos/o/r/merges")).toBe("/repos/o/r/merges");
    expect(apiPath("repos/o/r/merges", { url: true })).toBeNull();
    expect(apiPath("https://example.com/repos/o/r/merges", { url: true })).toBeNull();
    expect(apiPath("https://API.GitHub.com/repos/o/r/merges", { url: true })).toBe("/repos/o/r/merges");
    expect(apiPath("mailto:x@y", {})).toBeNull();
  });
});
