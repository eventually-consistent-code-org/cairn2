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
    /** Standing closures whose close-time re-run (#357) did not reproduce the
     *  claimed pass -- a non-zero exit or a timeout, with the exit observed. */
    observedMismatches: (DistillLedgerEntry & {
        exit: string;
    })[];
    /** Union range the ledger lines span (closure and evidence lines alike --
     *  both landed commits): the base the other bases descend from, to the
     *  head that descends from the other heads (#445) -- never "the last
     *  line", which is a merge artifact. Null when the ledger has no parsed
     *  entries. */
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
    /** The close-time re-run's exit (#357) when the line carries one ("0", "1", "timeout"). */
    observedExit?: string;
    /** Carries the literal `observed-mismatch` marker. */
    observedMismatch: boolean;
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
    /** The line order this parse resolved by (#445), git answers cached, for
     *  readers that still have lines of their own to rank. */
    order: LedgerLineOrder;
}
/** The three fields the rule reads, present on closure and evidence lines alike. */
export interface LedgerLineRef {
    headCommit: string;
    /** 1-indexed LEDGER.md line. */
    line: number;
    /** `closedDate` on a closure line, `loggedDate` on an evidence line. */
    closedDate?: string;
    loggedDate?: string;
}
/** Ancestry questions for one ledger's repository, answered by git and cached per parse. */
export interface LedgerLineOrder {
    /** True when `x` speaks after `y` by the rule above. */
    later(x: LedgerLineRef, y: LedgerLineRef): boolean;
    /** The commit range the given lines span, by the same rule; null for none. */
    range(spans: LedgerSpan[]): {
        base: string;
        head: string;
    } | null;
}
/** One ledger line's commits, with what the tie-breaks read. */
export interface LedgerSpan extends LedgerLineRef {
    baseCommit: string;
}
/**
 * Build the line order for the repository that holds `cwd` (the phase dir;
 * git discovers the repository upward, exactly as a hook run there would).
 *
 * :param cwd: the phase directory whose LEDGER.md is being read
 * :returns the rule, with git's answers cached for this parse
 */
export declare function ledgerLineOrder(cwd: string): LedgerLineOrder;
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
 * the union commit range those entries span. Filesystem reads plus git
 * ancestry questions (#445) -- no tracker, no LLM judgment; same repo
 * state, same manifest.
 *
 * :param projectDir: project root (the dir holding .cairn/)
 * :param phaseNumber: phase number, integer or one-decimal (1, 1.5, ...)
 * :returns DistillManifest scoped to exactly what the phase changed
 * :throws CairnError CONFIG_INVALID for a malformed phase number,
 *   NOT_FOUND when no live or archived phase dir carries that number
 */
export declare function distillManifest(projectDir: string, phaseNumber: number): DistillManifest;
