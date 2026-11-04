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
/** `minutes` is the span less any usage-limit wait inside it; `pausedMinutes`
 *  is that wait, present ONLY when there was one (#380) -- a close with no
 *  pause writes the same receipt it always did. */
export interface Measured {
    minutes: number | null;
    source: DurationSource;
    pausedMinutes?: number;
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
 *  progress, when the claim carried one, the commit the work starts
 *  from (#369) -- the close fold reads it back so the ledger append never
 *  has to be told -- and the session that claimed (#470), the key the
 *  pause recorder's rows carry, so the measurement at close believes only
 *  that session's pauses. `baseCommit` is absent on stamps written by a
 *  bare state change and on stamps from before it was recorded;
 *  `sessionId` is absent when the server was started by a harness that
 *  hands it none, and on older stamps. */
export interface ClaimRecord {
    issueId: string;
    at: string;
    baseCommit?: string;
    sessionId?: string;
}
/**
 * The session this server runs for (#470): Claude Code starts its MCP
 * servers with CLAUDE_CODE_SESSION_ID in their environment, the same id
 * every hook payload carries -- a claim about the harness, dated
 * 2026-11-04, measured on a live server's environment. Undefined under a
 * harness that sets none; a stamp then carries no session and the
 * measurement subtracts no pause (asserted: measured-duration.test.ts,
 * "a claim stamped with no session believes no row").
 */
export declare function sessionOfServer(): string | undefined;
/**
 * Rung two's evidence: the moment this server moved the issue to in
 * progress, with the base commit beside it when the claim named one, and
 * the claiming session when the server knows its own (#470). The FIRST
 * claim wins -- a re-claim after a parked stretch is still the same piece
 * of work, and cycle time (and the commit range) run from its start.
 * Never throws; a claim must not fail because instrumentation could not
 * write.
 */
export declare function recordClaim(projectDir: string, issueId: string, at: string, baseCommit?: string, sessionId?: string): boolean;
/** The whole claim stamp, without consuming it; null when absent or
 *  unreadable. Tolerant of the older shapes: a stamp with no baseCommit or
 *  no sessionId still parses, it just carries none. */
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
 * What the server saw when it re-ran the declared verify at close (#357):
 * the side effect it observed, beside the narration the worker supplied.
 * `exit` is the declared line's exit status, or "timeout" when it ran out
 * of time. `tail` is the last lines of combined stdout and stderr with
 * only trailing whitespace stripped -- it is evidence, so nothing else is
 * cleaned. `at` is the server clock when the run finished.
 */
export interface Observed {
    exit: number | "timeout";
    tail: string;
    at: string;
    /** What ran: always the PLAN.md-declared line, never the worker's string. */
    command: string;
}
/**
 * Why a close with `verify.rerun` on ran nothing. Every reason is a named
 * string the tool result and the ledger line carry -- never silence.
 * `plan-untracked`: PLAN.md is not tracked by git, so the declared line has
 * no provenance to check. `plan-unapproved` (#423): no owner-approval
 * stamp for the phase's PLAN.md (`plan_meta_set approve`); the claim's
 * base commit is the agent's own act and stopped being provenance.
 * `approval-unreadable`: the approved blob is not in git's object store any
 * more. `declared-changed`: the declared line differs from the one in the
 * approved plan. `classifier-unavailable` (#423): the run guard's shell
 * reader and effect classifier (hooks/scripts) are not beside this server,
 * so the line could not be classified -- fail closed, unlike the hooks.
 * `unclassifiable`: the line nests or hides a command the classifier
 * cannot read (a script file, stdin, too deep a substitution). `effect-refused`:
 * a git invocation in the line carries an effect the server never runs
 * (`discards-work`, `moves-shared-ref`); `effect` names it. `spawn-failed`:
 * the server's own error running the line (fail-open: the close still lands).
 */
export type ObservedSkip = "evidence-waived" | "no-declared-verify" | "command-differs" | "not-plain-shell" | "plan-untracked" | "plan-unapproved" | "approval-unreadable" | "declared-changed" | "classifier-unavailable" | "unclassifiable" | "effect-refused" | "spawn-failed";
export type Observation = Observed | {
    skipped: ObservedSkip;
    detail?: string;
    effect?: string;
};
/**
 * A close is the claim that the declared run passed, so an observed
 * non-zero exit or a timeout is the mismatch (#357). A skip observed
 * nothing, so it can never be one.
 */
export declare function isObservedMismatch(o: Observation): boolean;
/**
 * The ledger line's `observed` segment (#357), placed right after the
 * evidence segment it checks. Space-separated key=value pairs like
 * `actuals`, never an em dash; the tail stays in the tool result, not on a
 * one-line record. A mismatch carries the literal `observed-mismatch`
 * marker that plan_check and distill_manifest read back.
 */
export declare function observedSegment(o: Observation): string;
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
