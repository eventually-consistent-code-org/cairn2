#!/usr/bin/env node

/**
 * Purpose: what a git invocation does, as effects (#359) -- the one
 *   classifier the run guard derives its refusals from. A parsed invocation
 *   (subcommand, flags, operands) maps to the effects in EFFECTS, read off
 *   EFFECT_TABLE with git's own option semantics: a long option shortened as
 *   git allows (`--har` is `--hard`, #296), short clusters (`-fu`), a `+ref`
 *   refspec, a whole-tree pathspec. The table is data; adding a spelling is
 *   a row, not a new branch of code.
 *
 *   Pure functions, no imports and no I/O. What only the repository can
 *   answer -- a remote configured to mirror, a push that deletes the
 *   remote's HEAD branch, a second worktree sharing the stash (#363) --
 *   comes in through `probe`, which the guard fills in per target and a
 *   test can stub.
 *
 * removeWhen: the run guard meets its own removeWhen -- it is this
 *   module's only reader.
 * Author(s): John Reed
 */

// Constants

/** Uncommitted or unpushed work is lost with no undo. */
export const DISCARDS_WORK = "discards-work";

/** The default branch or any remote ref changes. */
export const MOVES_SHARED_REF = "moves-shared-ref";

/** The working tree and HEAD of the checkout it runs in change -- the owner's, if that's where it runs. */
export const TOUCHES_OWNER_CHECKOUT = "touches-owner-checkout";

/** None of the above: the default. */
export const READ_ONLY = "read-only";

/** The effects, in the order the guard's rules ask about them. */
export const EFFECTS = Object.freeze([DISCARDS_WORK, MOVES_SHARED_REF, TOUCHES_OWNER_CHECKOUT]);

/**
 * git's top-level options that eat the following word as their value, from
 * git(1) and git.c (#301): `git --attr-source HEAD reset --hard` resets.
 * Their `--opt=value` forms are one word, skipped like any switch, and so is
 * --exec-path, which only ever takes its value after `=`. git spells these
 * in full -- it shortens no top-level option. --super-prefix is gone from
 * newer git and --list-cmds only takes `=`; both stay, since git refuses a
 * line that misuses them, and an older git reads them this way.
 */
export const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
  "--attr-source", "--shallow-file", "--super-prefix", "--list-cmds"]);

// git push's value-taking options, and how a push is read (#296):
// -f, -d and -o are --force, --delete and --push-option.
const PUSH_VALUED = ["--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"];
export const PUSH_READ = {
  short: "o",
  longs: ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune", "--delete",
    "--all", "--branches", "--tags", ...PUSH_VALUED],
  valued: PUSH_VALUED,
  alias: { f: "--force", d: "--delete" },
};

// The push flags that send more than the refspecs name -- a moves-shared-ref cause names them.
const PUSH_SWEEPS = ["--all", "--branches", "--mirror", "--tags", "--delete"];

// How each subcommand's args are read: short letters that take a value, long
// options git may see shortened, which of those take a value, short aliases.
const READS = {
  reset: { longs: ["--hard"] },
  checkout: { short: "bB", alias: { f: "--force" },
    longs: ["--force", "--orphan", "--conflict", "--pathspec-from-file"],
    valued: ["--orphan", "--conflict", "--pathspec-from-file"] },
  switch: { short: "cC", alias: { f: "--force" },
    longs: ["--discard-changes", "--force", "--create", "--force-create", "--orphan", "--conflict"],
    valued: ["--create", "--force-create", "--orphan", "--conflict"] },
  restore: { short: "s", alias: { s: "--source", S: "--staged", W: "--worktree" },
    longs: ["--source", "--staged", "--worktree", "--pathspec-from-file", "--conflict"],
    valued: ["--source", "--pathspec-from-file", "--conflict"] },
  clean: { short: "e", alias: { n: "--dry-run" }, longs: ["--dry-run", "--exclude"], valued: ["--exclude"] },
  worktree: { alias: { f: "--force" }, longs: ["--force"] },
  push: PUSH_READ,
};

const DISCARDS = "it discards uncommitted work with no undo.";

// Why a stash pop, apply or drop refuses once a repository has linked worktrees (#363)
const SHARED_STASH = "the stash is shared by every worktree of this repository, so the entry it takes " +
  "may be another worktree's half-finished work. Park work in progress with a WIP commit on your own " +
  "branch instead, and squash it before the close.";

