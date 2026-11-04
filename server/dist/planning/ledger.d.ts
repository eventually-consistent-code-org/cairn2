import { type Measured, type Observation } from "./close-receipt.js";
/** Typed close evidence (phase 23): what was run, and what it showed. */
export interface CloseEvidence {
    /** The proving command — a suite name or the shell line ("npm test", "vitest run x.test.ts"). */
    command: string;
    /** The observed outcome ("1408 passed", "exit 0, 3 files changed"). */
    result: string;
}
export interface LedgerEntryInput {
    taskRef: string;
    summary: string;
    baseCommit: string;
    headCommit: string;
    issueId: string;
    /** The stamp on the line: the full ISO timestamp (the close fold passes
     *  `Date.toISOString()`, #472) or a bare YYYY-MM-DD day. Typed on the way
     *  in (#469); the readers rank two lines for one task by it. */
    closedDate: string;
    redCommit?: string;
    greenCommit?: string;
    /**
     * Exactly one of `evidence` / `evidenceWaived` is required: an issue
     * closes on what was run and what it showed, or on a written reason it
     * needed no run (docs-only, planning-only). Neither → the append refuses.
     */
    evidence?: CloseEvidence;
    evidenceWaived?: string;
    /**
     * "close" (default) writes the closure line `<issueId> closed <date>`.
     * "evidence" (#256) records evidence for an issue that is NOT being
     * closed -- `audit tests` logging what it wrote, or correcting a closure
     * line that claimed an issue still open. It renders `- [ ] … evidence for
     * <issueId> <date>` (closedDate is then the logged date), consumes no
     * close receipt, and every ledger reader treats it as not-a-closure. An
     * evidence line that does not speak strictly BEFORE a closure line for
     * the same taskRef (by commit ancestry, then the stamp, then the head
     * hash -- #445, #472; never file order) supersedes that closure: readers
     * report the issue not closed.
     */
    kind?: LedgerKind;
    /** Free-text note on an evidence line (e.g. "supersedes the closure line"). Evidence kind only. */
    note?: string;
}
export type LedgerKind = "close" | "evidence";
/**
 * Refuses a commit reference that is not a hash, with the field named so
 * the caller knows which end of the range to fix. Shared by the ledger's
 * own validation (base and head of the range) and the claim block in
 * index.ts (the stamp the close fold will read the range from). A moving
 * reference would make the range a different thing each time it is read;
 * an option-shaped one would make `git log` do whatever the option says
 * (asserted: ledger.test.ts "a commit reference is a hash, nothing else").
 *
 * :param value: the string the caller supplied
 * :param field: its name in the caller's input ("baseCommit", "claim.baseCommit")
 * :returns the trimmed hash
 */
export declare function assertCommitHash(value: string, field: string): string;
/**
 * The `verify:` command a phase's PLAN.md declared for one issue (#206),
 * or null when the plan names none. One parser for the whole server
 * (#357): plan_check's `declaredVerifyIn` reads the task block, and the
 * last clause in it wins.
 */
export declare function declaredVerifyFor(projectDir: string, phaseDir: string, issueId: string): string | null;
/**
 * Every refusal appendLedger can raise -- the phase dir exists, the entry is
 * well formed -- with nothing written and nothing consumed. appendLedger runs
 * it first; the close fold (#365) runs it BEFORE the tracker close too, so a
 * ledger line that would be refused refuses the whole call while the issue
 * is still open, instead of leaving a close with no line behind it.
 */
export declare function checkLedgerEntry(projectDir: string, phaseDir: string, entry: LedgerEntryInput): {
    number: number;
    name: string;
};
/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export declare function appendLedger(projectDir: string, phaseDir: string, entry: LedgerEntryInput): {
    path: string;
    line: string;
    /** Why this line carries no receipt facts, when it doesn't (#233). */
    degraded?: string[];
    /** The duration on the line and the rung that produced it (#232). */
    measured: Measured;
    /** What PLAN.md said would prove this task (#206), when it said anything. */
    declaredVerify?: string;
    /** Whether the evidence run cites that declaration. Reported, never enforced. */
    evidenceCitesDeclared?: boolean;
    /** What the server saw re-running the declared verify (#357), or why it ran
     *  nothing. Present only when `verify.rerun` is on and the line is a close. */
    observed?: Observation;
    /** The close claimed a pass the re-run did not reproduce. Reported, never refused. */
    observedMismatch?: boolean;
};
