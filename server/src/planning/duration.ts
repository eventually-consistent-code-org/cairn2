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
// A usage-limit wait inside the span (#380) is dead time, not work: the
// pause recorder (the notification-pause hook, #379) appends one row per
// platform event to the machine's pauses log, and the first two rungs read
// it back and subtract the windows that fall inside [claim, close], saying
// how much came off. No log, no window in the span, or a malformed row
// leaves the number byte-identical to the plain span (asserted:
// measured-duration.test.ts, close-receipt.test.ts).
//
// Every function here returns a value instead of throwing: a measurement
// that can fail a close is worse than no measurement.
//
// removeWhen: the harness hands the model trustworthy wall-clock stamps per
// turn and self-reports land within measured error across a milestone --
// and even then this is cheaper, so expect it to stay (ADR 0020).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IssueComment } from "../tracker/types.js";
import type { Measured } from "./close-receipt.js";
import { projectKey } from "./run-manifest.js";

const NONE: Measured = { minutes: null, source: "none" };

/** Whole minutes from start to end; null when either stamp is unparseable
 *  or the span runs backwards (clock skew, a stamp from another claim). */
function spanMinutes(start: string, end: string): number | null {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 60_000);
}

/** The opening every claim comment carries -- the one phrase rung one keys
 *  on. Composed here and parsed here (#343); no verb file spells it. */
const CLAIM_OPENING = "Starting now.";

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
export type ResolvedClaim = ClaimInput & { baseCommit: string };

/**
 * HEAD of the project's repository, or null when git cannot answer (no
 * repository, no commits yet, no git on PATH). Null rather than a throw,
 * like every function here; the caller decides whether a missing base is
 * an error (a claim with nothing to measure the ledger from is) or a
 * shrug (a stamp that simply carries no commit).
 */
