#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249-#252, #257, #262, #264, #270, #296, #297) --
 *   refuses git commands that rewrite a working tree or its history out
 *   from under whoever is in it, or push past the ship gate. Exit 2 blocks;
 *   ANY internal error exits 0 -- a broken guard never blocks work.
 *
 *   Always, in every session: the git commands that throw work away with
 *   no undo (the table in destructive(): hard reset; force, mirror and
 *   prune pushes, or one deleting the default branch; forced or whole-tree
 *   checkout/restore; a discarding switch; clean; stash clear; reflog
 *   expire), options shortened as git allows (--har is --hard, #296). Their
 *   everyday neighbours stay allowed. Escape: CAIRN_ALLOW_DESTRUCTIVE_GIT=1
 *   -- for the session, or as the leading assignment of the one command
 *   (honoured, never taught: refusals name only the owner's ways, #262).
 *
 *   Always: an agent push landing on the default branch (main, master, the
 *   remote's HEAD branch; a glob, `:` or push-everything push may, #297) is
 *   refused unless the last plan_drift left a clean ship-gate stamp for the
 *   exact commit pushed (#251; open issues stay prose).
 *   Other branches are untouched; a missing stamp refuses, an unreadable
 *   one skips. Escape: CAIRN_ALLOW_UNSHIPPED_PUSH=1, same two shapes.
 *
 *   While an unattended batch run is live (see liveRuns): `git checkout`,
 *   `git switch` and the hard reset (even overridden) aimed at the owner's
 *   own checkout (see isMainWorktree) are refused -- they change the
 *   human's files underneath them, mid-edit. CAIRN_RUN_OK=1 as the leading
 *   assignment overrides that once. And `git push`, from any worktree, is
 *   refused unless the run manifest grants pushAuth and marks one of its
 *   phases in flight (#260). No override: push authority is the owner's
 *   staging decision (ADR 0007).
 *
 *   Commands are read by shell-words.mjs, shared with the harness guard
 *   (#270), so rules see through wrappers and their flag values (sudo -u
 *   root, timeout 5). Quoted text never refuses, but a double-quoted $(...)
 *   still runs, so its body is checked as a command of its own (#257).
 *
 * removeWhen: headless runs execute in platform-provided isolated
 *   checkouts that cannot reach the human's working directory.
 * Author(s): John Reed
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SHELLS, shellCommandString, shellSegments, unwrap } from "./shell-words.mjs";

// Same per-machine hashing scheme as lib.mjs / server continuity. lib.mjs
// keeps its copy private and pins every path under the real home, while
// this guard honours CAIRN_HOME, so the few lines live here too.
function pathHash(projectDir) {
  const abs = resolve(projectDir);
  return { base: basename(abs), hash: createHash("sha256").update(abs).digest("hex").slice(0, 16) };
}

// Constants

// git global options that eat the following word as their value.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

/**
 * How this guard reads a command line (shell-words.mjs): ( ), backticks and
 * # comments end a command, quoted $(...) bodies are commands (#257), and
 * backslash-newline joins lines. Redirects and heredocs are not modelled,
 * so a heredoc body line reads as a command of its own.
 */
const READ = {
  subshells: true, comments: true, substitutions: true,
  continuation: true, posixEscapes: true, anyWhitespace: true,
};

// The session-wide escape for the always-on destructive refusals. Same shape
// as CAIRN_HARNESS_EDIT: set in the environment, or as the leading
// assignment of the very command it unlocks.
const DESTRUCTIVE_ENV = "CAIRN_ALLOW_DESTRUCTIVE_GIT";

// The escape for the default-branch ship gate (#251), same shape.
const UNSHIPPED_ENV = "CAIRN_ALLOW_UNSHIPPED_PUSH";

// Branch names that are always treated as the default branch.
const DEFAULT_BRANCHES = ["main", "master"];

/**
 * Every git invocation in a command line, parsed: the leading VAR=value
 * assignments, the -C directories in order, the -c and --config-env
 * values, the subcommand, its args (cut at a bare `--`) and the paths
 * past that `--`, which are paths, not flags -- `git checkout -- .`
 * (#264). Recurses into `sh -c '<script>'` style wrappers.
 */
function gitInvocations(line, depth = 0) {
  const found = [];
  for (const seg of shellSegments(line, READ)) {
    // Assignments and wrappers come off the front, flag values and all, so
    // `/usr/bin/sudo -u root git reset --hard` is still git (#270)
    const { words, assigns } = unwrap(seg.words, READ);
    const cmd = basename(words[0] ?? "");

    // sh -c / bash -lc: the script is one quoted word -- parse it too,
    // found the same way the harness guard finds it (#270)
    if (SHELLS.has(cmd) && depth < 2) {
      const script = shellCommandString(words.slice(1));
      if (script) found.push(...gitInvocations(script, depth + 1));
      continue;
    }
    if (cmd !== "git") continue;

    let i = 1;
    const dirs = [];
    const configs = [];
    const configEnvs = [];
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C") dirs.push(words[i + 1] ?? "");
      if (words[i] === "-c") configs.push(words[i + 1] ?? "");
      if (words[i] === "--config-env") configEnvs.push(words[i + 1] ?? "");
      if (words[i].startsWith("--config-env=")) configEnvs.push(words[i].slice(13));
      i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
    }
    const rest = words.slice(i + 1);
    const dashes = rest.indexOf("--");
    found.push({
      assigns,
      dirs,
      configs,
      configEnvs,
      sub: words[i] ?? "",
      args: dashes < 0 ? rest : rest.slice(0, dashes),
      paths: dashes < 0 ? [] : rest.slice(dashes + 1),
    });
  }
  return found;
}

/** `git -C <dir>` retargets the command (and stacks); honour it over the tool's cwd. */
function targetDir(dirs, cwd) {
  let dir = cwd;
  for (const d of dirs) dir = isAbsolute(d) ? d : join(dir, d);
  return dir;
}

/**
 * True when `dir` is the repository's MAIN working tree (not a linked
 * worktree) -- "the owner's checkout". A worktree's git dir resolves under
 * <main>/.git/worktrees/<name>, so the run's own worktree is recognised and
 * left alone. A dir git can't read is not the owner's checkout -- false,
 * so one odd -C target never aborts the checks on the rest of the line.
 */
function isMainWorktree(dir) {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return !/[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);
  } catch {
    return false;
  }
}

/**
 * Every manifest for this project whose status is `running`, as
 * { runId, state }. "A run is live" is file state in the per-machine cairn
 * home, not an env var, so it survives the agent boundaries an env var
 * would not cross.
 */
function liveRuns(projectDir, baseDir) {
  const { base, hash } = pathHash(projectDir);
  const prefix = `${base}-${hash}-`;
  let entries;
  try {
    entries = readdirSync(join(baseDir, "runs"));
  } catch {
    return []; // no runs dir -- this machine has never staged a batch run
  }
  const live = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(readFileSync(join(baseDir, "runs", name), "utf8"));
      if (state?.status === "running") {
        live.push({ runId: state.runId ?? name.slice(prefix.length, -5), state });
      }
    } catch {
      continue; // a corrupt manifest is not evidence of a live run
    }
  }
  return live;
}

/**
 * Why a running manifest doesn't authorize a push now, or null when it
 * does. Push authority is granted + scoped to "manifest-phases" at staging;
 * #260 adds the phase: run_manifest set_phase records `currentPhase` at
 * each phase start, and only a currentPhase that is one of the manifest's
 * phases carries the grant. No currentPhase (an older manifest, or a run
 * between phases) refuses. It can't prove the pushed commits belong to
 * that phase -- only that a phase the owner authorized is in flight.
 */
function pushRefusal(state) {
  const auth = state?.pushAuth;
  const phases = Array.isArray(state?.phases) ? state.phases : [];
  if (auth?.granted !== true || auth.scope !== "manifest-phases" || !phases.length) {
    return "without push authority for its phases — nothing pushes until the owner grants it at staging";
  }
  const current = state.currentPhase;
  if (typeof current !== "number") {
    return "without a phase marked in flight (run_manifest set_phase) — a push can't be tied to " +
      "a phase the owner authorized";
  }
  if (!phases.some((p) => p?.number === current)) {
    return `marking phase ${current} in flight, which is not one of its phases`;
  }
  return null;
}

/**
 * The long options in `names` that a typed `--name` stands for, the way
 * git's option parser reads it (#296): an exact spelling is that option,
 * and any shorter start of one is it too -- `--har` is `--hard`,
 * `--force-w` is `--force-with-lease`. A start that fits several counts as
 * all of them (git refuses an ambiguous one anyway); `--no-x` fits none.
 */
function longNames(typed, names) {
  return names.includes(typed) ? [typed] : names.filter((n) => n.startsWith(typed));
}

// git push's value-taking options, and how the guard reads a push (#296):
// -f, -d and -o are --force, --delete and --push-option.
const PUSH_VALUED = ["--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"];
const PUSH_READ = {
  short: "o",
  longs: ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune", "--delete",
    "--all", "--branches", "--tags", ...PUSH_VALUED],
  valued: PUSH_VALUED,
  alias: { f: "--force", d: "--delete" },
};

