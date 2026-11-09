#!/usr/bin/env node

// cairn-setup — wire cairn into a non-Claude harness (CRN-71).
//
//   node setup/cairn-setup.mjs <harness> [--project <dir>] [--local] [--check] [--git-hooks] [--sandbox]
//   harness: grok | copilot | codex | gemini | cursor | claude
//
// What it does, per project:
//   1. merges a `cairn` entry into the project's .mcp.json (read directly by
//      Claude Code, Grok Build, and Cursor)
//   2. installs the AGENTS.md cairn fragment (marker-delimited, idempotent),
//      and the `@AGENTS.md` import at the top of CLAUDE.md whenever one is
//      present (the claude target creates it): Claude Code reads AGENTS.md
//      only when no CLAUDE.md is in scope -- a claim, as of 2026-10, per the
//      Claude Code memory docs (#398)
//   3. copies the verb subroutines to .cairn/harness/ so harnesses without
//      the plugin can read them, plus the helpers those verbs run
//      (merge-overlap, cost-report and their imports) into a scripts/
//      folder beside them, with the copied verbs re-pointed at it (#474)
//   4. harness-specific wiring (Copilot mcp-config + instructions + prompts;
//      Codex prints its config.toml block; Gemini merges settings + GEMINI.md)
//   5. with --git-hooks only: a pre-push git hook that applies the ship
//      gate's default-branch rule to every process in the checkout, and
//      core.hooksPath pointed at it (#456). The hook and the script it runs
//      live under the git common directory, where no checkout, merge,
//      restore or pull writes and every linked worktree finds the same pair;
//      a re-run moves an older install off .cairn/githooks (#558, asserted:
//      gitlayer.test.ts). Opt-in, never default: a git
//      config write is the owner's ground, and the flag is the consent. The
//      consent is for this project: a core.hooksPath at global or system
//      scope is never written into (#497). A flag is the owner's only where
//      something says so: the harness guard refuses it from an agent without
//      the owner's escape, and this install refuses to arm a folder holding
//      hooks it did not write, for the harnesses running no guard (#508).
//   6. with --sandbox, for the claude harness only: a Claude Code sandbox
//      block in the main checkout's .claude/settings.local.json -- enabled,
//      failing when unavailable, no unsandboxed retry, and a denyWrite list
//      for cairn's protected folders and git's (#567, setup/sandbox.mjs,
//      asserted: sandbox.test.ts). Opt-in and the owner's, as --git-hooks
//      is: the harness guard refuses it from an agent (asserted: hooks.test.ts).
//
// Every copied-artifact surface gets a version stamp (.cairn-manifest.json:
// source version + install date) so `--check` can answer "what's actually
// installed where" (#82): it walks the surfaces, compares stamps against
// this clone's version, prints a per-surface table, writes NOTHING, and
// exits non-zero when anything lags — so it can gate. It also walks the
// readers: whether the harness's session-start file reaches the fragment
// (setup/spine-reach.mjs holds the table), and the git layer: whether the
// pre-push hook is installed and git still runs hooks from there (#456).
//
// Additive and idempotent: existing config entries are merged, never
// clobbered; re-running produces byte-identical results. Every project-scoped
// write goes through one link check: a link leaving the project, or one that
// points at nothing, is the owner's file somewhere else and is refused (#498,
// asserted: setup.test.ts, which also counts the raw writers' call sites).
// Dependency-free node — builtins only.
//
// Not seen, dated 2026-11-05 (each pinned in server/test/setup.test.ts):
//   - a local core.hooksPath naming a folder other repositories name in their
//     own local configs is respected; git keeps no list of them (#497).
//   - a local core.hooksPath the owner points inside the working tree (a
//     tracked .githooks, a husky folder) is respected too, and the hook goes
//     there: that layout is the owner's, so a checkout can still change the
//     hook file in it, though not the script it runs, which stays under the
//     git common directory (#558, pinned in gitlayer.test.ts).
//   - the hook drops PATH folders inside the worktree it runs in before it
//     runs node (#558); a PATH folder inside another linked worktree of the
//     repository, or a program file elsewhere that links into a worktree, is
//     kept (pinned in gitlayer.test.ts).
//   - a hard link has no direction: one to a file outside the project is that
//     file, by this name too, so it is written through (#498).
//   - a link staying inside the project writes as today, wherever inside it
//     lands, the .git folder included (#498).
//   - a home-scoped write (~/.codex, ~/.copilot, ~/.gemini) follows a link on
//     purpose: a dotfiles manager keeps those as links (#498).
//   - a link swapped in between the check and the write: the check is one
//     look per write, with no lock held across it (#498).

