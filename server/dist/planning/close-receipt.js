// Close receipt (#233): the bridge between the two tools that each hold half
// of a closed task's record. issue_close has the tracker facts (the estimate
// as stored, the claim and close times, the claimed minutes, the worklog
// outcome) but no commit range; ledger_append has the range but would need
// a network read to recover the tracker side. The close writes a small
// ephemeral file keyed by issue id; the append consumes it and deletes it.
//
// Two rules matter more than the mechanism, and both live here:
//   - every read and write is best-effort and NEVER throws -- instrumentation
//     that can block a close is worse than no instrumentation;
//   - a missing or unreadable receipt is reported as a named `degraded`
//     marker, never as silent nulls, so no later reader has to guess whether
//     a null means zero or unknown.
//
// removeWhen: the durable per-task outcome record lands and the close and
// the ledger append both write into it directly (ADR 0021).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Receipts live in local state, never in git: the directory ignores itself,
 *  so this holds in any repo whether or not its .gitignore knows about it. */
export function receiptsDir(projectDir) {
    return join(projectDir, ".cairn", "state", "receipts");
}
// Issue ids come from eight backends ("PROJ-12", "#233", "a1b2c"); keep the
// filename to a safe alphabet so no id can reach outside the folder. A
// leading "#" is dropped first: the close and the append name the same
// issue as "233" and "#233" often enough that the two must meet.
function idKey(issueId) {
    return issueId.trim().replace(/^#/, "");
}
function receiptPath(projectDir, issueId, kind = "close") {
    const safe = idKey(issueId).replace(/[^A-Za-z0-9._-]/g, "_");
    return join(receiptsDir(projectDir), `${safe}.${kind}.json`);
}
function ensureDir(projectDir) {
    const d = receiptsDir(projectDir);
    mkdirSync(d, { recursive: true });
    const ignore = join(d, ".gitignore");
    if (!existsSync(ignore))
        writeFileSync(ignore, "*\n");
}
/** Writes the receipt. Returns false instead of throwing on any failure --
 *  the close has already happened and must report success regardless. */
export function writeReceipt(projectDir, receipt) {
    try {
        ensureDir(projectDir);
        writeFileSync(receiptPath(projectDir, receipt.issueId), JSON.stringify(receipt, null, 2) + "\n");
        return true;
    }
    catch {
        return false;
    }
}
function isReceipt(v, issueId) {
    if (!v || typeof v !== "object")
        return false;
    const r = v;
    return r.version === 1
        && typeof r.issueId === "string" && idKey(r.issueId) === idKey(issueId)
        && typeof r.closedAt === "string"
        && typeof r.estimate === "object" && r.estimate !== null
        && typeof r.worklog === "string";
}
/**
 * Rung two's evidence: the moment this server moved the issue to in
 * progress, with the base commit beside it when the claim named one. The
 * FIRST claim wins -- a re-claim after a parked stretch is still the same
 * piece of work, and cycle time (and the commit range) run from its start.
 * Never throws; a claim must not fail because instrumentation could not
 * write.
 */
export function recordClaim(projectDir, issueId, at, baseCommit) {
    try {
        ensureDir(projectDir);
        const path = receiptPath(projectDir, issueId, "claim");
        if (existsSync(path))
            return true;
        const record = { issueId, at, ...(baseCommit ? { baseCommit } : {}) };
        writeFileSync(path, JSON.stringify(record) + "\n");
        return true;
    }
    catch {
        return false;
    }
}
/** The whole claim stamp, without consuming it; null when absent or
 *  unreadable. Tolerant of the older two-field shape: a stamp with no
 *  baseCommit still parses, it just carries none. */
export function readClaimRecord(projectDir, issueId) {
    try {
        const raw = readFileSync(receiptPath(projectDir, issueId, "claim"), "utf8");
        const r = JSON.parse(raw);
        const at = r.at;
        if (typeof at !== "string" || Number.isNaN(Date.parse(at)))
            return null;
        const baseCommit = typeof r.baseCommit === "string" && r.baseCommit ? r.baseCommit : undefined;
        return {
            issueId: typeof r.issueId === "string" ? r.issueId : issueId,
            at,
            ...(baseCommit ? { baseCommit } : {}),
        };
    }
    catch {
        return null;
    }
}
/** The claim stamp's time alone, without consuming it; null when absent or
 *  unreadable. The close reads it BEFORE closing and clears it only once
 *  the close succeeded -- a close that throws must leave the clock where
 *  it was. */
export function readClaim(projectDir, issueId) {
    return readClaimRecord(projectDir, issueId)?.at ?? null;
}
export function clearClaim(projectDir, issueId) {
    try {
        unlinkSync(receiptPath(projectDir, issueId, "claim"));
    }
    catch { /* absent is fine */ }
}
function minutes(n) {
    return n === null ? "none" : `${n}m`;
}
// `wall=12m:claim_comment` -- the number never travels without its rung.
function wallField(w) {
    return w.minutes === null || w.source === "none"
        ? "wall=none" : `wall=${w.minutes}m:${w.source}`;
}
function estimateField(e) {
    const parts = [];
    if (e.points !== null)
        parts.push(`${e.points}pt:${e.pointsSource}`);
    if (e.minutes !== null)
        parts.push(`${e.minutes}m:${e.minutesSource}`);
    return parts.length ? parts.join(",") : "none";
}
/**
 * The ledger line's `actuals` segment, placed before `<issueId> closed` like
 * the tdd and evidence segments. Space-separated key=value pairs so a later
 * reader can split it without knowing every key; never an em dash, which is
 * the line's field separator. A receipt-less append still gets the segment,
 * carrying only its degraded marker -- absence is stated, not implied.
 */
export function actualsSegment(from) {
    if ("degraded" in from) {
        return `actuals ${wallField(from.wall)} degraded=${from.degraded} — `;
    }
    const r = from.receipt;
    return `actuals ${wallField(from.wall)} claimed=${minutes(r.claimedMinutes)} `
        + `est=${estimateField(r.estimate)} worklog=${r.worklog} — `;
}
/**
 * Reads and deletes the receipt for one issue. Exactly one of `receipt` /
 * `degraded` is set. An unreadable file is deleted too -- a corrupt receipt
 * left behind would degrade every later append for the same id the same way.
 */
export function takeReceipt(projectDir, issueId) {
    const path = receiptPath(projectDir, issueId);
    let raw;
    try {
        if (!existsSync(path))
            return { degraded: "no_receipt" };
        raw = readFileSync(path, "utf8");
    }
    catch {
        return { degraded: "receipt_unreadable" };
    }
    try {
        unlinkSync(path);
    }
    catch { /* a stale file is a smaller harm than a failed append */ }
    try {
        const parsed = JSON.parse(raw);
        return isReceipt(parsed, issueId)
            ? { receipt: parsed }
            : { degraded: "receipt_unreadable" };
    }
    catch {
        return { degraded: "receipt_unreadable" };
    }
}