export function headCommit(projectDir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The claim comment, composed server-side so its first line is always the
 * one `isClaimComment` recognises. The verify command is quoted back before
 * the work so the bar is visible up front, not negotiated after; the base
 * commit sits on its own line as a short ref. Composed here, screened in
 * index.ts (screenComment, #374) before it is posted: a verify line that
 * names a planning-dir file reaches the tracker as a placeholder, never
 * as written.
 */
export function composeClaimComment(c: ResolvedClaim): string {
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
export function isClaimComment(text: string): boolean {
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
export function claimCommentTime(comments: IssueComment[]): string | null {
  const stamps = comments
    .filter((c) => c.at && isClaimComment(c.text))
    .map((c) => c.at!)
    .filter((at) => !Number.isNaN(Date.parse(at)))
    .sort((x, y) => Date.parse(x) - Date.parse(y));
  return stamps[0] ?? null;
}

// Usage-limit pauses (#380)

/** One row of the pauses log, reduced to what the windows need. The hook
 *  writes `kind` (paused | resumed | stale | stopped | needs_input),
 *  `observedAt` from its own clock and the `session_id`; anything else on
 *  the row is the comment's business, not the measurement's. */
interface PauseRow { kind: string; at: number; session: string }

/**
 * `<cairn home>/pauses/<projectKey>.jsonl` -- the hook-side pausesPath's
 * twin. Per repository, not per worktree: a batch run spans worktrees and
 * the limit that stalls it stalls the run. The server reads the home as
 * `~/.cairn` like every other repository-state path here; `home` is the
 * test seam.
 */
export function pausesPath(projectDir: string, home: string = join(homedir(), ".cairn")): string {
  return join(home, "pauses", `${projectKey(projectDir)}.jsonl`);
}

/** The rows that parse, oldest first. A torn last line, a non-object, a row
 *  with no readable kind or stamp: skipped, never fatal. */
function parsePauseRows(raw: string): PauseRow[] {
  const rows: PauseRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Record<string, unknown> | null;
      if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.kind !== "string") continue;
      const at = typeof v.observedAt === "string" ? Date.parse(v.observedAt) : NaN;
      if (Number.isNaN(at)) continue;
      rows.push({ kind: v.kind, at, session: typeof v.session_id === "string" ? v.session_id : "" });
    } catch {
      // malformed row -- the next one may still be fine
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

/**
 * The pause windows the rows describe, as epoch-ms [from, to] pairs, one
 * open window per session at a time. A `paused` row (the platform's
 * rate_limit stop) opens a window; a `stale` or `stopped` row (the
 * auto-resume went stale across a sleep, or was disabled) opens one too when
 * none is open, since the wait is on either way. The window closes at the
 * session's next recorded event -- `resumed` (quota_auto_resume_fired) in
 * the ordinary case, and otherwise whatever row that session writes next,
 * which is the first proof it took a turn again -- or at `closeAt` when
 * nothing closed it by then. Rows of other sessions never close a window:
 * one worker's resume says nothing about another's wait. needs_input rows
 * (an agent stopped for a human) are not pauses and are left alone.
 */
function pauseWindows(rows: PauseRow[], closeAt: number): Array<[number, number]> {
  const windows: Array<[number, number]> = [];
  const open = new Map<string, number>();
  for (const r of rows) {
    const from = open.get(r.session);
    if (from !== undefined && r.kind !== "needs_input") {
      windows.push([from, r.at]);
      open.delete(r.session);
    }
    if (r.kind === "paused" || r.kind === "stale" || r.kind === "stopped") open.set(r.session, r.at);
  }
  for (const from of open.values()) windows.push([from, closeAt]);
  return windows;
}

/** Whole minutes of `windows` that fall inside [from, to], overlaps merged
 *  so a limit that stalls three sessions at once is one wait, not three. */
function clippedMinutes(windows: Array<[number, number]>, from: number, to: number): number {
  const inside = windows
    .map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const w of inside) {
    if (cur && w[0] <= cur[1]) {
      cur[1] = Math.max(cur[1], w[1]);
    } else {
      if (cur) total += cur[1] - cur[0];
      cur = [w[0], w[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / 60_000);
}

/**
 * Minutes of usage-limit wait inside [claimAt, closeAt] according to one
 * pauses log's text. Zero for an empty log, an unparseable or reversed
 * span, or windows that all fall outside it -- never a throw.
 */
export function pausedMinutesFromLog(raw: string, claimAt: string, closeAt: string): number {
  const a = Date.parse(claimAt);
  const b = Date.parse(closeAt);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return clippedMinutes(pauseWindows(parsePauseRows(raw), b), a, b);
}

/** The same, read from the project's pauses log; a missing or unreadable
 *  log is zero minutes, which is exactly what no recorded pause means. */
export function pausedMinutesIn(projectDir: string, claimAt: string, closeAt: string,
  home?: string): number {
  let raw: string;
  try {
    raw = readFileSync(pausesPath(projectDir, home), "utf8");
  } catch {
    return 0;
  }
  try {
    return pausedMinutesFromLog(raw, claimAt, closeAt);
  } catch {
    return 0;
  }
}

/** Where to find the pauses log when the close wants the wait subtracted;
 *  `home` is the test seam, absent in production. */
export interface PauseSource { projectDir: string; home?: string }

/** The measurement with the wait taken off: `pausedMinutes` rides beside the
 *  number ONLY when there was a pause, so a close with none is byte-identical
 *  to today's. Floors at zero -- a wait longer than the span is a clock
 *  story, not negative work. */
function lessPauses(m: Measured, claimedAt: string, closedAt: string,
  pauses: PauseSource | undefined): Measured {
  if (!pauses || m.minutes === null) return m;
  const paused = pausedMinutesIn(pauses.projectDir, claimedAt, closedAt, pauses.home);
  return paused > 0
    ? { ...m, minutes: Math.max(0, m.minutes - paused), pausedMinutes: paused }
    : m;
}

/**
 * Rungs one and two, at close. `comments` is undefined on backends that
 * cannot enumerate them (GitHub today) -- that is not a failure, the ladder
 * simply starts one rung down. With `pauses` the usage-limit wait inside
 * the span is subtracted (#380); without it the span stands as measured.
 */
export function measureAtClose(input: {
  comments?: IssueComment[];
  observedClaimAt: string | null;
  closedAt: string;
  pauses?: PauseSource;
}): Measured & { claimedAt: string | null } {
  const fromComment = input.comments ? claimCommentTime(input.comments) : null;
  if (fromComment) {
    const m = spanMinutes(fromComment, input.closedAt);
    if (m !== null) {
      const measured: Measured = { minutes: m, source: "claim_comment" };
      return { ...lessPauses(measured, fromComment, input.closedAt, input.pauses), claimedAt: fromComment };
    }
  }
  if (input.observedClaimAt) {
    const m = spanMinutes(input.observedClaimAt, input.closedAt);
    if (m !== null) {
      const measured: Measured = { minutes: m, source: "observed_claim" };
      return {
        ...lessPauses(measured, input.observedClaimAt, input.closedAt, input.pauses),
        claimedAt: input.observedClaimAt,
      };
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
export function gitSpan(projectDir: string, base: string, head: string): Measured {
  try {
    const out = execFileSync("git",
      ["-C", projectDir, "log", "--reverse", "--format=%aI%x09%cI", `${base}..${head}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!out) return NONE;
    const rows = out.split("\n").map((l) => l.split("\t"));
    const first = rows[0][0];
    const last = rows[rows.length - 1][1];
    const m = first && last ? spanMinutes(first, last) : null;
    return m === null ? NONE : { minutes: m, source: "git_span" };
  } catch {
    return NONE;
  }
}

const RUNG_TEXT: Record<Exclude<Measured["source"], "none">, string> = {
  claim_comment: "claim comment to close",
  observed_claim: "claim the server saw to close",
  git_span: "first to last commit",
};

/** `5h 10m`, `2h`, `3m` -- minutes as a reader says them. */
function hoursMinutes(n: number): string {
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The close comment's line: the number, always with where it came from,
 *  and the wait it no longer includes when there was one (#380). */
export function measuredText(m: Measured): string {
  if (m.minutes === null || m.source === "none") {
    return "measured: not derivable at close (the ledger append takes it from the commit range)";
  }
  const paused = m.pausedMinutes
    ? `, ${hoursMinutes(m.pausedMinutes)} paused on a usage limit (subtracted)` : "";
  return `measured: ~${m.minutes}m (${RUNG_TEXT[m.source]})${paused}`;
}

/**
 * The evidence + measured block every close posts (phase 23, #232): one
 * standard line per fact, the same shape on every backend. A close with no
 * evidence posts the measured line alone.
 */
export function closeEvidenceText(
  measured: Measured, evidence?: { command: string; result: string },
): string {
  const line = measuredText(measured);
  return evidence
    ? `evidence: \`${evidence.command.trim()}\` → ${evidence.result.trim()}\n${line}`
    : line;
}

/** A sha as the short ref a reader scans for; anything else as given. */
function shortRef(commit: string): string {
  const c = commit.trim();
  return /^[0-9a-f]{7,40}$/i.test(c) ? c.slice(0, 7) : c;
}

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
export function composeCloseComment(c: {
  summary: string;
  baseCommit: string;
  headCommit: string;
  evidence: { command: string; result: string };
  measured: Measured;
  costUsd: number;
}): string {
  const cost = c.costUsd > 0 ? [`agent cost: ~$${c.costUsd.toFixed(2)} (approximate)`] : [];
  return [
    c.summary.trim(),
    `Commits: ${shortRef(c.baseCommit)}..${shortRef(c.headCommit)}`,
    [closeEvidenceText(c.measured, c.evidence), ...cost].join("\n"),
  ].join("\n\n");
}
