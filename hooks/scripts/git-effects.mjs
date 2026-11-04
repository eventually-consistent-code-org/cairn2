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
 *   remote's HEAD branch, a second worktree sharing the stash (#363), an
 *   alias from the user's configuration (#430) -- comes in through `probe`
 *   and resolveAlias's `lookup`, which the guard fills in per target and a
 *   test can stub. An alias is what it runs (#430): the inline `-c
 *   alias.<name>=<value>` ones are expanded as the words are parsed, so
 *   every reader of parseInvocation classifies the real subcommand. The
 *   other channels a command line defines config on (#467) -- --config-env,
 *   GIT_CONFIG_COUNT / KEY_n / VALUE_n -- are read through the `env` lookup
 *   the guard passes (the line's own prefix, then its environment) and
 *   folded into `configs` in git's order, so the same rows and the same
 *   alias walk see them; what the lookup can't read lands in `unread`.
 *   The push action has routes that never run git (#483): SIDE_DOOR_TABLE
 *   and sideDoor read a gh, curl or wget line for a merge, a ref write or
 *   a release at GitHub's API, as the one moves-shared-ref the guard
 *   gates by the same two rules as a push.
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
 * The subcommand a `!` shell alias resolves to (#430): git hands the rest
 * of the value to the shell as it stands, so there is no subcommand to
 * classify -- the table refuses this one word instead. No git command is
 * ever spelled `!`.
 */
export const SHELL_ALIAS = "!";

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
  reset: { longs: ["--hard", "--merge", "--keep"] },
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
  rm: { alias: { f: "--force", n: "--dry-run" },
    longs: ["--force", "--cached", "--dry-run", "--pathspec-from-file"], valued: ["--pathspec-from-file"] },
  worktree: { alias: { f: "--force" }, longs: ["--force"] },
  // #468 -- the owner-checkout rows that turn on a flag or are spared by one
  apply: { short: "pC", alias: { R: "--reverse" },
    longs: ["--check", "--stat", "--numstat", "--summary", "--cached", "--index", "--reverse", "--directory",
      "--exclude", "--include", "--whitespace", "--build-fake-ancestor"],
    valued: ["--directory", "--exclude", "--include", "--whitespace", "--build-fake-ancestor"] },
  "checkout-index": { alias: { f: "--force", a: "--all", u: "--index", n: "--no-create" },
    longs: ["--force", "--all", "--index", "--no-create", "--prefix", "--stage", "--temp", "--stdin"],
    valued: ["--prefix", "--stage"] },
  // read-tree's -u has no long spelling (builtin/read-tree.c); the row names `-u` itself
  "read-tree": { alias: { n: "--dry-run" },
    longs: ["--dry-run", "--prefix", "--index-output", "--exclude-per-directory"],
    valued: ["--prefix", "--index-output", "--exclude-per-directory"] },
  // #288 -- ref and reflog destruction; gc's --prune takes its date after `=` only
  "update-ref": { alias: { d: "--delete" }, longs: ["--delete", "--no-deref", "--stdin", "--create-reflog"] },
  gc: { longs: ["--prune", "--auto", "--aggressive"] },
  prune: { alias: { n: "--dry-run" }, longs: ["--dry-run", "--expire"], valued: ["--expire"] },
  push: PUSH_READ,
};

const DISCARDS = "it discards uncommitted work with no undo.";

// Why a touches-owner-checkout row refuses mid-run in the owner's checkout (#216, #435)
const REWRITES = "it rewrites the files or HEAD of the checkout it runs in.";

// Why an explicit gc prune date refuses (#288): the default keeps two weeks of unreachable objects
const PRUNES = "an explicit prune date reaches past the two weeks the default keeps -- `now` deletes every " +
  "unreachable object, the dangling commits a reflog or `git fsck --lost-found` would have recovered.";

// Why a stash pop, apply, drop or branch refuses once a repository has linked worktrees (#363, #438)
const SHARED_STASH = "the stash is shared by every worktree of this repository, so the entry it takes " +
  "may be another worktree's half-finished work. Park work in progress with a WIP commit on your own " +
  "branch instead, and squash it before the close.";

/**
 * The effect table (#249, #250, #264, #296, #414, #359, #434, #435, #438,
 * #464, #468, #288).
 * Each row: the effect, the subcommand, the first word it needs (`action`,
 * read off before the flags are -- one word or a list, where "" is git's
 * default action: no word, or an option first, as in a bare `git stash`),
 * and `when` -- one of:
 *   flag       any of `names` is set (spelled out, shortened, or a short
 *              alias); with `value`, a regexp, only when the `=value` typed
 *              with it, or the word it took, matches -- `gc --prune=now`,
 *              never the bare `--prune` that keeps the default (#288)
 *   wholeTree  a pathspec names the whole tree (wholeTree below: `.`, a
 *              glob, the colon magic of #464, the repository root as an
 *              absolute path through the `repoRoot` probe, #288), or
 *              --pathspec-from-file hides it; `needs` names the flag the
 *              row also wants and names (a forced rm, #434: unforced, git
 *              refuses a modified file itself)
 *   unlessOn   always, unless `name` -- one, or any of a list -- is on at
 *              the end (a dry run; `apply --check`)
 * and on any row, `sparesTree` names the flags that keep the write off the
 * work tree (`restore --staged`, `rm --cached`, `apply --cached`, a dry
 * run, `checkout-index --temp`): on, the row doesn't match (#434, #468).
 *   always     the subcommand (and action) alone
 *   pushTo     any push; the cause is what decides where it lands
 *   plusRef    a refspec with a leading `+`
 *   config     a `-c` setting matching `key` that reads as true
 *   probe      the repository says so: probe[name](inv) is true
 * The probes a wholeTree row asks on its own: `repoRoot(word)`, the
 * repository root when `word` is its absolute path (#288).
 * Rows are read in order; the first DISCARDS_WORK row that matches is the
 * one a refusal names. The everyday neighbours have no discards-work row
 * because they are routine or recoverable: a single-path checkout/restore
 * and a forced single-path `rm` (#434) -- which touch the checkout they
 * run in and nothing more, #468 -- `branch -D` (its reflog keeps the
 * commits), `restore --staged .` and `rm --cached .` (the index only, like
 * a plain `git reset`), deleting a feature branch, and `clean -n`.
 *
 * Refs (#288): a deleted branch is recoverable -- HEAD's reflog keeps the
 * commits of any branch that was checked out, and `git fsck --lost-found`
 * finds the rest as dangling objects -- until something prunes them. So
 * `branch -D` stays off the table, and the commands that make its loss
 * final are rows: `reflog delete` and `reflog expire` (the record), a
 * `prune` that isn't a dry run and `gc` with an explicit prune date, typed
 * or set inline as gc.pruneExpire (the objects), and `update-ref -d` (any
 * ref, with its reflog, and none of `branch -d`'s checks). Their twins --
 * a ref written, the reflog read, the default gc, `branch -D` itself --
 * carry no row. Not seen, dated 2026-11-04: an `update-ref --stdin` batch
 * whose delete lines arrive on stdin, and a gc.pruneExpire set in the
 * repository's or the user's config rather than on the line. Asserted by
 * runguard-effects.test.ts and runguard-guards.test.ts (#288).
 *
 * Stash (#363): one `.git` means one stash, so with linked worktrees a pop,
 * apply or drop can take another worktree's work -- those rows, and the
 * branch action, which is pop plus a checkout (#438), ask the
 * `linkedWorktrees` probe (`git worktree list --porcelain` reports more
 * than one entry). With one worktree they never match and the guard is
 * unchanged byte for byte. `stash push`, `save` and a bare `stash` are the
 * recoverable half and have no discards-work row -- the table refuses, it
 * doesn't advise; the run guard emits their advisory itself. `stash
 * list|show` stay reads. Asserted by runguard-effects.test.ts and
 * runguard-guards.test.ts (#363, #438).
 *
 * Owner checkout (#216, #435, #468): a command touches the checkout it
 * runs in when it rewrites the working files, or replaces the checked-out
 * commit with another -- checkout, switch, merge, pull, rebase,
 * cherry-pick, revert, am, mv, the stash actions that write the tree
 * (push, save, a bare stash, pop, apply, branch), reset in its hard, merge
 * and keep forms, and (#468) apply, bisect in the actions that move HEAD
 * (start, bad, good, new, old, skip, reset, replay, run), restore,
 * checkout-index --force, sparse-checkout set / add / reapply / disable /
 * init, read-tree -u, submodule update and deinit, rm, and clean. A
 * commit adds to the branch and leaves the files as the human left them;
 * add, rm --cached, restore --staged, apply --cached and a soft or mixed
 * reset touch the index only; a dry run, apply --check / --stat,
 * checkout-index --temp, bisect log / visualize / terms, sparse-checkout
 * list, submodule status / init and the reads touch nothing -- none has a
 * row. The run guard refuses the effect only mid-run, aimed at the owner's
 * checkout. Asserted by runguard-effects.test.ts (the subcommand list is
 * pinned) and runguard-guards.test.ts (#435, #468).
 *
 * Aliases (#430): a row's `sub` is the subcommand git runs, so an alias is
 * resolved to it before the table is read (resolveAlias) and needs no row
 * of its own -- `git -c 'alias.hr=reset --hard' hr` matches the hard-reset
 * rows. The one row an alias adds is the shell alias, SHELL_ALIAS: a `!`
 * value goes to the shell as it stands, a file delete as easily as a
 * reset, and nothing on this table can read it, so it is refused as if it
 * discarded work, in every session, under the same owner's escape as the
 * other discards-work rows. Asserted by runguard-effects.test.ts and
 * runguard-guards.test.ts (#430).
 *
 * Two more rows read the same way (#467), and apply to every subcommand
 * (no `sub`): an include set on the line (`-c include.path=F`, or the
 * same key through --config-env or GIT_CONFIG_KEY_n) pulls a file's every
 * setting in -- an alias, a mirror, a prune date -- unread here, so the
 * command is refused outright; and a setting this table reads (an alias,
 * `remote.<r>.mirror`, `gc.pruneExpire`, an include) whose value sits
 * where the guard can't read it -- a variable neither the prefix nor the
 * environment holds, a `$` expansion, GIT_CONFIG_PARAMETERS set by hand,
 * a numbered entry with no key or value -- is refused the same way
 * (`inv.unread`, filled by parseInvocation's `env` lookup and envConfig).
 * A setting the table never reads is left to git whatever its value:
 * `--config-env=core.editor=E status` passes. Asserted by
 * runguard-guards.test.ts (#467).
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
  { effect: DISCARDS_WORK, sub: "restore", when: "wholeTree", sparesTree: ["--staged"],
    what: "a whole-tree `git restore`", why: DISCARDS },
  { effect: DISCARDS_WORK, sub: "rm", when: "wholeTree", needs: ["--force"], sparesTree: ["--cached", "--dry-run"],
    what: "a forced whole-tree `git rm`", why: DISCARDS },
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
  { effect: DISCARDS_WORK, sub: "stash", action: "branch", when: "probe", name: "linkedWorktrees",
    cause: "more than one worktree", what: "`git stash branch`", why: SHARED_STASH },
  { effect: DISCARDS_WORK, sub: "reflog", action: "expire", when: "always",
    what: "`git reflog expire`", why: "it erases the record git recovers lost commits from." },
  // #288 -- the rest of ref and reflog destruction: what makes a deleted
  // branch unrecoverable. `branch -D` itself stays off the table (below).
  { effect: DISCARDS_WORK, sub: "reflog", action: "delete", when: "always",
    what: "`git reflog delete`", why: "it erases the record git recovers lost commits from." },
  { effect: DISCARDS_WORK, sub: "update-ref", when: "flag", names: ["--delete"],
    what: "`git update-ref -d`", why: "it deletes any ref outright -- plumbing with none of `branch -d`'s checks -- " +
      "and takes the ref's reflog with it, so nothing is left to find its commits by." },
  { effect: DISCARDS_WORK, sub: "gc", when: "flag", names: ["--prune"], value: /^(?!(?:never|false)$)./i,
    what: "`git gc --prune=<date>`", why: PRUNES },
  { effect: DISCARDS_WORK, sub: "gc", when: "config", key: /^gc\.pruneExpire(?:=(?!(?:never|false)$)(.*))?$/i,
    what: "`git gc --prune=<date>`", why: PRUNES },
  { effect: DISCARDS_WORK, sub: "prune", when: "unlessOn", name: "--dry-run",
    what: "`git prune`", why: "a bare prune deletes every unreachable object at once, and --expire only narrows " +
      "it: the dangling commits a reflog or `git fsck --lost-found` would have recovered are gone." },
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
  // #430 -- a `!` alias: git runs the rest in the shell, unread by this table
  { effect: DISCARDS_WORK, sub: SHELL_ALIAS, when: "always", what: "a `!` shell alias",
    why: "git hands what follows the `!` to the shell as it stands, so whether it discards work can't be " +
      "read off the effect table; it is refused as if it did." },
  // #467 -- an include on the line: a file's every setting, unread here; any subcommand
  { effect: DISCARDS_WORK, when: "config", key: /^include(?:if\.[^=]*)?\.path(?:=(.*))?$/i,
    what: "a `-c include.path` include",
    why: "git reads every setting in the included file -- an alias, a mirror, a prune date -- and this guard reads " +
      "none of them before the line runs, so what the command does can't be told; it is refused as if it discarded " +
      "work. Put the setting on the line itself (`-c key=value`) and the guard can judge it." },
  // #467 -- a setting this table reads, from a value the guard can't; any subcommand
  { effect: DISCARDS_WORK, when: "unread", key: /^(?:alias\.|include(?:if\.[^=]*)?\.path$|remote\..+\.mirror$|gc\.pruneexpire$)/i,
    what: "a git setting from a value the guard can't read",
    why: "the value sits in an environment variable or a shell expansion the guard can't see, and the setting " +
      "decides what the command does (an alias, a mirror, a prune date); set it on the line itself " +
      "(`VAR=value git ...`, or `-c key=value`) so the guard can read it, or run the plain command." },
  { effect: MOVES_SHARED_REF, sub: "push", when: "pushTo",
    what: "`git push`", why: "it changes refs other clones fetch." },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "checkout", when: "always", what: "`git checkout`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "switch", when: "always", what: "`git switch`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "reset", when: "flag", names: ["--hard"],
    what: "`git reset --hard`", why: REWRITES },
  // #435 -- the rest of the commands the definition names
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "reset", when: "flag", names: ["--merge"],
    what: "`git reset --merge`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "reset", when: "flag", names: ["--keep"],
    what: "`git reset --keep`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "merge", when: "always", what: "`git merge`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "pull", when: "always", what: "`git pull`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "rebase", when: "always", what: "`git rebase`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "cherry-pick", when: "always", what: "`git cherry-pick`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "revert", when: "always", what: "`git revert`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "am", when: "always", what: "`git am`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "mv", when: "always", what: "`git mv`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "stash", action: ["", "push", "save"], when: "always",
    what: "`git stash push`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "stash", action: "pop", when: "always", what: "`git stash pop`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "stash", action: "apply", when: "always", what: "`git stash apply`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "stash", action: "branch", when: "always", what: "`git stash branch`", why: REWRITES },
  // #468 -- the rest of the commands the definition names: each rewrites
  // the working files or moves HEAD; its twin is the same command kept off
  // the work tree (a check, a stat, --cached, --staged, a dry run, --temp)
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "apply", when: "unlessOn", name: ["--check", "--stat", "--numstat", "--summary"],
    sparesTree: ["--cached"], what: "`git apply`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "bisect", when: "always",
    action: ["start", "bad", "good", "new", "old", "skip", "reset", "replay", "run"], what: "`git bisect`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "restore", when: "always", sparesTree: ["--staged"],
    what: "`git restore`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "checkout-index", when: "flag", names: ["--force"], sparesTree: ["--temp"],
    what: "`git checkout-index --force`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "sparse-checkout", when: "always",
    action: ["set", "add", "reapply", "disable", "init"], what: "`git sparse-checkout`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "read-tree", when: "flag", names: ["-u"], sparesTree: ["--dry-run"],
    what: "`git read-tree -u`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "submodule", action: "update", when: "always",
    what: "`git submodule update`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "submodule", action: "deinit", when: "always",
    what: "`git submodule deinit`", why: REWRITES },
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "rm", when: "always", sparesTree: ["--cached", "--dry-run"],
    what: "`git rm`", why: REWRITES },
  // the #288 fold: with discards-work overridden for the session, a clean
  // of the owner's checkout mid-run is still refused, as a hard reset is
  { effect: TOUCHES_OWNER_CHECKOUT, sub: "clean", when: "unlessOn", name: "--dry-run", what: "`git clean`", why: REWRITES },
]);

// The subcommands the table knows (#430). In git a builtin wins over an
// alias of its own name, so none of these is ever resolved as one -- an
// alias can't disguise a hard reset as something else. A row with no
// `sub` applies to every subcommand (#467) and names none here.
const TABLED = new Set(EFFECT_TABLE.map((row) => row.sub).filter((sub) => sub !== undefined));

/**
 * An alias value split into words the way git does it (#430, split_cmdline):
 * whitespace separates, a single or double quote groups, and a backslash
 * takes the next character literally except inside single quotes. An
 * unclosed quote, which git refuses, runs to the end of the value here.
 */
export function aliasWords(value) {
  const words = [];
  let cur = null;
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (!quote && /\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (!quote && (c === "'" || c === '"')) {
      quote = c;
      cur ??= "";
    } else if (c === quote) {
      quote = "";
    } else if (c === "\\" && quote !== "'" && i + 1 < value.length) {
      cur = (cur ?? "") + value[++i];
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

/**
 * The value an inline `-c alias.<name>=<value>` of `inv` gives `name`
 * (#430), as git reads it: the last one wins, the key in any letter case.
 * Undefined when none does, or for a bare `-c alias.<name>` (git refuses
 * it as a missing value).
 */
export function inlineAlias(inv, name) {
  const want = `alias.${name.toLowerCase()}`;
  let found;
  for (const c of inv.configs) {
    const eq = c.indexOf("=");
    if (eq > 0 && c.slice(0, eq).toLowerCase() === want) found = c.slice(eq + 1);
  }
  return found;
}

/**
 * Resolves the subcommand of `inv` through its aliases, in place, the way
 * git runs them (#430): a subcommand on the table is a builtin and wins
 * over an alias of its own name; otherwise the inline `-c` value, or what
 * `lookup(name)` gives back (the guard asks git for the configured one),
 * is the alias. Its words go ahead of the typed args as a new git command
 * line -- so a value may carry top-level options and a `--` of its own --
 * and the result is resolved again until the name is no alias, or repeats
 * (git refuses the loop; the words stay as last expanded). A `!` value
 * ends the walk with `sub` SHELL_ALIAS. An empty value, which git fails,
 * leaves the words as typed. `alias` on the result is the name first
 * typed, for the refusal to name; the dirs, configs, opts and unread
 * settings gathered so far are kept, the expansion's own coming after
 * them -- read through the same `env` lookup the invocation was parsed
 * with (#467), so a --config-env inside an alias value is folded too.
 */
export function resolveAlias(inv, lookup = () => undefined) {
  const seen = new Set();
  while (inv.sub && !TABLED.has(inv.sub) && !seen.has(inv.sub)) {
    seen.add(inv.sub);
    const value = inlineAlias(inv, inv.sub) ?? lookup(inv.sub);
    if (typeof value !== "string" || value === "") return inv;
    inv.alias ??= inv.sub;
    if (value.startsWith("!")) {
      inv.sub = SHELL_ALIAS;
      inv.shell = value.slice(1);
      return inv;
    }
    const tail = inv.paths.length ? ["--", ...inv.paths] : [];
    const next = parseInvocation(["git", ...aliasWords(value), ...inv.args, ...tail], { aliases: false, env: inv.readEnv });
    Object.assign(inv, {
      dirs: [...inv.dirs, ...next.dirs],
      configs: [...inv.configs, ...next.configs],
      configEnvs: [...inv.configEnvs, ...next.configEnvs],
      unread: [...inv.unread, ...next.unread],
      opts: { ...inv.opts, ...next.opts },
      sub: next.sub, args: next.args, paths: next.paths,
    });
  }
  return inv;
}

/**
 * True for a value the shell would still work out (#467): a `$` or a
 * backtick anywhere in it. Quotes are gone by the time a prefix assignment
 * reaches here, so `HR="$X"` and `HR='$X'` both read as `$X` -- the literal
 * is refused along with the expansion, which nobody types as an alias.
 */
const expands = (value) => /[$`]/.test(value);

