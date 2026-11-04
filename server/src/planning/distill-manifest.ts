// Purpose: per-phase distill manifest -- the scope contract for an
//   incremental `distill <N>` run. Resolves one phase (live under phases/ or
//   archived under milestones/vN), reads its PLAN.md issue list, and parses
//   its LEDGER.md lines back into structured entries so synthesis covers ONLY
//   what that phase actually changed. The line grammar here mirrors
//   ledger.ts's formatEntry exactly -- the ledger is append-only and stable,
//   so an honest parse is a safe parse. Malformed lines are skipped with a
//   note, never guessed at.
// Author(s): John Reed

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import {
  PHASE_NUMBER_ERROR, isValidPhaseNumber, parsePhaseDirName, plansRoot,
} from "./artifacts.js";
import { parsePlanDoc } from "./frontmatter.js";
import { projectStatus } from "./status.js";

export interface DistillLedgerEntry {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  closedDate: string;
}

/** An evidence-only ledger line (#256): work recorded against an issue
 *  that this line does NOT claim closed. */
export interface DistillEvidenceEntry {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  loggedDate: string;
}

export interface DistillManifest {
  /** `dir` is the phase's path relative to the plans root minus the live
   *  "phases/" prefix -- "01-core" live, "milestones/v1/01-core" archived --
   *  the same id convention docs-drift reports use. */
  phase: { number: number; name: string; dir: string; archived: boolean };
  issues: string[];
  /** Closure lines still standing -- a closure later superseded by an
   *  evidence line for the same taskRef is moved to `superseded`. */
  ledgerEntries: DistillLedgerEntry[];
  /** Evidence-only lines: never closures, in file order. */
  evidenceEntries: DistillEvidenceEntry[];
  /** Closure lines an evidence line for the same taskRef later corrected --
   *  the issue reads NOT closed. */
  superseded: DistillLedgerEntry[];
  /** Standing closures whose close-time re-run (#357) did not reproduce the
   *  claimed pass -- a non-zero exit or a timeout, with the exit observed. */
  observedMismatches: (DistillLedgerEntry & { exit: string })[];
  /** Union range the ledger lines span (closure and evidence lines alike --
   *  both landed commits): the base the other bases descend from, to the
   *  head that descends from the other heads (#445) -- never "the last
   *  line", which is a merge artifact. Null when the ledger has no parsed
   *  entries. */
  commitRange: { base: string; head: string } | null;
  /** One note per ledger line that LOOKED like an entry but didn't match the
   *  writer's grammar -- surfaced, not silently dropped. */
  skipped: string[];
}

// The exact shape ledger.ts formatEntry writes -- em dashes and all:
//   - [x] <taskRef> — <summary> — commits <base7>..<head7> — [tdd <r>..<g> — ]
//     [evidence <cmd> => <result> — | waived <reason> — ][observed <k=v ...> — ]
//     [actuals <k=v ...> — ]<issueId> closed <date>
// taskRef matches lazily (up to the first em dash) and summary GREEDILY, so
// the LAST "commits <sha>..<sha>" run from which the rest of the grammar
// still matches is the anchor, never the first (#426). The segments the
// server writes -- evidence, observed, actuals -- sit after the real anchor,
// so a summary carrying its own fake run (the writer neutralises em dashes
// there now; a line written before #426 or by hand does not) is swallowed
// whole into the summary slot and the server's observation is the one
// read. Asserted by test/distill-manifest.test.ts "the parser binds the
// LAST segment run". The evidence segment (phase 23) is optional so
// pre-gate lines keep parsing; the writer strips em dashes from evidence
// text so the segment can't swallow issueId. The actuals segment (phase
// 24.7) is optional for the same reason, and so is the observed segment
// (#357), written only when `verify.rerun` is on.
//
// An evidence line (#256) makes no closure claim: unchecked box, optional
// note segment, and an "evidence for <issueId> <date>" tail. It is matched
// FIRST -- its free-text note could otherwise satisfy the closure pattern.
const EVIDENCE_LINE_RE = new RegExp(
  "^- \\[ \\] (.+?) — (.+) — commits ([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40}) — "
  + "(?:tdd [0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40} — )?"
  + "(?:(?:evidence|waived) [^—]*? — )?(?:note [^—]*? — )?evidence for (.+?) (.+)$",
);
// The closure pattern also captures its gate segments (groups 5, 6 and 7:
// tdd, evidence, observed) so plan_check's ledger gates read the same parse
// distill does -- one grammar, one parser.
const LEDGER_LINE_RE = new RegExp(
  "^- \\[x\\] (.+?) — (.+) — commits ([0-9a-f]{7,40})\\.\\.([0-9a-f]{7,40}) — "
  + "(tdd [0-9a-f]{7,40}\\.\\.[0-9a-f]{7,40} — )?"
  + "((?:evidence|waived) [^—]*? — )?(observed [^—]*? — )?(?:actuals [^—]*? — )?(.+?) closed (.+)$",
);
// Inside an observed segment: the exit it recorded, and the mismatch marker.
const OBSERVED_EXIT_RE = /\bexit=(\S+)/;
const OBSERVED_MISMATCH_RE = /\sobserved-mismatch\s/;

