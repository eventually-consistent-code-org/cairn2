import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { readRoadmapMeta, patchRoadmapMeta } from "./milestones.js";

export interface OutOfBandCommit { sha: string; subject: string; files: string[] }
export interface ResyncReport {
  outOfBand: OutOfBandCommit[]; sinceSha: string | null;
  headSha: string; initialized?: boolean;
}

// Matches ledger.ts formatEntry: "… — commits abc1234..def5678 — …"
const RANGE_RE = /commits ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})/;

function git(projectDir: string, args: string[]): string {
  try {
    return execFileSync("git", args,
      { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    throw new CairnError("PRECONDITION_FAILED", `git ${args[0]} failed: ${e}`,
      "plan_resync needs a git repository with at least one commit");
  }
}

/** What the working tree looked like when something was recorded (#195). */
export interface RevisionStamp {
  /** Full HEAD sha at capture time. */
  commit: string;
  /** True when tracked files carried uncommitted changes — the recorded
   *  judgment covered content HEAD does not have. Untracked files are
   *  ignored on purpose (scratch files are common, and .cairn/ itself is
   *  usually untracked). */
  dirty: boolean;
}

/**
 * Captures HEAD + dirty flag for a record writer — server-side, at write
 * time, never model-asserted. Returns null outside a git repo or before
 * the first commit, so writers that never needed git keep working
 * (audit records in a bare temp dir, say) and simply carry no stamp.
 *
 * :param projectDir: repository root
 * :returns: the stamp, or null when git can't answer
 */
export function revisionStamp(projectDir: string): RevisionStamp | null {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return null;
  }
}

/**
 * Paths whose edits never move what an audit examined: readmes and release
 * notes at any depth, plus the root license (#279). Agent instruction files
 * (CLAUDE.md, harness/, skills/, commands/, templates/) are deliberately NOT
 * here — they steer behavior, so they count as code.
 */
const NON_CODE_PATHSPECS = [
  ":(exclude,glob)**/README.md",
  ":(exclude,glob)**/CHANGELOG.md",
  ":(exclude)LICENSE",
];

/**
 * Counts commits reachable from HEAD but not from `commit` that touch any
 * path outside `excludeDir` and the non-code prose above — "how much code
 * moved since this stamp". Null when git can't resolve the range (commit
 * rebased away, gc'd, or not a repo): the caller decides whether
 * unknowable means stale.
 *
 * :param projectDir: repository root
 * :param commit: the stamp's commit
 * :param excludeDir: top-level directory whose changes don't count (docs)
 * :returns: commit count, or null when unknowable
 */
export function codeCommitsSince(
  projectDir: string, commit: string, excludeDir = "docs",
): number | null {
  try {
    const raw = execFileSync("git",
      ["rev-list", "--count", `${commit}..HEAD`, "--", ".", `:(exclude)${excludeDir}`,
        ...NON_CODE_PATHSPECS],
      { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number.parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

function ledgerRanges(projectDir: string): Array<{ base: string; head: string }> {
  const phasesDir = join(plansRoot(projectDir), "phases");
  const ranges: Array<{ base: string; head: string }> = [];
  if (!existsSync(phasesDir)) return ranges;
  for (const entry of readdirSync(phasesDir)) {
    const ledger = join(phasesDir, entry, "LEDGER.md");
    if (!existsSync(ledger)) continue;
    for (const line of readFileSync(ledger, "utf8").split("\n")) {
      const m = RANGE_RE.exec(line);
      if (m) ranges.push({ base: m[1], head: m[2] });
    }
  }
  return ranges;
}

export function resyncReport(projectDir: string): ResyncReport {
  const headSha = git(projectDir, ["rev-parse", "HEAD"]).trim();
  const meta = readRoadmapMeta(projectDir);
  if (!meta.lastResync) {
    // First run: initialize, never scan unbounded history.
    patchRoadmapMeta(projectDir, { lastResync: headSha });
    return { outOfBand: [], sinceSha: null, headSha, initialized: true };
  }

  const covered = new Set<string>();
  for (const r of ledgerRanges(projectDir)) {
    try {
      for (const sha of git(projectDir, ["rev-list", `${r.base}..${r.head}`])
        .split("\n").map((s) => s.trim()).filter(Boolean)) covered.add(sha);
    } catch {
      // range refers to unknown shas (rebased/gc'd) — skip it, stay honest elsewhere
    }
  }

  // \x1e separates commit records, \x1f separates sha from subject;
  // --name-only lists touched files after each record.
  const raw = git(projectDir, ["log", "--no-merges", "--format=%x1e%H%x1f%s",
    "--name-only", `${meta.lastResync}..HEAD`]);
  const outOfBand: OutOfBandCommit[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [sha, subject] = lines[0].split("\x1f");
    if (covered.has(sha)) continue;
    outOfBand.push({
      sha, subject: subject ?? "",
      files: lines.slice(1).map((l) => l.trim()).filter(Boolean),
    });
  }

  patchRoadmapMeta(projectDir, { lastResync: headSha });
  return { outOfBand, sinceSha: meta.lastResync, headSha };
}
