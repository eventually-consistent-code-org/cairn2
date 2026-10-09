#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249-#252, #257, #262, #264, #270) --
 *   refuses git commands that rewrite a working tree or its history out
 *   from under whoever is in it, or push past the ship gate. Exit 2 blocks;
 *   ANY internal error exits 0 -- a broken guard never blocks work.
 *
 *   Always, in every session: the git commands that throw work away with
 *   no undo (the table in destructive(): hard reset; force, mirror and
 *   prune pushes, or one deleting the default branch; forced or whole-tree
 *   checkout/restore; a discarding switch; clean; stash clear; reflog
 *   expire). Their everyday neighbours stay allowed. The owner's escape is
 *   CAIRN_ALLOW_DESTRUCTIVE_GIT=1 -- set for the session, or as the leading
 *   assignment of the one command (honoured, never taught: refusals name
 *   only the owner's ways to approve, #262).
 *
 *   Always: an agent push landing on the default branch (main, master, the
 *   remote's HEAD branch) is refused unless the last plan_drift left a
 *   clean ship-gate stamp for the exact commit pushed -- the drift half of
 *   ship's "never push with flagged drift" (#251; open issues stay prose).
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
 * assignments, the -C directories in order, the -c config values, the
 * subcommand, its args (cut at a bare `--`) and the paths past that `--`,
 * which are paths, not flags -- `git checkout -- .` (#264). Recurses into
 * `sh -c '<script>'` style wrappers.
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
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C") dirs.push(words[i + 1] ?? "");
      if (words[i] === "-c") configs.push(words[i + 1] ?? "");
      i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
    }
    const rest = words.slice(i + 1);
    const dashes = rest.indexOf("--");
    found.push({
      assigns,
      dirs,
      configs,
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

// git push options that eat the following word as their value.
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * True when `git push <args>` overwrites remote history: --force, -f
 * (alone or clustered, e.g. -fu), --force-with-lease[=...],
 * --force-if-includes, or any refspec with a leading `+`.
 */
function isForcePush(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (PUSH_VALUE_OPTS.has(a)) { k++; continue; }
    if (a === "--force" || a === "--force-if-includes" || /^--force-with-lease(=|$)/.test(a)) {
      return true;
    }
    if (/^-[^-]/.test(a)) {
      // short cluster -- `o` takes the rest of the word as its value
      for (const ch of a.slice(1)) {
        if (ch === "o") break;
        if (ch === "f") return true;
      }
      continue;
    }
    if (a.startsWith("+")) return true; // +refspec forces that ref
  }
  return false;
}

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
 * What `git push <args>` would land on the default branch, as the source
 * revs being pushed there (null for a deletion). Empty when the push never
 * touches the default branch -- feature branches, tags, other refs.
 */
function defaultBranchSources(args, dir) {
  const positional = [];
  let all = false;
  let del = false;
  let tags = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (PUSH_VALUE_OPTS.has(a)) { k++; continue; }
    if (a === "--all" || a === "--mirror" || a === "--branches") { all = true; continue; }
    if (a === "--delete") { del = true; continue; }
    if (a === "--tags") { tags = true; continue; }
    if (/^-[^-]/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === "o") break; // -o eats the rest of the word
        if (ch === "d") del = true;
      }
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }

  // Default branch names: main, master, and the remote's HEAD when known
  const remote = positional[0] ?? "origin";
  const defaults = new Set(DEFAULT_BRANCHES);
  if (/^[\w.-]+$/.test(remote)) {
    const head = gitOut(dir, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]);
    if (head?.startsWith(`${remote}/`)) defaults.add(head.slice(remote.length + 1));
  }
  const current = gitOut(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);

  // --all / --mirror push every local branch, the default one included
  if (all) {
    return [...defaults].filter((b) => gitOut(dir, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]));
  }

  const refspecs = positional.slice(1);
  if (!refspecs.length) {
    // bare `git push` / `git push origin`: the current branch, unless --tags only
    if (tags) return [];
    return current && defaults.has(current) ? ["HEAD"] : [];
  }

  const sources = [];
  for (const spec of refspecs) {
    const plain = spec.replace(/^\+/, "");
    const colon = plain.indexOf(":");
    let src = colon < 0 ? plain : plain.slice(0, colon);
    let dst = colon < 0 ? plain : plain.slice(colon + 1);
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
 */
function readArgs(args, valuedShort = "", valuedLong = []) {
  const flags = new Set();
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      flags.add(name);
      if (eq < 0 && valuedLong.includes(name)) k++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        flags.add(`-${a[c]}`);
        if (valuedShort.includes(a[c])) {
          if (c === a.length - 1) k++; // value is the next word
          break; // ...or the rest of this one
        }
      }
      continue;
    }
    words.push(a);
  }
  return { flags, words };
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
      return args.includes("--hard") ? ["`git reset --hard`", discards] : null;

    case "checkout": {
      const { flags, words } = readArgs(args, "bB",
        ["--orphan", "--conflict", "--pathspec-from-file"]);
      if (flags.has("-f") || flags.has("--force")) return ["`git checkout --force`", discards];
      return wholeTreeSpec(flags, words, paths) ? ["a whole-tree `git checkout`", discards] : null;
    }

    case "switch": {
      const { flags } = readArgs(args, "cC",
        ["--create", "--force-create", "--orphan", "--conflict"]);
      return flags.has("--discard-changes") || flags.has("-f") || flags.has("--force")
        ? ["`git switch --discard-changes`", discards] : null;
    }

    case "restore": {
      const { flags, words } = readArgs(args, "s",
        ["--source", "--pathspec-from-file", "--conflict"]);
      // the work tree is restored unless only --staged is asked for
      const worktree = flags.has("-W") || flags.has("--worktree")
        || !(flags.has("-S") || flags.has("--staged"));
      return worktree && wholeTreeSpec(flags, words, paths)
        ? ["a whole-tree `git restore`", discards] : null;
    }

    case "clean": {
      // Every clean but a dry run: plain `git clean` only refuses on its own
      // while clean.requireForce holds, and `-c clean.requireForce=false`
      // or a repo config turns that off -- so the -f isn't what to look for
      const { flags } = readArgs(args, "e", ["--exclude"]);
      return flags.has("-n") || flags.has("--dry-run") ? null
        : ["`git clean`", "it deletes untracked files, which git never had a copy of."];
    }

    case "stash":
      return args[0] === "clear" ? ["`git stash clear`", "it drops every stash at once."] : null;

    case "reflog":
      return args[0] === "expire"
        ? ["`git reflog expire`", "it erases the record git recovers lost commits from."] : null;

    case "push": {
      // Past a bare `--` a push's words are still refspecs, not paths
      const all = [...args, ...paths];
      if (isForcePush(all)) {
        return ["`git push --force`",
          "it overwrites remote history other people may already have pulled."];
      }
      const { flags, words } = readArgs(all, "o",
        ["--push-option", "--repo", "--receive-pack", "--exec"]);
      if (isMirrorPush(inv, flags, words, dir)) {
        return ["`git push --mirror`", "it force-updates and deletes remote refs to match this clone."];
      }
      if (flags.has("--prune")) {
        return ["`git push --prune`", "it deletes every remote branch this clone doesn't have."];
      }
      return defaultBranchSources(all, dir).includes(null)
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
function shipGateRefusal(args, dir, projectDir, baseDir) {
  try {
    const sources = defaultBranchSources(args, dir);
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

  for (const inv of gitInvocations(command)) {
    // Overrides only count as the leading assignment of THIS command, so a
    // quoted mention elsewhere can't bypass the guard
    const prefixed = (name) => inv.assigns.includes(`${name}=1`);
    const hardReset = inv.sub === "reset" && inv.args.includes("--hard");
    const dir = targetDir(inv.dirs, cwd);

    // #249, #250, #264 -- the work-destroying table, every session
    if (!allowDestructive && !prefixed(DESTRUCTIVE_ENV)) {
      const hit = destructive(inv, dir);
      if (hit) refuseDestructive(...hit);
    }

    // #251 -- the default branch only takes what a clean drift check saw
    if (inv.sub === "push" && process.env[UNSHIPPED_ENV] !== "1" && !prefixed(UNSHIPPED_ENV)) {
      const why = shipGateRefusal([...inv.args, ...inv.paths], dir, projectDir, baseDir);
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
