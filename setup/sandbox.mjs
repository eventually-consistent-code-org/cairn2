#!/usr/bin/env node

/**
 * Purpose: the opt-in Claude Code sandbox recipe (#567) -- what
 *   `cairn-setup claude --sandbox` writes and what `--check` reads back. The
 *   guards read shell text, and a shell can spell anything; Claude Code's Bash
 *   sandbox refuses a write at the operating system, however the command was
 *   spelled. This module turns it on for a cairn project and adds cairn's own
 *   folders to its write-deny list. Builtins only, no top-level side effects:
 *   cairn-setup owns the writes (its link check, #498) and hands them in.
 * Author(s): John Reed
 *
 * What the sandbox does is a claim about a third party, read 2026-11-06 from
 *   the Claude Code sandboxing page and 2026-11-09 from its settings pages,
 *   until server/drills/drill-sandbox.mjs measures it on a machine. The page:
 *   "the limits apply to Bash, PowerShell, and Monitor commands and the
 *   processes they start"; inside the writable folders it still denies "the
 *   `.claude` settings files, the `.claude/skills`, `.claude/agents`,
 *   `.claude/commands`, and `.claude/hooks` directories, `.mcp.json`", and
 *   "`hooks` and `config` inside `.git`"; `filesystem.denyWrite` adds more.
 *
 * The decisions, each with its reason:
 *   - allowUnsandboxedCommands: false. The retry is the route a steered agent
 *     takes the moment the OS refuses it: "Claude analyzes the failure and may
 *     retry the command with the `dangerouslyDisableSandbox` parameter", and in
 *     bypassPermissions mode "the retry runs without a prompt". With it on, the
 *     recipe holds only until the first refusal. The cost is real: a git
 *     command that must replace a denied file, and on macOS a push over SSH,
 *     fail inside the sandbox ("`git push` against an SSH remote fail inside
 *     the sandbox even when the host is allowed"), and the owner runs them in
 *     a terminal of their own. No excludedCommands entry is written: `git push
 *     *` would run --receive-pack and a local remote's hooks unsandboxed.
 *   - failIfUnavailable: true. Without it, "when the platform doesn't support
 *     the sandbox or the dependency check at startup fails, Claude Code runs
 *     commands without sandboxing" -- the recipe would read as on and be off.
 *   - autoAllowBashIfSandboxed: false. Its default `true` runs sandboxed
 *     commands "without prompting, even in Manual mode". An opt-in hardening
 *     adds a boundary and removes no prompt; the owner can flip it in /sandbox.
 *   - Local settings, `.claude/settings.local.json`, at the repository root,
 *     not the committed `.claude/settings.json`. Claude Code reads the local
 *     file "at the repository root" from any folder below it, and "in a
 *     worktree, it uses the file at the main checkout's root" (settings page,
 *     2026-11-09), so one block reaches every linked worktree's session. The
 *     git rows are this machine's absolute paths. Local outranks project, so
 *     a branch's committed settings can't turn `enabled` or the retry back.
 *     And the opt-in is one owner's: a committed block would switch the
 *     sandbox on, retry off, for every clone, and stop Claude Code starting on
 *     a machine without bubblewrap.
 *
 * Not covered, by the sandbox's own scope (dated claims, 2026-11-06):
 *   Claude's built-in file tools (Read, Edit, Write) and MCP servers, which
 *   "follow permission rules instead" -- the guards still stand there; a
 *   command the owner types at `!`, which "runs unsandboxed in most sessions";
 *   `git reset --hard` and every other write inside the working tree the
 *   deny list doesn't name; pushes and every other network effect, which the
 *   recipe leaves to the sandbox's own network prompts; the seven other
 *   harnesses, which have no such sandbox. Nor a repository's committed
 *   settings that loosen it -- `excludedCommands` and `allowWrite` merge in
 *   unless the sandbox is admin-required ("managed settings, or with the
 *   `--settings` flag") -- so --check reports those keys rather than trust them.
 *
 * Not seen, dated 2026-11-05 (each pinned in server/test/sandbox.test.ts):
 *   - a worktree or submodule made after the install has no rows of its own
 *     on Linux, where a denyWrite wildcard works only as a trailing `/**`;
 *     --check reports it as lagging until the owner re-runs.
 *   - a relative row anchors at the session's working directory, not the
 *     repository root ("anchors at the session's primary working directory"),
 *     so the absolute rows are the ones the main checkout relies on.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// Constants
export const SANDBOX_FLAG = "--sandbox";
export const SETTINGS_REL = join(".claude", "settings.local.json");

// The four values the recipe sets, each decided above.
export const RECIPE = Object.freeze({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: false,
});

// cairn's own folders something else trusts, as rows: `at` names the base a
// row hangs from ("project": every checkout's root; "common": git's common
// directory, shared by every linked worktree), `rel` the path under it, `why`
// what a reader of the settings file is told. The gate's new home in the
// common directory (#558) is one more `at: "common"` row -- add it here, and
// the install, --check and the drill all pick it up.
export const CAIRN_DENY = Object.freeze([
  Object.freeze({ at: "project", rel: ".cairn/harness", why: "the scripts cairn's git hook runs and the verbs beside them" }),
  Object.freeze({ at: "project", rel: ".cairn/githooks", why: "the folder an older --git-hooks install points git at" }),
  Object.freeze({ at: "project", rel: ".cairn/state/approvals", why: "the owner's approval stamps the close-time re-run trusts" }),
  Object.freeze({ at: "project", rel: "cairn.json", why: "the config file holding the owner-only keys" }),
  Object.freeze({ at: "common", rel: "hooks", why: "the hooks git runs (the sandbox denies .git/hooks; this names the shared one)" }),
  Object.freeze({ at: "common", rel: "config", why: "the repository config, which names the hooks folder" }),
  Object.freeze({ at: "common", rel: "config.worktree", why: "per-worktree config, which can name a hooks folder too" }),
]);

// Keys in the committed project settings that loosen the sandbox for every
// session reading them, unless it is admin-required (sandboxing page,
// "Repository settings under an admin-required sandbox", 2026-11-06).
export const LOOSENING = Object.freeze(["excludedCommands", "filesystem.allowWrite", "ignoreViolations"]);

// Helpers

/** git's trimmed answer at `dir`, or null when it says no. GIT_CONFIG is
 *  dropped as cairn-setup drops it (#497): a value the shell carried would
 *  make git answer for whatever file it names. */
