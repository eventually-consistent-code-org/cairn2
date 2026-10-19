export interface DistillLedgerEntry {
    taskRef: string;
    summary: string;
    baseCommit: string;
    headCommit: string;
    issueId: string;
    closedDate: string;
}
/** An evidence-only ledger line (#256): work recorded against an issue
 *  that this line does NOT claim closed. */
export interface DistillEvidenceEntry {
    taskRef: string;
    summary: string;
    baseCommit: string;
    headCommit: string;
    issueId: string;
    loggedDate: string;
}
export interface DistillManifest {
    /** `dir` is the phase's path relative to the plans root minus the live
     *  "phases/" prefix -- "01-core" live, "milestones/v1/01-core" archived --
     *  the same id convention docs-drift reports use. */
    phase: {
        number: number;
        name: string;
        dir: string;
        archived: boolean;
    };
    issues: string[];
    /** Closure lines still standing -- a closure later superseded by an
     *  evidence line for the same taskRef is moved to `superseded`. */
    ledgerEntries: DistillLedgerEntry[];
    /** Evidence-only lines: never closures, in file order. */
    evidenceEntries: DistillEvidenceEntry[];
    /** Closure lines an evidence line for the same taskRef later corrected --
     *  the issue reads NOT closed. */
    superseded: DistillLedgerEntry[];
    /** Union range the ledger lines span (closure and evidence lines alike --
     *  both landed commits): first line's base to last line's head (the ledger is append-only, so file order IS chronological order).
     *  Null when the ledger has no parsed entries. */
    commitRange: {
        base: string;
        head: string;
    } | null;
    /** One note per ledger line that LOOKED like an entry but didn't match the
     *  writer's grammar -- surfaced, not silently dropped. */
    skipped: string[];
}
/**
 * A closure line as the ledger gates read it: the distill entry plus where
 * it sits and which gate segments it carries. distillManifest strips these
 * back off, so its result shape never moves.
 */
export interface ParsedClosure extends DistillLedgerEntry {
    /** 1-indexed LEDGER.md line. */
    line: number;
    /** Carries a `tdd <red>..<green>` segment. */
    tdd: boolean;
    /** Carries an `evidence <cmd> => <result>` or `waived <reason>` segment. */
    closeEvidence: boolean;
    /** Superseded closures only: the evidence line that corrected it. */
    supersededBy?: number;
}
/** An evidence-only line plus where it sits. */
export interface ParsedEvidence extends DistillEvidenceEntry {
    line: number;
}
export interface ParsedLedger {
    entries: ParsedClosure[];
    evidence: ParsedEvidence[];
    superseded: ParsedClosure[];
    skipped: string[];
    range: {
        base: string;
        head: string;
    } | null;
}
/**
 * Parse one phase dir's LEDGER.md -- the one ledger reader that
 * distill_manifest and plan_check's ledger gates share.
 *
 * :param base: the phase directory (live or archived) holding LEDGER.md
 * :returns standing closures, evidence lines, superseded closures, skip
 *   notes and the union commit range -- all empty when there is no ledger
 */
export declare function parseLedger(base: string): ParsedLedger;
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
export declare function distillManifest(projectDir: string, phaseNumber: number): DistillManifest;
