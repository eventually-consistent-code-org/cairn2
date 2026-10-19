// Purpose: per-phase distill manifest -- the scope contract for an
//   incremental `distill <N>` run. Resolves one phase (live under phases/ or
//   archived under milestones/vN), reads its PLAN.md issue list, and parses
//   its LEDGER.md lines back into structured entries so synthesis covers ONLY
//   what that phase actually changed. The line grammar here mirrors
//   ledger.ts's formatEntry exactly -- the ledger is append-only and stable,
//   so an honest parse is a safe parse. Malformed lines are skipped with a
//   note, never guessed at.
// Author(s): John Reed
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { PHASE_NUMBER_ERROR, isValidPhaseNumber, parsePhaseDirName, plansRoot, } from "./artifacts.js";
import { parsePlanDoc } from "./frontmatter.js";
import { projectStatus } from "./status.js";
// The exact shape ledger.ts formatEntry writes -- em dashes and all:
//   - [x] <taskRef> — <summary> — commits <base7>..<head7> — [tdd <r>..<g> — ]
//     [evidence <cmd> => <result> — | waived <reason> — ][actuals <k=v ...> — ]
//     <issueId> closed <date>
// taskRef and summary match lazily so the "commits <sha>..<sha>" anchor, not
// an em dash inside a summary, decides where the fields end. The evidence
// segment (phase 23) is optional so pre-gate lines keep parsing; the writer
// strips em dashes from evidence text so the segment can't swallow issueId.
// The actuals segment (phase 24.7) is optional for the same reason.
//
// An evidence line (#256) makes no closure claim: unchecked box, optional
// note segment, and an "evidence for <issueId> <date>" tail. It is matched
// FIRST -- its free-text note could otherwise satisfy the closure pattern.
const EVIDENCE_LINE_RE = new RegExp("^- \\[ \\] (.+?) — (.+?) — commits ([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40}) — "
    + "(?:tdd [0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40} — )?"
    + "(?:(?:evidence|waived) [^—]*? — )?(?:note [^—]*? — )?evidence for (.+?) (.+)$");
// The closure pattern also captures its two gate segments (groups 5 and 6)
// so plan_check's ledger gates read the same parse distill does -- one
// grammar, one parser.
const LEDGER_LINE_RE = new RegExp("^- \\[x\\] (.+?) — (.+?) — commits ([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40}) — "
    + "(tdd [0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40} — )?"
    + "((?:evidence|waived) [^—]*? — )?(?:actuals [^—]*? — )?(.+?) closed (.+)$");
// Live phases win; among archived copies (a number can recur across
// milestones) the newest vN wins -- that's the copy summit archived last.
function resolvePhase(projectDir, phaseNumber) {
    const root = plansRoot(projectDir);
    const live = projectStatus(projectDir).phases
        .find((p) => p.number === phaseNumber);
    if (live) {
        return {
            number: live.number, name: live.name, dir: live.dir, archived: false,
            base: join(root, "phases", live.dir),
        };
    }
    const msDir = join(root, "milestones");
    if (existsSync(msDir)) {
        const versions = readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
            .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
        for (const v of versions) {
            for (const entry of readdirSync(join(msDir, v))) {
                const parsed = parsePhaseDirName(entry);
                if (!parsed || parsed.number !== phaseNumber)
                    continue;
                return {
                    number: parsed.number,
                    name: parsed.slug.replace(/-/g, " "),
                    dir: join("milestones", v, entry),
                    archived: true,
                    base: join(msDir, v, entry),
                };
            }
        }
    }
    throw new CairnError("NOT_FOUND", `no phase ${phaseNumber} under .cairn/plans/phases or .cairn/plans/milestones`, "run plan_status to list live phases, or check milestones/vN for archived ones");
}
// PLAN.md frontmatter issues at an arbitrary phase dir -- readPlanIssues
// hardcodes the live phases/ path, and archived plans live elsewhere.
function planIssuesAt(base) {
    const path = join(base, "PLAN.md");
    if (!existsSync(path))
        return [];
    return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
}
/**
 * Parse one phase dir's LEDGER.md -- the one ledger reader that
 * distill_manifest and plan_check's ledger gates share.
 *
 * :param base: the phase directory (live or archived) holding LEDGER.md
 * :returns standing closures, evidence lines, superseded closures, skip
 *   notes and the union commit range -- all empty when there is no ledger
 */
