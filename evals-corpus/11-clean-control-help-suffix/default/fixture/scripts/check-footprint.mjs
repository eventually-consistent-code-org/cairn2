#!/usr/bin/env node

// Context-footprint pin (issue #211).
//
// Everything cairn puts in front of the model BEFORE it is asked to do
// anything: 39 command descriptions in the slash listing, 3 skill
// descriptions in the skill listing, and the fixed prose the SessionStart
// hook injects. That is rent, paid once per session whether or not a single
// verb runs, and nothing was watching it grow.
//
// This guard sums it, prints the breakdown, and fails above a pinned
// budget. The budget is a decision, not a measurement: it moves when
// someone decides the surface has earned more room, exactly like the tool
// count. Raising it to silence a failure is the failure.
//
// ON THE NUMBER. Tokens are estimated as characters / 4. That is an
// approximation, and the script says so in its own output rather than
// implying a precision it does not have. The estimate is stable and
// monotone -- more text always reads as more tokens -- which is all a
// growth guard needs. An exact tokenizer would make the number prettier
// and the guard no better, at the cost of a dependency in a script whose
// whole point is that it is cheap enough to run on every push.
//
// NOT counted, deliberately: verb subroutine bodies and SKILL.md bodies.
// Those load on demand -- that lazy split is the design this budget exists
// to protect, and counting them here would punish exactly the behaviour we
// want (moving prose OUT of the always-resident surface and INTO files
// that load when needed).
//
// COUNTED: MCP tool schemas. They are neither a slash listing entry nor an
// on-demand body -- they are resident on every turn of every session, and
// they are 83% of what cairn actually costs. The guard watching only the
// descriptions was watching the small half.
//
// Exit 0 clean, exit 1 over budget.

import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The pinned budget, in estimated tokens. Pinned AT today's shape, not at
// an aspiration -- the same posture as the tool-count pin, which fixes the
// count at 87 rather than demanding fewer tools. Its job is to make growth
// deliberate, and a budget the tree already fails would just be noise
// everyone learns to skip.
//
// Headroom is small on purpose. The guard's first run found a 438-token
// saving in the command descriptions: all 39 ended with the same
// "(cairn — /cairn:help for the verb reference)" suffix. The owner chose
// to shorten it to "(/cairn:help)" rather than drop it (#226, phase 26) --
// discoverability kept, most of the rent returned -- and the budget came
// down with it (see the 2026-10-13 re-pin below).
//
// It jumped from 2300 to 13712 when tool schemas came inside the fence.
// Nothing got worse that day; the guard simply stopped excluding 83% of
// what it was built to watch. The way this number comes down is
// progressive disclosure for schemas -- deferring rarely-used tools so they
// load on call instead of on every turn, the way skill bodies already do --
// not by moving the pin.
//
// The budget carries a 38-token cushion above that measured 13712 --
// mirroring the ~36-token margin the previous pin (2300 against a measured
// 2264) carried before it. That margin absorbs the incidental one-word
// prose edit across 87 tool descriptions, 39 command blurbs, and 3 skill
// blurbs without demanding a re-pin for every one of them, while staying
// far too small to hide a genuinely added tool -- those run 130+ tokens
// each. Raising the budget to silence a failure is still the failure; this
// cushion is not that, because it was set from the shape at hand, not to
// dodge one.
//
// It moved again, from 13750 to 13885, for the compaction artifact
// contract on continuity_checkpoint: eight fields (decisions, constraints,
// rejected, state, filesTouched, nextSteps, requirements, skills) added to
// that tool's inputSchema so a checkpoint can carry what a compaction
// needs to be worth resuming from. That is 135 resident tokens spent on
// purpose -- the price of the contract that makes the lower compaction
// threshold elsewhere on this branch pay off, not an accident this guard
// failed to catch. Raising the budget to silence a failure is still the
// failure; this is a recorded purchase of real resident cost for a real
// feature.
//
// The pin still carries its ~38-token cushion above the newly measured
// 13847 -- the same margin this budget has carried at every pin since the
// 2300-against-2264 original, not a fresh grant for this feature. Zero
// slack would turn every incidental one-word prose edit across 87 tool
// descriptions into a mandatory re-pin, and a guard re-pinned that
// routinely stops enforcing deliberateness at all. The cushion is still
// far too small to hide a real schema change -- these eight fields alone
// cost 135, well clear of it -- so a genuinely added tool or field still
// fails immediately, which is the whole point.
//
// Re-pinned DOWN to 13784 (2026-10-02): the SessionStart measure used to
// count header-comment prose the hook never injects (see section 3). The
// corrected reading is 13746; the budget follows it with the same ~38
// cushion, so a measurement fix never becomes room nobody paid for.
//
// Re-pinned DOWN again to 13481 (2026-10-13, #342): the same section's
// regex paired one string's closing quote with the next string's opening
// quote and counted the code between them as prose -- 1923 characters
// where the hook's real literals hold 596. Replaced by a string-state walk
// that also sees the template literals the resume block is built from.
// Corrected reading 13443; same ~38 cushion.
//
// Re-pinned DOWN to 13429 (2026-10-13, #329): the native-task mirror left
// with its session-start advisory, 52 tokens of standing rent that warned
// about a flag nobody sets for a mechanism that could not fire. Reading
// 13391; same ~38 cushion.
//
// Re-pinned DOWN to 13145 (2026-10-13, #226): the 39 command descriptions
// now end in "(/cairn:help)" instead of the 42-character suffix. Reading
// 13107 (the #332 manifest field had meanwhile spent 18 of the cushion);
// same ~38 cushion.
const BUDGET_TOKENS = 13145;

