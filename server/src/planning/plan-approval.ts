// Purpose: the owner-approval stamp on a phase's PLAN.md (#423). A human
//   act -- the plan verb's final confirmation, or `plan_meta_set` with
//   `approve: true` -- records the plan exactly as it read at that moment:
//   the git blob of the file, when, and the git identity of the checkout
//   that approved it. The close-time re-run (verify-rerun.ts) compares a
//   task's declared `verify:` line against THIS blob and nothing else: the
//   claim's base commit stopped being provenance when it turned out the
//   claim is the agent's own act (ADR 0017, amendment 2026-11-03).
// Author(s): John Reed
//
// Two rules, same as the close receipt next door: every read is best-effort
// and NEVER throws (an unreadable stamp reads as no approval, which fails
// closed -- the line does not run), and the stamp lives in local state,
// never in git. Whoever can commit PLAN.md must not be able to commit its
// approval alongside; a stamp that travelled with the plan would prove
// nothing. The blob is written into the object store (`hash-object -w`) so
// the approved text stays readable even when the working tree moves on;
// an uncommitted plan's blob can be pruned by a later gc, and then the
// stamp reads `approval-unreadable`, which also fails closed.
//
// removeWhen: the plan file carries a signed approval of its own that the
// server can check without local state -- not on any roadmap.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";

// Constants
/** A git object id: sha1 today, sha256 on a repository that chose it. */
const BLOB_SHAPE = /^[0-9a-f]{40,64}$/;

/** The stamp as written: `by` is the checkout's git identity -- a record of
 *  whose checkout approved, not an authentication. */
export interface PlanApproval {
  version: 1;
  phaseDir: string;
  /** The blob of PLAN.md exactly as approved; `git cat-file -p` reads it back. */
  blob: string;
  at: string;
  by: string;
}

/** Stamps live beside the receipts in local state, never in git: the
 *  directory ignores itself, whatever the project's .gitignore knows. */
export function approvalsDir(projectDir: string): string {
  return join(projectDir, ".cairn", "state", "approvals");
}

// A phase dir is "01-core" or "01.5-core"; keep the filename to a safe
// alphabet so no name can reach outside the folder.
function approvalPath(projectDir: string, phaseDir: string): string {
  return join(approvalsDir(projectDir), `${phaseDir.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function git(projectDir: string, args: string[]): string {
  return execFileSync("git", ["-C", projectDir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
}

// Who approved: the checkout's git identity, then the login, then a
// stated unknown -- never an empty field.
function approver(projectDir: string): string {
  const read = (key: string): string => { try { return git(projectDir, ["config", key]); } catch { return ""; } };
  const name = read("user.name");
  const email = read("user.email");
  if (name && email) return `${name} <${email}>`;
  return name || email || process.env.USER || process.env.LOGNAME || "unknown";
}

/**
 * Records the owner's approval of a phase's PLAN.md as it reads right now.
 * The latest approval wins -- a re-approval after an edit is a new human
 * act and replaces the stamp. Throws a typed error when there is nothing
 * to approve (no PLAN.md) or no git to hold the blob; the caller is a tool
 * handler and renders it.
 *
 * :param projectDir: project root
 * :param phaseDir: the phase directory name ("01-core")
 * :returns the stamp as written
 */
export function approvePlan(projectDir: string, phaseDir: string,
  now: () => Date = () => new Date()): PlanApproval {
  const plan = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(plan)) {
    throw new CairnError("NOT_FOUND", `no PLAN.md at phaseDir '${phaseDir}' — nothing to approve`);
  }
  let blob: string;
  try {
    blob = git(projectDir, ["hash-object", "-w", "--", plan]);
  } catch {
    throw new CairnError("CONFIG_INVALID",
      "the project is not a git repository, so the approved plan has nowhere to live — init git first");
  }
  if (!BLOB_SHAPE.test(blob)) {
    throw new CairnError("CONFIG_INVALID", `git returned no blob id for ${phaseDir}/PLAN.md`);
  }
  const stamp: PlanApproval = { version: 1, phaseDir, blob, at: now().toISOString(), by: approver(projectDir) };
  const d = approvalsDir(projectDir);
  mkdirSync(d, { recursive: true });
  const ignore = join(d, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  writeFileSync(approvalPath(projectDir, phaseDir), JSON.stringify(stamp, null, 2) + "\n");
  return stamp;
}

/**
 * The approval stamp for a phase, or null when there is none or it is not
 * a stamp. Never throws: a corrupt file is the same as no approval, and
 * the re-run fails closed on either.
 */
export function readPlanApproval(projectDir: string, phaseDir: string): PlanApproval | null {
  try {
    const r = JSON.parse(readFileSync(approvalPath(projectDir, phaseDir), "utf8")) as Record<string, unknown>;
    if (r.version !== 1 || typeof r.blob !== "string" || !BLOB_SHAPE.test(r.blob)) return null;
    if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
    return {
      version: 1,
      phaseDir: typeof r.phaseDir === "string" ? r.phaseDir : phaseDir,
      blob: r.blob,
      at: r.at,
      by: typeof r.by === "string" && r.by ? r.by : "unknown",
    };
  } catch {
    return null;
  }
}