import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEGIN, READERS, insideDir, reachFrom, realOrNull, sameFile, spliceFragment, spliceImport,
} from "./spine-reach.mjs";
import { SANDBOX_FLAG, checkSandbox, installSandbox } from "./sandbox.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESSES = ["grok", "copilot", "codex", "gemini", "cursor", "opencode", "zed", "claude"];

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage: node setup/cairn-setup.mjs <${HARNESSES.join("|")}> [--project <dir>] [--local] [--check] [--git-hooks] [--sandbox]`);
  process.exit(msg ? 1 : 0);
}

// --- args --------------------------------------------------------------------

const args = process.argv.slice(2);
const harness = args[0];
if (!harness || harness.startsWith("--")) usage("missing harness");
if (!HARNESSES.includes(harness)) usage(`unknown harness: ${harness}`);
const projIdx = args.indexOf("--project");
if (projIdx >= 0 && (!args[projIdx + 1] || args[projIdx + 1].startsWith("--"))) {
  usage("--project needs a directory");
}
const projectDir = resolve(projIdx >= 0 ? args[projIdx + 1] : process.cwd());
const useLocal = args.includes("--local");
const checkMode = args.includes("--check");
const gitHooks = args.includes("--git-hooks");

// --- helpers -----------------------------------------------------------------

/** Does a project-scoped path reach through a link that leaves the project, or
 *  one that points at nothing? Every name from the project down is looked at,
 *  so a folder link above the file counts as much as a link at the file. A
 *  path outside the project is a home-scoped write, not this check's (the Not
 *  seen block above). `base` is the project, or the worktree root for a hooks
 *  folder a project below the root reaches up to (#526).
 *  :returns { link, real } with real null when dangling, or null when clear */
function linkOut(path, base = projectDir) {
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const root = realOrNull(base);
  let at = base;
  for (const name of rel.split(sep)) {
    at = join(at, name);
    try {
      if (!lstatSync(at).isSymbolicLink()) continue;
    } catch {
      return null; // absent from here down: a fresh write lands inside
    }
    const real = realOrNull(at);
    if (real === null || !insideDir(real, root)) return { link: at, real };
  }
  return null;
}

/** The refusal's one line (#429 wrote it for CLAUDE.md; #498 made it everyone's). */
function linkRefusal({ link, real }, wayOut = "point the link inside the project, then re-run cairn-setup") {
  return real === null
    ? `  ${link}: is a symlink to a file that does not exist — refusing to write through it; fix the link, then re-run cairn-setup.`
    : `  ${link}: resolves outside the project (${real}) — refusing to write through it; ${wayOut}.`;
}

/** The one check every write passes (#498): a link out stops setup, exit 1, the
 *  way a config that does not parse does. What landed before it stays, and a
 *  re-run is byte-identical. :returns path */
function checkLinks(path, base) {
  const out = linkOut(path, base);
  if (out) {
    console.error(linkRefusal(out));
    process.exit(1);
  }
  return path;
}

// The only call sites of the fs writers in this file (asserted: setup.test.ts).
function writeChecked(path, data, base) {
  writeFileSync(checkLinks(path, base), data);
}
function copyChecked(src, path, base) {
  copyFileSync(src, checkLinks(path, base));
}
function mkdirChecked(path, base) {
  mkdirSync(checkLinks(path, base), { recursive: true });
}

/** The command that launches the server. Default is the portable npx form —
 *  the configs this script writes get committed and shared, and an absolute
 *  clone path breaks for every teammate who isn't this machine (CRN-75).
 *  `--local` opts into this clone's built server for cairn development. */
function serverCommand() {
  if (useLocal) {
    const dist = join(repoRoot, "server", "dist", "index.js");
    if (!existsSync(dist)) {
      console.error("--local: no built server at server/dist/index.js — run `cd server && npm run build` first");
      process.exit(1);
    }
    return { command: "node", args: [dist] };
  }
  return { command: "npx", args: ["-y", "@eventually-consistent/cairn-server"] };
}

/** Missing file → null (fine, we create it). A file that EXISTS but doesn't
 *  parse is never treated as absent — overwriting it would silently destroy
 *  whatever the user had in it (other MCP servers, settings). Stop instead. */
function readJson(path) {
  checkLinks(path);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`  ${path}: exists but is not valid JSON — refusing to touch it. Fix or remove it, then re-run cairn-setup.`);
    process.exit(1);
  }
}

/** Merge the cairn server entry into an mcpServers-shaped JSON config.
 *  An existing, different `cairn` entry is left alone (reported, not clobbered). */
function mergeMcpJson(path) {
  const existing = readJson(path) ?? {};
  const servers = existing.mcpServers ?? {};
  const entry = serverCommand();
  if (servers.cairn) {
    if (JSON.stringify(servers.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${path}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${path}: cairn entry already present...`);
    }
    return;
  }
  const next = { ...existing, mcpServers: { ...servers, cairn: entry } };
  mkdirChecked(dirname(path));
  writeChecked(path, JSON.stringify(next, null, 2) + "\n");
  console.log(`  ${path}: cairn MCP entry added.`);
}

/** Install/replace the marker-delimited cairn fragment inside a markdown file. */
function installFragment(path, fragment) {
  checkLinks(path);
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  // Orphaned begin marker (truncated file / hand edit): appending would
  // duplicate the whole fragment. Stop rather than guess.
  const { next, error } = spliceFragment(body, fragment);
  if (error) {
    console.error(`  ${path}: ${error} — fix the markers, then re-run cairn-setup.`);
    process.exit(1);
  }
  if (next === body) {
    console.log(`  ${path}: cairn section already current...`);
    return;
  }
  mkdirChecked(dirname(path));
  writeChecked(path, next);
  console.log(`  ${path}: cairn section installed.`);
}

/** Which way two names meet on one file, for the one-line alias note (#473).
 *  :returns "symlink" (CLAUDE.md is the link, the #429 shape),
 *    "AGENTS.md is the symlink", or "hard link" */
function linkShape(claude, agents) {
  const isLink = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (isLink(claude)) return "symlink";
  if (isLink(agents)) return "AGENTS.md is the symlink";
  return "hard link";
}

/** Put the `@AGENTS.md` import at the top of CLAUDE.md (#398), inside the
 *  cairn markers, idempotent. Claude Code reads AGENTS.md only when no
 *  CLAUDE.md is in scope (a claim, as of 2026-10, per the Claude Code memory
 *  docs), so without this line a project that has both never shows Claude
 *  the spine.
 *  :param create write a CLAUDE.md holding only the import when none exists
 *    (the claude target); every other target touches an existing one only
 *  :returns "installed" | "alias" | "refused" | "absent" -- the claude tail
 *    line reads it */
function installClaudeImport(path, { create }) {
  let body = null;
  try {
    body = readFileSync(path, "utf8");
  } catch { /* absent */ }
  if (body === null && !create) return "absent";

  // #429/#473: one file by two names, checked BEFORE any splice and whichever
  // name is the link. CLAUDE.md as a symlink to AGENTS.md, AGENTS.md as a
  // symlink to CLAUDE.md, or the two names one hard-linked inode: the spine
  // was just installed through the AGENTS.md name into these same bytes, and
  // splicing the import here would replace it with a block that imports
  // itself. #429 gated this on CLAUDE.md being the symlink, so the other two
  // layouts erased the spine and printed the success line; sameFile now
  // compares real path, then device and inode. One line, nothing written,
  // same line on every re-run (asserted: setup.test.ts and
  // sweep-surface.test.ts, #429, #473).
  const agentsPath = join(projectDir, "AGENTS.md");
  if (sameFile(path, agentsPath)) {
    console.log(`  ${path}: is AGENTS.md by another name (${linkShape(path, agentsPath)}) — import skipped; Claude Code reads the spine straight from it.`);
    return "alias";
  }

  // A CLAUDE.md that is itself a symlink to something else: a link that
  // leaves the project (or points at nothing) is the owner's file somewhere
  // else -- refused in one line, nothing written (#429). The one check every
  // other write takes, with the difference that this file is optional: the
  // install goes on, the claude tail line says so and --check reports it.
  const out = linkOut(path);
  if (out) {
    console.log(linkRefusal(out, "point the link inside the project or add the @AGENTS.md import by hand"));
    return "refused";
  }

  const { next, note, error } = spliceImport(body ?? "");
  if (error) {
    console.error(`  ${path}: ${error} — fix the markers, then re-run cairn-setup.`);
    process.exit(1);
  }
  if (next === body) {
    console.log(`  ${path}: ${note}...`);
    return "installed";
  }
  writeChecked(path, next);
  console.log(`  ${path}: @AGENTS.md ${note} (Claude Code reads the spine through it).`);
  return "installed";
}

