#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249, #250, #251, #252, #257) --
 *   refuses the git commands that rewrite a working tree or its history out
 *   from under whoever is in it, or push past the ship gate. Exit 2 blocks
 *   the tool call; ANY internal error exits 0 -- never block work because
 *   the guard itself broke.
 *
 *   Always, in every session: `git reset --hard` (any flag order, any -C
 *   target) and force-pushes (--force, -f / -fu, --force-with-lease,
 *   --force-if-includes, a `+refspec`) are refused. They throw away work
 *   with no undo, and no cairn verb ever needs them. The owner's escape is
 *   CAIRN_ALLOW_DESTRUCTIVE_GIT=1 -- set for the session, or as the leading
 *   assignment of the one command it unlocks.
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
 *   refused unless the run manifest grants pushAuth for its phases. No
 *   override: push authority is the owner's staging decision (ADR 0007).
 *
 *   Commands are read as shell words by shell-words.mjs, the reader this
 *   guard shares with the harness guard (#270), never by a raw regex.
 *   Quoted text (`git commit -m "explain git reset --hard"`) is never a
 *   refusal, but command substitution inside double quotes still runs, so
 *   its body is checked as a command of its own (#257).
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
import { SHELLS, shellSegments } from "./shell-words.mjs";

// Same per-machine hashing scheme as lib.mjs / server continuity. lib.mjs
// keeps its copy private and pins every path under the real home, while
// this guard honours CAIRN_HOME, so the few lines live here too.
function pathHash(projectDir) {
  const abs = resolve(projectDir);
  return { base: basename(abs), hash: createHash("sha256").update(abs).digest("hex").slice(0, 16) };
}

// Constants

// Wrappers that just run the next word as the command -- skipped so
// `sudo git reset --hard` is still seen as git.
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time"]);

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
 * assignments, the -C directories in order, the subcommand, and its args
 * (cut at a bare `--`, past which words are paths, not flags). Recurses
 * into `sh -c '<script>'` style wrappers.
 */
function gitInvocations(line, depth = 0) {
  const found = [];
  for (const { words } of shellSegments(line, READ)) {
    let i = 0;
    const assigns = [];
    while (i < words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) { assigns.push(words[i]); i++; continue; }
      if (WRAPPERS.has(words[i])) {
        i++;
        while (i < words.length && words[i].startsWith("-")) i++;
        continue;
      }
      break;
    }
    const cmd = basename(words[i] ?? "");

    // sh -c / bash -lc: the script is one quoted word -- parse it too
    if (SHELLS.has(cmd) && depth < 2) {
      const flag = words.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
      if (flag > 0 && words[flag + 1]) found.push(...gitInvocations(words[flag + 1], depth + 1));
      continue;
    }
    if (cmd !== "git") continue;

    i++;
    const dirs = [];
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "-C") dirs.push(words[i + 1] ?? "");
      i += GIT_VALUE_OPTS.has(words[i]) ? 2 : 1;
    }
    const rest = words.slice(i + 1);
    const dashes = rest.indexOf("--");
    found.push({
      assigns,
      dirs,
      sub: words[i] ?? "",
      args: dashes < 0 ? rest : rest.slice(0, dashes),
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
 * True when a running manifest authorizes pushes. The manifest records
 * push authority as granted + a scope that is always "manifest-phases" --
 * it stores no per-push phase, so "covers the phase being pushed" reduces
 * to: granted, scoped to the manifest, and the manifest has phases at all.
 */
function pushAuthorized(state) {
  const auth = state?.pushAuth;
  return auth?.granted === true && auth.scope === "manifest-phases"
    && Array.isArray(state.phases) && state.phases.length > 0;
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

/** Prints the refusal for an always-on destructive command and blocks. */
function refuseDestructive(name, why) {
  console.error(`cairn run guard: \`${name}\` is refused in every session — ${why}`);
  console.error(`  if you really mean it, set ${DESTRUCTIVE_ENV}=1 for the session,`);
  console.error(`  or prefix this one command with ${DESTRUCTIVE_ENV}=1.`);
  process.exit(2);
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

    // #249 -- hard reset, every session
    if (hardReset && !allowDestructive && !prefixed(DESTRUCTIVE_ENV)) {
      refuseDestructive("git reset --hard",
        "it discards uncommitted work with no undo.");
    }

    // #250 -- force-push, every session
    if (inv.sub === "push" && isForcePush(inv.args) && !allowDestructive
      && !prefixed(DESTRUCTIVE_ENV)) {
      refuseDestructive("git push --force",
        "it overwrites remote history other people may already have pulled.");
    }

    // #251 -- the default branch only takes what a clean drift check saw
    if (inv.sub === "push" && process.env[UNSHIPPED_ENV] !== "1" && !prefixed(UNSHIPPED_ENV)) {
      const why = shipGateRefusal(inv.args, targetDir(inv.dirs, cwd), projectDir, baseDir);
      if (why) {
        console.error(`cairn run guard: this push lands on the default branch, but ${why}.`);
        console.error("  run /cairn:ship instead -- it runs the drift check first, then pushes.");
        console.error(`  to push anyway, set ${UNSHIPPED_ENV}=1 for the session,`);
        console.error(`  or prefix this one command with ${UNSHIPPED_ENV}=1.`);
        process.exit(2);
      }
    }

    // #252 -- mid-run, a push needs the authority granted at the staging
    // gate. From ANY worktree -- the run's own is exactly where it pushes.
    if (inv.sub === "push") {
      const unauthorized = currentRuns().find((r) => !pushAuthorized(r.state));
      if (unauthorized) {
        console.error(
          `cairn run guard: a batch run (${unauthorized.runId}) is in flight without push ` +
          "authority for its phases — nothing pushes until the owner grants it at staging.",
        );
        console.error("  the phase ends verified-not-pushed; push it yourself from your own");
        console.error("  terminal once the run is done, or stage a run with push authority.");
        process.exit(2);
      }
      continue;
    }

    // #216 -- tree-rewriting commands aimed at the owner's checkout mid-run
    if (!hardReset && inv.sub !== "checkout" && inv.sub !== "switch") continue;
    if (prefixed("CAIRN_RUN_OK")) continue;
    if (!currentRuns().length) continue; // no unattended run in flight -- ordinary work
    if (!isMainWorktree(targetDir(inv.dirs, cwd))) continue; // the run's own worktree

    const name = hardReset ? "git reset --hard" : `git ${inv.sub}`;
    console.error(
      `cairn run guard: a batch run (${runs[0].runId}) is in flight, and this \`${name}\` targets ` +
      "the checkout you work in — it would change your files underneath you.",
    );
    console.error("  run the command inside the run's own worktree, wait for the run to finish,");
    console.error("  or prefix it with CAIRN_RUN_OK=1 to override once.");
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
