// The ledger append: the evidence gate a close must pass (a typed record of
// what was run and what it showed, or a written waiver) and the line that
// records it.
//
// Ordering across branches is by merge, not by append time: the ledger
// merges by union (.gitattributes, #361), so lines from two branches land
// in merge order. Readers treat it as a set of lines keyed by issue id;
// asserted by test/ledger.test.ts "ledger ordering is a merge artifact".
//
// removeWhen: never for the record -- a commit range and its evidence are
// the audit trail, not a model workaround. The refusal on missing evidence
// can soften to a report once agents attach evidence unprompted on every
// close across a milestone.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { declaredVerifyIn } from "./check.js";
import { actualsSegment, isObservedMismatch, observedSegment, takeReceipt, } from "./close-receipt.js";
import { gitSpan } from "./duration.js";
import { projectStatus } from "./status.js";
import { observeDeclaredVerify } from "./verify-rerun.js";
/** Short-SHA form used in the ledger line -- matches `git log --abbrev=7` convention. */
function shortSha(commit) {
    return commit.slice(0, 7);
}
/** Collapses embedded newlines (and the whitespace around them) to a single space, so a
 *  multi-line field (e.g. a pasted commit-message summary) can never break the ledger's
 *  one-line-per-entry invariant. */
function sanitize(field) {
    return field.replace(/\s*\n\s*/g, " ").trim();
}
/** Evidence text additionally loses em dashes — " — " is the ledger line's
 *  field separator, so one inside a command or result would shift every
 *  field after it for the readers (distill-manifest, resync). */
function sanitizeSegment(field) {
    return sanitize(field).replace(/—/g, "-");
}
/**
 * The evidence segment: `evidence <command> => <result> — ` or
 * `waived <reason> — `, placed before `<issueId> closed` exactly like the
 * tdd segment. Refuses neither (PRECONDITION_FAILED — the gate) and both
 * (CONFIG_INVALID — a contradiction).
 */
function evidenceSegment(entry) {
    const has = entry.evidence !== undefined;
    const waived = entry.evidenceWaived !== undefined;
    if (has && waived) {
        throw new CairnError("CONFIG_INVALID", "evidence and evidenceWaived are mutually exclusive", "pass the evidence you have, or a waiver reason — not both");
    }
    if (has) {
        const cmd = sanitizeSegment(entry.evidence.command ?? "");
        const res = sanitizeSegment(entry.evidence.result ?? "");
        if (!cmd || !res) {
            throw new CairnError("PRECONDITION_FAILED", "close evidence needs both a command (what was run) and a result (what it showed)", "e.g. { command: \"npm test\", result: \"1408 passed\" }");
        }
        return `evidence ${cmd} => ${res} — `;
    }
    if (waived) {
        const reason = sanitizeSegment(entry.evidenceWaived);
        if (!reason) {
            throw new CairnError("PRECONDITION_FAILED", "an evidence waiver needs a reason", "say why this close needed no run — \"docs only\", \"plan text only\"");
        }
        return `waived ${reason} — `;
    }
    throw new CairnError("PRECONDITION_FAILED", "close evidence missing: state what was run and what it showed, or waive with a reason", "ledger_append(evidence: { command, result }) from the run that justified the close, "
        + "or evidenceWaived: \"<why no run was needed>\" for docs/planning-only issues");
}
/** Every refusal the line can raise, checked before anything is consumed --
 *  a refused append must leave the close receipt where it found it. */
