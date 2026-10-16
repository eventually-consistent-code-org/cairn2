import type { EstimateSource } from "./token-estimate.js";
/** What the worklog did with the time at close. */
export type WorklogOutcome = "logged" | "failed" | "unsupported" | "not_requested";
/** The estimate exactly as the close saw it, each number with its source. */
export interface ReceiptEstimate {
    points: number | null;
    pointsSource: EstimateSource | null;
    minutes: number | null;
    minutesSource: EstimateSource | null;
}
export interface CloseReceipt {
    version: 1;
    issueId: string;
    /** Server clock at the moment the close was issued. */
    closedAt: string;
    /** When the work was claimed, when the close could find out; null otherwise. */
    claimedAt: string | null;
    /** The duration the close could measure (#232) -- the first two rungs of
     *  the ladder. Absent or `none` leaves the git rung to the append, which
     *  is the only tool holding the commit range. */
    measured?: Measured;
    /** The agent's own number -- a claim to check, never the measurement. */
    claimedMinutes: number | null;
    estimate: ReceiptEstimate;
    worklog: WorklogOutcome;
}
/** Which rung of the duration ladder produced a number (#232). They are
 *  different measurements of different spans -- the label is what stops a
 *  later reader pooling them as if they were one. */
export type DurationSource = "claim_comment" | "observed_claim" | "git_span" | "none";
export interface Measured {
    minutes: number | null;
    source: DurationSource;
}
/** Why the append is working without a receipt. Always named, never implied. */
export type ReceiptDegraded = "no_receipt" | "receipt_unreadable";
/** Receipts live in local state, never in git: the directory ignores itself,
 *  so this holds in any repo whether or not its .gitignore knows about it. */
export declare function receiptsDir(projectDir: string): string;
/** Writes the receipt. Returns false instead of throwing on any failure --
 *  the close has already happened and must report success regardless. */
export declare function writeReceipt(projectDir: string, receipt: CloseReceipt): boolean;
/** What the claim stamp holds: when the server saw the issue go in
 *  progress and, when the claim carried one, the commit the work starts
 *  from (#369) -- the close fold reads it back so the ledger append never
 *  has to be told. `baseCommit` is absent on stamps written by a bare
 *  state change and on stamps from before it was recorded. */
export interface ClaimRecord {
    issueId: string;
    at: string;
    baseCommit?: string;
}
/**
 * Rung two's evidence: the moment this server moved the issue to in
 * progress, with the base commit beside it when the claim named one. The
 * FIRST claim wins -- a re-claim after a parked stretch is still the same
 * piece of work, and cycle time (and the commit range) run from its start.
 * Never throws; a claim must not fail because instrumentation could not
 * write.
 */
export declare function recordClaim(projectDir: string, issueId: string, at: string, baseCommit?: string): boolean;
/** The whole claim stamp, without consuming it; null when absent or
 *  unreadable. Tolerant of the older two-field shape: a stamp with no
 *  baseCommit still parses, it just carries none. */
export declare function readClaimRecord(projectDir: string, issueId: string): ClaimRecord | null;
/** The claim stamp's time alone, without consuming it; null when absent or
 *  unreadable. The close reads it BEFORE closing and clears it only once
 *  the close succeeded -- a close that throws must leave the clock where
 *  it was. */
export declare function readClaim(projectDir: string, issueId: string): string | null;
export declare function clearClaim(projectDir: string, issueId: string): void;
/**
 * The ledger line's `actuals` segment, placed before `<issueId> closed` like
 * the tdd and evidence segments. Space-separated key=value pairs so a later
 * reader can split it without knowing every key; never an em dash, which is
 * the line's field separator. A receipt-less append still gets the segment,
 * carrying only its degraded marker -- absence is stated, not implied.
 */
export declare function actualsSegment(from: ({
    receipt: CloseReceipt;
} | {
    degraded: ReceiptDegraded;
}) & {
    wall: Measured;
}): string;
/**
 * Reads and deletes the receipt for one issue. Exactly one of `receipt` /
 * `degraded` is set. An unreadable file is deleted too -- a corrupt receipt
 * left behind would degrade every later append for the same id the same way.
 */
export declare function takeReceipt(projectDir: string, issueId: string): {
    receipt: CloseReceipt;
    degraded?: undefined;
} | {
    receipt?: undefined;
    degraded: ReceiptDegraded;
};
