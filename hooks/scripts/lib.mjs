#!/usr/bin/env node

/**
 * Purpose: shared, dependency-free helpers for cairn's plugin hook scripts
 *   (posttooluse-breadcrumb, sessionstart-continuity, the guards, the
 *   observers and the cost tracker).
 *   node: builtins only -- these scripts must never import server code, so
 *   the path schemes (worktree key, project key, the one-shot rekey) are
 *   recomputed here rather than reused from server/src/planning/run-manifest.ts
 *   (which stays the source of truth).
 * Author(s): John Reed
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync, constants as fsConstants, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync,
  readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Project key (#362) -- the hook side's copy of server/src/planning/run-manifest.ts's
// worktreeKey / projectKey / the one-shot rekey. Hook scripts may never import
// server code, so two copies is the floor; project-key.test.ts pins them byte
// for byte -- change one and the other must follow.
//   worktreeKey -- the resolved checkout folder: handoff and banner, one
//     session's task in flight.
//   projectKey -- `git rev-parse --git-common-dir`, real path, hashed: every
//     worktree of one repository shares it. Non-git folders degrade to
//     worktreeKey, which is the pre-#362 key.

/** The cairn home folders whose files belong to the repository. */
export const REPOSITORY_STATE_DIRS = [
  "index", "metrics", "outlook", "yield", "loop", "state", "refusals", "runs", "ship-gate", "budget",
];