// The helpers the verbs tell the agent to run (#474). They are copied beside
// the verbs into harness/scripts/ under the cairn home folder, for EVERY
// harness, together with every `./x.mjs` they import so the copy runs where
// it lands (node builtins need nothing). The verbs name them through
// $CLAUDE_PLUGIN_ROOT, a variable only Claude Code sets, so the copied verbs
// are re-pointed at that folder on the way in; the claude target keeps the
// plugin root (asserted: setup.test.ts, #474). Phase 30 copied the hook
// scripts folder for Cursor alone and said setup copied it everywhere.
const VERB_HELPERS = ["merge-overlap.mjs", "cost-report.mjs"];
const SCRIPTS_REL = [".cairn", "harness", "scripts"].join("/");
const PLUGIN_SCRIPTS = '"$CLAUDE_PLUGIN_ROOT/hooks/scripts/';

/** The helper files plus every relative `./x.mjs` they import, transitively.
 *  :returns sorted file names under dir */
function helperClosure(dir, names) {
  const seen = new Set();
  const queue = [...names];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const body = readFileSync(join(dir, f), "utf8");
    for (const m of body.matchAll(/^import\b[^;]*?from\s+"\.\/([^"]+\.mjs)"/gm)) queue.push(m[1]);
  }
  return [...seen].sort();
}

/** Copy the verb subroutines + registry into the project for pluginless
 *  harnesses, plus the helpers the verbs run (#474). */
function installVerbs() {
  const srcDir = join(repoRoot, "skills", "cairn-trailhead");
  const outDir = join(projectDir, ".cairn", "harness");
  mkdirChecked(join(outDir, "verbs"));
  mkdirChecked(join(outDir, "scripts"));
  // Verb text is re-pointed on the way in, never copied raw, so every
  // harness but claude reads a path that exists in its own install.
  const localize = (body) => (harness === "claude" ? body : body.replaceAll(PLUGIN_SCRIPTS, `"${SCRIPTS_REL}/`));
  writeChecked(join(outDir, "SKILL.md"), localize(readFileSync(join(srcDir, "SKILL.md"), "utf8")));
  let n = 0;
  for (const f of readdirSync(join(srcDir, "verbs"))) {
    if (!f.endsWith(".md")) continue;
    writeChecked(join(outDir, "verbs", f), localize(readFileSync(join(srcDir, "verbs", f), "utf8")));
    n++;
  }
  const helpers = helperClosure(join(repoRoot, "hooks", "scripts"), VERB_HELPERS);
  for (const f of helpers) copyChecked(join(repoRoot, "hooks", "scripts", f), join(outDir, "scripts", f));
  stampInstall(outDir, "verb subroutines");
  console.log(`  .cairn/harness/: registry + ${n} verb subroutines installed (stamped v${sourceVersion}).`);
  console.log(`  ${SCRIPTS_REL}/: ${helpers.length} verb helpers installed (${helpers.join(", ")}); ${harness === "claude" ? "the verbs keep the plugin root" : "the copied verbs name them there"}.`);
}

/** Merge the [mcp_servers.cairn] block into ~/.codex/config.toml between
 *  marker comments — no TOML parser needed, and re-runs stay byte-identical.
 *  A hand-written cairn block outside the markers is left alone. */
function mergeCodexToml(path) {
  const TOML_BEGIN = "# cairn:begin — managed by cairn-setup; do not edit inside markers";
  const TOML_END = "# cairn:end";
  const { command, args: cmdArgs } = serverCommand();
  const block = `${TOML_BEGIN}\n[mcp_servers.cairn]\ncommand = "${command}"\nargs = [${cmdArgs.map((a) => `"${a}"`).join(", ")}]\n${TOML_END}\n`;
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  const start = body.indexOf(TOML_BEGIN);
  const end = body.indexOf(TOML_END);
  let next;
  if (start >= 0 && end > start) {
    // block ends with \n, so drop at most one leading newline from the
    // remainder — never a content byte (a hand-edit may omit the newline).
    const after = body.slice(end + TOML_END.length).replace(/^\n/, "");
    next = body.slice(0, start) + block + after;
  } else if (body.includes("[mcp_servers.cairn]")) {
    console.log(`  ${path}: existing 'cairn' entry left untouched (outside cairn-setup markers)`);
    return;
  } else {
    next = body.length ? `${body.trimEnd()}\n\n${block}` : block;
  }
  if (next === body) {
    console.log(`  ${path}: cairn entry already current...`);
    return;
  }
  mkdirChecked(dirname(path));
  writeChecked(path, next);
  console.log(`  ${path}: [mcp_servers.cairn] block written.`);
}

// --- the git layer of the ship gate (#456) -----------------------------------

// The run guard sees a push only through the Bash tool of a harness that
// runs the hook; a human's terminal, a harness wired for skills but not
// hooks, and a script that shells out to git all push past it. `--git-hooks`
// installs a pre-push hook that applies the same rule to every process in
// the checkout. Opt-in, never default: it writes core.hooksPath into the
// repository's config, the owner's ground (axiom 5), so the flag is the
// consent. The hook file is a thin caller over the copied pre-push.mjs
// (its imports land beside it in the scripts folder); the rule lives in
// git-effects.mjs and lib.mjs. Asserted: setup.test.ts "(#456)".
//
// Where the pair lives (#558): both under the git common directory, in
// cairn/hooks and cairn/scripts. A folder in the working tree is one any
// checkout, merge, restore or pull writes: a contributor's branch adding a
// post-checkout there ran it as the owner, and a branch carrying its own
// copy of the script swapped the gate, or, checked out and back, deleted it,
// so the next push landed unjudged. git never writes the common directory
// from a commit, and every linked worktree reads the same one. The hook
// names its script by that one absolute path and looks nowhere else.
// Asserted: gitlayer.test.ts, each scenario a real git run.
const PREPUSH = "pre-push.mjs";
// The layout before #558, inside the working tree: read for the move and for --check, never written.
const GITHOOKS_REL = [".cairn", "githooks"].join("/");
const GATE_REL = "cairn";
const HOOK_BEGIN = "# cairn:begin -- managed by cairn-setup --git-hooks; do not edit inside markers";
const HOOK_END = "# cairn:end";
const SH_SHEBANG = /^#!.*\b(?:sh|bash|dash|ksh|zsh)\b/;

