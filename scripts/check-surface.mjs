#!/usr/bin/env node

// Surface-conformance check (Tier 0, G9 ratchet).
// Verifies the /cairn command surface can't drift:
//   (a) every `live` routing-table row has its verbs/<verb>.md file
//   (b) every verbs/*.md file has a `live` table row (reserved-with-file fails)
//   (c) subroutine frontmatter has required keys (verb/args/status), only
//       allowed keys (required + any adopted platform fields), and verb
//       matches filename
//   (d) every prefixed tool reference in verb docs exists in the server registry
//   (e) the reserved verb set matches the Tier 0 spec exactly
//   (f) commands/ holds exactly one shim per live verb (gen-commands.mjs output)
//   (h) verb docs claiming "decimal" support near a numeric tool param must not
//       find that param still `.int()`-restricted server-side (the drift class
//       that let route.md document decimal phase inserts for ~12 days while the
//       server rejected them). Gap: this catches ONLY the int-vs-decimal drift
//       class -- other doc/behavior drift shapes are explicitly out of scope.
//   (i) the seat roster rendered into harness/AGENTS-cairn.md matches a fresh
//       parse of templates/seats/*.md frontmatter (gen-agents --check-seats)
// Exit 0 clean, exit 1 with one line per failure.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

// --- inputs -----------------------------------------------------------------

const SPEC_RESERVED = {};
const TOOL_PREFIXES = /^(context|issue|plan|mem|continuity|ledger|milestone|config|trace|probe|draft|session|audit|map|thread|workspace|board|peer|seat)_/;

