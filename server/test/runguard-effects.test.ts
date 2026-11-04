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
      expect(effects(c), c).toEqual([DISCARDS_WORK]);
    }
  });

  it("the unforced, cached, dry-run and single-path forms stay read-only", () => {
    for (const c of ["git rm -r .", "git rm .", "git rm --cached -r .", "git rm -rf --cached .",
      "git rm -r -f --cached :/", "git rm -rfn .", "git rm -rf --dry-run .", "git rm -rf src/a.ts",
      "git rm -rf src", "git rm -f seed.txt", "git rm --cached seed.txt", "git rm -rf *.log"]) {
      expect(causes(c, DISCARDS_WORK), c).toEqual([]);
      expect(effects(c), c).toEqual([READ_ONLY]);
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