export function parseLedger(base) {
    const entries = [];
    const evidence = [];
    const superseded = [];
    const skipped = [];
    let range = null;
    // File order IS chronological order (append-only): keep the first base, move the head.
    const extend = (b, h) => { range = { base: range ? range.base : b, head: h }; };
    const path = join(base, "LEDGER.md");
    if (!existsSync(path))
        return { entries, evidence, superseded, skipped, range };
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
        // Only list lines are candidate entries; the header and the append-only
        // comment are the file's own furniture.
        if (!line.startsWith("- "))
            continue;
        const ev = EVIDENCE_LINE_RE.exec(line);
        if (ev) {
            evidence.push({
                taskRef: ev[1], summary: ev[2], baseCommit: ev[3], headCommit: ev[4],
                issueId: ev[5], loggedDate: ev[6], line: i + 1,
            });
            extend(ev[3], ev[4]);
            // A closure EARLIER in the file for the same taskRef was wrong: the
            // evidence line is the correction, so that closure stops standing.
            // (A closure written AFTER this line is a real later close and stays.)
            for (let j = entries.length - 1; j >= 0; j--) {
                if (entries[j].taskRef !== ev[1])
                    continue;
                const [gone] = entries.splice(j, 1);
                superseded.push({ ...gone, supersededBy: i + 1 });
            }
            continue;
        }
        const m = LEDGER_LINE_RE.exec(line);
        if (!m) {
            skipped.push(`LEDGER.md line ${i + 1} does not match the ledger entry `
                + `format -- skipped: ${line.slice(0, 120)}`);
            continue;
        }
        entries.push({
            taskRef: m[1], summary: m[2], baseCommit: m[3], headCommit: m[4],
            issueId: m[7], closedDate: m[8],
            line: i + 1, tdd: m[5] !== undefined, closeEvidence: m[6] !== undefined,
        });
        extend(m[3], m[4]);
    }
    return { entries, evidence, superseded, skipped, range };
}
// Back to the published shapes: the gate fields are plan_check's, and the
// manifest's result must not grow them.
const asEntry = ({ taskRef, summary, baseCommit, headCommit, issueId, closedDate }) => ({ taskRef, summary, baseCommit, headCommit, issueId, closedDate });
const asEvidence = ({ taskRef, summary, baseCommit, headCommit, issueId, loggedDate }) => ({ taskRef, summary, baseCommit, headCommit, issueId, loggedDate });
/**
 * Assemble the distill manifest for one phase: its PLAN.md issues, its
 * LEDGER.md entries (each carrying the commit range the task landed as), and
 * the union commit range those entries span. Pure filesystem reads -- no git,
 * no tracker, no LLM judgment; same repo state, same manifest.
 *
 * :param projectDir: project root (the dir holding .cairn/)
 * :param phaseNumber: phase number, integer or one-decimal (1, 1.5, ...)
 * :returns DistillManifest scoped to exactly what the phase changed
 * :throws CairnError CONFIG_INVALID for a malformed phase number,
 *   NOT_FOUND when no live or archived phase dir carries that number
 */
export function distillManifest(projectDir, phaseNumber) {
    if (!isValidPhaseNumber(phaseNumber)) {
        throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(phaseNumber));
    }
    const phase = resolvePhase(projectDir, phaseNumber);
    const { entries, evidence, superseded, skipped, range } = parseLedger(phase.base);
    return {
        phase: {
            number: phase.number, name: phase.name,
            dir: phase.dir, archived: phase.archived,
        },
        issues: planIssuesAt(phase.base),
        ledgerEntries: entries.map(asEntry),
        evidenceEntries: evidence.map(asEvidence),
        superseded: superseded.map(asEntry),
        commitRange: range,
        skipped,
    };
}
