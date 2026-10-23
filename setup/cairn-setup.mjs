#!/usr/bin/env node

// cairn-setup — wire cairn into a non-Claude harness (CRN-71).
//
//   node setup/cairn-setup.mjs <harness> [--project <dir>] [--local] [--check]
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
//      the plugin can read them
//   4. harness-specific wiring (Copilot mcp-config + instructions + prompts;
//      Codex prints its config.toml block; Gemini merges settings + GEMINI.md)
//
// Every copied-artifact surface gets a version stamp (.cairn-manifest.json:
// source version + install date) so `--check` can answer "what's actually
// installed where" (#82): it walks the surfaces, compares stamps against
// this clone's version, prints a per-surface table, writes NOTHING, and
// exits non-zero when anything lags — so it can gate. It also walks the
// readers: whether the harness's session-start file reaches the fragment
// (setup/spine-reach.mjs holds the table).
//
// Additive and idempotent: existing config entries are merged, never
// clobbered; re-running produces byte-identical results.
// Dependency-free node — builtins only.

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEGIN, READERS, reachFrom, spliceFragment, spliceImport,
} from "./spine-reach.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESSES = ["grok", "copilot", "codex", "gemini", "cursor", "opencode", "zed", "claude"];

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`usage: node setup/cairn-setup.mjs <${HARNESSES.join("|")}> [--project <dir>] [--local] [--check]`);
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

/** Put the `@AGENTS.md` import at the top of CLAUDE.md (#398), inside the
 *  cairn markers, idempotent. Claude Code reads AGENTS.md only when no
 *  CLAUDE.md is in scope (a claim, as of 2026-10, per the Claude Code memory
 *  docs), so without this line a project that has both never shows Claude
 *  the spine.
 *  :param create write a CLAUDE.md holding only the import when none exists
 *    (the claude target); every other target touches an existing one only */
function installClaudeImport(path, { create }) {
  let body = null;
  try {
    body = readFileSync(path, "utf8");
  } catch { /* absent */ }
  if (body === null && !create) return;
  const { next, note, error } = spliceImport(body ?? "");
  if (error) {
    console.error(`  ${path}: ${error} — fix the markers, then re-run cairn-setup.`);
    process.exit(1);
  }
  if (next === body) {
    console.log(`  ${path}: ${note}...`);
    return;
  }
  writeFileSync(path, next);
  console.log(`  ${path}: @AGENTS.md ${note} (Claude Code reads the spine through it).`);
}

/** Copy the verb subroutines + registry into the project for pluginless harnesses. */
function installVerbs() {
  const srcDir = join(repoRoot, "skills", "cairn-trailhead");
  const outDir = join(projectDir, ".cairn", "harness");
  mkdirSync(join(outDir, "verbs"), { recursive: true });
  copyFileSync(join(srcDir, "SKILL.md"), join(outDir, "SKILL.md"));
  let n = 0;
  for (const f of readdirSync(join(srcDir, "verbs"))) {
    if (!f.endsWith(".md")) continue;
    copyFileSync(join(srcDir, "verbs", f), join(outDir, "verbs", f));
    n++;
  }
  stampInstall(outDir, "verb subroutines");
  console.log(`  .cairn/harness/: registry + ${n} verb subroutines installed (stamped v${sourceVersion}).`);
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
  const row = READERS.find((r) => r.harness === harness);
  const agentsInstalled = reachFrom(projectDir, { loadFile: "AGENTS.md", via: "direct" }).state === "reaches";
  if (harness === "claude") {
    const r = reachFrom(projectDir, row);
    if (r.state === "reaches") {
      console.log(`  readers (${row.path}): ${r.detail}`);
    } else {
      console.log(`  readers (${row.path}): ${r.detail} — Claude Code has no path to the spine`);
      lagging++;
    }
  } else {
    const r = reachFrom(projectDir, row);
    console.log(`  readers (${row.path}): ${r.state === "absent" ? "not installed" : r.detail}`);
    if (r.state === "broken" && r.detail.includes("cairn:begin")) lagging++;
    if (agentsInstalled && existsSync(join(projectDir, "CLAUDE.md"))) {
      const c = reachFrom(projectDir, READERS.find((x) => x.harness === "claude"));
      if (c.state !== "reaches") {
        console.log(`  readers (CLAUDE.md → @AGENTS.md → fragment): ${c.detail} — Claude Code sessions here never read the spine`);
        lagging++;
      }
    }
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
installClaudeImport(join(projectDir, "CLAUDE.md"), { create: harness === "claude" });
installVerbs();

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
  console.log("  CLAUDE.md imports AGENTS.md, so Claude Code reads the spine here. install the plugin too — it adds the hooks, commands, and skills.");
}

console.log("cairn-setup complete.");