/** chars / 4 — see the note above on why this approximation is the right one. */
const estimateTokens = (chars) => Math.ceil(chars / 4);

/** The `description:` value from a markdown file's YAML frontmatter. */
function frontmatterField(text, field) {
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end === -1) return null;
  const block = text.slice(3, end);
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(block);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const parts = [];

// --- 1. command shims: what the slash listing carries ------------------------
// The name and the description are resident; the body is not.
const commandsDir = join(root, "commands");
let commandChars = 0;
let commandCount = 0;
for (const entry of readdirSync(commandsDir)) {
  if (!entry.endsWith(".md")) continue;
  const text = readFileSync(join(commandsDir, entry), "utf8");
  const description = frontmatterField(text, "description");
  if (description === null) continue;
  const hint = frontmatterField(text, "argument-hint") ?? "";
  commandChars += `/cairn:${entry.slice(0, -3)} ${hint} ${description}`.length;
  commandCount++;
}
parts.push({ what: `${commandCount} command descriptions`, chars: commandChars });

// --- 2. skill listing entries ------------------------------------------------
const skillsDir = join(root, "skills");
let skillChars = 0;
let skillCount = 0;
for (const entry of readdirSync(skillsDir)) {
  const path = join(skillsDir, entry, "SKILL.md");
  if (!existsSync(path)) continue;
  const text = readFileSync(path, "utf8");
  const name = frontmatterField(text, "name") ?? entry;
  const description = frontmatterField(text, "description") ?? "";
  skillChars += `${name} ${description}`.length;
  skillCount++;
}
parts.push({ what: `${skillCount} skill descriptions`, chars: skillChars });

// --- 3. SessionStart injection, fixed prose only -----------------------------
// The hook's variable content (a resume block, a banner) is per-session and
// not cairn's standing rent; its hardcoded advisory strings are.
const hookPath = join(root, "hooks", "scripts", "sessionstart-continuity.mjs");
let injectionChars = 0;
if (existsSync(hookPath)) {
  // Comments are never injected, so they come out first. Before they did, a
  // short quoted word in the header comment ("off") left the next quote
  // unpaired, and the match ran on through the rest of the comment -- 544
  // characters of prose that no session ever received, counted as rent.
  const src = readFileSync(hookPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // String literals long enough to be prose rather than a key or a path.
  // Walked one character at a time with string state, not matched by a
  // regex: a regex pairs one literal's closing quote with the next one's
  // opening quote and counts the code in between as prose (#342) -- adding
  // a short "utf8" shifted the whole pairing. Template literals count too;
  // the resume block is built from them.
  for (const body of stringLiterals(src)) if (body.length >= 40) injectionChars += body.length;
}

/** Every string literal body in a JS source (double, single, template quotes), escapes folded. */
function stringLiterals(src) {
  const bodies = [];
  let i = 0;
  while (i < src.length) {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") { i++; continue; }
    let j = i + 1;
    let body = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\") { body += src[j + 1] ?? ""; j += 2; continue; }
      body += src[j];
      j++;
    }
    bodies.push(body);
    i = j + 1;
  }
  return bodies;
}
parts.push({ what: "SessionStart injected prose", chars: injectionChars });

