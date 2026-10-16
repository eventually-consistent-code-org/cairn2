#!/usr/bin/env node

// Universal instruction-spine generator (CRN-71 multi-harness).
// Reads the canonical routing table + shared rules in
// skills/cairn-trailhead/SKILL.md, plus the axioms block in
// docs/ARCHITECTURE.md (#356), and writes harness/AGENTS-cairn.md — the
// cairn fragment cairn-setup appends into a project's AGENTS.md so any
// MCP-capable harness (Grok Build, Codex, Cursor, OpenCode, ...) can drive
// the same verbs the Claude Code plugin ships. Also renders the default seat
// roster (templates/seats/ frontmatter) into the spine — single source,
// rendered per host. Regenerate, never hand-edit; check-surface runs
// `--check` / `--check-seats` so the fragment can't drift from its sources.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "harness", "AGENTS-cairn.md");
const SENTINEL = "\u0001"; // control byte no cell can contain -- placeholder while splitting on |

const skillMd = readFileSync(join(root, "skills/cairn-trailhead/SKILL.md"), "utf8");

// --- routing table rows: | `verb` | purpose | args | subroutine | status ------
const rows = [];
for (const line of skillMd.split("\n")) {
  if (!/^\|\s*`[a-z]+`\s*\|/.test(line)) continue;
  const cells = line.replaceAll("\\|", SENTINEL).split("|")
    .map((c) => c.trim().replaceAll(SENTINEL, "\\|"));
  // cells[0] and last are empty edge artifacts of leading/trailing pipes
  const [, verb, purpose, args, , status] = cells;
  if (status === "live") {
    rows.push({ verb: verb.replaceAll("`", ""), purpose, args: args.replaceAll("`", "") });
  }
}
if (rows.length === 0) {
  console.error("gen-agents: no live verbs parsed from the routing table");
  process.exit(1);
}

// --- seat roster: templates/seats/*.md frontmatter ---------------------------
//
// The DEFAULT roster only: shipped seat definitions under templates/seats/.
// Project seats live under a project's .cairn/roles/ and never render into
// the repo spine. Per-host note: every harness spine carries the SAME roster
// content this iteration — the studied system's per-host knobs (per-harness
// seat tuning/enablement) are future maturity, not built here.
const seatsDir = join(root, "templates", "seats");
const seats = [];
for (const f of readdirSync(seatsDir).filter((n) => n.endsWith(".md")).sort()) {
  const doc = readFileSync(join(seatsDir, f), "utf8");
  const fm = doc.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    console.error(`gen-agents: templates/seats/${f} missing frontmatter`);
    process.exit(1);
  }
  const field = (key) => fm[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
  // stage is optional frontmatter — absent means review, same default the
  // server schema applies (SeatSchema stage: review | plan | any).
  const seat = {
    name: field("name"),
    lens: field("lens"),
    dose: field("dose"),
    stage: field("stage") ?? "review",
  };
  const cats = field("categories");
  seat.categories = cats ? cats.replace(/^\[|\]$/g, "").split(",").map((c) => c.trim()) : [];
  for (const key of ["name", "lens", "dose"]) {
    if (!seat[key]) {
      console.error(`gen-agents: templates/seats/${f} frontmatter missing '${key}'`);
      process.exit(1);
    }
  }
  seats.push(seat);
}
if (seats.length === 0) {
  console.error("gen-agents: no seat definitions parsed from templates/seats/");
  process.exit(1);
}

const seatSection = `<!-- cairn:seats:begin -->
## Seat roster

Internal seats are framing lenses — cheap, same-model viewpoints folded
into review and audit; peers remain the genuinely adversarial external
council. This table is the shipped DEFAULT roster (\`templates/seats/\`);
a project can add or override seats under \`.cairn/roles/\` — project
seats are per-project and never appear in this spine. Stage says when a
seat convenes: review-stage seats (stage review or any) form the diff
panel; plan-stage seats convene at plan time and never join it.

| seat | lens | categories | dose | stage |
|---|---|---|---|---|
${seats.map((s) => `| ${s.name} | ${s.lens} | ${s.categories.join(", ")} | ${s.dose} | ${s.stage} |`).join("\n")}
<!-- cairn:seats:end -->`;

