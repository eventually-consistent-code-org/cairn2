// Measured duration (#232): the server derives how long a task took from
// timestamps it already controls, instead of asking the agent -- whose
// numbers measured 6x-14x inflated in phase 24.5, and which has no
// introspective access to its own elapsed time to begin with.
//
// The ladder, best rung first, the rung always recorded beside the number:
//   1. claim_comment  -- the claim comment's tracker timestamp to close
//   2. observed_claim -- the moment this server moved the issue in progress
//   3. git_span       -- first author date to last committer date over the
//                        task's commits (computed at ledger append, the only
//                        place the commit range is known)
//   4. none           -- recorded as such, never guessed
//
// Every function here returns a value instead of throwing: a measurement
// that can fail a close is worse than no measurement.
//
// removeWhen: the harness hands the model trustworthy wall-clock stamps per
// turn and self-reports land within measured error across a milestone --
// and even then this is cheaper, so expect it to stay (ADR 0020).
import { execFileSync } from "node:child_process";
const NONE = { minutes: null, source: "none" };
/** Whole minutes from start to end; null when either stamp is unparseable
 *  or the span runs backwards (clock skew, a stamp from another claim). */
function spanMinutes(start, end) {
    const a = Date.parse(start);
    const b = Date.parse(end);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a)
        return null;
    return Math.round((b - a) / 60_000);
}
/** The opening every claim comment carries -- the one phrase rung one keys
 *  on. Composed here and parsed here (#343); no verb file spells it. */
const CLAIM_OPENING = "Starting now.";
/**
 * HEAD of the project's repository, or null when git cannot answer (no
 * repository, no commits yet, no git on PATH). Null rather than a throw,
 * like every function here; the caller decides whether a missing base is
 * an error (a claim with nothing to measure the ledger from is) or a
 * shrug (a stamp that simply carries no commit).
 */
export function headCommit(projectDir) {
    try {
        const out = execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return /^[0-9a-f]{40}$/i.test(out) ? out : null;
    }
    catch {
        return null;
    }
}
/**
 * The claim comment, composed server-side so its first line is always the
 * one `isClaimComment` recognises. The verify command is quoted back before
 * the work so the bar is visible up front, not negotiated after; the base
 * commit sits on its own line as a short ref.
 */
export function composeClaimComment(c) {
    const wave = c.wave?.trim();
    const task = c.task?.trim();
    const context = wave && task ? `Wave ${wave}: ${task}`
        : wave ? `Wave ${wave}` : task ?? "";
    const head = context ? `${CLAIM_OPENING} ${context.replace(/\.$/, "")}.` : CLAIM_OPENING;
    const verify = c.verifyCommand?.trim();
    const base = c.baseCommit.trim();
    const short = /^[0-9a-f]{7,40}$/i.test(base) ? base.slice(0, 7) : base;
    return [head, ...(verify ? [`Declared verify: \`${verify}\``] : []), `Base: ${short}`]
        .join("\n\n");
}
/**
 * Whether a comment is the work verb's claim comment -- the one posted the
 * moment an issue is picked up, whose timestamp starts the clock on rung one.
 */
export function isClaimComment(text) {
    // Strict on purpose: only a first line opening "Starting now" -- the work
    // verb's own claim. A missed hand-written claim just falls to rung two; a
    // false match ("...starting now on the adapter" in a progress note) would
    // start the clock early and inflate the very number this replaces.
    const firstLine = text.trimStart().split("\n")[0];
    return /^starting now\b/i.test(firstLine);
}
/** The claim comment's timestamp: the EARLIEST matching comment, so a
 *  re-claim after a parked stretch still measures from the first pickup --
 *  the same first-claim rule the observed stamp follows. */
export function claimCommentTime(comments) {
    const stamps = comments
        .filter((c) => c.at && isClaimComment(c.text))
        .map((c) => c.at)
        .filter((at) => !Number.isNaN(Date.parse(at)))
        .sort((x, y) => Date.parse(x) - Date.parse(y));
    return stamps[0] ?? null;
}
/**
 * Rungs one and two, at close. `comments` is undefined on backends that
 * cannot enumerate them (GitHub today) -- that is not a failure, the ladder
 * simply starts one rung down.
 */
export function measureAtClose(input) {
    const fromComment = input.comments ? claimCommentTime(input.comments) : null;
    if (fromComment) {
        const m = spanMinutes(fromComment, input.closedAt);
        if (m !== null)
            return { minutes: m, source: "claim_comment", claimedAt: fromComment };
    }
    if (input.observedClaimAt) {
        const m = spanMinutes(input.observedClaimAt, input.closedAt);
        if (m !== null) {
            return { minutes: m, source: "observed_claim", claimedAt: input.observedClaimAt };
        }
    }
    return { ...NONE, claimedAt: null };
}
/**
 * Rung three: first author date to last committer date across base..head.
 * Author date marks when the first change was written; committer date marks
 * when the last one landed (rebases and amends move it, which is the point).
 * A single-commit range measures its own author-to-commit gap. No commits
 * or no git -> none.
 */
export function gitSpan(projectDir, base, head) {
    try {
        const out = execFileSync("git", ["-C", projectDir, "log", "--reverse", "--format=%aI%x09%cI", `${base}..${head}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (!out)
            return NONE;
        const rows = out.split("\n").map((l) => l.split("\t"));
        const first = rows[0][0];
        const last = rows[rows.length - 1][1];
        const m = first && last ? spanMinutes(first, last) : null;
        return m === null ? NONE : { minutes: m, source: "git_span" };
    }
    catch {
        return NONE;
    }
}
const RUNG_TEXT = {
    claim_comment: "claim comment to close",
    observed_claim: "claim the server saw to close",
    git_span: "first to last commit",
};
/** The close comment's line: the number, always with where it came from. */
export function measuredText(m) {
    return m.minutes === null || m.source === "none"
        ? "measured: not derivable at close (the ledger append takes it from the commit range)"
        : `measured: ~${m.minutes}m (${RUNG_TEXT[m.source]})`;
}
/**
 * The evidence + measured block every close posts (phase 23, #232): one
 * standard line per fact, the same shape on every backend. A close with no
 * evidence posts the measured line alone.
 */
export function closeEvidenceText(measured, evidence) {
    const line = measuredText(measured);
    return evidence
        ? `evidence: \`${evidence.command.trim()}\` → ${evidence.result.trim()}\n${line}`
        : line;
}
/** A sha as the short ref a reader scans for; anything else as given. */
function shortRef(commit) {
    const c = commit.trim();
    return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 7) : c;
}
/**
 * The close comment, composed server-side when issue_close carries a
 * summary (#365) -- the mirror of composeClaimComment. What shipped first,
 * the commit range as short refs on its own line, then the standard
 * evidence + measured block, then the agent-cost line when the cost log has
 * spend for this issue (never a zero line: no rows means no line). No time
 * spent of the agent's own: the measured line is the duration.
 */
export function composeCloseComment(c) {
    const cost = c.costUsd > 0 ? [`agent cost: ~$${c.costUsd.toFixed(2)} (approximate)`] : [];
    return [
        c.summary.trim(),
        `Commits: ${shortRef(c.baseCommit)}..${shortRef(c.headCommit)}`,
        [closeEvidenceText(c.measured, c.evidence), ...cost].join("\n"),
    ].join("\n\n");
}