/**
 * The effect table (#249, #250, #264, #296, #414, #359). Each row: the
 * effect, the subcommand, the first word it needs (`action`, read off
 * before the flags are), and `when` -- one of:
 *   flag       any of `names` is set (spelled out, shortened, or a short alias)
 *   wholeTree  a pathspec names the whole tree, or --pathspec-from-file
 *              hides it; `stagedOnly` leaves a restore of only the index alone
 *   unlessOn   always, unless `name` is on at the end (a dry run)
 *   always     the subcommand (and action) alone
 *   pushTo     any push; the cause is what decides where it lands
 *   plusRef    a refspec with a leading `+`
 *   config     a `-c` setting matching `key` that reads as true
 *   probe      the repository says so: probe[name](inv) is true
 * Rows are read in order; the first DISCARDS_WORK row that matches is the
 * one a refusal names. The everyday neighbours stay off the table because
 * they are routine or recoverable: a single-path checkout/restore, `branch
 * -D` (its reflog keeps the commits), `restore --staged .` (the index only,
 * like a plain `git reset`), deleting a feature branch, and `clean -n`.
 *
 * Stash (#363): one `.git` means one stash, so with linked worktrees a pop,
 * apply or drop can take another worktree's work -- those three rows ask
 * the `linkedWorktrees` probe (`git worktree list --porcelain` reports more
 * than one entry). With one worktree they never match and the guard is
 * unchanged byte for byte. `stash push`, `save` and a bare `stash` are the
 * recoverable half and have no row -- the table refuses, it doesn't advise;
 * the run guard emits their advisory itself. `stash list|show` stay reads.
 * Asserted by runguard-effects.test.ts and runguard-guards.test.ts (#363).
 */
export const EFFECT_TABLE = Object.freeze([
  { effect: DISCARDS_WORK, sub: "reset", when: "flag", names: ["--hard"],
    what: "`git reset --hard`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "checkout", when: "flag", names: ["--force"],
    what: "`git checkout --force`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "checkout", when: "wholeTree",
    what: "a whole-tree `git checkout`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "switch", when: "flag", names: ["--discard-changes", "--force"],
    what: "`git switch --discard-changes`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "restore", when: "wholeTree", stagedOnly: true,
    what: "a whole-tree `git restore`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "clean", when: "unlessOn", name: "--dry-run",
    what: "`git clean`", why: "it deletes untracked files, which git never had a copy of." },
  { effect: DISCARDS_WORK, sub: "worktree", action: "remove", when: "flag", names: ["--force"],
    what: "`git worktree remove --force`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "stash", action: "clear", when: "always",
    what: "`git stash clear`", why: "it drops every stash at once." },
  { effect: DISCARDS_WORK, sub: "stash", action: "pop", when: "probe", name: "linkedWorktrees",
    cause: "more than one worktree", what: "`git stash pop`", why: SHARED_STASH },
  { effect: DISCARDS_WORK, sub: "stash", action: "apply", when: "probe", name: "linkedWorktrees",
    cause: "more than one worktree", what: "`git stash apply`", why: SHARED_STASH },
  { effect: DISCARDS_WORK, sub: "stash", action: "drop", when: "probe", name: "linkedWorktrees",
    cause: "more than one worktree", what: "`git stash drop`", why: SHARED_STASH },
  { effect: DISCARDS_WORK, sub: "reflog", action: "expire", when: "always",
    what: "`git reflog expire`", why: "it erases the record git recovers lost commits from." },
  { effect: DISCARDS_WORK, sub: "push", when: "flag", names: ["--force", "--force-with-lease", "--force-if-includes"],
    what: "`git push --force`", why: "it overwrites remote history other people may already have pulled." },
  { effect: DISCARDS_WORK, sub: "push", when: "plusRef",
    what: "`git push --force`", why: "it overwrites remote history other people may already have pulled." },
  { effect: DISCARDS_WORK, sub: "push", when: "flag", names: ["--mirror"],
    what: "`git push --mirror`", why: "it force-updates and deletes remote refs to match this clone." },
  { effect: DISCARDS_WORK, sub: "push", when: "config", key: /^remote\.(.+)\.mirror(?:=(.*))?$/i,
    what: "`git push --mirror`", why: "it force-updates and deletes remote refs to match this clone." },
  { effect: DISCARDS_WORK, sub: "push", when: "probe", name: "mirrorConfigured", cause: "remote.<name>.mirror",
    what: "`git push --mirror`", why: "it force-updates and deletes remote refs to match this clone." },
  { effect: DISCARDS_WORK, sub: "push", when: "flag", names: ["--prune"],
    what: "`git push --prune`", why: "it deletes every remote branch this clone doesn't have." },
  { effect: DISCARDS_WORK, sub: "push", when: "probe", name: "deletesDefaultBranch", cause: "a deleted default branch",
    what: "a push deleting the default branch", why: "everyone's shared history hangs off it." },
  { effect: MOVES_SHARED_REF, sub: "push", when: "pushTo",
    what: "`git push`", why: "it changes refs other clones fetch." },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "checkout", when: "always",
    what: "`git checkout`", why: "it rewrites the files and HEAD of the checkout it runs in." },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "switch", when: "always",
    what: "`git switch`", why: "it rewrites the files and HEAD of the checkout it runs in." },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "reset", when: "flag", names: ["--hard"],
    what: "`git reset --hard`", why: "it rewrites the files and HEAD of the checkout it runs in." },
]);