function validateEntry(entry) {
    const kind = entry.kind ?? "close";
    if (kind !== "close" && kind !== "evidence") {
        throw new CairnError("CONFIG_INVALID", `kind '${String(kind)}' is not a ledger line kind`, "pass kind: \"close\" or \"evidence\"");
    }
    if (entry.note !== undefined && kind !== "evidence") {
        throw new CairnError("CONFIG_INVALID", "note is only written on evidence lines", "pass kind: \"evidence\" with the note, or drop the note from the closure line");
    }
    if ((entry.redCommit === undefined) !== (entry.greenCommit === undefined)) {
        throw new CairnError("CONFIG_INVALID", "redCommit/greenCommit: both or neither", "pass the failing-test commit AND the passing commit, or omit both");
    }
    evidenceSegment(entry);
}
function formatEntry(entry, actuals, observed = "") {
    const tdd = entry.redCommit
        ? `tdd ${shortSha(sanitize(entry.redCommit))}..${shortSha(sanitize(entry.greenCommit))} — `
        : "";
    const evidence = evidenceSegment(entry);
    if ((entry.kind ?? "close") === "evidence") {
        // No closure claim anywhere on the line: an unchecked box, no actuals
        // (nothing closed, so no receipt to render), and an "evidence for" tail
        // in place of "<issueId> closed". The readers key off exactly this tail.
        const note = entry.note !== undefined && sanitizeSegment(entry.note)
            ? `note ${sanitizeSegment(entry.note)} — ` : "";
        return `- [ ] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
            + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
            + `${tdd}${evidence}${note}evidence for ${sanitize(entry.issueId)} ${sanitize(entry.closedDate)}\n`;
    }
    return `- [x] ${sanitize(entry.taskRef)} — ${sanitize(entry.summary)} — commits `
        + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
        + `${tdd}${evidence}${observed}${actuals}${sanitize(entry.issueId)} closed ${sanitize(entry.closedDate)}\n`;
}
/**
 * The `verify:` command a phase's PLAN.md declared for one issue (#206),
 * or null when the plan names none. One parser for the whole server
 * (#357): plan_check's `declaredVerifyIn` reads the task block, and the
 * last clause in it wins.
 */
export function declaredVerifyFor(projectDir, phaseDir, issueId) {
    const planPath = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
    if (!existsSync(planPath))
        return null;
    return declaredVerifyIn(readFileSync(planPath, "utf8").split("\n"), issueId);
}
/**
 * Whether the evidence actually run cites what the plan declared.
 *
 * Deliberately a REPORT, never a refusal. Declared commands are written in
 * shorthand ("npm test") while evidence records what was really typed
 * ("npx vitest run --exclude '**\/*.live.test.ts'"), so a string gate here
 * would fail honest closes constantly and teach people to pad the field.
 * The comparison is loose on purpose — a shared significant token is
 * enough to say "this is the same check" — and the judgement of whether a
 * mismatch matters belongs to verify, where a human reads it.
 */
function citesDeclared(declared, evidenceCommand) {
    const tokens = (t) => new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g)?.filter((w) => !["run", "npm", "npx", "the", "and", "--exclude", "test"].includes(w)) ?? []);
    const d = tokens(declared);
    const e = tokens(evidenceCommand);
    for (const t of d)
        if (e.has(t))
            return true;
    // Nothing distinctive matched. "npm test" against "npx vitest run
    // --exclude ..." is the common honest case: both name the suite, neither
    // shares a distinctive token once the stoplist has done its work. Treat
    // "both are the test suite" as the same check, then fall back to exact
    // equality for anything else.
    const SUITE = /\b(?:test|tests|vitest|jest|mocha|pytest|suite)\b/i;
    if (SUITE.test(declared) && SUITE.test(evidenceCommand))
        return true;
    return declared.trim().toLowerCase() === evidenceCommand.trim().toLowerCase();
}
function ledgerHeader(phase) {
    return `# Phase ${phase.number}: ${phase.name} — Ledger\n\n`
        + `<!-- append-only; one line per verified task; server appends, never rewrites -->\n\n`;
}
/**
 * Every refusal appendLedger can raise -- the phase dir exists, the entry is
 * well formed -- with nothing written and nothing consumed. appendLedger runs
 * it first; the close fold (#365) runs it BEFORE the tracker close too, so a
 * ledger line that would be refused refuses the whole call while the issue
 * is still open, instead of leaving a close with no line behind it.
 */
export function checkLedgerEntry(projectDir, phaseDir, entry) {
    const phase = projectStatus(projectDir).phases.find((p) => p.dir === phaseDir);
    if (!phase) {
        throw new CairnError("NOT_FOUND", `no phase dir '${phaseDir}' found under .cairn/plans/phases`, "run plan_scaffold_phase (or plan_status to list known phases), then retry ledger_append");
    }
    validateEntry(entry);
    return phase;
}
/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export function appendLedger(projectDir, phaseDir, entry, opts = {}) {
    const phase = checkLedgerEntry(projectDir, phaseDir, entry);
    const declaredVerify = declaredVerifyFor(projectDir, phaseDir, entry.issueId);
    const path = join(plansRoot(projectDir), "phases", phaseDir, "LEDGER.md");
    const span = () => gitSpan(projectDir, sanitize(entry.baseCommit), sanitize(entry.headCommit));
    let line;
    let wall;
    let degraded;
    let observation = null;
    if ((entry.kind ?? "close") === "evidence") {
        // An evidence line closes nothing (#256), so it must not eat the close
        // receipt a real close of this issue may still be waiting to render.
        wall = span();
        line = formatEntry(entry, "");
    }
    else {
        // The close receipt (#233): consumed only once the line is known to be
        // writable. takeReceipt never throws -- a missing or broken receipt
        // degrades the segment, it never fails the append.
        // The re-run (#357) happens here, inside the one write path, so the
        // folded close (#365) and a standalone ledger_append both observe. It
        // never throws and is null when rerun is off -- the line then carries
        // no observed segment at all, byte-identical to before.
        observation = observeDeclaredVerify({
            projectDir, phaseDir, issueId: sanitize(entry.issueId), evidence: entry.evidence,
            declared: declaredVerify, claimBase: opts.claimBase,
        });
        const taken = takeReceipt(projectDir, sanitize(entry.issueId));
        // Duration ladder (#232): the close measured rungs one and two when it
        // could; rung three needs the commit range, which only this append holds.
        // A missing receipt does not cost the duration -- git still has it.
        const fromClose = taken.receipt?.measured;
        wall = fromClose && fromClose.source !== "none" && fromClose.minutes !== null
            ? fromClose : span();
        line = formatEntry(entry, actualsSegment(taken.receipt
            ? { receipt: taken.receipt, wall } : { degraded: taken.degraded, wall }), observation ? observedSegment(observation) : "");
        degraded = taken.degraded;
    }
    if (existsSync(path)) {
        appendFileSync(path, line);
    }
    else {
        writeFileSync(path, ledgerHeader(phase) + line);
    }
    return {
        path, line: line.trimEnd(),
        ...(degraded ? { degraded: [degraded] } : {}),
        measured: wall,
        ...(declaredVerify === null ? {} : {
            declaredVerify,
            evidenceCitesDeclared: entry.evidence
                ? citesDeclared(declaredVerify, entry.evidence.command)
                : false,
        }),
        ...(observation ? { observed: observation, observedMismatch: isObservedMismatch(observation) } : {}),
    };
}