// --- axioms: the clauses every rule derives from (#356) ----------------------
//
// docs/ARCHITECTURE.md is the prose home; the spine carries a copy so every
// harness reads the same clauses. Taken from "## Axioms" to the next heading
// of any level (so the "### Deriving from them" plumbing paragraph stays
// behind), demoted one level to nest under Shared rules. --check guards the
// copy against drift; sweep-surface.test.ts pins the clause count.
const archMd = readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8");
const axiomsAt = archMd.indexOf("\n## Axioms\n");
if (axiomsAt < 0) {
  console.error("gen-agents: '## Axioms' section not found in docs/ARCHITECTURE.md");
  process.exit(1);
}
const axiomsFrom = archMd.slice(axiomsAt + 1);
const axiomsEnd = axiomsFrom.indexOf("\n##", "## Axioms\n".length);
const axioms = (axiomsEnd < 0 ? axiomsFrom : axiomsFrom.slice(0, axiomsEnd)).trim()
  .replace(/^## Axioms/, "### Axioms");
if (!/^\d+\. \*\*/m.test(axioms)) {
  console.error("gen-agents: '## Axioms' section carries no numbered clauses");
  process.exit(1);
}

// --- shared rules section, verbatim, axioms nested under its heading ---------
const sharedIdx = skillMd.indexOf("## Shared rules");
if (sharedIdx < 0) {
  console.error("gen-agents: shared-rules section not found");
  process.exit(1);
}
const sharedSection = skillMd.slice(sharedIdx).trim();
const sharedHeadingEnd = sharedSection.indexOf("\n");
const sharedRules = `${sharedSection.slice(0, sharedHeadingEnd)}

${axioms}

${sharedSection.slice(sharedHeadingEnd + 1).trim()}`;

const fragment = `<!-- cairn:begin — generated by scripts/gen-agents.mjs; regenerate, never hand-edit -->
# cairn — tracker-first project management

Cairn plans projects in git and mirrors every piece of work — claims,
progress comments, closes with evidence, worklogs, estimates — to the issue
tracker the team actually reads. Plans live in \`.cairn/plans/\`; the tracker
named in \`cairn.json\` is the single source of truth for work items.

**Tools:** the \`cairn\` MCP server (configure it in this harness's MCP
settings; \`cairn-setup\` does this for you). Every operation with a wrong
answer — state transitions, mirroring, drift math — is a typed tool on that
server; call tools rather than editing \`.cairn/\` state by hand.

**Running a verb:** this harness has no \`/cairn:<verb>\` slash commands —
ask for the verb by name ("run cairn status", "cairn work phase 2"). Each
verb's full subroutine lives at \`.cairn/harness/verbs/<verb>.md\` in this
project (installed by \`cairn-setup\`); read it and follow it exactly when
executing that verb.

## Verb registry

| verb | purpose | args |
|---|---|---|
${rows.map((r) => `| ${r.verb} | ${r.purpose} | ${r.args} |`).join("\n")}

${seatSection}

${sharedRules}
<!-- cairn:end -->
`;

const checkMode = process.argv.includes("--check");
if (checkMode) {
  let existing = "";
  try {
    existing = readFileSync(OUT, "utf8");
  } catch { /* missing counts as drift */ }
  if (existing !== fragment) {
    console.error("gen-agents: harness/AGENTS-cairn.md is stale — run node scripts/gen-agents.mjs");
    process.exit(1);
  }
  process.exit(0);
}

// --check-seats: only the seat-roster section vs a fresh parse of
// templates/seats/ (check-surface rule (i) -- same shape as the verb-registry
// freshness rule, scoped so a stale roster names its actual source of truth).
if (process.argv.includes("--check-seats")) {
  let existing = "";
  try {
    existing = readFileSync(OUT, "utf8");
  } catch { /* missing counts as drift */ }
  const m = existing.match(/<!-- cairn:seats:begin -->[\s\S]*?<!-- cairn:seats:end -->/);
  if (!m || m[0] !== seatSection) {
    console.error("gen-agents: seat roster in harness/AGENTS-cairn.md is stale vs templates/seats/ — run node scripts/gen-agents.mjs");
    process.exit(1);
  }
  process.exit(0);
}

console.log("generating AGENTS spine...");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, fragment);
console.log(`harness/AGENTS-cairn.md written — ${rows.length} live verbs, ${seats.length} seats.`);

// Context footprint (#211): the generated surface is resident in every
// session, so say what it now costs. Advisory here -- check-footprint.mjs
// is the gate; this is the number appearing where the change was made.
try {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath,
    [join(root, "scripts", "check-footprint.mjs")], { encoding: "utf8" });
  const summary = out.trim().split("\n").at(-1);
  if (summary) console.log(`  ${summary.replace(/^check-footprint: /, "footprint: ")}`);
} catch (e) {
  // Over budget exits non-zero; still worth printing what it said.
  const out = (e.stdout ?? "") + (e.stderr ?? "");
  const line = out.trim().split("\n").find((l) => l.includes("check-footprint:"));
  if (line) console.log(`  ${line.trim()}`);
}