/**
 * The long options in `names` that a typed `--name` stands for, the way
 * git's option parser reads it (#296): an exact spelling is that option,
 * and any shorter start of one is it too -- `--har` is `--hard`,
 * `--force-w` is `--force-with-lease`. A start that fits several counts as
 * all of them (git refuses an ambiguous one anyway); `--no-x` fits none.
 */
export function longNames(typed, names) {
  return names.includes(typed) ? [typed] : names.filter((n) => n.startsWith(typed));
}

/**
 * A git subcommand's args split into the flags it sets and its bare words,
 * skipping the values valued flags swallow: `-b name`, `--source x`, and a
 * short cluster's tail after a valued letter (`-sHEAD`). `--x=v` keeps `--x`.
 * A typed long option counts as each of `longs` it spells or shortens
 * (#296), and takes the next word when one of them is `valued`; `alias`
 * files a short letter under its long name (`f` is `--force`). `flags` is
 * every flag ever set, for the ones that refuse; `on` is each one's state
 * after any `--no-` negation, for the ones that make a command safe --
 * `git clean -n --no-dry-run` deletes. `typed` is the word that first set
 * each flag, cut at any `=` (#359): what a refusal names.
 */
export function readArgs(args, { short = "", longs = [], valued = [], alias = {} } = {}) {
  const flags = new Set();
  const on = new Map();
  const typed = new Map();
  const words = [];
  const set = (n, word) => {
    flags.add(n);
    on.set(n, true);
    if (!typed.has(n)) typed.set(n, word);
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const hit = longNames(name, longs);
      for (const n of hit) set(n, name);
      if (eq < 0 && hit.some((n) => valued.includes(n))) k++;
      if (!hit.length && name.startsWith("--no-")) {
        for (const n of longNames(`--${name.slice(5)}`, longs)) on.set(n, false);
      }
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        set(alias[a[c]] ?? `-${a[c]}`, a);
        if (short.includes(a[c])) {
          if (c === a.length - 1) k++; // value is the next word
          break; // ...or the rest of this one
        }
      }
      continue;
    }
    words.push(a);
  }
  return { flags, on, typed, words };
}

/**
 * True for a pathspec that names the whole tree rather than a file in it:
 * `.`, `./`, `..`, `../..`, `:/`, `:/.`, `:(top)`, and a bare glob (`*`,
 * `**`, `./*` -- a pathspec `*` crosses `/`). A single path -- `src/a.ts`,
 * `.gitignore`, `:/src`, `*.ts` -- is not.
 */
export function wholeTree(p) {
  return p !== "" && /^(?::\/|:\(top\))?(?:\.{1,2}(?:\/\.{1,2})*)?\/?\**$/.test(p);
}

/** True for a git config value that reads as true (`true`, `yes`, `on`, `1`, bare). */
export const truthy = (v) => !/^(false|no|off|0)$/i.test(String(v).trim());

/** A push's flags and bare words -- remote, then refspecs -- read once per invocation. */
export const pushArgs = (inv) => (inv.push ??= readArgs([...inv.args, ...inv.paths], PUSH_READ));

/**
 * A git command's words (from `git` on, wrappers already peeled) as an
 * invocation: the -C directories in order, the -c and --config-env values,
 * --git-dir / --work-tree / --bare as `opts`, the subcommand, its args (cut
 * at a bare `--`), and the paths past that `--`, which are paths, not flags
 * -- `git checkout -- .` (#264).
 */