interface ResolvedPhase {
  number: number; name: string; dir: string; archived: boolean; base: string;
}

// Live phases win; among archived copies (a number can recur across
// milestones) the newest vN wins -- that's the copy summit archived last.
function resolvePhase(projectDir: string, phaseNumber: number): ResolvedPhase {
  const root = plansRoot(projectDir);
  const live = projectStatus(projectDir).phases
    .find((p) => p.number === phaseNumber);
  if (live) {
    return {
      number: live.number, name: live.name, dir: live.dir, archived: false,
      base: join(root, "phases", live.dir),
    };
  }
  const msDir = join(root, "milestones");
  if (existsSync(msDir)) {
    const versions = readdirSync(msDir).filter((d) => /^v\d+$/.test(d))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    for (const v of versions) {
      for (const entry of readdirSync(join(msDir, v))) {
        const parsed = parsePhaseDirName(entry);
        if (!parsed || parsed.number !== phaseNumber) continue;
        return {
          number: parsed.number,
          name: parsed.slug.replace(/-/g, " "),
          dir: join("milestones", v, entry),
          archived: true,
          base: join(msDir, v, entry),
        };
      }
    }
  }
  throw new CairnError("NOT_FOUND",
    `no phase ${phaseNumber} under .cairn/plans/phases or .cairn/plans/milestones`,
    "run plan_status to list live phases, or check milestones/vN for archived ones");
}

// PLAN.md frontmatter issues at an arbitrary phase dir -- readPlanIssues
// hardcodes the live phases/ path, and archived plans live elsewhere.
function planIssuesAt(base: string): string[] {
  const path = join(base, "PLAN.md");
  if (!existsSync(path)) return [];
  return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
}

/**
 * A closure line as the ledger gates read it: the distill entry plus where
 * it sits and which gate segments it carries. distillManifest strips these
 * back off, so its result shape never moves.
 */
export interface ParsedClosure extends DistillLedgerEntry {
  /** 1-indexed LEDGER.md line. */
  line: number;
  /** Carries a `tdd <red>..<green>` segment. */
  tdd: boolean;
  /** Carries an `evidence <cmd> => <result>` or `waived <reason>` segment. */
  closeEvidence: boolean;
  /** The close-time re-run's exit (#357) when the line carries one ("0", "1", "timeout"). */
  observedExit?: string;
  /** Carries the literal `observed-mismatch` marker. */
  observedMismatch: boolean;
  /** Superseded closures only: the evidence line that corrected it. */
  supersededBy?: number;
}

/** An evidence-only line plus where it sits. */
export interface ParsedEvidence extends DistillEvidenceEntry { line: number }

export interface ParsedLedger {
  entries: ParsedClosure[]; evidence: ParsedEvidence[];
  superseded: ParsedClosure[]; skipped: string[];
  range: { base: string; head: string } | null;
  /** The line order this parse resolved by (#445), git answers cached, for
   *  readers that still have lines of their own to rank. */
  order: LedgerLineOrder;
}

// Which ledger line speaks last (#445)
//
// The ledger merges by union, so the order two branches' lines land in is
// the merge direction, not time. Readers that resolve "a closure and its
// fix-up for the same task" or "the range the phase spans" by file
// position give opposite answers for the two merge orders of the same two
// lines. The rule that reads the same both ways, in order:
//   1. commit ancestry -- the line whose head commit descends from the
//      other's head is later (git is asked; a sha git cannot place, no
//      repository, or no git at all, is "cannot say" and falls through);
//   2. the date written on the line (closedDate / loggedDate);
//   3. file order, last -- the single-branch case this used to be.
// Asserted by test/ledger.test.ts "closure-plus-evidence across a union
// merge reads the same answer in both directions (#445)". Fail-open: git
// trouble never fails a parse, it only loses the first step.

/** The three fields the rule reads, present on closure and evidence lines alike. */
export interface LedgerLineRef {
  headCommit: string;
  /** 1-indexed LEDGER.md line. */
  line: number;
  /** `closedDate` on a closure line, `loggedDate` on an evidence line. */
  closedDate?: string;
  loggedDate?: string;
}