/** git's trimmed answer at `dir`, or null when it says no (no repository, no git on PATH). */
function gitAt(dir, gitArgs) {
  // GIT_CONFIG makes every plain `git config` read and write that one file, so
  // a value the shell carried would turn this install's local write into a
  // write on whatever it names (#497, asserted: setup.test.ts).
  const { GIT_CONFIG: _ignored, ...env } = process.env;
  try {
    return execFileSync("git", gitArgs, {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

const expandHome = (value) => value.replace(/^~(?=\/|$)/, homedir());

/** The folder git reads a relative core.hooksPath from: the worktree root, whatever
 *  folder below it the command stood in (measured against git 2.56.0, 2026-11-06,
 *  asserted: setup.test.ts "#526"). The project's own spelling when the project is
 *  the root, so what a root project prints stays as it was; the project's folder when
 *  git names no root, as in a bare repository. */
function worktreeRoot() {
  const top = gitAt(projectDir, ["rev-parse", "--show-toplevel"]);
  return top === null || realOrNull(top) === realOrNull(projectDir) ? projectDir : top;
}

/** A core.hooksPath value as git reads one: `~` expanded, a relative path from the worktree root. */
function hooksDirOf(value) {
  return resolve(worktreeRoot(), expandHome(value));
}

/** An answer from `rev-parse --git-path`, which is relative to where git stood:
 *  the project's real folder, since `..` steps walk the disk and not a link's name. */
function gitPathDir(answer) {
  const root = worktreeRoot();
  return resolve(root === projectDir ? projectDir : realOrNull(projectDir) ?? projectDir, answer);
}

/** The gate's folders under the git common directory, real paths (#558): `home`
 *  holds `hooks` (what core.hooksPath names) and `scripts` (what the hook runs).
 *  Every linked worktree shares the one common directory. null outside a repository. */
function gateDirs() {
  const answer = gitAt(projectDir, ["rev-parse", "--git-common-dir"]);
  const common = answer ? realOrNull(resolve(realOrNull(projectDir) ?? projectDir, answer)) : null;
  if (common === null) return null;
  const home = join(common, GATE_REL);
  return { common, home, hooks: join(home, "hooks"), scripts: join(home, "scripts") };
}

/** One folder by two spellings: real paths compared, a path that isn't there yet as written. */
const sameDir = (a, b) => (realOrNull(a) ?? resolve(a)) === (realOrNull(b) ?? resolve(b));

/** An install before #558: the hooks folder is some checkout's .cairn/githooks. */
const oldLayout = (dir) => basename(dir) === basename(GITHOOKS_REL) && basename(dirname(dir)) === dirname(GITHOOKS_REL);

/** Is a folder inside this worktree, where a checkout writes? */
function inWorkingTree(dir) {
  return insideDir(realOrNull(dir) ?? resolve(dir), realOrNull(worktreeRoot()));
}

/** A value for a sh line: single-quoted, so no folder name is ever read as shell. */
const shQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// The only scopes that are this repository's own. Anything else -- global,
// system, the environment's GIT_CONFIG_COUNT or `git -c` (git calls that one
// command), or a git too old to say -- names a folder --git-hooks has no
// consent for, so it is never written into (#497, asserted: setup.test.ts).
const OWN_SCOPES = ["local", "worktree"];

/** The core.hooksPath git obeys here and the scope it comes from, include
 *  files counted under the file that pulled them in. null when unset. A git
 *  with no --show-scope (older than 2.26) still answers the plain read, and
 *  that value reads as a scope it cannot name: refused, never guessed. */
function hooksPathSetting() {
  const scoped = gitAt(projectDir, ["config", "--show-scope", "--get", "core.hooksPath"]);
  const tab = scoped === null ? -1 : scoped.indexOf("\t");
  if (tab > 0) return { scope: scoped.slice(0, tab), value: scoped.slice(tab + 1) };
  const plain = gitAt(projectDir, ["config", "--get", "core.hooksPath"]);
  return plain ? { scope: null, value: plain } : null;
}

/** Why the folder a setting names is not this project's alone, or null: the
 *  setting's scope, or a local setting spelling the very folder the global or
 *  system config names. A relative value up there resolves per repository, so
 *  it is no one folder to collide with. */
function sharedFolderWhy(setting, dir) {
  if (!OWN_SCOPES.includes(setting.scope)) {
    return `core.hooksPath is set at ${setting.scope ? `${setting.scope} scope` : "a scope this git cannot name (git config --show-scope, git 2.26+)"}, to ${dir}`;
  }
  const real = (p) => realOrNull(p) ?? resolve(p);
  for (const scope of ["global", "system"]) {
    const value = gitAt(projectDir, ["config", `--${scope}`, "--includes", "--get", "core.hooksPath"]);
    if (value && isAbsolute(expandHome(value)) && real(expandHome(value)) === real(dir)) {
      return `core.hooksPath here names ${dir}, the folder the ${scope} config names`;
    }
  }
  return null;
}

/** The marker-delimited block: the gate runs first, and the refs git handed
 *  over stay on stdin for whatever the owner keeps below the markers. The
 *  script is named by one absolute path under the git common directory, and
 *  looked for nowhere else (#558): the worktree git runs the hook in is what a
 *  checkout writes, and every linked worktree shares the common directory.
 *  node, and the git the script runs, come from PATH with this worktree's
 *  folders taken out, and the owner's lines after the markers get PATH back.
 *  Exit 2 from the script is the refusal; anything else fails open. */
function hookBlock(gate) {
  return [
    HOOK_BEGIN,
    "# The git layer of cairn's ship gate: a push landing on the default branch",
    "# is refused without a clean drift stamp for the exact commit pushed, judged",
    "# by the shared effect table and stamp reader (no rule lives in this file).",
    "# Exit 2 from the script refuses the push; anything else fails open, so a",
    "# missing node or script never blocks a push -- it says so instead. The refs",
    "# git hands this hook are kept on stdin for whatever follows the markers.",
    "# The script lives under the git common directory, which no checkout writes.",
    `cairn_prepush=${shQuote(join(gate.scripts, PREPUSH))}`,
    "# Every program the block runs, node and the git the script calls, comes from",
    "# a PATH folder outside this worktree: a branch can carry node_modules/.bin/node,",
    "# and npm puts that folder first. The owner's lines below get their PATH back.",
    'cairn_top=$(pwd -P); cairn_oldpath=$PATH; cairn_safe=; cairn_ifs=$IFS; IFS=:',
    "for cairn_d in $PATH; do",
    '  case "$cairn_d" in /*) ;; *) continue ;; esac',
    '  cairn_real=$(cd "$cairn_d" 2>/dev/null && pwd -P) || continue',
    '  case "$cairn_real/" in "$cairn_top"/*) continue ;; esac',
    "  cairn_safe=${cairn_safe:+$cairn_safe:}$cairn_d",
    "done",
    "IFS=$cairn_ifs; PATH=$cairn_safe",
    'if command -v node >/dev/null 2>&1 && [ -f "$cairn_prepush" ]; then',
    "  if cairn_refs=$(mktemp 2>/dev/null); then",
    '    cat > "$cairn_refs"',
    '    node "$cairn_prepush" "$@" < "$cairn_refs"; cairn_rc=$?',
    '    exec < "$cairn_refs"',
    '    rm -f "$cairn_refs"',
    "  else",
    '    node "$cairn_prepush" "$@"; cairn_rc=$?',
    "  fi",
    '  [ "$cairn_rc" -ne 2 ] || exit 1',
    "else",
    '  echo "cairn pre-push: node or $cairn_prepush not found -- this push was not judged" >&2',
    "fi",
    "PATH=$cairn_oldpath",
    HOOK_END,
  ].join("\n") + "\n";
}

/** The existing hook with the cairn block spliced in: replaced between the
 *  markers; else put right after a sh shebang (one is written when there is
 *  no file or no shebang). Another interpreter's hook is refused -- sh lines
 *  at its top would break it. An orphaned marker is refused, never guessed. */
function spliceHook(body, block, scriptsDir) {
  const start = body.indexOf(HOOK_BEGIN);
  const end = body.indexOf(HOOK_END);
  if (start >= 0 && end > start) {
    const after = body.slice(end + HOOK_END.length).replace(/^\n/, "");
    return { next: body.slice(0, start) + block + after };
  }
  if (start >= 0 || end >= 0) return { error: "an orphaned cairn marker (begin without end, or end without begin)" };
  if (body.length === 0) return { next: `#!/bin/sh\n${block}` };
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  if (!first.startsWith("#!")) return { next: `#!/bin/sh\n${block}${body}` };
  if (!SH_SHEBANG.test(first)) {
    return { error: `runs under ${first.slice(2).trim()}, not sh -- call ${join(scriptsDir, PREPUSH)} from it by hand` };
  }
  return { next: `${first}\n${block}${nl < 0 ? "" : body.slice(nl + 1)}` };
}

/** True for a pre-push holding this install's block and nothing around it but a shebang. */
function onlyOurBlock(path) {
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const start = body.indexOf(HOOK_BEGIN);
  const end = body.indexOf(HOOK_END);
  if (start < 0 || end < start) return false;
  return /^(?:#![^\n]*\n)?\s*$/.test(body.slice(0, start) + body.slice(end + HOOK_END.length));
}

/** What in a hooks folder this install did not write (#508): a sample or a
 *  dotfile git never runs aside, every name but a pre-push of ours alone. */
function foreignHooks(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith(".") && !n.endsWith(".sample"));
  } catch { /* no folder yet: nothing to arm */ }
  return names.filter((n) => n !== "pre-push" || !onlyOurBlock(join(dir, n)));
}

/** Where the hook goes: cairn's own folder under the git common directory
 *  (#558), which the install then names; or the folder a local or worktree
 *  core.hooksPath names when the owner set one (respected, the setting stays).
 *  A setting naming some checkout's .cairn/githooks is an install before #558,
 *  and it moves: the pointer changes, the old folder is left as it was.
 *  Refused: a folder the setting shares with other repositories (#497), the
 *  install says why and writes nothing there; live hooks in the folder git runs
 *  today that a new hooksPath would silence, the owner moves them or sets the path. */
function gitHooksTarget() {
  const gate = gateDirs();
  if (gate === null) {
    return { error: "not a git repository -- nothing for a pre-push hook to guard" };
  }
  const setting = hooksPathSetting();
  if (setting) {
    const dir = hooksDirOf(setting.value);
    const why = sharedFolderWhy(setting, dir);
    if (why) {
      const wayOut = setting.scope === "command"
        ? "drop the setting from this environment"
        : `to gate this project alone, run \`git config --local core.hooksPath ${gate.hooks}\` (the shared hooks then stop running in this repository)`;
      return { error: `${why}: every repository it reaches runs hooks from that folder, and --git-hooks is consent for this project alone, so nothing was written there -- ${wayOut}, then re-run` };
    }
    if (sameDir(dir, gate.hooks)) return { gate, dir: gate.hooks, configured: setting.value, base: gate.common };
    if (oldLayout(dir)) return { gate, dir: gate.hooks, configured: null, base: gate.common, moved: { dir, scope: setting.scope } };
    return { gate, dir, configured: setting.value, base: worktreeRoot(), inTree: inWorkingTree(dir) };
  }
  const today = gitAt(projectDir, ["rev-parse", "--git-path", "hooks"]);
  const todayDir = today ? gitPathDir(today) : null;
  let live = [];
  try {
    live = readdirSync(todayDir).filter((n) => !n.startsWith(".") && !n.endsWith(".sample"));
  } catch { /* no hooks folder yet: nothing a hooksPath would silence */ }
  if (live.length) {
    return { error: `${todayDir} holds live hooks (${live.join(", ")}) that a core.hooksPath would silence -- ` +
      `move them under ${gate.hooks}, or set core.hooksPath yourself, then re-run` };
  }
  return { gate, dir: gate.hooks, configured: null, base: gate.common };
}

/** Install the git layer: the script and its imports under the git common
 *  directory, the hook under the markers, core.hooksPath set once. Idempotent:
 *  a re-run is byte-identical. */
function installGitHooks() {
  const target = gitHooksTarget();
  if (target.error) {
    console.error(`  --git-hooks: ${target.error}.`);
    process.exit(1);
  }
  const { gate } = target;
  const path = checkLinks(join(target.dir, "pre-push"), target.base);
  // Setting the pointer arms whatever the folder holds (#508), so one holding
  // hooks this install did not write is the owner's to read first. A setting
  // already there arms nothing new, and its folder keeps what it holds.
  const foreign = target.configured === null ? foreignHooks(target.dir) : [];
  if (foreign.length) {
    console.error(`  --git-hooks: ${target.dir} holds hooks this install did not write (${foreign.join(", ")}), and pointing core.hooksPath at it would arm them for your next commit or push -- ` +
      "read them, then remove them, or set core.hooksPath yourself, then re-run.");
    process.exit(1);
  }
  mkdirChecked(gate.scripts, gate.common);
  for (const f of helperClosure(join(repoRoot, "hooks", "scripts"), [PREPUSH])) {
    copyChecked(join(repoRoot, "hooks", "scripts", f), join(gate.scripts, f), gate.common);
  }
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  const { next, error } = spliceHook(body, hookBlock(gate), gate.scripts);
  if (error) {
    console.error(`  ${path}: ${error} -- then re-run cairn-setup.`);
    process.exit(1);
  }
  mkdirChecked(target.dir, target.base);
  if (next !== body) writeChecked(path, next, target.base);
  chmodSync(checkLinks(path, target.base), 0o755);
  // The move keeps the scope the old pointer had: a worktree setting outranks a local one.
  const scope = target.moved?.scope === "worktree" ? "--worktree" : "--local";
  if (target.configured === null && gitAt(projectDir, ["config", scope, "core.hooksPath", target.dir]) === null) {
    console.error(`  core.hooksPath could not be set to ${target.dir} -- set it yourself, then re-run cairn-setup.`);
    process.exit(1);
  }
  console.log(`  ${path}: pre-push hook ${next === body ? "already current..." : "installed (the ship gate's default-branch rule, for every process here)."}`);
  console.log(`  ${join(gate.scripts, PREPUSH)}: the script the hook runs, under the git common directory (no checkout writes there).`);
  if (target.moved) {
    // Moved, never deleted (#558): what the old folder holds is the owner's to read,
    // and nothing in it is copied across, since a checkout may have put it there.
    console.log(`  core.hooksPath: moved from ${target.moved.dir}, inside the working tree, to ${target.dir}; the old folder is left as it was.`);
    const left = foreignHooks(target.moved.dir);
    if (left.length) {
      console.log(`  ${target.moved.dir}: no longer runs ${left.join(", ")} -- read them, and move any you keep into ${target.dir} yourself.`);
    }
    return;
  }
  console.log(`  core.hooksPath: ${target.configured === null ? `set to ${target.dir}` : `already ${target.configured}, left as is -- the hook went into that folder`}.`);
  if (target.inTree) {
    console.log(`  note: ${target.dir} is inside the working tree, so a checkout can change the hook file there (the script it runs stays under the git common directory) -- that layout is yours, and it stays.`);
  }
}

/** Read-only, for --check: where git runs hooks today, and whether cairn's
 *  pre-push is there, current, with its script under the git common directory.
 *  null outside a repository (no line). */
function gitLayerStatus() {
  const today = gitAt(projectDir, ["rev-parse", "--git-path", "hooks"]);
  const gate = gateDirs();
  if (today === null || gate === null) return null;
  const dir = gitPathDir(today);
  const setting = hooksPathSetting();
  const script = join(gate.scripts, PREPUSH);
  const read = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const carries = (p) => read(p).includes(HOOK_BEGIN);
  if (carries(join(dir, "pre-push"))) {
    // An older install wrote here before #497: setup never writes here now,
    // and it never deletes, so the block stays until the owner takes it out.
    const why = setting ? sharedFolderWhy(setting, dir) : null;
    if (why) {
      return { detail: `installed at ${dir}, but ${why}: every repository it reaches runs this project's gate -- take the cairn block out of that file`, lagging: true };
    }
    if (oldLayout(dir)) {
      return { detail: `installed at ${dir}, inside the working tree, where a checkout can change what runs or delete the gate (#558) -- re-run with --git-hooks to move it to ${gate.hooks}`, lagging: true };
    }
    if (!read(join(dir, "pre-push")).includes(hookBlock(gate))) {
      return { detail: `installed at ${dir}, but its block is an older one, which looks for the script in the working tree (#558), or names another git folder -- re-run with --git-hooks`, lagging: true };
    }
    if (!existsSync(script)) {
      return { detail: `installed at ${dir}, but ${script} is missing -- not reached; re-run with --git-hooks`, lagging: true };
    }
    const out = linkOut(script, gate.common);
    if (out) {
      return { detail: `installed at ${dir}, but ${out.link} leads out of the git folder (${out.real ?? "to nothing"}), so what runs is not what setup wrote -- remove the link, then re-run with --git-hooks`, lagging: true };
    }
    const note = inWorkingTree(dir) ? " (a folder inside the working tree, by your core.hooksPath: a checkout can change the hook file there, not the script it runs)" : "";
    return { detail: `installed at ${dir}; git runs hooks from there${note}` };
  }
  if (carries(join(gate.hooks, "pre-push"))) {
    return { detail: `installed at ${gate.hooks}, but git runs hooks from ${dir} -- not reached; re-run with --git-hooks, or point core.hooksPath back`, lagging: true };
  }
  const ours = join(projectDir, GITHOOKS_REL);
  if (carries(join(ours, "pre-push"))) {
    return { detail: `installed at ${ours}, inside the working tree (#558), and git runs hooks from ${dir} -- not reached; re-run with --git-hooks`, lagging: true };
  }
  // An install before #526 read a relative value from the project, and git never runs that folder.
  const stranded = setting ? resolve(projectDir, expandHome(setting.value)) : null;
  if (stranded !== null && carries(join(stranded, "pre-push"))) {
    return { detail: `installed at ${stranded}, but git reads a relative core.hooksPath from the worktree root and runs hooks from ${dir} -- not reached; re-run with --git-hooks`, lagging: true };
  }
  return { detail: "not installed (opt-in: --git-hooks adds the pre-push ship gate)" };
}

// --- version stamps + --check (#82) ------------------------------------------

// The harness installs above are point-in-time COPIES — without a stamp there
// is no answer to "what version is actually installed here". So every copied
// surface gets a small manifest at install time, and --check reads them back.
const MANIFEST = ".cairn-manifest.json";
const sourceVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

/** Write the version stamp alongside a surface's installed artifacts. */
function stampInstall(dir, surface) {
  writeChecked(join(dir, MANIFEST), JSON.stringify({
    surface, harness, version: sourceVersion,
    installedAt: new Date().toISOString(), installedBy: "cairn-setup",
  }, null, 2) + "\n");
}

/** The copied-artifact surfaces this harness owns (universal layer first). */
function surfacesFor(h) {
  const s = [{ label: ".cairn/harness (verb subroutines)", dir: join(projectDir, ".cairn", "harness") }];
  if (h === "copilot") s.push({ label: ".github/prompts (copilot prompts)", dir: join(projectDir, ".github", "prompts") });
  if (h === "gemini") s.push({ label: ".gemini/commands/cairn (gemini TOML commands)", dir: join(projectDir, ".gemini", "commands", "cairn") });
  if (h === "codex") s.push({ label: "~/.codex/prompts (codex prompts)", dir: join(homedir(), ".codex", "prompts") });
  if (h === "cursor") s.push({ label: ".cursor/hooks/cairn (adapter + hook scripts)", dir: join(projectDir, ".cursor", "hooks", "cairn") });
  if (h === "opencode") s.push({ label: ".opencode/commands (opencode commands)", dir: join(projectDir, ".opencode", "commands") });
  return s;
}

/** Manifest reader for check mode: a corrupt or missing stamp is "no stamp",
 *  never a hard stop — check reports, it doesn't repair. */
function readManifest(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    return typeof m.version === "string" ? m : null;
  } catch {
    return null;
  }
}

/** Latest published npm version — advisory only, fails soft to "unknown"
 *  (an unreachable registry must never fail the gate). */
async function npmLatestVersion() {
  if (process.env.CAIRN_SETUP_OFFLINE) return "unknown";
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2000);
    try {
      const res = await fetch("https://registry.npmjs.org/@eventually-consistent%2fcairn-server/latest", { signal: ctl.signal });
      if (!res.ok) return "unknown";
      const body = await res.json();
      return typeof body.version === "string" ? body.version : "unknown";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unknown";
  }
}

if (checkMode) {
  // Read-only by construction: this branch writes nothing and exits before
  // any install code runs. Exit 0 = all current, 1 = something lags (gate).
  console.log(`checking installed cairn artifacts for ${harness} in ${projectDir}...`);
  let lagging = 0;
  for (const s of surfacesFor(harness)) {
    if (!existsSync(s.dir)) {
      console.log(`  ${s.label}: not installed`);
      continue;
    }
    const m = readManifest(s.dir);
    if (!m) {
      console.log(`  ${s.label}: no stamp — predates stamping, reinstall to adopt`);
      lagging++;
    } else if (m.version === sourceVersion) {
      console.log(`  ${s.label}: v${m.version} (current, installed ${m.installedAt ?? "unknown date"})`);
    } else {
      console.log(`  ${s.label}: installed v${m.version}, available v${sourceVersion}`);
      lagging++;
    }
  }
  // Readers (#398): does this harness's session-start file reach the
  // fragment? For claude a CLAUDE.md without the import is red outright --
  // that is the gap. For the rest, an absent file is "not installed", and a
  // CLAUDE.md beside an installed AGENTS.md must still carry the import.
  // The rendered fragment goes along (#429) so a span that holds only the
  // import block, or a stale copy, reads as not reaching -- without it any
  // marker span counted.
  const fragment = readFileSync(join(repoRoot, "harness", "AGENTS-cairn.md"), "utf8");
  const row = READERS.find((r) => r.harness === harness);
  const agentsInstalled = reachFrom(projectDir, { loadFile: "AGENTS.md", via: "direct" }, { fragment }).state === "reaches";
  if (harness === "claude") {
    const r = reachFrom(projectDir, row, { fragment });
    if (r.state === "reaches") {
      console.log(`  readers (${row.path}): ${r.detail}`);
    } else {
      console.log(`  readers (${row.path}): ${r.detail} — Claude Code has no path to the spine`);
      lagging++;
    }
  } else {
    const r = reachFrom(projectDir, row, { fragment });
    console.log(`  readers (${row.path}): ${r.state === "absent" ? "not installed" : r.detail}`);
    if (r.state === "broken" && r.detail.includes("cairn:begin")) lagging++;
    if (agentsInstalled && existsSync(join(projectDir, "CLAUDE.md"))) {
      const c = reachFrom(projectDir, READERS.find((x) => x.harness === "claude"), { fragment });
      if (c.state !== "reaches") {
        console.log(`  readers (CLAUDE.md → @AGENTS.md → fragment): ${c.detail} — Claude Code sessions here never read the spine`);
        lagging++;
      }
    }
  }

  // The git layer (#456): is the pre-push hook where git runs hooks from?
  // Absent is opt-in, never lagging; installed but unreached lags.
  const layer = gitLayerStatus();
  if (layer) {
    console.log(`  git hooks (pre-push): ${layer.detail}`);
    if (layer.lagging) lagging++;
  }
  if (harness === "claude") lagging += checkSandbox(projectDir); // the sandbox recipe (#567): absent is opt-in

  const latest = await npmLatestVersion();
  if (latest !== "unknown" && latest !== sourceVersion) {
    console.log(`  note: npm has v${latest}; this clone is v${sourceVersion} — pull/update before reinstalling.`);
  }
  if (lagging > 0) {
    console.log(`${lagging} surface(s) lag or miss their reader — re-run \`node setup/cairn-setup.mjs ${harness}\` to adopt v${sourceVersion}.`);
    process.exit(1);
  }
  console.log("all installed surfaces current.");
  process.exit(0);
}

// --- main --------------------------------------------------------------------

const fragment = readFileSync(join(repoRoot, "harness", "AGENTS-cairn.md"), "utf8");
console.log(`wiring cairn into ${harness} for ${projectDir}...`);
if (args.includes(SANDBOX_FLAG)) installSandbox({ harness, projectDir, write: writeChecked, mkdir: mkdirChecked }); // opt-in (#567)

// Universal layer — every harness benefits from these three.
mergeMcpJson(join(projectDir, ".mcp.json"));
installFragment(join(projectDir, "AGENTS.md"), fragment);
const claudeImport = installClaudeImport(join(projectDir, "CLAUDE.md"), { create: harness === "claude" });
installVerbs();
if (gitHooks) installGitHooks();

if (harness === "copilot") {
  mergeMcpJson(join(homedir(), ".copilot", "mcp-config.json"));
  installFragment(join(projectDir, ".github", "copilot-instructions.md"), fragment);
  const promptsSrc = join(repoRoot, "harness", "copilot", "prompts");
  const promptsOut = join(projectDir, ".github", "prompts");
  mkdirChecked(promptsOut);
  for (const f of readdirSync(promptsSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyChecked(join(promptsSrc, f), join(promptsOut, f));
  }
  stampInstall(promptsOut, "copilot prompts");
  console.log(`  .github/prompts/: cairn prompt files installed (stamped v${sourceVersion}).`);
}

if (harness === "gemini") {
  const settingsPath = join(homedir(), ".gemini", "settings.json");
  mergeMcpJson(settingsPath);
  installFragment(join(projectDir, "GEMINI.md"), fragment);
  const cmdSrc = join(repoRoot, "harness", "gemini", "commands", "cairn");
  const cmdOut = join(projectDir, ".gemini", "commands", "cairn");
  mkdirChecked(cmdOut);
  for (const f of readdirSync(cmdSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyChecked(join(cmdSrc, f), join(cmdOut, f));
  }
  stampInstall(cmdOut, "gemini TOML commands");
  console.log(`  .gemini/commands/cairn/: TOML commands installed (/cairn:plan, /cairn:work, ...) (stamped v${sourceVersion}).`);
}

if (harness === "codex") {
  mergeCodexToml(join(homedir(), ".codex", "config.toml"));
  const promptsSrc = join(repoRoot, "harness", "codex", "prompts");
  const promptsOut = join(homedir(), ".codex", "prompts");
  mkdirChecked(promptsOut);
  for (const f of readdirSync(promptsSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyChecked(join(promptsSrc, f), join(promptsOut, f));
  }
  stampInstall(promptsOut, "codex prompts");
  console.log(`  ~/.codex/prompts/: cairn prompt files installed (Codex reads AGENTS.md from the project) (stamped v${sourceVersion}).`);
}

if (harness === "cursor") {
  mergeMcpJson(join(projectDir, ".cursor", "mcp.json"));

  // Hooks port: adapter + the cairn hook scripts, then hooks.json entries.
  const hooksOut = join(projectDir, ".cursor", "hooks", "cairn");
  mkdirChecked(hooksOut);
  copyChecked(join(repoRoot, "harness", "cursor", "cursor-adapter.mjs"),
    join(hooksOut, "cursor-adapter.mjs"));
  for (const f of readdirSync(join(repoRoot, "hooks", "scripts"))) {
    if (f.endsWith(".mjs")) copyChecked(join(repoRoot, "hooks", "scripts", f), join(hooksOut, f));
  }
  stampInstall(hooksOut, "cursor adapter + hook scripts");
  console.log(`  .cursor/hooks/cairn/: adapter + hook scripts installed (stamped v${sourceVersion}).`);

  // Merge our adapter into .cursor/hooks.json, keeping any foreign entries.
  const hooksJsonPath = join(projectDir, ".cursor", "hooks.json");
  const template = JSON.parse(readFileSync(join(repoRoot, "harness", "cursor", "hooks.json"), "utf8"));
  const existing = readJson(hooksJsonPath);
  let next;
  if (!existing) {
    next = template;
  } else {
    next = { ...existing, version: existing.version ?? 1, hooks: { ...(existing.hooks ?? {}) } };
    for (const [event, entries] of Object.entries(template.hooks)) {
      const current = next.hooks[event] ?? [];
      const present = current.some((e) => (e.command ?? "").includes("cursor-adapter.mjs"));
      next.hooks[event] = present ? current : [...current, ...entries];
    }
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  let prior = "";
  try {
    prior = readFileSync(hooksJsonPath, "utf8");
  } catch { /* new file */ }
  if (serialized === prior) {
    console.log(`  ${hooksJsonPath}: cairn hooks already current...`);
  } else {
    writeChecked(hooksJsonPath, serialized);
    console.log(`  ${hooksJsonPath}: cairn hook entries merged (cost tracker stays Claude-only).`);
  }
}

if (harness === "opencode") {
  // opencode.json uses its own mcp shape: {mcp: {cairn: {type: "local", command: [...]}}}.
  const cfgPath = join(projectDir, "opencode.json");
  const existing = readJson(cfgPath) ?? {};
  const { command, args: cmdArgs } = serverCommand();
  const entry = { type: "local", command: [command, ...cmdArgs], enabled: true };
  const mcp = existing.mcp ?? {};
  if (mcp.cairn) {
    if (JSON.stringify(mcp.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${cfgPath}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${cfgPath}: cairn entry already present...`);
    }
  } else {
    writeChecked(cfgPath, JSON.stringify({ ...existing, mcp: { ...mcp, cairn: entry } }, null, 2) + "\n");
    console.log(`  ${cfgPath}: cairn MCP entry added.`);
  }
  const cmdSrc = join(repoRoot, "harness", "opencode", "commands");
  const cmdOut = join(projectDir, ".opencode", "commands");
  mkdirChecked(cmdOut);
  for (const f of readdirSync(cmdSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyChecked(join(cmdSrc, f), join(cmdOut, f));
  }
  stampInstall(cmdOut, "opencode commands");
  console.log(`  .opencode/commands/: cairn command files installed (/cairn-plan, /cairn-work, ...) (stamped v${sourceVersion}).`);
}

if (harness === "zed") {
  // Zed's MCP config lives under context_servers in (project) settings.json.
  const cfgPath = join(projectDir, ".zed", "settings.json");
  const existing = readJson(cfgPath) ?? {};
  const { command, args: cmdArgs } = serverCommand();
  const entry = { command, args: cmdArgs, env: {} };
  const servers = existing.context_servers ?? {};
  if (servers.cairn) {
    if (JSON.stringify(servers.cairn) !== JSON.stringify(entry)) {
      console.log(`  ${cfgPath}: existing 'cairn' entry left untouched (differs from this install)`);
    } else {
      console.log(`  ${cfgPath}: cairn entry already present...`);
    }
  } else {
    mkdirChecked(dirname(cfgPath));
    writeChecked(cfgPath, JSON.stringify({ ...existing, context_servers: { ...servers, cairn: entry } }, null, 2) + "\n");
    console.log(`  ${cfgPath}: cairn context server added (Zed reads AGENTS.md natively).`);
  }
}

if (harness === "grok") {
  console.log("  grok build reads .mcp.json and AGENTS.md directly — you're done.");
}

if (harness === "claude") {
  if (claudeImport === "alias") {
    console.log("  CLAUDE.md is AGENTS.md here, so Claude Code reads the spine from it directly. install the plugin too — it adds the hooks, commands, and skills.");
  } else if (claudeImport === "refused") {
    console.log("  CLAUDE.md was left as written, so Claude Code has no path to the spine here until the import is in — `--check` reports it.");
  } else {
    console.log("  CLAUDE.md imports AGENTS.md, so Claude Code reads the spine here. install the plugin too — it adds the hooks, commands, and skills.");
  }
}

console.log("cairn-setup complete.");