export function parseInvocation(words) {
  let i = 1;
  const dirs = [];
  const configs = [];
  const configEnvs = [];
  const opts = {};
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C") dirs.push(words[i + 1] ?? "");
    if (w === "-c") configs.push(words[i + 1] ?? "");
    if (w === "--config-env") configEnvs.push(words[i + 1] ?? "");
    if (w.startsWith("--config-env=")) configEnvs.push(w.slice(13));
    // --git-dir and --work-tree, either form; the last one wins, as in git
    const where = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(w);
    if (where) opts[where[1] === "git-dir" ? "GIT_DIR" : "GIT_WORK_TREE"] = where[2] ?? words[i + 1] ?? "";
    if (w === "--bare") opts.bare = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  const rest = words.slice(i + 1);
  const dashes = rest.indexOf("--");
  return {
    dirs, configs, configEnvs, opts,
    sub: words[i] ?? "",
    args: dashes < 0 ? rest : rest.slice(0, dashes),
    paths: dashes < 0 ? [] : rest.slice(dashes + 1),
  };
}

/**
 * The word in `inv` that makes `row` match, or null when it doesn't. The
 * one place the table's `when` kinds are read.
 */
function rowCause(row, inv, probe) {
  if (row.sub !== inv.sub) return null;
  if (row.action !== undefined && inv.args[0] !== row.action) return null;
  const args = row.action !== undefined ? inv.args.slice(1) : inv.args;
  // past a bare `--` a push's words are still refspecs, not paths
  const parsed = () => (inv.sub === "push" ? pushArgs(inv) : readArgs(args, READS[inv.sub]));
  switch (row.when) {
    case "always":
      return row.action ?? inv.sub;
    case "flag": {
      const { flags, typed } = parsed();
      const hit = row.names.find((n) => flags.has(n));
      return hit === undefined ? null : typed.get(hit) ?? hit;
    }
    case "unlessOn":
      return parsed().on.get(row.name) === true ? null : inv.sub;
    case "wholeTree": {
      const { flags, on, typed, words } = parsed();
      // a restore writes the work tree unless only --staged is asked for,
      // and --no-staged takes that back
      if (row.stagedOnly && !flags.has("--worktree") && on.get("--staged") === true) return null;
      if (flags.has("--pathspec-from-file")) return typed.get("--pathspec-from-file");
      return [...words, ...inv.paths].find(wholeTree) ?? null;
    }
    case "pushTo": {
      // what decides where it lands: the push-everything flags, then remote and refspecs
      const { flags, typed, words } = pushArgs(inv);
      const sweeps = PUSH_SWEEPS.filter((n) => flags.has(n)).map((n) => typed.get(n));
      return ["push", ...sweeps, ...words].join(" ");
    }
    case "plusRef":
      return pushArgs(inv).words.find((w) => w.startsWith("+")) ?? null;
    case "config": {
      const hit = (inv.configs ?? []).find((c) => { const m = row.key.exec(c); return m && truthy(m[2] ?? "true"); });
      return hit === undefined ? null : `-c ${hit.split("=")[0]}`;
    }
    case "probe":
      return typeof probe?.[row.name] === "function" && probe[row.name](inv) ? row.cause : null;
  }
  return null;
}

/**
 * Every effect of a parsed git invocation, as [{ effect, flag, what, why }]
 * in table order -- `flag` the word that caused it. Empty means READ_ONLY.
 * `only` keeps one effect's rows; `first` stops at the first match, so a
 * probe the repository answers slowly runs only when nothing before it hit.
 * Rows that need the repository match only when `probe` says so.
 */
export function classify(inv, probe = {}, { only, first = false } = {}) {
  const out = [];
  for (const row of EFFECT_TABLE) {
    if (only !== undefined && row.effect !== only) continue;
    const flag = rowCause(row, inv, probe);
    if (flag === null || flag === undefined) continue;
    out.push({ effect: row.effect, flag, what: row.what, why: row.why });
    if (first) break;
  }
  return out;
}

/** The set of effect names a parsed invocation carries -- [READ_ONLY] when it carries none. */
export function effectsOf(inv, probe = {}) {
  const found = new Set(classify(inv, probe).map((c) => c.effect));
  return found.size ? EFFECTS.filter((e) => found.has(e)) : [READ_ONLY];
}

/**
 * The line a refusal adds naming the effect it refuses and the flag that
 * caused it, plus any other effect the same invocation carries (#359): a
 * hard reset of the owner's checkout both discards work and touches it.
 */
export function effectLine(inv, cause) {
  const others = effectsOf(inv).filter((e) => e !== cause.effect && e !== READ_ONLY);
  return `  effect: ${cause.effect}, from \`${cause.flag}\`` + (others.length ? `; also ${others.join(", ")}.` : ".");
}
