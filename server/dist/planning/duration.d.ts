import type { IssueComment } from "../tracker/types.js";
import type { Measured } from "./close-receipt.js";
/** What a claim carries besides the state change: the base commit the
 *  ledger will need, and the context a reader wants before the work --
 *  which wave/task this is and the bar it will be held to. The base
 *  commit is optional on the way in (#369): the server reads HEAD itself
 *  when it is left off, so no verb has to shell out just to feed it. */
export interface ClaimInput {
    baseCommit?: string;
    wave?: string;
    task?: string;
    verifyCommand?: string;
}
/** A claim after the server has settled its base commit -- the shape the
 *  comment composer and the receipt both take. */
export type ResolvedClaim = ClaimInput & {
    baseCommit: string;
};
/**
 * HEAD of the project's repository, or null when git cannot answer (no
 * repository, no commits yet, no git on PATH). Null rather than a throw,
 * like every function here; the caller decides whether a missing base is
 * an error (a claim with nothing to measure the ledger from is) or a
 * shrug (a stamp that simply carries no commit).
 */
export declare function headCommit(projectDir: string): string | null;
/**
 * The claim comment, composed server-side so its first line is always the
 * one `isClaimComment` recognises. The verify command is quoted back before
 * the work so the bar is visible up front, not negotiated after; the base
 * commit sits on its own line as a short ref.
 */
export declare function composeClaimComment(c: ResolvedClaim): string;
/**
 * Whether a comment is the work verb's claim comment -- the one posted the
 * moment an issue is picked up, whose timestamp starts the clock on rung one.
 */
export declare function isClaimComment(text: string): boolean;
/** The claim comment's timestamp: the EARLIEST matching comment, so a
 *  re-claim after a parked stretch still measures from the first pickup --
 *  the same first-claim rule the observed stamp follows. */
export declare function claimCommentTime(comments: IssueComment[]): string | null;
/**
 * Rungs one and two, at close. `comments` is undefined on backends that
 * cannot enumerate them (GitHub today) -- that is not a failure, the ladder
 * simply starts one rung down.
 */
export declare function measureAtClose(input: {
    comments?: IssueComment[];
    observedClaimAt: string | null;
    closedAt: string;
}): Measured & {
    claimedAt: string | null;
};
/**
 * Rung three: first author date to last committer date across base..head.
 * Author date marks when the first change was written; committer date marks
 * when the last one landed (rebases and amends move it, which is the point).
 * A single-commit range measures its own author-to-commit gap. No commits
 * or no git -> none.
 */
export declare function gitSpan(projectDir: string, base: string, head: string): Measured;
/** The close comment's line: the number, always with where it came from. */
export declare function measuredText(m: Measured): string;
/**
 * The evidence + measured block every close posts (phase 23, #232): one
 * standard line per fact, the same shape on every backend. A close with no
 * evidence posts the measured line alone.
 */
export declare function closeEvidenceText(measured: Measured, evidence?: {
    command: string;
    result: string;
}): string;
/**
 * The close comment, composed server-side when issue_close carries a
 * summary (#365) -- the mirror of composeClaimComment. What shipped first,
 * the commit range as short refs on its own line, then the standard
 * evidence + measured block, then the agent-cost line when the cost log has
 * spend for this issue (never a zero line: no rows means no line). No time
 * spent of the agent's own: the measured line is the duration.
 */
export declare function composeCloseComment(c: {
    summary: string;
    baseCommit: string;
    headCommit: string;
    evidence: {
        command: string;
        result: string;
    };
    measured: Measured;
    costUsd: number;
}): string;