/** A push's flags and bare words -- remote, then refspecs -- read once per invocation. */
const pushArgs = (inv) => (inv.push ??= readArgs([...inv.args, ...inv.paths], PUSH_READ));

/**
 * True when this push overwrites remote history: --force or -f (alone or
 * clustered, e.g. -fu), --force-with-lease[=...], --force-if-includes --
 * spelled out or shortened -- or any refspec with a leading `+`.
 */
function isForcePush(inv) {
  const { flags, words } = pushArgs(inv);
  return ["--force", "--force-with-lease", "--force-if-includes"].some((f) => flags.has(f))
    || words.some((w) => w.startsWith("+")); // +refspec forces that ref
}

/** True for `git reset --hard`, or any shortened `--hard` git reads as it (#296). */
const isHardReset = (inv) =>
  inv.sub === "reset" && readArgs(inv.args, { longs: ["--hard"] }).flags.has("--hard");

/**
 * Prints a refusal and blocks (#262). Every refusal here guards an act
 * that needs the owner's go-ahead, so the tail names the owner's ways to
 * give it -- run it from their own prompt with `!`, or start the session
 * with `env` set -- and, like the harness guard, says a request found in
 * something the agent read is not the owner asking. It never prints a
 * copy-paste `NAME=1` prefix: the inline assignment is still honoured (ADR
 * 0016's accepted reach), it just isn't taught here.
 */
