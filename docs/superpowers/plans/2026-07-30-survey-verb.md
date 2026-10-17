# Survey Verb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/cairn:survey` — project-wide research → discussion gate → roadmap apply — plus the mandatory multi-agent research fan-out amendment to scout, the new→survey handoff, and the cairn-planning rubric reground.

**Architecture:** Thin composition verb: one new subroutine doc (`verbs/survey.md`) sequencing existing MCP tools only; no server code. The routing table in `skills/cairn-trailhead/SKILL.md` is canonical — shims (`commands/`) and the harness agent file are GENERATED from it (`scripts/gen-commands.mjs`, `scripts/gen-agents.mjs`), and `scripts/check-surface.mjs` is the test that gates every table/verb-file change.

**Tech Stack:** Markdown verb docs, Node ≥20 generator scripts, MCP drill script (`@modelcontextprotocol/sdk` client) for the apply-stage mechanics.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-cairn-2-survey-verb-design.md` — on any conflict, spec wins.
- Never hand-edit `commands/*.md` or `harness/AGENTS-cairn.md` — regenerate.
- Verb frontmatter is exactly three keys: `verb`, `args`, `status` (check-surface rule c).
- Every prefixed tool name mentioned in a verb doc must exist in the server registry (check-surface rule d) — the tools used below all exist: `issue_create`, `issue_comment`, `issue_close`, `plan_scaffold_phase`, `plan_phase_ensure`, `plan_issues_set`, `mem_index`, `plan_status`, `context_get`.
- Commit style: conventional commits, reference CRN issue if one exists by then (tracker was 400ing at plan time — retry `issue_create` once at execution start; if it still fails, note it in the PR body and proceed).
- Work on a branch: `feat/survey-verb` (repo merges via PR).
- Verification command after every doc task: `node scripts/check-surface.mjs` — exit 0.

---

### Task 1: Registry row + `verbs/survey.md`

**Files:**
- Modify: `skills/cairn-trailhead/SKILL.md` (routing table, after the `docs` row at line 54)
- Create: `skills/cairn-trailhead/verbs/survey.md`
- Generated: `commands/survey.md`, `harness/AGENTS-cairn.md` (via scripts)

**Interfaces:**
- Produces: routing-table row `survey` (live) that Tasks 2–6 and the generators rely on; `verbs/survey.md` whose stage names ("research", "discussion", "apply") Task 6's drill comments reference.

- [ ] **Step 1: Create branch**

```bash
git checkout -b feat/survey-verb
```

- [ ] **Step 2: Add the registry row (test-first — this makes check-surface fail)**

In `skills/cairn-trailhead/SKILL.md`, after the `docs` row (the last `live` row), add:

```markdown
| `survey` | Project-wide research — findings, then discussed roadmap changes | `["<topic>"]` | verbs/survey.md | live |
```

- [ ] **Step 3: Run check-surface, verify it fails**

Run: `node scripts/check-surface.mjs`
Expected: FAIL — missing `verbs/survey.md` for live row (rule a), and commands/ out of sync (rule f).

- [ ] **Step 4: Write `skills/cairn-trailhead/verbs/survey.md`**

Exact content:

````markdown
---
verb: survey
args: "[\"<topic>\"]"
status: live
---

Project-wide research, then roadmap changes — but only through a discussion
gate. `scout` researches one phase; survey researches the terrain: roadmap
gaps, cross-phase unknowns, assumptions gone stale since planning. Three
stages; NOTHING mutates before stage 2's gate, in any mode.

## Stage 1 — research (resumable, multi-agent)

1. `plan_status()` — project must exist (else stop: suggest `/cairn:new`).
2. Artifact is `.cairn/plans/SURVEY.md` (project level, next to
   roadmap.md). Same marker discipline as scout: each `## <topic>` section
   carries `<!-- survey: done -->` or `<!-- survey: pending -->` on the
   line after the heading. `done` sections are FINISHED — never
   re-research. No marker = legacy content, treat as done.
3. Topics: derive from roadmap.md phase table + each phase's CONTEXT.md
   unknowns + PROJECT.md goals — plus the user's topic argument when
   given. Append new topics as `pending` sections.
4. Tracker mirror: `issue_create` ONE plain-language research issue at
   start ("Project survey: <one-line scope>"); `issue_comment` progress in
   manager language as sections finish. If the tracker is down, continue
   git-side and create the issue when it recovers — say so.
5. Fan-out is mandatory (not depth-gated): dispatch ONE subagent per
   `pending` section, in parallel. Route each agent's model by the WORK
   CLASS OF THE TOPIC per the cairn-planning rubric — enumerate/locate →
   haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit. Subagents return section content ONLY;
   the main thread writes the section and flips its marker as EACH agent
   completes. A failed agent's section stays `pending` with a one-line
   failure note — the next run retries it.

## Stage 2 — discussion (the gate)

6. Distill findings into concrete proposals, each exactly one of:
   **new phase N.5** · **rescope phase N** · **new issues in phase N** ·
   **no action**. One batched AskUserQuestion — multiSelect per proposal,
   cairn's recommendation first with trade-offs. This gate holds in vibe
   mode too: roadmap surgery from research is always "a peer would have
   wanted a say."

## Stage 3 — apply (approved proposals only)

7. New phases: `plan_scaffold_phase` with a DECIMAL number between
   neighbors (route's rule — never renumber) + `plan_phase_ensure` for
   the tracker object + a roadmap.md row between its neighbors.
8. Rescopes: CONTEXT.md edits recorded as locked decisions with SURVEY.md
   source links — what changed and why.
9. New work: `issue_create` + `plan_issues_set`, estimates per the plan
   verb's convention (points + minutes, always both).
10. Wrap: `mem_index` the finished SURVEY.md (source: its path), close
    the research issue (`issue_close`) with a plain summary of findings
    and applied changes, report sections done/remaining, and suggest
    `/cairn:plan <N>` for any new phase.
````

- [ ] **Step 5: Regenerate shims + harness agent file**

```bash
node scripts/gen-commands.mjs
node scripts/gen-agents.mjs
```

Expected: `commands/survey.md` appears; `harness/AGENTS-cairn.md` now says 38 live verbs.

- [ ] **Step 6: Run check-surface, verify it passes**

Run: `node scripts/check-surface.mjs`
Expected: exit 0, no failure lines.

- [ ] **Step 7: Commit**

```bash
git add skills/cairn-trailhead/SKILL.md skills/cairn-trailhead/verbs/survey.md commands/survey.md harness/AGENTS-cairn.md
git commit -m "feat(survey): project-wide research verb — resumable fan-out, discussion gate, roadmap apply"
```

---

### Task 2: Scout explicit multi-agent fan-out

**Files:**
- Modify: `skills/cairn-trailhead/verbs/scout.md` (steps 3–4)

**Interfaces:**
- Consumes: nothing from Task 1 (independent edit; same fan-out contract wording).
- Produces: scout step 4 wording that Task 4's rubric section title must match ("research fan-out").

- [ ] **Step 1: Rewrite steps 3–4**

Replace (current text):

```markdown
3. Determine research topics from CONTEXT.md unknowns + PLAN.md gaps (depth
   dial and model routing per the `cairn-planning` skill). New topics get
   `pending` sections appended; only `pending` sections get researched.
4. Research each pending section (fan out per the model-routing rubric);
   write findings into its section and flip its marker to `done` as EACH
   section completes — a kill mid-run must lose at most one section.
```

With:

```markdown
3. Determine research topics from CONTEXT.md unknowns + PLAN.md gaps (depth
   dial per the `cairn-planning` skill). New topics get `pending` sections
   appended; only `pending` sections get researched.
4. Fan out — mandatory, not depth-gated: dispatch ONE subagent per
   `pending` section, in parallel, model routed by the WORK CLASS OF THE
   TOPIC per the cairn-planning research fan-out rubric (enumerate/locate
   → haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit). Subagents return section content ONLY;
   the main thread writes each section and flips its marker to `done` as
   EACH agent completes — a kill mid-run must lose at most the in-flight
   sections, never finished ones. A failed agent's section stays `pending`
   with a one-line failure note.
```

- [ ] **Step 2: Verify surface still clean**

Run: `node scripts/check-surface.mjs`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add skills/cairn-trailhead/verbs/scout.md
git commit -m "feat(scout): mandatory multi-agent research fan-out, model per work class"
```

---

### Task 3: `new` → survey handoff

**Files:**
- Modify: `skills/cairn-trailhead/verbs/new.md` (step 6, line 45)

**Interfaces:**
- Consumes: the `survey` verb name from Task 1's registry row.

- [ ] **Step 1: Edit the report line**

Replace:

```markdown
6. Report: phases created, issues created, next step `/cairn:plan 1`.
```

With:

```markdown
6. Report: phases created, issues created, next step `/cairn:survey`
   (project-wide research while unknowns are at their peak), then
   `/cairn:plan 1`. Recommendation only — never auto-run survey.
```

- [ ] **Step 2: Verify surface still clean**

Run: `node scripts/check-surface.mjs`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add skills/cairn-trailhead/verbs/new.md
git commit -m "feat(new): hand off to survey before plan 1"
```

---

### Task 4: cairn-planning rubric reground + artifact row

**Files:**
- Modify: `skills/cairn-planning/SKILL.md` (artifact table ~line 25; rubric section title ~line 57)

**Interfaces:**
- Consumes: SURVEY.md artifact semantics from Task 1; "research fan-out" phrase used by Tasks 1–2.

- [ ] **Step 1: Add the SURVEY.md artifact row**

In the artifacts table, after the `phases/NN/RESEARCH.md` row, add:

```markdown
| SURVEY.md | project-wide research brief (survey markers) | /cairn:survey fan-out |
```

- [ ] **Step 2: Retitle and reground the rubric section**

Replace:

```markdown
## Model routing (deep-mode fan-out)
```

With:

```markdown
## Model routing (research fan-out)
```

And after the existing line "Blast radius rules: … Uncertain → inherit." append a new paragraph:

```markdown
The rubric governs ALL research fan-out — `scout`, `survey`, and
`plan --deep` — not only deep mode. Research verbs dispatch one subagent
per pending topic, in parallel, classifying each TOPIC by work class to
pick its model; the main thread writes results and flips markers as each
agent completes.
```

- [ ] **Step 3: Check nothing else referenced the old title**

Run: `grep -rn "deep-mode fan-out" skills/ docs/ README.md server/drills/`
Expected: no hits outside historical spec docs (`docs/superpowers/specs/` hits are fine — historical records, leave them).

- [ ] **Step 4: Commit**

```bash
git add skills/cairn-planning/SKILL.md
git commit -m "docs(planning): model-routing rubric governs all research fan-out; SURVEY.md artifact row"
```

---

### Task 5: README + CHANGELOG

**Files:**
- Modify: `README.md` (verb list lines 74–79)
- Modify: `CHANGELOG.md` (new entry at top, below `# Changelog`)

**Interfaces:**
- Consumes: verb name + count from Task 1 (37 → 38).

- [ ] **Step 1: Update README verb list**

Change `**Verbs (37 live):**` to `**Verbs (38 live):**` and add `` `survey` `` to the backticked list immediately after `` `scout` ``.

- [ ] **Step 2: Add CHANGELOG entry**

Insert directly under `# Changelog`:

```markdown
## v2 — survey verb: project-wide research (2026-07-30)

- New `/cairn:survey ["<topic>"]`: project-wide research into a resumable
  `SURVEY.md` (scout's done/pending markers), a hard discussion gate, then
  approved roadmap changes applied via route mechanics (decimal phase
  insert — never renumber, locked-decision CONTEXT.md edits, mirrored
  issues). Composition of existing tools; no server changes (38 verbs).
- Research fan-out is now mandatory and multi-agent for `scout`, `survey`,
  and `plan --deep`: one subagent per pending topic, model routed per the
  work class of the topic (mechanical → haiku-tier, synthesis →
  sonnet-tier, judgment → opus-tier); sections commit as each agent
  finishes, so a killed run keeps everything completed.
- `/cairn:new` now recommends `/cairn:survey` before `/cairn:plan 1` —
  whole-project research is cheapest when nothing is planned yet.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: README verb list + CHANGELOG for survey verb"
```

---

### Task 6: drill-survey.mjs — apply-stage mechanics

**Files:**
- Create: `server/drills/drill-survey.mjs`

**Interfaces:**
- Consumes: server MCP tools `plan_scaffold_project`, `plan_scaffold_phase`, `plan_phase_ensure`, `issue_create`, `plan_issues_set`, `mem_index`, `plan_status` — all existing. Invocation convention from sibling drills: `node drill-survey.mjs <project-dir> <server-entry>`.
- Produces: standalone PASS/FAIL drill; nothing downstream consumes it.

- [ ] **Step 1: Write the drill**

Follow the sibling pattern (`drill-distill.mjs` header/`check` helper). Exact content:

```javascript
#!/usr/bin/env node

// Purpose: survey drill (mechanical) — verbs/survey.md's apply stage proven
//          end-to-end against the server: SURVEY.md marker discipline
//          (done sections survive a "resume"), decimal phase insert between
//          neighbors without renumbering, mirrored issue into the new
//          phase, and mem_index of the finished brief.
// Author(s): John Reed

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const client = new Client({ name: "drill-survey", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, CAIRN_PROJECT_DIR: PROJECT },
}));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  if (res.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
};

console.log("scaffolding fixture project...");
await call("plan_scaffold_project", { name: "survey-drill" });
await call("plan_scaffold_phase", { number: 1, name: "alpha" });
await call("plan_scaffold_phase", { number: 2, name: "beta" });

// --- marker discipline: done sections survive a resume ----------------------
const surveyPath = join(PROJECT, ".cairn", "plans", "SURVEY.md");
writeFileSync(surveyPath, [
  "# Survey",
  "",
  "## finished topic",
  "<!-- survey: done -->",
  "finding: keep me",
  "",
  "## unfinished topic",
  "<!-- survey: pending -->",
  "",
].join("\n"));
const before = readFileSync(surveyPath, "utf8");
// a resume must not touch done sections — simulate by asserting the done
// block parses as done and its content is intact after re-read
check("SURVEY.md done marker parses",
  /## finished topic\n<!-- survey: done -->/.test(before));
check("SURVEY.md pending marker parses",
  /## unfinished topic\n<!-- survey: pending -->/.test(before));
check("done section content intact", before.includes("finding: keep me"));

// --- decimal insert: phase 1.5 between 1 and 2, no renumber -----------------
await call("plan_scaffold_phase", { number: 1.5, name: "gamma" });
const phasesDir = join(PROJECT, ".cairn", "plans", "phases");
const dirs = readdirSync(phasesDir);
check("decimal phase dir created", dirs.some((d) => d.startsWith("1.5")));
check("phase 1 untouched", dirs.some((d) => d.startsWith("01") || d.startsWith("1-")));
check("phase 2 untouched", dirs.some((d) => d.startsWith("02") || d.startsWith("2-")));

// --- mirrored issue into the new phase --------------------------------------
const phase = await call("plan_phase_ensure", { number: 1.5, name: "gamma" });
const issue = await call("issue_create", {
  title: "survey drill: work item from findings",
  body: "created by drill-survey apply stage",
  phase: phase.id ?? phase.phaseId ?? String(phase),
});
check("issue created with id", Boolean(issue.id));
const gammaDir = dirs.find((d) => d.startsWith("1.5")) ?? "1.5-gamma";
await call("plan_issues_set", {
  phaseDir: join("phases", gammaDir),
  issues: [issue.id],
});
const planMd = readFileSync(join(phasesDir, gammaDir, "PLAN.md"), "utf8");
check("PLAN.md frontmatter carries the issue", planMd.includes(String(issue.id)));

// --- mem_index the finished brief -------------------------------------------
const idx = await call("mem_index", { source: surveyPath, content: before });
check("mem_index accepted SURVEY.md", idx !== undefined);

await client.close();
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? "drill-survey: all checks pass." : `drill-survey: ${failed} FAILED`);
process.exit(failed);
```

NOTE to implementer: before finalizing, open TWO sibling drills
(`drill-distill.mjs`, `drill-routing.mjs`) and mirror their EXACT
conventions for (a) server spawn env/args, (b) tool argument shapes for
`plan_scaffold_phase` / `plan_phase_ensure` / `plan_issues_set` (decimal
number handling, phaseDir form, issue-id form), and (c) how they resolve
phase dir names. Adjust the code above to match what the drills actually
do — the sibling drills are the source of truth for call shapes, this
listing is the structure and the assertions.

- [ ] **Step 2: Run the drill against a throwaway fixture**

```bash
cd server && npm run build && cd ..
mkdir -p /tmp/survey-drill-fixture && cd /tmp/survey-drill-fixture && git init -q && cd -
node server/drills/drill-survey.mjs /tmp/survey-drill-fixture server/dist/index.js
```

Expected: `drill-survey: all checks pass.` exit 0. (Use the same fixture-init steps the sibling drills' headers document if they differ.)

- [ ] **Step 3: Commit**

```bash
git add server/drills/drill-survey.mjs
git commit -m "test(survey): apply-stage drill — markers, decimal insert, mirror, mem_index"
```

---

### Task 7: Final verification + PR

**Files:** none new.

- [ ] **Step 1: Full gate**

```bash
node scripts/check-surface.mjs
cd server && npm test && cd ..
git status --short
```

Expected: check-surface exit 0; full vitest suite green (752 tests at last count — no server code changed, count unchanged); working tree clean.

- [ ] **Step 2: Retry the tracker mirror**

Retry `issue_create` (CRN) for this work once; if created, `issue_close` is NOT called — leave open, it closes on merge per repo convention. If still HTTP 400, note in PR body.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/survey-verb
gh pr create --title "feat(survey): project-wide research verb + mandatory research fan-out" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-07-30-cairn-2-survey-verb-design.md.

- New /cairn:survey: resumable project-level SURVEY.md research (scout marker pattern), mandatory multi-agent fan-out (model per work class), hard discussion gate, apply via route mechanics (decimal insert, never renumber).
- scout: explicit parallel fan-out contract, write+flip per agent completion.
- new: hands off to survey before plan 1.
- cairn-planning: rubric governs all research fan-out; SURVEY.md artifact row.
- drill-survey.mjs proves the apply-stage mechanics end-to-end.
- No server code changes; check-surface green; shims/agents regenerated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Amendment (2026-07-30, mid-execution): Task 6a — server decimal-phase support

Task 6 exposed that `plan_scaffold_phase` rejects decimals (`z.number().int()`
in server/src/index.ts; integer guard in `phaseDirName`,
server/src/planning/artifacts.ts) — route.md's `insert <N.5>` was
aspirational. Human ruling: implement decimal support on this branch; the
"no server code changes" constraint is lifted for exactly this.

Requirements (TDD — failing tests first):
- Accept phase numbers with exactly one fractional digit (N.1–N.9),
  integer part 1..98, alongside integers 1..99. Anything else still errors
  (CONFIG_INVALID).
- Dir form pads the integer part only: `01.5-slug` — lexically sorts
  between `01-…` and `02-…`. Roadmap/status/drift code that parses phase
  numbers from dir names must round-trip decimals: sweep phaseDirName
  callers and any `parseInt`/`Number(` on phase dirs, fix + test each.
- Widen the schemas: `plan_scaffold_phase`, `plan_phase_ensure`, and any
  other tool taking a phase `number`.
- Tests: artifacts unit tests (accept 1.5 → `01.5-slug`; reject 1.55,
  0.5, 99.5), tool-layer test via the MCP harness pattern used by
  server/test/mcp.test.ts, and a round-trip (scaffold 1, 1.5, 2 → status
  lists them ordered 1, 1.5, 2).
- Full suite green; dist rebuilt (`npm run build`) so the drift gate passes.

Task 6 (drill) then proceeds unchanged.