/** Git location variables a hook inherits from a git hook; any of them would
 *  make rev-parse answer for another repository than the folder. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

const KEY_CACHE = new Map();

/** `<base>-<first 16 hex of sha256(abs)>`. */
function keyOf(abs, base) {
  return `${base}-${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
}

/** The checkout folder's key -- the scheme every file used before #362. */
export function worktreeKey(projectDir) {
  const abs = resolve(projectDir);
  return keyOf(abs, basename(abs));
}

/** The repository's common git dir, real path, or null outside a repository. */
export function gitCommonDir(projectDir) {
  const cwd = resolve(projectDir);
  const env = { ...process.env };
  for (const k of GIT_LOCATION_ENV) delete env[k];
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    }).trim();
    return out ? realpathSync(resolve(cwd, out)) : null;
  } catch {
    return null; // not a repository, no git on PATH, or no such folder
  }
}

/** The repository's key; outside a repository, worktreeKey. */
export function projectKey(projectDir) {
  const abs = resolve(projectDir);
  const hit = KEY_CACHE.get(abs);
  if (hit) return hit;
  const common = gitCommonDir(abs);
  if (common === null) return worktreeKey(abs);
  const name = basename(common);
  const base = name === ".git" ? basename(dirname(common)) : name.replace(/\.git$/, "") || name;
  const key = keyOf(common, base);
  KEY_CACHE.set(abs, key);
  return key;
}

/**
 * Moves `from` to `to`, never replacing a `to` that exists: hard link (EEXIST
 * instead of clobbering) then unlink; across devices, an exclusive copy.
 * Concurrency -- atomicity: the link is one syscall that refuses an existing
 * target, so two hooks cannot both move one file. Visibility: until the
 * unlink both names are one inode, so an append through the old name lands
 * in the moved file (the copy fallback makes no such promise). Ordering:
 * none needed -- the first link wins, the rest move nothing.
 */
export function moveNoClobber(from, to) {
  try {
    linkSync(from, to);
  } catch (e) {
    if (e?.code === "EEXIST" || e?.code === "ENOENT") return false;
    try {
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(from);
  } catch {
    // the move landed; a leftover old name is clutter the next sweep skips
  }
  return true;
}

/** The rekey's one metrics row: no session_id, so per-session readers skip it. */
export function recordRekey(home, projectDir, moved) {
  if (moved.length === 0) return;
  const key = projectKey(projectDir);
  const path = join(home, "metrics", `${key}.jsonl`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(), event: "rekey", from: worktreeKey(projectDir), to: key, moved,
    }) + "\n");
  } catch {
    // a measurement; an unwritable home never fails the hook
  }
}

/** One-shot move of every `<worktreeKey><rest>` repository-state file to
 *  `<projectKey><rest>`; a name whose twin exists stays put. */
export function migrateRepositoryState(projectDir, home = join(homedir(), ".cairn")) {
  const key = projectKey(projectDir);
  const legacy = worktreeKey(projectDir);
  if (key === legacy) return [];
  const moved = [];
  for (const sub of REPOSITORY_STATE_DIRS) {
    const dir = join(home, sub);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue; // never written on this machine
    }
    for (const name of names) {
      const rest = name.slice(legacy.length);
      if (!name.startsWith(legacy) || !(rest.startsWith(".") || rest.startsWith("-"))) continue;
      if (rest.endsWith(".tmp")) continue; // a write in flight renames itself
      if (moveNoClobber(join(dir, name), join(dir, `${key}${rest}`))) moved.push(`${sub}/${name}`);
    }
  }
  recordRekey(home, projectDir, moved);
  return moved;
}

/** `<home>/<dir>/<projectKey><suffix>` after the move; the old name when only it survived. */
export function repositoryPath(projectDir, dir, suffix, home = join(homedir(), ".cairn")) {
  migrateRepositoryState(projectDir, home);
  const path = join(home, dir, `${projectKey(projectDir)}${suffix}`);
  if (existsSync(path)) return path;
  const old = join(home, dir, `${worktreeKey(projectDir)}${suffix}`);
  return existsSync(old) ? old : path;
}

/** Fixed-width UTC stamp for a closed segment: 20260920-143000. */
export function segmentStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** One-shot move of the checkout's pre-#362 in-repo observation log into the
 *  shared one; the old live file lands as a closed segment stamped now. */
export function migrateLegacyObservations(projectDir, home = join(homedir(), ".cairn")) {
  const oldDir = join(resolve(projectDir), ".cairn", "observations");
  let names;
  try {
    names = readdirSync(oldDir).filter((n) => /^observations(\..+)?\.jsonl$/.test(n)).sort();
  } catch {
    return []; // nothing in the checkout -- the usual case
  }
  if (names.length === 0) return [];
  const key = projectKey(projectDir);
  const newDir = join(home, "observations");
  mkdirSync(newDir, { recursive: true });
  const moved = [];
  for (const name of names) {
    const from = join(oldDir, name);
    if (name !== "observations.jsonl") {
      if (moveNoClobber(from, join(newDir, `${key}${name.slice("observations".length)}`))) {
        moved.push(`observations/${name}`);
      }
      continue;
    }
    const stamp = segmentStamp(new Date());
    for (let n = 0; n < 100 && existsSync(from); n++) {
      if (moveNoClobber(from, join(newDir, `${key}.${stamp}-${String(n).padStart(2, "0")}.jsonl`))) {
        moved.push(`observations/${name}`);
        break;
      }
    }
  }
  recordRekey(home, projectDir, moved);
  return moved;
}

/** The shared observation log's live file -- server observationsPath's twin. */
export function observationsPath(projectDir, home = join(homedir(), ".cairn")) {
  migrateLegacyObservations(projectDir, home);
  return join(home, "observations", `${projectKey(projectDir)}.jsonl`);
}

/** One session's task in flight -- per worktree. */
export function handoffPath(projectDir) {
  return join(homedir(), ".cairn", "handoff", `${worktreeKey(projectDir)}.json`);
}

/** The session banner -- per worktree, like the handoff. */
export function bannerPath(projectDir) {
  return join(homedir(), ".cairn", "banner", `${worktreeKey(projectDir)}.md`);
}

/** The cost log -- per repository. */
export function metricsPath(projectDir) {
  return repositoryPath(projectDir, "metrics", ".jsonl");
}

/**
 * Every segment of the metrics log, oldest first, the live one last (#237).
 *
 * The log is SEGMENTED, never truncated (#229): a full segment is closed by
 * renaming it to "<stem>.<stamp>.jsonl" with a fixed-width UTC stamp, so a
 * plain lexical sort is chronological order. Readers depend on that order --
 * rows are cumulative per session and the LATEST row wins, so a session that
 * gets another row days later, landing in a newer segment while its older
 * rows sit in an older one, must resolve to the newer row. Concatenating and
 * summing instead would inflate every number that session touches.
 *
 * stop-costtracker.mjs owns the naming rule, being the writer. This is the
 * hook side's only copy; the server's lives in server/src/core/metrics.ts,
 * because hook scripts may never import server code. Two copies is the floor
 * that boundary allows -- change one and the other must follow.
 */
export function metricsSegments(current) {
  const dir = dirname(current);
  const stem = basename(current).replace(/\.jsonl$/, "");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [current]; // no metrics dir yet -- the live segment is the whole story
  }
  const closed = names
    .filter((n) => n !== `${stem}.jsonl` && n.startsWith(`${stem}.`) && n.endsWith(".jsonl"))
    .sort();
  return [...closed.map((n) => join(dir, n)), current];
}

/** Current repeated-call streak (tool + input hash + count) the loop check keeps per repository. */
export function loopStatePath(projectDir) {
  return repositoryPath(projectDir, "loop", ".json");
}

/** Live context-meter state for one repository: current band and turn count. */
export function meterPath(projectDir) {
  return repositoryPath(projectDir, "state", "-meter.json");
}

/** mtime in ms of `path`, or null when it doesn't exist. */
export function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Reads + JSON.parses `path`. Throws on missing/corrupt -- callers decide how to handle it. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Same tmp+rename atomic write as writeHandoff in server/src/core/continuity.ts.
 * The tmp name carries the pid and a random suffix (#351): with one fixed
 * `${path}.tmp`, two concurrent writers shared it, the first rename took the
 * second's bytes and the second rename threw ENOENT. Now each writer renames
 * its own whole file -- last writer wins, and nobody throws.
 */
export function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Reads cairn.json in `projectDir` directly (plain JSON, no zod). Returns null when absent/invalid. */
export function readCairnConfig(projectDir) {
  try {
    return JSON.parse(readFileSync(join(projectDir, "cairn.json"), "utf8"));
  } catch {
    return null;
  }
}

/** `continuity.resume`, defaulting to "prompt" when cairn.json, continuity, or resume is absent/invalid. */
export function resumeMode(projectDir) {
  const resume = readCairnConfig(projectDir)?.continuity?.resume;
  return resume === "auto" || resume === "off" ? resume : "prompt";
}

/**
 * Bare file paths from `git status --porcelain`, capped at `cap`. Best-effort --
 * a non-git dir or missing git binary yields [] rather than throwing, so a
 * breadcrumb write still lands with an empty uncommitted_files list.
 */
export function uncommittedFiles(projectDir, cap = 20) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n")
      .filter((line) => line.length > 0)
      .slice(0, cap)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

/** "just now" / "5m" / "3h" / "2d" -- compact age since an ISO timestamp. */
export function humanizeAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export { existsSync };