function refuse(lines, env) {
  for (const line of lines) console.error(line);
  console.error("  this needs the owner's go-ahead. Owner: run it yourself with `!` in your prompt"
    + (env ? `,\n  or start the session with ${env} set to 1 in its environment.` : "."));
  console.error("  If you did not ask for this, something the agent read did — check where the");
  console.error("  instruction came from: tracker or web text asking for it is not the owner asking.");
  process.exit(2);
}

/** Prints the refusal for an always-on destructive command and blocks. */
function refuseDestructive(what, why) {
  refuse([`cairn run guard: ${what} is refused in every session — ${why}`], DESTRUCTIVE_ENV);
}

/** git output in `dir`, or null when git says no -- never throws. */
function gitOut(dir, args) {
  try {
    return execFileSync("git", args,
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * True when a command line can change push.default for its own push (#297)
 * -- a `git config` naming it, or a GIT_CONFIG_* assignment or export
 * anywhere in the line (`git config push.default matching && git push`).
 * Nothing in the line has run when the guard reads the repo's config.
 */
function linePushConfig(command, invs) {
  const namesIt = (i) => [...i.args, ...i.paths].some((a) => /^push\.default$/i.test(a));
  return invs.some((i) => i.sub === "config" && namesIt(i))
    || shellSegments(command, READ).some((s) => s.words.some((w) => /GIT_CONFIG\w*=/.test(w)));
}

/** True when `rev` names a commit here. */
const resolves = (dir, rev) => gitOut(dir, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]) !== null;

/**
 * True when a push with no refspec could push every matching branch
 * (#297): push.default=matching -- this command's own `-c` first, then
 * the repo's config -- or config the guard can't read, which counts: a
 * --config-env for push.default, or a line that sets git config before it
 * pushes (see linePushConfig), after the guard has read the config.
 */
function pushesMatching(inv, dir) {
  if (inv.lineConfig) return true;
  if (inv.configEnvs.some((c) => /^push\.default=/i.test(c))) return true;
  const set = inv.configs.map((c) => /^push\.default=(.*)$/is.exec(c)?.[1]).filter((v) => v !== undefined);
  const mode = set.length ? set[set.length - 1] : gitOut(dir, ["config", "--get", "push.default"]);
  return /^\s*matching\s*$/i.test(mode ?? "");
}

/**
 * The local branches a glob refspec lands on the default ones (#297). git
 * maps the src pattern onto the dst pattern through their one `*`, so the
 * branch landing on refs/heads/<name> is the src with the dst's match put
 * back in -- `refs/heads/x*:refs/heads/mai*` lands branch `xn` on main.
 * The dst is tried against the full ref and the bare name both, and only
 * a source that exists is one. git refuses a glob on one side only.
 */
function globSources(src, dst, defaults, dir) {
  if (!src.includes("*")) return [];
  const star = dst.indexOf("*");
  const [pre, suf] = [dst.slice(0, star), dst.slice(star + 1)];
  const found = [];
  for (const b of defaults) {
    for (const name of [`refs/heads/${b}`, b]) {
      if (name.length < pre.length + suf.length || !name.startsWith(pre) || !name.endsWith(suf)) continue;
      const from = src.replace("*", () => name.slice(pre.length, name.length - suf.length));
      if (resolves(dir, from)) found.push(from);
    }
  }
  return found;
}

/**
 * What `git push <args>` would land on the default branch, as the source
 * revs being pushed there (null for a deletion). Empty when the push never
 * touches the default branch -- feature branches, tags, other refs. A push
 * of every branch counts (#297): --all, --branches and --mirror, the `:`
 * matching refspec, a bare push under push.default=matching, and a glob
 * whose destination can name the default branch.
 */
function defaultBranchSources(inv, dir) {
  const { flags, words: positional } = pushArgs(inv);
  const all = flags.has("--all") || flags.has("--mirror") || flags.has("--branches");
  const del = flags.has("--delete");
  const tags = flags.has("--tags");

  // Default branch names: main, master, and the remote's HEAD when known
  const remote = positional[0] ?? "origin";
  const defaults = new Set(DEFAULT_BRANCHES);
  if (/^[\w.-]+$/.test(remote)) {
    const head = gitOut(dir, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]);
    if (head?.startsWith(`${remote}/`)) defaults.add(head.slice(remote.length + 1));
  }
  const current = gitOut(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);

  // Every local default branch, as the full ref -- a tag spelled the same
  // can't stand in for the branch that actually lands
  const everyBranch = () => [...defaults].map((b) => `refs/heads/${b}`).filter((r) => resolves(dir, r));

  // --all / --mirror push every local branch, the default one included
  if (all) return everyBranch();

  const refspecs = positional.slice(1);
  if (!refspecs.length) {
    // bare `git push` / `git push origin`: the current branch, unless --tags
    // only -- or every matching branch under push.default=matching
    if (tags) return [];
    if (pushesMatching(inv, dir)) return everyBranch();
    return current && defaults.has(current) ? ["HEAD"] : [];
  }

  const sources = [];
  for (const spec of refspecs) {
    const plain = spec.replace(/^\+/, "");
    // `:` pushes every branch both sides have, the default one included
    if (plain === ":") { sources.push(...everyBranch()); continue; }
    const colon = plain.indexOf(":");
    let src = colon < 0 ? plain : plain.slice(0, colon);
    let dst = colon < 0 ? plain : plain.slice(colon + 1);
    if (dst.includes("*")) { sources.push(...globSources(src, dst, defaults, dir)); continue; }
    if (dst === "HEAD") dst = current ?? "";
    dst = dst.replace(/^refs\/heads\//, "");
    if (!defaults.has(dst)) continue;
    if (del || src === "") src = null;
    sources.push(src);
  }
  return sources;
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
 * `git clean -n --no-dry-run` deletes.
 */
function readArgs(args, { short = "", longs = [], valued = [], alias = {} } = {}) {
  const flags = new Set();
  const on = new Map();
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const hit = longNames(name, longs);
      for (const n of hit) { flags.add(n); on.set(n, true); }
      if (eq < 0 && hit.some((n) => valued.includes(n))) k++;
      if (!hit.length && name.startsWith("--no-")) {
        for (const n of longNames(`--${name.slice(5)}`, longs)) on.set(n, false);
      }
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        const f = alias[a[c]] ?? `-${a[c]}`;
        flags.add(f);
        on.set(f, true);
        if (short.includes(a[c])) {
          if (c === a.length - 1) k++; // value is the next word
          break; // ...or the rest of this one
        }
      }
      continue;
    }
    words.push(a);
  }
  return { flags, on, words };
}

/**
 * True for a pathspec that names the whole tree rather than a file in it:
 * `.`, `./`, `..`, `../..`, `:/`, `:/.`, `:(top)`, and a bare glob (`*`,
 * `**`, `./*` -- a pathspec `*` crosses `/`). A single path -- `src/a.ts`,
 * `.gitignore`, `:/src`, `*.ts` -- is not.
 */
function wholeTree(p) {
  return p !== "" && /^(?::\/|:\(top\))?(?:\.{1,2}(?:\/\.{1,2})*)?\/?\**$/.test(p);
}

/**
 * True when a checkout/restore's pathspec names the whole tree -- or comes
 * from --pathspec-from-file, which the guard can't see into.
 */
function wholeTreeSpec(flags, words, paths) {
  return flags.has("--pathspec-from-file") || [...words, ...paths].some(wholeTree);
}

/** True for a git config value that reads as true (`true`, `yes`, `on`, `1`, bare). */
const truthy = (v) => !/^(false|no|off|0)$/i.test(String(v).trim());

/**
 * True when this push mirrors -- `--mirror`, `-c remote.<r>.mirror=true`,
 * or a remote configured to mirror already (`git remote add --mirror=push`,
 * `git config remote.<r>.mirror true`), which turns a plain `git push <r>`
 * into one that force-updates and deletes every remote ref.
 */
function isMirrorPush(inv, flags, words, dir) {
  if (flags.has("--mirror")) return true;
  const key = /^remote\.(.+)\.mirror(?:=(.*))?$/i;
  if (inv.configs.some((c) => { const m = key.exec(c); return m && truthy(m[2] ?? "true"); })) {
    return true;
  }
  const set = gitOut(dir, ["config", "--get-regexp", "^remote\\..*\\.mirror$"]);
  if (!set) return false;
  const remote = words[0];
  return set.split("\n").some((line) => {
    const m = /^remote\.(.+)\.mirror\s*(.*)$/i.exec(line.trim());
    return m && truthy(m[2] || "true") && (remote === undefined || remote === m[1]);
  });
}

/**
 * The always-on table (#249, #250, #264): why `inv` throws work away with
 * no undo, as [what, why] -- or null. Every row is refused in every session
 * behind the one CAIRN_ALLOW_DESTRUCTIVE_GIT escape. The everyday
 * neighbours stay allowed because they are routine or recoverable: a
 * single-path checkout/restore, `stash drop`, `branch -D`, `restore
 * --staged .` (the index only, like a plain `git reset`), deleting a
 * feature branch, and `clean -n`.
 */
function destructive(inv, dir) {
  const { sub, args, paths } = inv;
  const discards = "it discards uncommitted work with no undo.";
  switch (sub) {
    case "reset":
      return isHardReset(inv) ? ["`git reset --hard`", discards] : null;

    case "checkout": {
      const { flags, words } = readArgs(args, { short: "bB", alias: { f: "--force" },
        longs: ["--force", "--orphan", "--conflict", "--pathspec-from-file"],
        valued: ["--orphan", "--conflict", "--pathspec-from-file"] });
      if (flags.has("--force")) return ["`git checkout --force`", discards];
      return wholeTreeSpec(flags, words, paths) ? ["a whole-tree `git checkout`", discards] : null;
    }

    case "switch": {
      const { flags } = readArgs(args, { short: "cC", alias: { f: "--force" },
        longs: ["--discard-changes", "--force", "--create", "--force-create", "--orphan", "--conflict"],
        valued: ["--create", "--force-create", "--orphan", "--conflict"] });
      return flags.has("--discard-changes") || flags.has("--force")
        ? ["`git switch --discard-changes`", discards] : null;
    }

    case "restore": {
      const { flags, on, words } = readArgs(args, { short: "s",
        alias: { s: "--source", S: "--staged", W: "--worktree" },
        longs: ["--source", "--staged", "--worktree", "--pathspec-from-file", "--conflict"],
        valued: ["--source", "--pathspec-from-file", "--conflict"] });
      // the work tree is restored unless only --staged is asked for, and
      // --no-staged takes that back
      const worktree = flags.has("--worktree") || on.get("--staged") !== true;
      return worktree && wholeTreeSpec(flags, words, paths)
        ? ["a whole-tree `git restore`", discards] : null;
    }

    case "clean": {
      // Every clean but a dry run: plain `git clean` only refuses on its own
      // while clean.requireForce holds, and `-c clean.requireForce=false`
      // or a repo config turns that off -- so the -f isn't what to look for.
      // A dry run counts once it's the last word on it: -n --no-dry-run deletes
      const { on } = readArgs(args, { short: "e", alias: { n: "--dry-run" },
        longs: ["--dry-run", "--exclude"], valued: ["--exclude"] });
      return on.get("--dry-run") === true ? null
        : ["`git clean`", "it deletes untracked files, which git never had a copy of."];
    }

    case "stash":
      return args[0] === "clear" ? ["`git stash clear`", "it drops every stash at once."] : null;

    case "reflog":
      return args[0] === "expire"
        ? ["`git reflog expire`", "it erases the record git recovers lost commits from."] : null;

    case "push": {
      // Past a bare `--` a push's words are still refspecs, not paths (pushArgs)
      if (isForcePush(inv)) {
        return ["`git push --force`",
          "it overwrites remote history other people may already have pulled."];
      }
      const { flags, words } = pushArgs(inv);
      if (isMirrorPush(inv, flags, words, dir)) {
        return ["`git push --mirror`", "it force-updates and deletes remote refs to match this clone."];
      }
      if (flags.has("--prune")) {
        return ["`git push --prune`", "it deletes every remote branch this clone doesn't have."];
      }
      return defaultBranchSources(inv, dir).includes(null)
        ? ["a push deleting the default branch", "everyone's shared history hangs off it."] : null;
    }
  }
  return null;
}

/**
 * Why this push may not land on the default branch yet, or null when the
 * ship gate is satisfied or doesn't apply (#251). The stamp is plan_drift's
 * record of its last run: { head, clean, at }. A missing stamp is a
 * refusal; anything the guard can't read is a skip, not a block.
 */
function shipGateRefusal(inv, dir, projectDir, baseDir) {
  try {
    const sources = defaultBranchSources(inv, dir);
    if (!sources.length) return null;

    const { base, hash } = pathHash(projectDir);
    const path = join(baseDir, "ship-gate", `${base}-${hash}.json`);
    let stamp;
    try {
      stamp = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") return "no drift check has been recorded for this project";
      if (e instanceof SyntaxError) return "the last drift check's record is unreadable";
      return null; // stamp dir/file unreadable -- the guard's problem, not yours
    }
    if (stamp?.clean !== true) return "the last drift check flagged drift that ship stops on";

    for (const src of sources) {
      if (src === null) return "it deletes the default branch";
      const sha = gitOut(dir, ["rev-parse", "--verify", "-q", `${src}^{commit}`]);
      if (sha === null) return null; // git can't resolve it -- the push will fail on its own
      if (sha !== stamp.head) {
        return `the last drift check was for ${String(stamp.head).slice(0, 7)}, ` +
          `not the commit being pushed (${sha.slice(0, 7)})`;
      }
    }
    return null;
  } catch {
    return null; // fail open for this check only -- the rest of the line still gets checked
  }
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  if (payload?.tool_name !== "Bash") process.exit(0);
  const command = payload?.tool_input?.command ?? "";

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const baseDir = process.env.CAIRN_HOME || join(homedir(), ".cairn");
  const cwd = payload?.cwd || projectDir;
  const allowDestructive = process.env[DESTRUCTIVE_ENV] === "1";

  // Read the run manifests at most once, and only if a command needs them
  let runs;
  const currentRuns = () => (runs ??= liveRuns(projectDir, baseDir));

  const invs = gitInvocations(command);
  const lineConfig = linePushConfig(command, invs);
  for (const inv of invs) {
    inv.lineConfig = lineConfig;
    // Overrides only count as the leading assignment of THIS command, so a
    // quoted mention elsewhere can't bypass the guard
    const prefixed = (name) => inv.assigns.includes(`${name}=1`);
    const hardReset = isHardReset(inv);
    const dir = targetDir(inv.dirs, cwd);

    // #249, #250, #264 -- the work-destroying table, every session
    if (!allowDestructive && !prefixed(DESTRUCTIVE_ENV)) {
      const hit = destructive(inv, dir);
      if (hit) refuseDestructive(...hit);
    }

    // #251 -- the default branch only takes what a clean drift check saw
    if (inv.sub === "push" && process.env[UNSHIPPED_ENV] !== "1" && !prefixed(UNSHIPPED_ENV)) {
      const why = shipGateRefusal(inv, dir, projectDir, baseDir);
      if (why) {
        refuse([
          `cairn run guard: this push lands on the default branch, but ${why}.`,
          "  run /cairn:ship instead -- it runs the drift check first, then pushes.",
        ], UNSHIPPED_ENV);
      }
    }

    // #252, #260 -- mid-run, a push needs the authority granted at the
    // staging gate and a manifest phase in flight. From ANY worktree --
    // the run's own is exactly where it pushes.
    if (inv.sub === "push") {
      for (const run of currentRuns()) {
        const why = pushRefusal(run.state);
        if (!why) continue;
        console.error(`cairn run guard: a batch run (${run.runId}) is in flight ${why}.`);
        console.error("  the phase ends verified-not-pushed; push it yourself from your own");
        console.error("  terminal once the run is done.");
        process.exit(2);
      }
      continue;
    }

    // #216 -- tree-rewriting commands aimed at the owner's checkout mid-run
    if (!hardReset && inv.sub !== "checkout" && inv.sub !== "switch") continue;
    if (prefixed("CAIRN_RUN_OK")) continue;
    if (!currentRuns().length) continue; // no unattended run in flight -- ordinary work
    if (!isMainWorktree(dir)) continue; // the run's own worktree

    const name = hardReset ? "git reset --hard" : `git ${inv.sub}`;
    refuse([
      `cairn run guard: a batch run (${runs[0].runId}) is in flight, and this \`${name}\` targets ` +
      "the checkout you work in — it would change your files underneath you.",
      "  run the command inside the run's own worktree, or wait for the run to finish.",
    ]);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
