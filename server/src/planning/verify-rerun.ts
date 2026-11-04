// Purpose: the close-time re-run of a task's declared verify (#357). A
//   worker closes on `evidence { command, result }` it ran and narrated
//   itself; with `verify.rerun` on, the server runs the owner-authored
//   PLAN.md `verify:` line once more and records what it observed beside
//   what was claimed. Reported, never refused (ADR 0017).
// Author(s): John Reed
//
// The trust boundary, stated once: the server runs ONLY the declared line
// read out of a git-tracked PLAN.md, never the worker-supplied string, and
// only a declared line that is the same as the one in the plan the OWNER
// approved (#423) -- the blob `plan_meta_set approve` stamped, read back
// out of git's object store. The claim's base commit was the provenance
// before #423 and is not any more: the claim is the agent's act, so an
// agent that committed a plan edit and then claimed passed that check.
// Server-side execution bypasses every PreToolUse hook, so the tracked
// plan file and the owner's stamp are the whole of the trust; an untracked
// plan has no provenance, an unapproved one no owner behind it, and both
// are reported, not run. The line runs with a minimal environment: the
// server's own env carries tracker tokens, and a verify line has no
// business reading them.
//
// Asserted by ledger.test.ts ("verify.rerun" block) and the folded-close
// case in measured-duration.test.ts.
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
import { type Observation } from "./close-receipt.js";
import { readPlanApproval } from "./plan-approval.js";

// Constants
/** Lines of combined output kept as the observed tail. */
export const TAIL_LINES = 20;
/** Bytes read off the end of the output file -- enough for any 20 lines a test runner prints. */
const TAIL_BYTES = 64 * 1024;

export interface RerunSettings { rerun: boolean; timeoutSeconds: number }

/**
 * The `verify` block of cairn.json, fail-open: a missing or invalid config
 * reads as rerun off, because a config error is reported by the tools that
 * own config, and the close must never be the one to trip over it.
 *
 * :param projectDir: project root holding cairn.json
 * :returns the rerun switch and its timeout
 */
export function rerunSettings(projectDir: string): RerunSettings {
  try {
    const { verify } = loadConfig(projectDir);
    return { rerun: verify.rerun, timeoutSeconds: verify.timeoutSeconds };
  } catch {
    return { rerun: false, timeoutSeconds: 600 };
  }
}

function git(projectDir: string, args: string[]): string {
  return execFileSync("git", ["-C", projectDir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}

// What the declared line may see of the server's environment: enough to
// find node, npm and a cache, and nothing that authenticates anything.
// The server holds GITHUB_TOKEN and the other tracker tokens for its own
// use; a verify line that needs a credential is not a verify line.
const ENV_ALLOWED = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL"];

/** The minimal environment the declared line runs under. */
export function minimalEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWED) if (from[k] !== undefined) env[k] = from[k];
  return env;
}

/**
 * Whether the declared line has the provenance the server needs before it
 * runs it: PLAN.md is tracked, the owner stamped an approval of it (#423),
 * the approved blob is still in git's object store, and the task's declared
 * line in that approved plan is the same line the plan declares now. A
 * content comparison against the approved text catches a committed edit
 * AND an uncommitted one in the working tree, whoever made it and however
 * long before the claim.
 *
 * :returns null when the line may run, or the named skip reason
 */
function provenance(projectDir: string, phaseDir: string, planPath: string, issueId: string,
  declared: string): Observation | null {
  const rel = `./${relative(projectDir, planPath).split(sep).join("/")}`;
  try {
    git(projectDir, ["ls-files", "--error-unmatch", "--", rel]);
  } catch {
    return { skipped: "plan-untracked" };
  }
  const approval = readPlanApproval(projectDir, phaseDir);
  if (!approval) {
    return { skipped: "plan-unapproved", detail: "no owner-approval stamp for this phase's PLAN.md (plan_meta_set approve)" };
  }
  let approved: string;
  try {
    approved = git(projectDir, ["cat-file", "-p", approval.blob]);
  } catch {
    return { skipped: "approval-unreadable", detail: `the approved plan (blob ${approval.blob.slice(0, 12)}) is not in git's object store` };
  }
  const was = declaredVerifyIn(approved.split("\n"), issueId);
  if (was !== declared) {
    return {
      skipped: "declared-changed",
      detail: was === null
        ? `the plan approved at ${approval.at} declared no verify for this task`
        : `the plan approved at ${approval.at} declared: ${was}`,
    };
  }
  return null;
}

// The last TAIL_LINES lines of a file, trailing whitespace stripped and
// nothing else -- the tail is evidence.
function tailOf(fd: number): string {
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
export function runDeclared(projectDir: string, command: string,
  timeoutSeconds: number, now: () => Date = () => new Date()): Observation {
  // pid + random suffix: two closes on one machine never share a file.
  const outPath = join(tmpdir(), `cairn-rerun-${process.pid}-${randomBytes(6).toString("hex")}.log`);
  let fd: number | undefined;
  try {
    fd = openSync(outPath, fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_TRUNC, 0o600);
    const r = spawnSync(command, {
      cwd: projectDir, shell: true, stdio: ["ignore", fd, fd],
      timeout: timeoutSeconds * 1000, killSignal: "SIGKILL", env: minimalEnv(),
    });
    const err = r.error as NodeJS.ErrnoException | undefined;
    const timedOut = err?.code === "ETIMEDOUT";
    if (err && !timedOut) return { skipped: "spawn-failed", detail: err.message };
    const exit: number | "timeout" = timedOut ? "timeout"
      : r.status !== null ? r.status
      : 128 + (osConstants.signals[r.signal as NodeJS.Signals] ?? 0);
    return { exit, tail: tailOf(fd), at: now().toISOString(), command };
  } catch (e) {
    return { skipped: "spawn-failed", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(outPath); } catch { /* never created */ }
  }
}

/**
 * The close-time observation for one close-kind ledger append, or null
 * when rerun is off (nothing recorded, the line byte-identical to before).
 * Every way of NOT running is a named skip, checked in this order:
 * evidence waived, no declared verify, the evidence command differs from
 * the declaration (character for character), the declaration is not a
 * plain shell line, PLAN.md is untracked, no owner approval is stamped on
 * it, the approved blob is unreadable, the declared line differs from the
 * approved one. Only then does the declared line run.
 *
 * :param o.declared: the task's declared verify, already read off PLAN.md
 * :returns the observation, or null when rerun is off
 */
export function observeDeclaredVerify(o: {
  projectDir: string; phaseDir: string; issueId: string;
  evidence?: { command: string }; declared: string | null;
  settings?: RerunSettings; now?: () => Date;
}): Observation | null {
  const settings = o.settings ?? rerunSettings(o.projectDir);
  if (!settings.rerun) return null;
  if (!o.evidence) return { skipped: "evidence-waived" };
  if (o.declared === null) return { skipped: "no-declared-verify" };
  // The worker's string is compared, never executed: what runs below is
  // `declared`, read off the plan by the server.
  if (o.evidence.command !== o.declared) return { skipped: "command-differs" };
  if (!isPlainShellLine(o.declared)) return { skipped: "not-plain-shell" };
  const planPath = join(plansRoot(o.projectDir), "phases", o.phaseDir, "PLAN.md");
  const refused = provenance(o.projectDir, o.phaseDir, planPath, o.issueId, o.declared);
  if (refused) return refused;
  return runDeclared(o.projectDir, o.declared, settings.timeoutSeconds, o.now);
}