const skillMd = readFileSync(
  join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");

// routing table rows: | `verb` | purpose | args | verbs/<verb>.md | status |
const rows = [];
for (const line of skillMd.split("\n")) {
  const m = line.match(
    /^\|\s*`([a-z]+)`\s*\|.*\|\s*(verbs\/[a-z]+\.md)\s*\|\s*(live|reserved-[A-F0-9]+)\s*\|\s*$/);
  if (m) rows.push({ verb: m[1], path: m[2], status: m[3] });
}
if (rows.length === 0) failures.push("no routing-table rows parsed from SKILL.md");

const verbFiles = readdirSync(join(root, "skills/cairn-trailhead/verbs"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

// server registry: registerTool("name", …) plus the templated
// registerSessionTools("kind", …) factory, which expands to
// `${kind}_start` / `${kind}_log` / `${kind}_close` at runtime.
const serverSrc = readFileSync(join(root, "server/src/index.ts"), "utf8");
// \s* between ( and the name: the v2-migration formatter wraps the call so
// the string literal lands on its own line (#94).
const registry = new Set(
  [...serverSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) {
  const kind = m[1];
  for (const suffix of ["start", "log", "close"]) registry.add(`${kind}_${suffix}`);
}
if (registry.size === 0) failures.push("no registerTool() names found in server/src/index.ts");

// --- checks ------------------------------------------------------------------

const liveRows = rows.filter((r) => r.status === "live");
const reservedRows = rows.filter((r) => r.status !== "live");

// (a) live row -> file
for (const r of liveRows) {
  if (!verbFiles.includes(r.verb))
    failures.push(`(a) live verb '${r.verb}' has no verbs/${r.verb}.md`);
  if (r.path !== `verbs/${r.verb}.md`)
    failures.push(`(a) row '${r.verb}' names ${r.path}, expected verbs/${r.verb}.md`);
}

// (b) file -> live row
for (const v of verbFiles) {
  const row = rows.find((r) => r.verb === v);
  if (!row) failures.push(`(b) verbs/${v}.md has no routing-table row`);
  else if (row.status !== "live")
    failures.push(`(b) verbs/${v}.md exists but row status is '${row.status}' (reserved verbs must not have files)`);
}

// (c) frontmatter shape + (d) tool references
//
// Required keys must all be present; anything outside the allowed set fails.
// Allowed = required + any platform frontmatter fields we deliberately adopt
// for verb files (none yet) — tolerant of sanctioned additions, still strict
// about unknown junk keys.
const VERB_FM_REQUIRED = ["verb", "args", "status"];
const VERB_FM_ALLOWED = new Set([...VERB_FM_REQUIRED]);

for (const v of verbFiles) {
  const doc = readFileSync(join(root, `skills/cairn-trailhead/verbs/${v}.md`), "utf8");
  const fm = doc.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { failures.push(`(c) verbs/${v}.md missing frontmatter`); continue; }
  const keys = fm[1].split("\n")
    .map((l) => l.match(/^([a-z-]+):/)).filter(Boolean).map((m) => m[1]);
  for (const req of VERB_FM_REQUIRED) {
    if (!keys.includes(req))
      failures.push(`(c) verbs/${v}.md frontmatter missing required key '${req}'`);
  }
  for (const k of keys) {
    if (!VERB_FM_ALLOWED.has(k))
      failures.push(`(c) verbs/${v}.md frontmatter has disallowed key '${k}'`);
  }
  const declared = fm[1].match(/^verb:\s*(\S+)/m)?.[1];
  if (declared !== v)
    failures.push(`(c) verbs/${v}.md declares verb '${declared}', filename says '${v}'`);

  for (const m of doc.matchAll(/`([a-z]+_[a-z_]+)\(?/g)) {
    const tool = m[1];
    if (TOOL_PREFIXES.test(tool) && !registry.has(tool))
      failures.push(`(d) verbs/${v}.md references unknown tool '${tool}'`);
  }
}

// (e) reserved set matches spec
const reservedActual = Object.fromEntries(
  reservedRows.map((r) => [r.verb, r.status.replace("reserved-", "")]));
for (const [verb, tier] of Object.entries(SPEC_RESERVED)) {
  if (!(verb in reservedActual))
    failures.push(`(e) spec reserved verb '${verb}' missing from routing table`);
  else if (reservedActual[verb] !== tier)
    failures.push(`(e) '${verb}' reserved for tier '${reservedActual[verb]}', spec says '${tier}'`);
}
for (const verb of Object.keys(reservedActual)) {
  if (!(verb in SPEC_RESERVED))
    failures.push(`(e) routing table reserves '${verb}' which is not in the spec list`);
}

// (f) commands/ shims <-> live rows, both directions
const commandFiles = readdirSync(join(root, "commands"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));
for (const r of liveRows) {
  if (!commandFiles.includes(r.verb))
    failures.push(`(f) live verb '${r.verb}' has no commands/${r.verb}.md shim (run scripts/gen-commands.mjs)`);
}
for (const c of commandFiles) {
  if (!liveRows.find((r) => r.verb === c))
    failures.push(`(f) commands/${c}.md has no live routing-table row (run scripts/gen-commands.mjs)`);
}

// --- (g) AGENTS spine freshness ---------------------------------------------

import { spawnSync } from "node:child_process";
{
  const r = spawnSync(process.execPath, [join(root, "scripts", "gen-agents.mjs"), "--check"],
    { encoding: "utf8" });
  if (r.status !== 0) {
    // gen-agents --check names each failure: a stale spine, or (#398) a
    // harness with no load path to it
    const lines = (r.stderr ?? "").split("\n").filter((l) => l.startsWith("gen-agents: "));
    if (lines.length === 0) failures.push("(g) harness/AGENTS-cairn.md stale vs routing table (run scripts/gen-agents.mjs)");
    for (const l of lines) failures.push(`(g) ${l.slice("gen-agents: ".length)}`);
  }
}

// --- (i) seat-roster freshness ------------------------------------------------
//
// Same shape as (g): the spine's seat section must match a fresh parse of
// templates/seats/*.md frontmatter. gen-agents --check-seats does the parse
// and the compare; a stale roster fails with the regenerate command.
let seatCount = 0;
{
  seatCount = readdirSync(join(root, "templates", "seats"))
    .filter((f) => f.endsWith(".md")).length;
  const r = spawnSync(process.execPath, [join(root, "scripts", "gen-agents.mjs"), "--check-seats"],
    { encoding: "utf8" });
  if (r.status !== 0) {
    failures.push("(i) harness/AGENTS-cairn.md seat roster stale vs templates/seats/ (run scripts/gen-agents.mjs)");
  }
}

// --- (h) decimal-claim vs int-schema drift -----------------------------------
//
// Same regex-over-source technique as the registry build above: no dist
// import, no server boot. For each literal-named registerTool() call, slice
// the source from its call site to the next wrap( (its handler) -- that
// slice holds just the description + inputSchema object literal -- and pull
// every `paramName: z.number()...` chain out of it, noting whether `.int()`
// is present.
//
// Gap (recorded per issue #45 scope decision): this rule targets ONLY the
// int-vs-decimal drift class -- a verb doc claiming decimal support for a
// param the server still restricts to whole numbers. It does not attempt
// general documented-behavior-vs-code verification; that's a research
// problem, not a CI check.

const NUMERIC_PARAM_NAMES = ["phase", "number", "scopePhase"];

const toolNumericParams = {};
{
  const toolCalls = [...serverSrc.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)];
  const wrapStarts = [...serverSrc.matchAll(/\bwrap\(/g)].map((m) => m.index);
  for (const tm of toolCalls) {
    const start = tm.index;
    const wrapIdx = wrapStarts.find((idx) => idx > start);
    const block = serverSrc.slice(start, wrapIdx ?? serverSrc.length);
    const params = {};
    for (const pm of block.matchAll(
      /([A-Za-z_]+):\s*z\.number\(\)((?:\.[a-zA-Z]+\([^)]*\))*)/g)) {
      params[pm[1]] = pm[2].includes(".int(");
    }
    toolNumericParams[tm[1]] = params;
  }
}

for (const v of verbFiles) {
  const doc = readFileSync(join(root, `skills/cairn-trailhead/verbs/${v}.md`), "utf8");
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/decimal/i.test(lines[i])) continue;

    const lo = Math.max(0, i - 2);
    const hi = Math.min(lines.length - 1, i + 2);
    const windowText = lines.slice(lo, hi + 1).join("\n");

    const toolsInWindow = [...new Set(
      [...windowText.matchAll(/`([a-z_]+)`/g)]
        .map((m) => m[1])
        .filter((name) => name in toolNumericParams))];
    const paramsInWindow = NUMERIC_PARAM_NAMES.filter(
      (p) => new RegExp(`\\b${p}\\b`).test(windowText));

    if (toolsInWindow.length === 0 && paramsInWindow.length === 0) continue;

    for (const tool of toolsInWindow) {
      const schema = toolNumericParams[tool];
      const named = paramsInWindow.filter((p) => p in schema);
      const toCheck = named.length ? named : Object.keys(schema);
      for (const p of toCheck) {
        if (schema[p]) {
          failures.push(
            `(h) verbs/${v}.md:${i + 1} claims decimal support near '${tool}' `
            + `but its '${p}' param is still z.number().int() server-side`);
        }
      }
    }
  }
}

// --- report ------------------------------------------------------------------

if (failures.length) {
  console.error(`check-surface: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-surface: clean — ${liveRows.length} live, ${reservedRows.length} reserved, ${registry.size} server tools, ${seatCount} seats fresh`);
