#!/usr/bin/env node

// Command-shim generator (P5″ per-verb surface).
// Reads the canonical routing table in skills/cairn-trailhead/SKILL.md and
// writes one thin command shim per `live` verb into commands/, so the typed
// surface is /cairn:<verb> [args]. check-surface.mjs check (f) enforces the
// commands/ dir stays exactly in sync with the table — regenerate, never
// hand-edit shims.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "\u0001"; // stand-in for escaped pipes while cell-splitting

// Every cairn verb drives the same tool families: the cairn MCP server plus
// the core file/exec/agent tools its subroutines lean on. One shared line for
// all shims — per-verb variance isn't worth the maintenance surface today.
const ALLOWED_TOOLS =
  "mcp__plugin_cairn_cairn__*, Bash, Read, Write, Edit, Glob, Grep, ToolSearch, Task, AskUserQuestion";

console.log("generating command shims...");

// --- parse the routing table -------------------------------------------------

const skillMd = readFileSync(
  join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");

// routing table rows: | `verb` | purpose | args | verbs/<verb>.md | status |
const rows = [];
for (const line of skillMd.split("\n")) {
  if (!/^\|\s*`[a-z]+`\s*\|/.test(line)) continue;
  const cells = line
    .replaceAll("\\|", SENTINEL)
    .split("|")
    .map((c) => c.replaceAll(SENTINEL, "|").trim());
  // cells: ["", `verb`, purpose, args, subroutine, status, ""]
  if (cells.length < 6) continue;
  const verb = cells[1].replaceAll("`", "");
  const status = cells[5];
  if (status !== "live") continue;
  rows.push({ verb, purpose: cells[2], args: cells[3].replaceAll("`", "") });
}

if (rows.length === 0) {
  console.error("no live routing-table rows parsed — aborting");
  process.exit(1);
}

// --- write one shim per live verb --------------------------------------------

for (const { verb, purpose, args } of rows) {
  const fm = [
    "---",
    `description: ${JSON.stringify(`${purpose} (cairn — /cairn:help for the verb reference)`)}`,
  ];
  if (args) fm.push(`argument-hint: ${JSON.stringify(args)}`);
  fm.push(`allowed-tools: ${JSON.stringify(ALLOWED_TOOLS)}`);
  fm.push("---");

  const body = [
    "",
    `Execute the cairn verb \`${verb}\`:`,
    "",
    // ${CLAUDE_PLUGIN_ROOT} is substituted inside plugin command bodies at
    // load time (verified 2026-09-19 under `claude plugin eval` — trace
    // fb6fa9fb): a bare relative path here left every fresh agent guessing
    // the plugin root and improvising the verb from its one-line registry
    // description. The absolute form is what a session outside this repo
    // (or any harness) can actually open.
    "1. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/SKILL.md` — its shared",
    "   rules apply to every step below.",
    `2. Read \`\${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/verbs/${verb}.md\` and`,
    "   execute it with `$ARGUMENTS` as its arguments.",
    "",
  ];

  writeFileSync(join(root, `commands/${verb}.md`), fm.concat(body).join("\n"));
}

// --- sweep stale shims (files with no live row) -------------------------------

const live = new Set(rows.map((r) => r.verb));
for (const f of readdirSync(join(root, "commands"))) {
  if (!f.endsWith(".md")) continue;
  const name = f.replace(/\.md$/, "");
  if (!live.has(name)) {
    unlinkSync(join(root, "commands", f));
    console.log(`  removed stale commands/${f}`);
  }
}

console.log(`command shims generated — ${rows.length} live verbs.`);