function gitAt(dir, args) {
  const { GIT_CONFIG: _ignored, ...env } = process.env;
  try {
    return execFileSync("git", args, {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

/** Folders directly under `dir`, or none. */
function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** Every submodule's git folder under `<common>/modules`, nested ones too: a
 *  folder holding HEAD is one, and its own `modules` is looked in again. */
function moduleDirs(modules) {
  const out = [];
  for (const d of subdirs(modules)) {
    if (existsSync(join(d, "HEAD"))) out.push(d, ...moduleDirs(join(d, "modules")));
    else out.push(...moduleDirs(d)); // a submodule name with a slash nests a folder
  }
  return out;
}

/** The linked worktree's own `.git` pointer file a worktree's gitdir names. */
function pointerOf(wt) {
  try {
    const p = readFileSync(join(wt, "gitdir"), "utf8").trim();
    return p && isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

// Main

/** Where the repository a project sits in keeps what the recipe names.
 *  :param projectDir the folder setup was pointed at
 *  :returns { root, top, common, hooksDir, file } -- root is the main
 *    checkout (where Claude Code keeps the local settings file), top this
 *    checkout's root, common git's common folder (null outside a repository),
 *    hooksDir the folder git runs hooks from today, file the settings path */
export function locate(projectDir) {
  const top = gitAt(projectDir, ["rev-parse", "--show-toplevel"]);
  const rawCommon = gitAt(projectDir, ["rev-parse", "--git-common-dir"]);
  const common = rawCommon === null ? null : resolve(projectDir, rawCommon);
  const rawHooks = gitAt(projectDir, ["rev-parse", "--git-path", "hooks"]);
  const hooksDir = rawHooks === null ? null : resolve(projectDir, rawHooks);
  let root = top ?? projectDir;
  if (common !== null && basename(common) === ".git") root = dirname(common);
  // "when the repository root is your home directory" the file stays where
  // the session starts (settings page, 2026-11-09)
  if (resolve(root) === resolve(homedir())) root = projectDir;
  return { root, top: top ?? projectDir, common, hooksDir, file: join(root, SETTINGS_REL) };
}

/** The denyWrite entries for one repository, from the rows. Every row yields
 *  path under each base it names; a list that comes out empty is an error,
 *  never a silent pass.
 *  :param where locate()'s answer
 *  :param opts.rows the rows (CAIRN_DENY by default; a caller extends it)
 *  :param opts.platform process.platform by default; darwin adds the glob rows
 *    that cover a worktree or submodule made after the install
 *  :returns string[] sorted, no duplicates */
export function denyPaths(where, { rows = CAIRN_DENY, platform = process.platform } = {}) {
  const out = new Set();
  const projects = [...new Set([where.root, where.top])];
  for (const row of rows) {
    if (row.at === "project") {
      for (const base of projects) out.add(join(base, row.rel));
      out.add(`./${row.rel}`);
    } else if (row.at === "common") {
      if (where.common === null) continue; // no repository: no git rows to write
      out.add(join(where.common, row.rel));
    } else {
      throw new Error(`sandbox row ${row.rel}: unknown base ${row.at}`);
    }
  }
  if (where.common !== null) {
    // the folder git runs hooks from today, when the owner's own local
    // core.hooksPath moved it out of the common folder (#497 respects one)
    if (where.hooksDir !== null) out.add(where.hooksDir);
    // the pointers that move git to another folder: a linked worktree's
    // commondir and gitdir files, its config.worktree, and the `.git` file in
    // its checkout -- rewrite one and git reads config and hooks from anywhere
    for (const wt of subdirs(join(where.common, "worktrees"))) {
      for (const f of ["commondir", "gitdir", "config.worktree"]) out.add(join(wt, f));
      const dotGit = pointerOf(wt);
      if (dotGit !== null) out.add(dotGit);
    }
    // a submodule's git folder runs its own hooks and reads its own config
    for (const m of moduleDirs(join(where.common, "modules"))) {
      out.add(join(m, "hooks"));
      out.add(join(m, "config"));
    }
    if (platform === "darwin") {
      // Seatbelt takes a wildcard mid-path; Linux takes only a trailing /**
      // (settings reference, "Where wildcards work in sandbox paths", 2026-11-09)
      for (const g of ["worktrees/*/commondir", "worktrees/*/gitdir", "worktrees/*/config.worktree",
        "modules/**/hooks", "modules/**/config"]) out.add(join(where.common, g));
    }
  }
  if (!out.size) throw new Error("sandbox recipe named no path to deny");
  return [...out].sort();
}

/** Read a settings file: missing is {}, a file that doesn't parse is an
 *  error the caller refuses on -- overwriting it would lose the owner's keys.
 *  :returns { json } or { error } */
export function readSettings(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { json: {} };
  }
  try {
    const json = JSON.parse(raw);
    return json && typeof json === "object" && !Array.isArray(json) ? { json } : { error: "is not a JSON object" };
  } catch {
    return { error: "exists but is not valid JSON" };
  }
}

/** The settings with the recipe merged in: the four values set, the deny
 *  entries added to whatever the owner listed (never removed), every other
 *  key kept as it was. :returns { next, changed } changed names each value
 *  the recipe overrode, so the install can say so */
export function mergeRecipe(settings, deny) {
  const sandbox = { ...(settings.sandbox ?? {}) };
  const changed = [];
  for (const [k, v] of Object.entries(RECIPE)) {
    if (k in sandbox && sandbox[k] !== v) changed.push(`${k} ${JSON.stringify(sandbox[k])} -> ${JSON.stringify(v)}`);
    sandbox[k] = v;
  }
  const filesystem = { ...(sandbox.filesystem ?? {}) };
  const have = Array.isArray(filesystem.denyWrite) ? filesystem.denyWrite : [];
  filesystem.denyWrite = [...have, ...deny.filter((p) => !have.includes(p))];
  sandbox.filesystem = filesystem;
  return { next: { ...settings, sandbox }, changed };
}

/** Is the recipe in a settings object, and whole? :returns { state, detail }
 *  state "absent" (no sandbox key: opt-in, never lagging), "current", or
 *  "lagging" with what is off */
export function recipeStatus(settings, deny) {
  const sandbox = settings.sandbox;
  if (sandbox === undefined) return { state: "absent", detail: `not installed (opt-in: ${SANDBOX_FLAG} turns on Claude Code's sandbox with cairn's folders write-denied)` };
  const off = Object.entries(RECIPE).filter(([k, v]) => sandbox?.[k] !== v).map(([k, v]) => `${k} is ${JSON.stringify(sandbox?.[k])}, not ${v}`);
  const have = Array.isArray(sandbox?.filesystem?.denyWrite) ? sandbox.filesystem.denyWrite : [];
  const missing = deny.filter((p) => !have.includes(p));
  if (missing.length) off.push(`${missing.length} deny entr${missing.length === 1 ? "y" : "ies"} missing (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""})`);
  return off.length ? { state: "lagging", detail: off.join("; ") } : { state: "current", detail: `on; ${have.length} write-deny entries, retry outside the sandbox off` };
}

/** The keys in a project settings object that loosen the sandbox, as dotted names. */
export function loosening(settings) {
  const s = settings?.sandbox ?? {};
  return LOOSENING.filter((k) => {
    const v = k.split(".").reduce((o, part) => (o && typeof o === "object" ? o[part] : undefined), s);
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false;
  });
}

/** `cairn-setup claude --sandbox`: write the recipe. Refuses for any other
 *  harness, a settings file that doesn't parse, and a write the OS refuses
 *  (a session already inside the sandbox can't write its own settings).
 *  :param io.write cairn-setup's writeChecked (the link check, #498)
 *  :param io.mkdir cairn-setup's mkdirChecked */
export function installSandbox({ harness, projectDir, write, mkdir }) {
  if (harness !== "claude") {
    console.error(`  ${SANDBOX_FLAG}: the recipe is Claude Code's sandbox, and ${harness} has none -- nothing was written. Run it as \`cairn-setup claude ${SANDBOX_FLAG}\`.`);
    process.exit(1);
  }
  const where = locate(projectDir);
  const { json, error } = readSettings(where.file);
  if (error) {
    console.error(`  ${where.file}: ${error} -- refusing to touch it. Fix or remove it, then re-run with ${SANDBOX_FLAG}.`);
    process.exit(1);
  }
  const deny = denyPaths(where);
  const { next, changed } = mergeRecipe(json, deny);
  const body = JSON.stringify(next, null, 2) + "\n";
  let prior = null;
  try {
    prior = readFileSync(where.file, "utf8");
  } catch { /* new file */ }
  if (body === prior) {
    console.log(`  ${where.file}: sandbox recipe already current...`);
  } else {
    try {
      mkdir(dirname(where.file), where.root);
      write(where.file, body, where.root);
    } catch (e) {
      const code = e && typeof e === "object" ? e.code : undefined;
      if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
        console.error(`  ${where.file}: the write was refused (${code}) -- a session inside the sandbox can't change its own settings. Run ${SANDBOX_FLAG} from a terminal of your own.`);
        process.exit(1);
      }
      throw e;
    }
    console.log(`  ${where.file}: sandbox recipe written (${deny.length} write-deny entries, retry outside the sandbox off, Claude Code refuses to start without the sandbox).`);
    for (const c of changed) console.log(`    changed: ${c}`);
  }
  if (where.common !== null && gitAt(where.root, ["check-ignore", "-q", SETTINGS_REL]) === null) {
    console.log(`  note: git does not ignore ${SETTINGS_REL} here -- it holds this machine's paths, so keep it out of commits.`);
  }
  const loose = loosening(readSettings(join(where.top, ".claude", "settings.json")).json ?? {});
  if (loose.length) console.log(`  note: .claude/settings.json sets ${loose.join(", ")}, which loosens the sandbox for every session here -- --check reports it.`);
  console.log("  the sandbox reaches Claude Code's shell commands only: its file tools, MCP servers, your own ! commands and the other harnesses stay under the guards.");
}

/** The --check line: is the recipe present and current? Absent is opt-in and
 *  never lags; a partial block, a stale deny list, or a committed settings
 *  file that loosens the sandbox does. :returns 1 when lagging, else 0 */
export function checkSandbox(projectDir) {
  const where = locate(projectDir);
  const { json, error } = readSettings(where.file);
  if (error) {
    console.log(`  sandbox (${SETTINGS_REL}): ${error} -- Claude Code can't read it either`);
    return 1;
  }
  let deny;
  try {
    deny = denyPaths(where);
  } catch (e) {
    console.log(`  sandbox (${SETTINGS_REL}): ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const s = recipeStatus(json, deny);
  let lag = s.state === "lagging" ? 1 : 0;
  console.log(`  sandbox (${SETTINGS_REL}): ${s.detail}${s.state === "lagging" ? ` -- re-run with ${SANDBOX_FLAG}` : ""}`);
  if (s.state !== "absent") {
    const loose = loosening(readSettings(join(where.top, ".claude", "settings.json")).json ?? {});
    if (loose.length) {
      console.log(`  sandbox (.claude/settings.json): sets ${loose.join(", ")}, which loosens the sandbox for every session here -- take it out, or start sessions with --settings '{"sandbox":{"allowUnsandboxedCommands":false}}' so Claude Code ignores it`);
      lag = 1;
    }
  }
  return lag;
}

