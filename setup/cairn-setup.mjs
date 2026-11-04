#!/usr/bin/env node

// cairn-setup — wire cairn into a non-Claude harness (CRN-71).
//
//   node setup/cairn-setup.mjs <harness> [--project <dir>] [--local] [--check] [--git-hooks]
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
//      core.hooksPath pointed at it (#456). Opt-in, never default: a git
//      config write is the owner's ground, and the flag is the consent.
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
// clobbered; re-running produces byte-identical results.
// Dependency-free node — builtins only.

import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEGIN, READERS, insideDir, reachFrom, realOrNull, sameFile, spliceFragment, spliceImport,
} from "./spine-reach.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESSES = ["grok", "copilot", "codex", "gemini", "cursor", "opencode", "zed", "claude"];

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage: node setup/cairn-setup.mjs <${HARNESSES.join("|")}> [--project <dir>] [--local] [--check] [--git-hooks]`);
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  console.log(`  ${path}: cairn MCP entry added.`);
}

/** Install/replace the marker-delimited cairn fragment inside a markdown file. */
function installFragment(path, fragment) {
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
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
  // else -- refused in one line, nothing written (#429).
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch { /* absent */ }
  if (isLink) {
    let real = null;
    try {
      real = realpathSync(path);
    } catch { /* dangling */ }
    if (real === null) {
      console.log(`  ${path}: is a symlink to a file that does not exist — refusing to write through it; fix the link, then re-run cairn-setup.`);
      return "refused";
    }
    if (!insideDir(real, realOrNull(projectDir))) {
      console.log(`  ${path}: resolves outside the project (${real}) — refusing to write through it; point the link inside the project or add the @AGENTS.md import by hand.`);
      return "refused";
    }
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
  writeFileSync(path, next);
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
  mkdirSync(join(outDir, "verbs"), { recursive: true });
  mkdirSync(join(outDir, "scripts"), { recursive: true });
  // Verb text is re-pointed on the way in, never copied raw, so every
  // harness but claude reads a path that exists in its own install.
  const localize = (body) => (harness === "claude" ? body : body.replaceAll(PLUGIN_SCRIPTS, `"${SCRIPTS_REL}/`));
  writeFileSync(join(outDir, "SKILL.md"), localize(readFileSync(join(srcDir, "SKILL.md"), "utf8")));
  let n = 0;
  for (const f of readdirSync(join(srcDir, "verbs"))) {
    if (!f.endsWith(".md")) continue;
    writeFileSync(join(outDir, "verbs", f), localize(readFileSync(join(srcDir, "verbs", f), "utf8")));
    n++;
  }
  const helpers = helperClosure(join(repoRoot, "hooks", "scripts"), VERB_HELPERS);
  for (const f of helpers) copyFileSync(join(repoRoot, "hooks", "scripts", f), join(outDir, "scripts", f));
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
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
const PREPUSH = "pre-push.mjs";
const GITHOOKS_REL = [".cairn", "githooks"].join("/");
const HOOK_BEGIN = "# cairn:begin -- managed by cairn-setup --git-hooks; do not edit inside markers";
const HOOK_END = "# cairn:end";
const SH_SHEBANG = /^#!.*\b(?:sh|bash|dash|ksh|zsh)\b/;

