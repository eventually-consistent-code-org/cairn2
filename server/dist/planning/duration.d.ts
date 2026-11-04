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
 * commit sits on its own line as a short ref. Composed here, screened in
 * index.ts (screenComment, #374) before it is posted: a verify line that
 * names a planning-dir file reaches the tracker as a placeholder, never
 * as written.
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
 * `<cairn home>/pauses/<projectKey>.jsonl` -- the hook-side pausesPath's
 * twin. Per repository, not per worktree: a batch run spans worktrees and
 * the limit that stalls it stalls the run. The server reads the home as
 * `~/.cairn` like every other repository-state path here; `home` is the
 * test seam.
 */
export declare function pausesPath(projectDir: string, home?: string): string;
/**
 * Minutes of usage-limit wait inside [claimAt, closeAt] according to one
 * pauses log's text, believing `session`'s rows (#470; every row when no
 * session is named). Zero for an empty log, an unparseable or reversed
 * span, or windows that all fall outside it -- never a throw.
 */
export declare function pausedMinutesFromLog(raw: string, claimAt: string, closeAt: string, session?: string | null): number;
/** The same, read from the project's pauses log; a missing or unreadable
 *  log is zero minutes, which is exactly what no recorded pause means. */
export declare function pausedMinutesIn(projectDir: string, claimAt: string, closeAt: string, home?: string, session?: string | null): number;
/** Where to find the pauses log when the close wants the wait subtracted,
 *  and whose rows to believe (#470): the claiming session from the claim
 *  stamp, null when the stamp carries none. `home` is the test seam,
 *  absent in production. */
export interface PauseSource {
    projectDir: string;
    home?: string;
    session: string | null;
}
/**
 * Rungs one and two, at close. `comments` is undefined on backends that
 * cannot enumerate them (GitHub today) -- that is not a failure, the ladder
 * simply starts one rung down. With `pauses` the usage-limit wait inside
 * the span is subtracted (#380); without it the span stands as measured.
 */
export declare function measureAtClose(input: {
    comments?: IssueComment[];
    observedClaimAt: string | null;
    closedAt: string;
    pauses?: PauseSource;
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
/** The close comment's line: the number, always with where it came from,
 *  and the wait it no longer includes when there was one (#380). */
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
 * spent of the agent's own: the measured line is the duration. Screened by
 * the same leak guard as the claim comment before posting (#374); the
 * ledger line keeps the exact text.
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