/**
 * The config a command's own prefix defines through the environment (#467),
 * as { configs, unread }: GIT_CONFIG_COUNT with its GIT_CONFIG_KEY_n and
 * GIT_CONFIG_VALUE_n entries as `key=value` strings, in order, and a
 * GIT_CONFIG_PARAMETERS set by hand (git's own carrier for -c values,
 * sq-quoted) as unread -- key `*`, every setting at once. `env(name)` gives
 * a variable's value, or undefined when the guard can't read it. A count
 * that isn't a plain number, or past ENV_CONFIG_MAX, a key or value the
 * lookup can't give, or one the shell would expand: unread, named by the
 * variable. git reads these entries before the -c ones (measured, git
 * 2.56, 2026-11-04), so the caller puts them first.
 */
export const ENV_CONFIG_MAX = 64;
export function envConfig(env) {
  const configs = [];
  const unread = [];
  if (env("GIT_CONFIG_PARAMETERS") !== undefined) unread.push({ key: "*", from: "GIT_CONFIG_PARAMETERS" });
  const count = env("GIT_CONFIG_COUNT");
  if (count === undefined) return { configs, unread };
  if (!/^\d+$/.test(count) || Number(count) > ENV_CONFIG_MAX) {
    unread.push({ key: "*", from: "GIT_CONFIG_COUNT" });
    return { configs, unread };
  }
  for (let n = 0; n < Number(count); n++) {
    const key = env(`GIT_CONFIG_KEY_${n}`);
    const value = env(`GIT_CONFIG_VALUE_${n}`);
    if (key === undefined || expands(key)) unread.push({ key: "*", from: `GIT_CONFIG_KEY_${n}` });
    else if (value === undefined || expands(value)) unread.push({ key, from: `GIT_CONFIG_VALUE_${n}` });
    else configs.push(`${key}=${value}`);
  }
  return { configs, unread };
}

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
 * each flag, cut at any `=` (#359): what a refusal names. `values` is what
 * a long option was last given -- after its `=`, or the word it took --
 * for the rows that read one (`gc --prune=now`, #288).
 */
export function readArgs(args, { short = "", longs = [], valued = [], alias = {} } = {}) {
  const flags = new Set();
  const on = new Map();
  const typed = new Map();
  const values = new Map();
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
      if (eq >= 0) for (const n of hit) values.set(n, a.slice(eq + 1));
      if (eq < 0 && hit.some((n) => valued.includes(n))) {
        for (const n of hit) values.set(n, args[k + 1] ?? "");
        k++;
      }
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
  return { flags, on, typed, values, words };
}

/**
 * True for a pathspec that names the whole tree rather than a file in it:
 * `.`, `./`, `..`, `../..`, a bare glob (`*`, `**`, `./*` -- a pathspec
 * `*` crosses `/`), and the magic spellings git reads as everything (#464):
 * a lone `:`, `::`, `:/`, `:/:`, `:/.`, `:(top)`, and any long-form magic
 * with no path after it (`:(glob,top)`, `:(icase)` -- measured against git
 * 2.56, 2026-11-04: `git rm -rfn -- :` lists every tracked file). With
 * `root`, the repository's own absolute path, that path too -- `/repo`,
 * `/repo/`, `/repo/.`, `/repo/*` (#288); only the repository knows its
 * root, so the guard's repoRoot probe supplies it per word. A single path
 * -- `src/a.ts`, `.gitignore`, `:/src`, `::src`, `*.ts`, `/repo/src` --
 * is not, and nor are the exclude forms (`:!x`, `:(exclude)x`): paths, by
 * decision (phase 31, 2026-11-04). Asserted by runguard-effects.test.ts
 * and runguard-guards.test.ts (#464).
 */
export function wholeTree(p, root) {
  if (p === "") return false;
  if (/^(?::(?:\/*:?|\((?!(?:\w+,)*exclude\b)\w+(?:,\w+)*\)))?(?:\.{1,2}(?:\/\.{1,2})*)?\/?\**$/.test(p)) return true;
  return root !== undefined && root !== null && bareRoot(p) === bareRoot(root);
}

/** A folder path with its trailing `/`, `/.` and `/*` spellings dropped -- what names the folder itself (#288). */
const bareRoot = (p) => p.replace(/(?:\/\.|\/\*+|\/)+$/, "") || "/";

/** True for a git config value that reads as true (`true`, `yes`, `on`, `1`, bare). */
export const truthy = (v) => !/^(false|no|off|0)$/i.test(String(v).trim());

/** A push's flags and bare words -- remote, then refspecs -- read once per invocation. */
export const pushArgs = (inv) => (inv.push ??= readArgs([...inv.args, ...inv.paths], PUSH_READ));

/**
 * A git command's words (from `git` on, wrappers already peeled) as an
 * invocation: the -C directories in order, the -c and --config-env values,
 * --git-dir / --work-tree / --bare as `opts`, the subcommand, its args (cut
 * at a bare `--`), and the paths past that `--`, which are paths, not flags
 * -- `git checkout -- .` (#264). An inline `-c alias.<name>=<value>` naming
 * the subcommand is expanded in place (#430, resolveAlias), so `sub` is
 * what git runs and `alias` the name typed; `aliases: false` leaves it,
 * for the expansion's own re-parse. With `env`, a lookup from a variable's
 * name to its value (undefined: can't read), each --config-env is folded
 * into `configs` at its place in line order as `key=value` (#467) -- the
 * last on a key wins, as in git -- or into `unread` as { key, from } when
 * the variable can't be read or the shell would still expand it; the
 * lookup is kept as `readEnv` for the alias walk. Without `env` the
 * --config-env values stay unread to this module (`configEnvs` only).
 */
export function parseInvocation(words, { aliases = true, env } = {}) {
  let i = 1;
  const dirs = [];
  const configs = [];
  const configEnvs = [];
  const unread = [];
  const opts = {};
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C") dirs.push(words[i + 1] ?? "");
    if (w === "-c") configs.push(words[i + 1] ?? "");
    const spec = w === "--config-env" ? words[i + 1] ?? "" : w.startsWith("--config-env=") ? w.slice(13) : undefined;
    if (spec !== undefined) {
      configEnvs.push(spec);
      if (env) {
        // `key=VAR`: the setting, and the variable git reads it from
        const eq = spec.lastIndexOf("=");
        const key = eq < 0 ? spec : spec.slice(0, eq);
        const value = eq < 0 ? undefined : env(spec.slice(eq + 1));
        if (value === undefined || expands(value)) unread.push({ key, from: w === "--config-env" ? `--config-env ${spec}` : w });
        else configs.push(`${key}=${value}`);
      }
    }
    // --git-dir and --work-tree, either form; the last one wins, as in git
    const where = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(w);
    if (where) opts[where[1] === "git-dir" ? "GIT_DIR" : "GIT_WORK_TREE"] = where[2] ?? words[i + 1] ?? "";
    if (w === "--bare") opts.bare = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  const rest = words.slice(i + 1);
  const dashes = rest.indexOf("--");
  const inv = {
    dirs, configs, configEnvs, unread, opts,
    sub: words[i] ?? "",
    args: dashes < 0 ? rest : rest.slice(0, dashes),
    paths: dashes < 0 ? [] : rest.slice(dashes + 1),
  };
  if (env) inv.readEnv = env;
  return aliases ? resolveAlias(inv) : inv;
}

/**
 * The word in `inv` that makes `row` match, or null when it doesn't. The
 * one place the table's `when` kinds are read.
 */
function rowCause(row, inv, probe) {
  // a row with no `sub` applies to every subcommand (#467: the include and unread rows)
  if (row.sub !== undefined && row.sub !== inv.sub) return null;
  // the action word: the first arg, or "" when there is none or it is an
  // option -- git's default action, as in a bare `git stash` (#435)
  const first = inv.args[0] === undefined || inv.args[0].startsWith("-") ? "" : inv.args[0];
  if (row.action !== undefined && ![].concat(row.action).includes(first)) return null;
  const args = row.action !== undefined && first !== "" ? inv.args.slice(1) : inv.args;
  // past a bare `--` a push's words are still refspecs, not paths; read once per row
  let read;
  const parsed = () => (read ??= inv.sub === "push" ? pushArgs(inv) : readArgs(args, READS[inv.sub]));
  // the write stays off the work tree, whatever the row's `when` (#434,
  // #468): `restore --staged` (unless --worktree is on too), `rm --cached`,
  // `apply --cached`, a dry run, `checkout-index --temp`; a --no- takes any
  // of them back
  if (row.sparesTree) {
    const { flags, on } = parsed();
    if (row.sparesTree.some((n) => on.get(n) === true) && !flags.has("--worktree")) return null;
  }
  switch (row.when) {
    case "always":
      // the action word it matched, or the subcommand for a row without one or a bare stash
      return row.action === undefined ? inv.sub : first || inv.sub;
    case "flag": {
      const { flags, typed, values } = parsed();
      // a row with `value` wants the flag's value to match too (#288): `--prune=now`, not a bare `--prune`
      const hit = row.names.find((n) => flags.has(n) && (row.value === undefined || row.value.test(values.get(n) ?? "")));
      return hit === undefined ? null : typed.get(hit) ?? hit;
    }
    case "unlessOn": {
      // one name or a list (#468): `apply --check`, `--stat`, `--numstat`, `--summary` apply nothing
      const { on } = parsed();
      return [].concat(row.name).some((n) => on.get(n) === true) ? null : inv.sub;
    }
    case "wholeTree": {
      const { flags, typed, words } = parsed();
      // a row that also needs a flag names it: `-rf`, not `.` (#434)
      const need = row.needs?.find((n) => flags.has(n));
      if (row.needs && need === undefined) return null;
      // the repository root as an absolute path is the whole tree too (#288):
      // the repoRoot probe answers per word, or no word is the root
      const root = typeof probe?.repoRoot === "function" ? probe.repoRoot : () => undefined;
      const tree = flags.has("--pathspec-from-file") ? typed.get("--pathspec-from-file")
        : [...words, ...inv.paths].find((w) => wholeTree(w, root(w))) ?? null;
      return tree === null || need === undefined ? tree : typed.get(need) ?? need;
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
    case "unread": {
      // a setting the guard couldn't read (#467): the row's keys, or `*` -- a channel whose keys it can't even list
      const hit = (inv.unread ?? []).find((u) => u.key === "*" || row.key.test(u.key));
      return hit === undefined ? null : hit.from;
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
 * A command that got there through an alias names the alias too (#430):
 * the flag is a word the reader never typed.
 */
export function effectLine(inv, cause) {
  const others = effectsOf(inv).filter((e) => e !== cause.effect && e !== READ_ONLY);
  const via = inv.alias === undefined ? "" : `, via alias \`${inv.alias}\``;
  return `  effect: ${cause.effect}, from \`${cause.flag}\`${via}` + (others.length ? `; also ${others.join(", ")}.` : ".");
}

// Side doors to the push action (#483)

// Why a route that merges a pull request is a push.
const MERGES_PR = "it merges a pull request onto its base branch, as a push would.";

/**
 * The GraphQL mutations that merge a pull request or move a ref (a claim
 * about GitHub's schema, dated 2026-11-04): what a `gh api graphql` or a
 * curl to /graphql can do that a REST path above does.
 */
const REF_MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|createRef|updateRef|updateRefs|deleteRef|createCommitOnBranch)\b/;

/**
 * The side-door table (#483): the routes to "move a shared ref" that never
 * run git, each the effect MOVES_SHARED_REF. Two kinds of row:
 *   a gh command  `sub` and `action` (`gh pr merge`, `gh release create`,
 *                 `gh repo delete`); `branchOpt` names the option that
 *                 says which branch (a release's --target), `deletes` what
 *                 the command deletes outright
 *   an API path   `path`, a regexp on the endpoint's path, reached by `gh
 *                 api`, curl or wget with a write method (API_PROGRAMS);
 *                 `ref` is the capture group naming the ref, `field` the
 *                 request field naming the branch instead (a merge's
 *                 `base`, a release's `target_commitish`, a created ref's
 *                 `ref`), `mutation` the GraphQL names a body must carry
 * A row that names no branch leaves `branch` undefined: the guard takes
 * the target as the default branch, fail closed on the cheaper read
 * (decided phase 31, 2026-11-04) -- a PR's base is only known to the API.
 * Reads (`gh pr view`, a GET, curl with no method or data), `gh pr
 * create`, `gh pr comment` and a write to any other path have no row.
 * Asserted by runguard-effects.test.ts (one test per row),
 * runguard-guards.test.ts (#483) and runguard-sidedoors.test.ts (#484).
 */
export const SIDE_DOOR_TABLE = Object.freeze([
  { route: "gh pr merge", sub: "pr", action: "merge", what: "`gh pr merge`", why: MERGES_PR },
  { route: "gh release create", sub: "release", action: "create", branchOpt: "--target",
    what: "`gh release create`", why: "it creates a tag on the remote, a ref every clone fetches." },
  { route: "gh repo delete", sub: "repo", action: "delete", deletes: "the repository and every ref in it",
    what: "`gh repo delete`", why: "it deletes the repository and every ref in it." },
  { route: "pull request merge", path: /\/pulls\/\d+\/merge\/?$/i, why: MERGES_PR },
  { route: "ref write", path: /\/git\/refs(?:\/(.+?))?\/?$/i, ref: 1, field: "ref",
    why: "it creates, moves or deletes a ref on the remote, as a push would." },
  { route: "branch merge", path: /\/merges\/?$/i, field: "base",
    why: "it merges one branch into another on the remote, as a push would." },
  { route: "release", path: /\/releases(?:\/\d+|\/tags\/[^/]+)?\/?$/i, field: "target_commitish",
    why: "it creates or changes a release, and the tag it stands on." },
  { route: "GraphQL mutation", path: /\/graphql\/?$/i, mutation: REF_MUTATIONS,
    why: "a GraphQL mutation can merge a pull request or move a ref, as a push would." },
]);

/** The programs that reach the API-path rows, by the name a line spells. */
export const API_PROGRAMS = Object.freeze(["gh api", "curl", "wget"]);

// The gh subcommands the table knows: builtins in gh, never expanded as an
// alias -- gh refuses `gh alias set pr ...` itself, so a line that sets one
// can't unrefuse the merge.
const GH_TABLED = new Set(SIDE_DOOR_TABLE.map((r) => r.sub).filter((s) => s !== undefined).concat("api"));

// How each program's args are read (readOpts): the options that take a
// value, and the short letters that stand for them (pflag for gh, getopt
// for curl and wget). Only the options this table reads need listing; a
// value left unread is a bare word nothing here looks at.
const GH_SUB_READ = { valued: ["--repo", "--target"], alias: { R: "--repo" } };
const GH_API_READ = {
  valued: ["--method", "--raw-field", "--field", "--header", "--jq", "--template", "--preview", "--hostname",
    "--input", "--cache"],
  alias: { X: "--method", f: "--raw-field", F: "--field", H: "--header", q: "--jq", t: "--template", p: "--preview" },
};
const CURL_READ = {
  valued: ["--request", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json",
    "--form", "--form-string", "--upload-file", "--header", "--url", "--user", "--user-agent", "--cookie",
    "--cookie-jar", "--continue-at", "--dump-header", "--referer", "--cert", "--config", "--max-time", "--output",
    "--ftp-port", "--quote", "--range", "--telnet-option", "--proxy-user", "--write-out", "--proxy",
    "--speed-time", "--speed-limit", "--time-cond", "--oauth2-bearer", "--url-query", "--variable", "--retry",
    "--connect-timeout", "--max-redirs", "--limit-rate", "--output-dir", "--key", "--cacert", "--resolve",
    "--interface"],
  alias: { A: "--user-agent", b: "--cookie", c: "--cookie-jar", C: "--continue-at", d: "--data", D: "--dump-header",
    e: "--referer", E: "--cert", F: "--form", H: "--header", K: "--config", m: "--max-time", o: "--output",
    P: "--ftp-port", Q: "--quote", r: "--range", t: "--telnet-option", T: "--upload-file", u: "--user",
    U: "--proxy-user", w: "--write-out", x: "--proxy", X: "--request", y: "--speed-time", Y: "--speed-limit",
    z: "--time-cond", G: "--get", I: "--head" },
};
const WGET_READ = {
  valued: ["--method", "--post-data", "--post-file", "--body-data", "--body-file", "--header", "--output-document",
    "--output-file", "--append-output", "--directory-prefix", "--user-agent", "--timeout", "--tries", "--user",
    "--password", "--http-user", "--http-password", "--referer", "--load-cookies", "--save-cookies"],
  alias: { O: "--output-document", o: "--output-file", a: "--append-output", P: "--directory-prefix",
    U: "--user-agent", T: "--timeout", t: "--tries" },
};

// The request bodies curl and wget send, by the option that carries them.
const CURL_BODIES = ["--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form",
  "--form-string"];
const WGET_BODIES = ["--post-data", "--post-file", "--body-data", "--body-file"];

// The methods that read; everything else writes.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A non-git program's args, read the way pflag and getopt read them
 * (#483): `--name=v` and `--name v` for a `valued` long name, `-x v` and
 * `-xv` for a short letter `alias` files under one, any other `-` word a
 * switch, and the bare words in order; past a bare `--` every word is
 * bare. `flags` is every name set; `values`, every value a name was
 * given, in order.
 */
export function readOpts(args, { valued = [], alias = {} } = {}) {
  const flags = new Set();
  const values = new Map();
  const words = [];
  const give = (n, v) => {
    flags.add(n);
    if (v !== undefined) values.set(n, [...(values.get(n) ?? []), v]);
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--") {
      words.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (eq >= 0) give(name, a.slice(eq + 1));
      else if (valued.includes(name)) give(name, args[++k] ?? "");
      else give(name);
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        const name = alias[a[c]] ?? `-${a[c]}`;
        if (valued.includes(name)) {
          give(name, a.slice(c + 1) || (args[++k] ?? ""));
          break;
        }
        give(name);
      }
      continue;
    }
    words.push(a);
  }
  return { flags, values, words };
}

/**
 * The path a word names at GitHub's API (#483), query and fragment
 * dropped, or null: for gh, its endpoint as typed (`repos/o/r/...`,
 * `/repos/...`) or any URL's path, an enterprise host's `/api/v3` prefix
 * cut off; for curl and wget (`url` true), only a URL at api.github.com,
 * or one whose path starts `/api/v3/` -- GitHub Enterprise's REST root (a
 * dated claim, 2026-11-04) -- is GitHub's.
 */
export function apiPath(word, { url = false } = {}) {
  const m = /^(?:https?:\/\/([^/?#]+))?([^?#]*)/i.exec(String(word));
  if (!m) return null;
  const host = m[1];
  let path = m[2];
  if (host === undefined && url) return null;
  if (host !== undefined && url && !/^api\.github\.com$/i.test(host) && !/^\/api\/v3\//i.test(path)) return null;
  if (host === undefined && !url && /^[a-z]+:/i.test(word)) return null; // some other scheme
  path = path.replace(/^\/api\/v3(?=\/)/i, "");
  return `/${path.replace(/^\/+/, "")}`;
}

/**
 * The `[name, words]` a `gh alias set NAME VALUE` on a line defines
 * (#483), the value split as gh splits it (aliasWords), or null: for any
 * other gh command, a missing value, or a `--shell` / `!` alias -- that
 * one runs a shell line, judged by the reader already (#315), never
 * expanded here. `args` are the words after `gh`.
 */
export function ghAliasSet(args) {
  if (args[0] !== "alias" || args[1] !== "set") return null;
  const bare = [];
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      bare.push(...args.slice(i + 1));
      break;
    }
    if (a === "-s" || /^--shell(?:=true)?$/.test(a)) return null;
    if (!a.startsWith("-")) bare.push(a);
  }
  const [name, value] = bare;
  if (typeof name !== "string" || typeof value !== "string" || value.startsWith("!")) return null;
  const words = aliasWords(value);
  return words.length ? [name, words] : null;
}

/**
 * A request body's fields as [key, value] pairs (#483): a `k=v` word (gh's
 * -f / -F, curl's --data-urlencode, a form), a `k=v&k2=v2` string, or a
 * JSON object's top-level strings. A body the guard can't read -- `@file`,
 * `@-` for stdin -- is the pair ["@", word], for the rows that refuse it.
 */
function bodyFields(bodies) {
  const out = [];
  for (const b of bodies) {
    if (b.startsWith("@")) {
      out.push(["@", b]);
      continue;
    }
    if (/^\s*\{/.test(b)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(b))) out.push([k, typeof v === "string" ? v : JSON.stringify(v)]);
        continue;
      } catch {
        // not JSON after all: read as k=v below
      }
    }
    for (const part of b.split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const v = part.slice(eq + 1);
      out.push(v.startsWith("@") ? ["@", v] : [part.slice(0, eq), v]);
    }
  }
  return out;
}

/**
 * The branch a ref write names (#483): `heads/x` and `refs/heads/x` are
 * branch x, as git reads them; a tag or any other ref keeps its name,
 * which is never a default branch's.
 */
const refBranch = (ref) => ref.replace(/^refs\//, "").replace(/^heads\//, "");

/**
 * The API-path cause of one `program` (an API_PROGRAMS name) with `args`
 * after it, or null: the method, the endpoint and the body read by the
 * program's own options, then the path rows of SIDE_DOOR_TABLE. A write
 * is any method but GET, HEAD and OPTIONS; with no method typed, gh posts
 * when it has fields or an input (a claim about gh 2.x, 2026-11-04), curl
 * posts data and puts an upload, wget posts a body. A GraphQL request
 * whose body sits in a file or on stdin is refused unread, like an include
 * on a git line (#467).
 */
function apiSideDoor(program, args) {
  const spec = program === "gh api" ? GH_API_READ : program === "curl" ? CURL_READ : WGET_READ;
  const { flags, values, words } = readOpts(args, spec);
  const last = (n) => values.get(n)?.at(-1);
  const all = (names) => names.flatMap((n) => values.get(n) ?? []);
  let bodies;
  let method;
  if (program === "gh api") {
    bodies = all(["--raw-field", "--field"]);
    if (flags.has("--input")) bodies.push(`@${last("--input") ?? "-"}`);
    method = last("--method") ?? (bodies.length ? "POST" : "GET");
  } else if (program === "curl") {
    bodies = all(CURL_BODIES);
    const upload = flags.has("--upload-file");
    method = last("--request") ?? (flags.has("--head") ? "HEAD" : flags.has("--get") ? "GET"
      : upload ? "PUT" : bodies.length ? "POST" : "GET");
  } else {
    bodies = all(WGET_BODIES);
    for (const n of ["--post-file", "--body-file"]) for (const f of values.get(n) ?? []) bodies.push(`@${f}`);
    method = last("--method") ?? (bodies.length ? "POST" : "GET");
  }
  method = method.toUpperCase();
  if (READ_METHODS.has(method)) return null;
  // gh's one endpoint; for curl and wget any word at GitHub's API (fail closed on a stray one)
  const paths = program === "gh api" ? [words[0] === undefined ? null : apiPath(words[0])]
    : args.map((w) => apiPath(w, { url: true }));
  const fields = bodyFields(bodies);
  const field = (k) => fields.filter(([key]) => key === k).map(([, v]) => v).at(-1);
  for (const path of paths) {
    if (path === null) continue;
    for (const row of SIDE_DOOR_TABLE) {
      if (row.path === undefined) continue;
      const m = row.path.exec(path);
      if (!m) continue;
      const what = `a \`${program}\` ${row.route}`;
      if (row.mutation) {
        const unread = field("@");
        if (unread !== undefined) {
          return { effect: MOVES_SHARED_REF, flag: unread, what: `${what} request from a file`,
            why: "its body sits in a file or on stdin the guard can't read, and " + row.why.replace(/\.$/, "; it is refused as if it did.") };
        }
        const hit = bodies.map((b) => row.mutation.exec(b)).find(Boolean);
        if (!hit) continue;
        return { effect: MOVES_SHARED_REF, flag: hit[1], what, why: row.why };
      }
      let ref = row.ref === undefined ? undefined : m[row.ref];
      if (ref === undefined && row.field !== undefined) ref = field(row.field);
      let branch;
      try {
        branch = ref === undefined ? undefined : refBranch(decodeURIComponent(ref));
      } catch {
        branch = refBranch(ref);
      }
      const deletes = method === "DELETE" && row.ref !== undefined && branch !== undefined ? "the default branch" : undefined;
      return { effect: MOVES_SHARED_REF, flag: `${method} ${path}`, what, why: row.why, branch, deletes };
    }
  }
  return null;
}

/**
 * What a non-git command does to a shared ref (#483): the cause -- {
 * effect: MOVES_SHARED_REF, flag, what, why, branch, deletes, alias } --
 * or null when `program` (the command's name, lower case) with `args` is
 * no route on SIDE_DOOR_TABLE. `branch` is the one the route names, or
 * undefined when only the API knows (a PR's base): the guard takes that
 * as the default branch. `deletes` names what a route deletes outright.
 * `aliases` is the Map of `gh alias set` names a line defined before this
 * command (ghAliasSet): `gh m 1` with m = `pr merge` is the merge, `alias`
 * the name typed; a name the table knows is gh's own and never expanded.
 * Pure: a route the line only spells is read from the words alone.
 */
export function sideDoor(program, args, aliases = new Map()) {
  if (program === "curl" || program === "wget") return apiSideDoor(program, args);
  if (program !== "gh") return null;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i++; // gh has no option that takes a value here
  let sub = args[i];
  let rest = args.slice(i + 1);
  let alias;
  if (sub !== undefined && !GH_TABLED.has(sub) && aliases.has(sub)) {
    alias = sub;
    [sub, ...rest] = [...aliases.get(sub), ...rest];
  }
  if (sub === "api") {
    const cause = apiSideDoor("gh api", rest);
    return cause && alias !== undefined ? { ...cause, alias } : cause;
  }
  for (const row of SIDE_DOOR_TABLE) {
    if (row.sub === undefined || row.sub !== sub) continue;
    const { values, words } = readOpts(rest, GH_SUB_READ);
    if (words[0] !== row.action) continue;
    const branch = row.branchOpt === undefined ? undefined : values.get(row.branchOpt)?.at(-1);
    return { effect: MOVES_SHARED_REF, flag: `gh ${sub} ${row.action}`, what: row.what, why: row.why,
      branch, deletes: row.deletes, alias };
  }
  return null;
}

/**
 * The effect line a side-door refusal adds (#483): the one effect, the
 * route that caused it, and the gh alias typed when there was one.
 */
export function sideEffectLine(cause) {
  const via = cause.alias === undefined ? "" : `, via gh alias \`${cause.alias}\``;
  return `  effect: ${cause.effect}, from \`${cause.flag}\`${via} -- the push action by another route.`;
}