/** git's trimmed answer at `dir`, or null when it says no (no repository, no git on PATH). */
function gitAt(dir, gitArgs) {
  try {
    return execFileSync("git", gitArgs, {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch {
    return null;
  }
}

/** A hooks folder as git reads one: `~` expanded, a relative path from the worktree root. */
function hooksDirOf(value) {
  return resolve(projectDir, value.replace(/^~(?=\/|$)/, homedir()));
}

/** The marker-delimited block: the gate runs first, and the refs git handed
 *  over stay on stdin for whatever the owner keeps below the markers. The
 *  script is looked for where git runs the hook ($PWD is the worktree root),
 *  then at this install's own copy -- a linked worktree has no copy of its
 *  own. Exit 2 from the script is the refusal; anything else fails open. */
function hookBlock() {
  const script = `${SCRIPTS_REL}/${PREPUSH}`;
  return [
    HOOK_BEGIN,
    "# The git layer of cairn's ship gate: a push landing on the default branch",
    "# is refused without a clean drift stamp for the exact commit pushed, judged",
    "# by the shared effect table and stamp reader (no rule lives in this file).",
    "# Exit 2 from the script refuses the push; anything else fails open, so a",
    "# missing node or script never blocks a push -- it says so instead. The refs",
    "# git hands this hook are kept on stdin for whatever follows the markers.",
    `cairn_prepush="$PWD/${script}"`,
    `[ -f "$cairn_prepush" ] || cairn_prepush="${join(projectDir, SCRIPTS_REL, PREPUSH)}"`,
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
    HOOK_END,
  ].join("\n") + "\n";
}

/** The existing hook with the cairn block spliced in: replaced between the
 *  markers; else put right after a sh shebang (one is written when there is
 *  no file or no shebang). Another interpreter's hook is refused -- sh lines
 *  at its top would break it. An orphaned marker is refused, never guessed. */
function spliceHook(body, block) {
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
    return { error: `runs under ${first.slice(2).trim()}, not sh -- call ${SCRIPTS_REL}/${PREPUSH} from it by hand` };
  }
  return { next: `${first}\n${block}${nl < 0 ? "" : body.slice(nl + 1)}` };
}

/** Where the hook goes: the folder core.hooksPath names when set (respected,
 *  the setting stays), else cairn's own, which the install then names --
 *  unless the folder git runs today holds live hooks a new hooksPath would
 *  silence: refused, the owner moves them or sets the path. */
function gitHooksTarget() {
  if (gitAt(projectDir, ["rev-parse", "--git-common-dir"]) === null) {
    return { error: "not a git repository -- nothing for a pre-push hook to guard" };
  }
  const ours = join(projectDir, GITHOOKS_REL);
  const configured = gitAt(projectDir, ["config", "--get", "core.hooksPath"]);
  if (configured) return { dir: hooksDirOf(configured), configured };
  const today = gitAt(projectDir, ["rev-parse", "--git-path", "hooks"]);
  const todayDir = today ? hooksDirOf(today) : null;
  let live = [];
  try {
    live = readdirSync(todayDir).filter((n) => !n.startsWith(".") && !n.endsWith(".sample"));
  } catch { /* no hooks folder yet: nothing a hooksPath would silence */ }
  if (live.length) {
    return { error: `${todayDir} holds live hooks (${live.join(", ")}) that a core.hooksPath would silence -- ` +
      `move them under ${ours}, or set core.hooksPath yourself, then re-run` };
  }
  return { dir: ours, configured: null };
}

/** Install the git layer: the script beside the verb helpers, the hook under
 *  the markers, core.hooksPath set once. Idempotent: a re-run is byte-identical. */
function installGitHooks() {
  const target = gitHooksTarget();
  if (target.error) {
    console.error(`  --git-hooks: ${target.error}.`);
    process.exit(1);
  }
  const scriptsOut = join(projectDir, SCRIPTS_REL);
  for (const f of helperClosure(join(repoRoot, "hooks", "scripts"), [PREPUSH])) {
    copyFileSync(join(repoRoot, "hooks", "scripts", f), join(scriptsOut, f));
  }
  const path = join(target.dir, "pre-push");
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch { /* new file */ }
  const { next, error } = spliceHook(body, hookBlock());
  if (error) {
    console.error(`  ${path}: ${error} -- then re-run cairn-setup.`);
    process.exit(1);
  }
  mkdirSync(target.dir, { recursive: true });
  if (next !== body) writeFileSync(path, next);
  chmodSync(path, 0o755);
  if (target.configured === null && gitAt(projectDir, ["config", "core.hooksPath", target.dir]) === null) {
    console.error(`  core.hooksPath could not be set to ${target.dir} -- set it yourself, then re-run cairn-setup.`);
    process.exit(1);
  }
  console.log(`  ${path}: pre-push hook ${next === body ? "already current..." : "installed (the ship gate's default-branch rule, for every process here)."}`);
  console.log(`  core.hooksPath: ${target.configured === null ? `set to ${target.dir}` : `already ${target.configured}, left as is -- the hook went into that folder`}.`);
}

/** Read-only, for --check: where git runs hooks today, and whether cairn's
 *  pre-push is there with its script. null outside a repository (no line). */
function gitLayerStatus() {
  const today = gitAt(projectDir, ["rev-parse", "--git-path", "hooks"]);
  if (today === null) return null;
  const dir = hooksDirOf(today);
  const script = join(projectDir, SCRIPTS_REL, PREPUSH);
  const carries = (p) => {
    try {
      return readFileSync(p, "utf8").includes(HOOK_BEGIN);
    } catch {
      return false;
    }
  };
  if (carries(join(dir, "pre-push"))) {
    return existsSync(script) ? { detail: `installed at ${dir}; git runs hooks from there` }
      : { detail: `installed at ${dir}, but ${script} is missing -- not reached; re-run with --git-hooks`, lagging: true };
  }
  const ours = join(projectDir, GITHOOKS_REL);
  if (carries(join(ours, "pre-push"))) {
    return { detail: `installed at ${ours}, but git runs hooks from ${dir} -- not reached; re-run with --git-hooks, or point core.hooksPath back`, lagging: true };
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
  writeFileSync(join(dir, MANIFEST), JSON.stringify({
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
  mkdirSync(promptsOut, { recursive: true });
  for (const f of readdirSync(promptsSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyFileSync(join(promptsSrc, f), join(promptsOut, f));
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
  mkdirSync(cmdOut, { recursive: true });
  for (const f of readdirSync(cmdSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyFileSync(join(cmdSrc, f), join(cmdOut, f));
  }
  stampInstall(cmdOut, "gemini TOML commands");
  console.log(`  .gemini/commands/cairn/: TOML commands installed (/cairn:plan, /cairn:work, ...) (stamped v${sourceVersion}).`);
}

if (harness === "codex") {
  mergeCodexToml(join(homedir(), ".codex", "config.toml"));
  const promptsSrc = join(repoRoot, "harness", "codex", "prompts");
  const promptsOut = join(homedir(), ".codex", "prompts");
  mkdirSync(promptsOut, { recursive: true });
  for (const f of readdirSync(promptsSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyFileSync(join(promptsSrc, f), join(promptsOut, f));
  }
  stampInstall(promptsOut, "codex prompts");
  console.log(`  ~/.codex/prompts/: cairn prompt files installed (Codex reads AGENTS.md from the project) (stamped v${sourceVersion}).`);
}

if (harness === "cursor") {
  mergeMcpJson(join(projectDir, ".cursor", "mcp.json"));

  // Hooks port: adapter + the cairn hook scripts, then hooks.json entries.
  const hooksOut = join(projectDir, ".cursor", "hooks", "cairn");
  mkdirSync(hooksOut, { recursive: true });
  copyFileSync(join(repoRoot, "harness", "cursor", "cursor-adapter.mjs"),
    join(hooksOut, "cursor-adapter.mjs"));
  for (const f of readdirSync(join(repoRoot, "hooks", "scripts"))) {
    if (f.endsWith(".mjs")) copyFileSync(join(repoRoot, "hooks", "scripts", f), join(hooksOut, f));
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
    writeFileSync(hooksJsonPath, serialized);
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
    writeFileSync(cfgPath, JSON.stringify({ ...existing, mcp: { ...mcp, cairn: entry } }, null, 2) + "\n");
    console.log(`  ${cfgPath}: cairn MCP entry added.`);
  }
  const cmdSrc = join(repoRoot, "harness", "opencode", "commands");
  const cmdOut = join(projectDir, ".opencode", "commands");
  mkdirSync(cmdOut, { recursive: true });
  for (const f of readdirSync(cmdSrc)) {
    if (f.startsWith(".")) continue; // never ship stray dotfiles (.DS_Store) into a project
    copyFileSync(join(cmdSrc, f), join(cmdOut, f));
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
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ ...existing, context_servers: { ...servers, cairn: entry } }, null, 2) + "\n");
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