const dateOf = (r: LedgerLineRef): string => r.closedDate ?? r.loggedDate ?? "";

/** Two sha spellings name one commit when one is a prefix of the other (7 vs 40 chars). */
const sameCommit = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** Steps 2 and 3 of the rule alone: the date on the line, then file order. */
const laterDated = (x: LedgerLineRef, y: LedgerLineRef): boolean =>
  dateOf(x) !== dateOf(y) ? dateOf(x) > dateOf(y) : x.line > y.line;

/** Ancestry questions for one ledger's repository, answered by git and cached per parse. */
export interface LedgerLineOrder {
  /** True when `x` speaks after `y` by the rule above. */
  later(x: LedgerLineRef, y: LedgerLineRef): boolean;
  /** The commit range the given lines span, by the same rule; null for none. */
  range(spans: LedgerSpan[]): { base: string; head: string } | null;
}

/** One ledger line's commits, with what the tie-breaks read. */
export interface LedgerSpan extends LedgerLineRef { baseCommit: string }

/**
 * Build the line order for the repository that holds `cwd` (the phase dir;
 * git discovers the repository upward, exactly as a hook run there would).
 *
 * :param cwd: the phase directory whose LEDGER.md is being read
 * :returns the rule, with git's answers cached for this parse
 */
export function ledgerLineOrder(cwd: string): LedgerLineOrder {
  // One git call: exit status and stdout, or the status git died with.
  // Anything but 0 or 1 (no repo, unknown or ambiguous sha, no git binary,
  // a timeout) reads as "cannot say" to the callers below. Every sha handed
  // in came off a line's `[0-9a-f]{7,40}` match, so none can read as an
  // option, and the subcommand names are fixed here.
  const git = (args: string[]): { status: unknown; out: string } => {
    try {
      const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", timeout: 5000 });
      return { status: 0, out };
    } catch (e) {
      return { status: (e as { status?: unknown }).status ?? null, out: "" };
    }
  };
  const cache = new Map<string, boolean | null>();
  // Is `ancestor` reachable from `descendant`? null when git cannot say.
  const isAncestor = (ancestor: string, descendant: string): boolean | null => {
    const key = `${ancestor}..${descendant}`;
    if (!cache.has(key)) {
      const { status } = git(["merge-base", "--is-ancestor", ancestor, descendant]);
      cache.set(key, status === 0 ? true : status === 1 ? false : null);
    }
    return cache.get(key)!;
  };
  const later = (x: LedgerLineRef, y: LedgerLineRef): boolean => {
    if (!sameCommit(x.headCommit, y.headCommit)) {
      if (isAncestor(y.headCommit, x.headCommit) === true) return true;
      if (isAncestor(x.headCommit, y.headCommit) === true) return false;
    }
    return laterDated(x, y);
  };
  // One git call each for the whole set: the heads no other head descends
  // from, and the commit every base descends from. Null when git cannot say.
  const gitLines = (args: string[]): string[] | null => {
    const { status, out } = git(args);
    return status === 0 ? out.split("\n").map((l) => l.trim()).filter(Boolean) : null;
  };
  const range = (spans: LedgerSpan[]): { base: string; head: string } | null => {
    if (spans.length === 0) return null;
    const heads = [...new Set(spans.map((s) => s.headCommit))];
    const bases = [...new Set(spans.map((s) => s.baseCommit))];
    // Head: among the independent tips (no ancestry between them, by git's
    // own answer -- or all spans when it cannot say), the latest-dated,
    // then the last in the file.
    const tips = heads.length > 1 ? gitLines(["merge-base", "--independent", ...heads]) : null;
    let headPool = tips ? spans.filter((s) => tips.some((t) => sameCommit(t, s.headCommit))) : spans;
    if (headPool.length === 0) headPool = spans;
    const head = headPool.reduce((w, s) => (laterDated(s, w) ? s : w));
    // Base: the one base the others descend from when there is one, else
    // the earliest-dated, then the first in the file.
    const common = bases.length > 1 ? gitLines(["merge-base", "--octopus", ...bases])?.[0] : undefined;
    let basePool = common ? spans.filter((s) => sameCommit(common, s.baseCommit)) : [];
    if (basePool.length === 0) basePool = spans;
    const base = basePool.reduce((w, s) => (laterDated(w, s) ? s : w));
    return { base: base.baseCommit, head: head.headCommit };
  };
  return { later, range };
}

/**
 * Parse one phase dir's LEDGER.md -- the one ledger reader that
 * distill_manifest and plan_check's ledger gates share.
 *
 * :param base: the phase directory (live or archived) holding LEDGER.md
 * :returns standing closures, evidence lines, superseded closures, skip
 *   notes and the union commit range -- all empty when there is no ledger
 */