// --- 4. MCP tool schemas ------------------------------------------------------
// Asked of the real server over stdio rather than estimated from source: the
// client sees zod lowered to JSON Schema, which is not the shape src/index.ts
// spells. Requires a built dist -- check-dist already demands one.
//
// The probe is written out to a scratch file and run as its own node process
// (rather than inlined as a `node -e` string) because a JSON-RPC handshake
// full of escaped newlines inside an already-escaped string is exactly the
// kind of fragile that breaks quietly. The scratch file is a temp copy, not
// a project fixture, and it is removed before this script exits either way.
const distPath = join(root, "server", "dist", "index.js");
const probeSrc = `
import { spawn } from "node:child_process";

const p = spawn(process.argv[2], [process.argv[3]], {
  env: { ...process.env, CLAUDE_PROJECT_DIR: process.argv[4] },
  stdio: ["pipe", "pipe", "ignore"],
});

let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 2 && msg.result && msg.result.tools) {
      let chars = 0;
      for (const t of msg.result.tools) chars += JSON.stringify(t).length;
      process.stdout.write("CHARS:" + chars + ":" + msg.result.tools.length + "\\n");
      p.kill();
      process.exit(0);
    }
  }
});

p.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "footprint", version: "1" } },
}) + "\\n");

setTimeout(() => {
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\\n");
}, 400);

setTimeout(() => { p.kill(); process.exit(1); }, 15000);
`;

let toolChars = null;
let toolCount = 0;
const scratchDir = mkdtempSync(join(tmpdir(), "cairn-footprint-"));
try {
  const probePath = join(scratchDir, "probe.mjs");
  writeFileSync(probePath, probeSrc);
  const probe = spawnSync(
    process.execPath,
    [probePath, process.execPath, distPath, root],
    { encoding: "utf8", timeout: 20000 },
  );
  const match = /CHARS:(\d+):(\d+)/.exec(probe.stdout ?? "");
  if (match) {
    toolChars = Number(match[1]);
    toolCount = Number(match[2]);
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

if (toolChars === null) {
  console.error("check-footprint: could not list tools from server/dist/index.js.");
  console.error("  Run `cd server && npm run build` first -- the guard measures the");
  console.error("  schemas the client really sees, not an estimate from source.");
  process.exit(1);
}
parts.push({ what: `${toolCount} MCP tool schemas`, chars: toolChars });

// --- report ------------------------------------------------------------------

const totalTokens = parts.reduce((n, p) => n + estimateTokens(p.chars), 0);

const width = Math.max(...parts.map((p) => p.what.length));
for (const p of parts) {
  console.log(`  ${p.what.padEnd(width)}  ${String(estimateTokens(p.chars)).padStart(5)} tokens (est.)`);
}

if (totalTokens > BUDGET_TOKENS) {
  console.error(
    `check-footprint: ${totalTokens} tokens (est.) resident, over the ${BUDGET_TOKENS} budget ` +
    `by ${totalTokens - BUDGET_TOKENS}`);
  console.error("  This is what cairn costs every session before any verb runs.");
  console.error("  Shorten a description, or move prose into a file that loads on demand.");
  console.error("  Raising BUDGET_TOKENS to make this pass is the failure, not the fix —");
  console.error("  move it only when the surface has genuinely earned the room.");
  process.exit(1);
}

console.log(
  `check-footprint: clean — ${totalTokens} tokens (est.) resident of a ${BUDGET_TOKENS} budget, ` +
  `${BUDGET_TOKENS - totalTokens} to spare`);
