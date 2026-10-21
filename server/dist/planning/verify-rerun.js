// Purpose: the close-time re-run of a task's declared verify (#357). A
//   worker closes on `evidence { command, result }` it ran and narrated
//   itself; with `verify.rerun` on, the server runs the owner-authored
//   PLAN.md `verify:` line once more and records what it observed beside
//   what was claimed. Reported, never refused (ADR 0017).
// Author(s): John Reed
//
// The trust boundary, stated once: the server runs ONLY the declared line
// read out of a git-tracked PLAN.md, never the worker-supplied string, and
// never a declared line that differs from the one at the claim's base
// commit. Server-side execution bypasses every PreToolUse hook, so the
// tracked plan file is the whole of the trust; an untracked plan has no
// provenance and is reported, not run.
//
// removeWhen: never for the observation itself -- a side effect the server
// saw is the only evidence a self-graded close cannot narrate around.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { loadConfig } from "../config.js";
import { plansRoot } from "./artifacts.js";
import { declaredVerifyIn, isPlainShellLine } from "./check.js";
import { readClaimRecord } from "./close-receipt.js";
// Constants
/** Lines of combined output kept as the observed tail. */
export const TAIL_LINES = 20;
/** Bytes read off the end of the output file -- enough for any 20 lines a test runner prints. */
const TAIL_BYTES = 64 * 1024;
/**
 * The `verify` block of cairn.json, fail-open: a missing or invalid config
 * reads as rerun off, because a config error is reported by the tools that
 * own config, and the close must never be the one to trip over it.
 *
 * :param projectDir: project root holding cairn.json
 * :returns the rerun switch and its timeout
 */
export function rerunSettings(projectDir) {
    try {
        const { verify } = loadConfig(projectDir);
        return { rerun: verify.rerun, timeoutSeconds: verify.timeoutSeconds };
    }
    catch {
        return { rerun: false, timeoutSeconds: 600 };
    }
}
function git(projectDir, args) {
    return execFileSync("git", ["-C", projectDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}
// A ref that starts with "-" would read as an option; anything outside a
// commit-ish alphabet is not a ref the claim could have recorded.
const SAFE_REF = /^[0-9A-Za-z][0-9A-Za-z._/~^-]*$/;
/**
 * Whether the declared line has the provenance the server needs before it
 * runs it: PLAN.md is tracked, and the task's declared line at the claim's
 * base commit is the same line the plan declares now. Content comparison
 * at the base commit is the precise form of "`git log -S` since planning":
 * it catches a committed edit after the base AND an uncommitted one in the
 * working tree, which `log -S` cannot see.
 *
 * :returns null when the line may run, or the named skip reason
 */
function provenance(projectDir, planPath, issueId, declared, baseRef) {
    const rel = `./${relative(projectDir, planPath).split(sep).join("/")}`;
    try {
        git(projectDir, ["ls-files", "--error-unmatch", "--", rel]);
    }
    catch {
        return { skipped: "plan-untracked" };
    }
    if (!SAFE_REF.test(baseRef))
        return { skipped: "base-unreadable", detail: `base '${baseRef}' is not a commit ref` };
    let then;
    try {
        then = git(projectDir, ["show", `${baseRef}:${rel}`]);
    }
    catch {
        return { skipped: "base-unreadable", detail: `PLAN.md does not exist at ${baseRef.slice(0, 12)}` };
    }
    const was = declaredVerifyIn(then.split("\n"), issueId);
    if (was !== declared) {
        return {
            skipped: "declared-changed",
            detail: was === null
                ? `the task declared no verify at ${baseRef.slice(0, 12)}`
                : `the declared line at ${baseRef.slice(0, 12)} was: ${was}`,
        };
    }
    return null;
}
// The last TAIL_LINES lines of a file, trailing whitespace stripped and
// nothing else -- the tail is evidence.
function tailOf(fd) {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}
/**
 * Run the declared line in the project root and capture what happened.
 * stdout and stderr share ONE file descriptor, so the tail interleaves the
 * way a terminal would have shown it, and no output size can overflow a
 * pipe buffer. Never throws: the server's own failure is a named skip.
 *
 * :param projectDir: cwd for the run
 * :param command: the declared line, verbatim
 * :param timeoutSeconds: hard stop; the run is killed and reads "timeout"
 * :returns the observation
 */
export function runDeclared(projectDir, command, timeoutSeconds, now = () => new Date()) {
    // pid + random suffix: two closes on one machine never share a file.
    const outPath = join(tmpdir(), `cairn-rerun-${process.pid}-${randomBytes(6).toString("hex")}.log`);
    let fd;
    try {
        fd = openSync(outPath, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_TRUNC, 0o600);
        const r = spawnSync(command, {
            cwd: projectDir, shell: true, stdio: ["ignore", fd, fd],
            timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", env: process.env,
        });
        const err = r.error;
        const timedOut = err?.code === "ETIMEDOUT";
        if (err && !timedOut)
            return { skipped: "spawn-failed", detail: err.message };
        const exit = timedOut ? "timeout"
            : r.status !== null ? r.status
                : 128 + (osConstants.signals[r.signal] ?? 0);
        return { exit, tail: tailOf(fd), at: now().toISOString(), command };
    }
    catch (e) {
        return { skipped: "spawn-failed", detail: e instanceof Error ? e.message : String(e) };
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* already closed */ }
        }
        try {
            unlinkSync(outPath);
        }
        catch { /* never created */ }
    }
}
/**
 * The close-time observation for one close-kind ledger append, or null
 * when rerun is off (nothing recorded, the line byte-identical to before).
 * Every way of NOT running is a named skip, checked in this order:
 * evidence waived, no declared verify, the evidence command differs from
 * the declaration (character for character), the declaration is not a
 * plain shell line, PLAN.md is untracked, the declared line changed since
 * the claim's base. Only then does the declared line run.
 *
 * :param o.declared: the task's declared verify, already read off PLAN.md
 * :param o.baseCommit: the ledger line's base; the claim stamp's base wins when it is still on disk
 * :returns the observation, or null when rerun is off
 */
export function observeDeclaredVerify(o) {
    const settings = o.settings ?? rerunSettings(o.projectDir);
    if (!settings.rerun)
        return null;
    if (!o.evidence)
        return { skipped: "evidence-waived" };
    if (o.declared === null)
        return { skipped: "no-declared-verify" };
    // The worker's string is compared, never executed: what runs below is
    // `declared`, read off the plan by the server.
    if (o.evidence.command !== o.declared)
        return { skipped: "command-differs" };
    if (!isPlainShellLine(o.declared))
        return { skipped: "not-plain-shell" };
    const planPath = join(plansRoot(o.projectDir), "phases", o.phaseDir, "PLAN.md");
    const baseRef = readClaimRecord(o.projectDir, o.issueId)?.baseCommit ?? o.baseCommit.trim();
    const refused = provenance(o.projectDir, planPath, o.issueId, o.declared, baseRef);
    if (refused)
        return refused;
    return runDeclared(o.projectDir, o.declared, settings.timeoutSeconds, o.now);
}