export function parseLedger(base: string): ParsedLedger {
  const entries: ParsedClosure[] = [];
  const evidence: ParsedEvidence[] = [];
  const superseded: ParsedClosure[] = [];
  const skipped: string[] = [];
  const spans: LedgerSpan[] = [];
  const order = ledgerLineOrder(base);
  const path = join(base, "LEDGER.md");
  if (!existsSync(path)) return { entries, evidence, superseded, skipped, range: null, order };
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [i, line] of lines.entries()) {
    // Only list lines are candidate entries; the header and the append-only
    // comment are the file's own furniture.
    if (!line.startsWith("- ")) continue;
    const ev = EVIDENCE_LINE_RE.exec(line);
    if (ev) {
      evidence.push({
        taskRef: ev[1], summary: ev[2], baseCommit: ev[3], headCommit: ev[4],
        issueId: ev[5], loggedDate: ev[6], line: i + 1,
      });
      spans.push(evidence[evidence.length - 1]);
      continue;
    }
    const m = LEDGER_LINE_RE.exec(line);
    if (!m) {
      skipped.push(`LEDGER.md line ${i + 1} does not match the ledger entry `
        + `format -- skipped: ${line.slice(0, 120)}`);
      continue;
    }
    const observedExit = m[7] === undefined ? undefined : OBSERVED_EXIT_RE.exec(m[7])?.[1];
    entries.push({
      taskRef: m[1], summary: m[2], baseCommit: m[3], headCommit: m[4],
      issueId: m[8], closedDate: m[9],
      line: i + 1, tdd: m[5] !== undefined, closeEvidence: m[6] !== undefined,
      ...(observedExit !== undefined ? { observedExit } : {}),
      observedMismatch: m[7] !== undefined && OBSERVED_MISMATCH_RE.test(m[7]),
    });
    spans.push(entries[entries.length - 1]);
  }
  // A closure for a task was wrong when an evidence line for the SAME task
  // speaks after it (by the rule, not by position): the evidence line is the
  // correction, so that closure stops standing. A closure that speaks after
  // every such evidence line is a real later close and stays. Git is only
  // asked when a task carries both kinds of line.
  for (let j = entries.length - 1; j >= 0; j--) {
    const c = entries[j];
    const fix = evidence.find((e) => e.taskRef === c.taskRef && order.later(e, c));
    if (!fix) continue;
    entries.splice(j, 1);
    superseded.unshift({ ...c, supersededBy: fix.line });
  }
  return { entries, evidence, superseded, skipped, range: order.range(spans), order };
}

// Back to the published shapes: the gate fields are plan_check's, and the
// manifest's result must not grow them.
const asEntry = ({ taskRef, summary, baseCommit, headCommit, issueId, closedDate }: ParsedClosure):
  DistillLedgerEntry => ({ taskRef, summary, baseCommit, headCommit, issueId, closedDate });
const asEvidence = ({ taskRef, summary, baseCommit, headCommit, issueId, loggedDate }: ParsedEvidence):
  DistillEvidenceEntry => ({ taskRef, summary, baseCommit, headCommit, issueId, loggedDate });

/**
 * Assemble the distill manifest for one phase: its PLAN.md issues, its
 * LEDGER.md entries (each carrying the commit range the task landed as), and
 * the union commit range those entries span. Filesystem reads plus git
 * ancestry questions (#445) -- no tracker, no LLM judgment; same repo
 * state, same manifest.
 *
 * :param projectDir: project root (the dir holding .cairn/)
 * :param phaseNumber: phase number, integer or one-decimal (1, 1.5, ...)
 * :returns DistillManifest scoped to exactly what the phase changed
 * :throws CairnError CONFIG_INVALID for a malformed phase number,
 *   NOT_FOUND when no live or archived phase dir carries that number
 */
export function distillManifest(projectDir: string,
  phaseNumber: number): DistillManifest {
  if (!isValidPhaseNumber(phaseNumber)) {
    throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(phaseNumber));
  }
  const phase = resolvePhase(projectDir, phaseNumber);
  const { entries, evidence, superseded, skipped, range } = parseLedger(phase.base);
  return {
    phase: {
      number: phase.number, name: phase.name,
      dir: phase.dir, archived: phase.archived,
    },
    issues: planIssuesAt(phase.base),
    ledgerEntries: entries.map(asEntry),
    evidenceEntries: evidence.map(asEvidence),
    superseded: superseded.map(asEntry),
    observedMismatches: entries.filter((e) => e.observedMismatch)
      .map((e) => ({ ...asEntry(e), exit: e.observedExit ?? "unknown" })),
    commitRange: range,
    skipped,
  };
}
