// The ledger append: the evidence gate a close must pass (a typed record of
// what was run and what it showed, or a written waiver) and the line that
// records it.
//
// Ordering across branches is by merge, not by append time: the ledger
// merges by union (.gitattributes, #361), so lines from two branches land
// in merge order. Readers never let file position decide between two
// lines for one task: a closure and its evidence fix-up resolve by commit
// ancestry, then the date on the line, then file order (#445, the rule
// lives in distill-manifest.ts). Asserted by test/ledger.test.ts "ledger
// ordering is a merge artifact" (closures of different tasks) and
// "closure-plus-evidence across a union merge reads the same answer in
// both directions" (a real union merge, both ways).
//
// removeWhen: never for the record -- a commit range and its evidence are
// the audit trail, not a model workaround. The refusal on missing evidence
// can soften to a report once agents attach evidence unprompted on every
// close across a milestone.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { plansRoot } from "./artifacts.js";
import { declaredVerifyIn } from "./check.js";
import {
  actualsSegment, isObservedMismatch, observedSegment, takeReceipt,
  type Measured, type Observation,
} from "./close-receipt.js";
import { gitSpan } from "./duration.js";
import { projectStatus } from "./status.js";
import { observeDeclaredVerify } from "./verify-rerun.js";

/** Typed close evidence (phase 23): what was run, and what it showed. */
export interface CloseEvidence {
  /** The proving command — a suite name or the shell line ("npm test", "vitest run x.test.ts"). */
  command: string;
  /** The observed outcome ("1408 passed", "exit 0, 3 files changed"). */
  result: string;
}

export interface LedgerEntryInput {
  taskRef: string;
  summary: string;
  baseCommit: string;
  headCommit: string;
  issueId: string;
  closedDate: string;
  redCommit?: string;
  greenCommit?: string;
  /**
   * Exactly one of `evidence` / `evidenceWaived` is required: an issue
   * closes on what was run and what it showed, or on a written reason it
   * needed no run (docs-only, planning-only). Neither → the append refuses.
   */
  evidence?: CloseEvidence;
  evidenceWaived?: string;
  /**
   * "close" (default) writes the closure line `<issueId> closed <date>`.
   * "evidence" (#256) records evidence for an issue that is NOT being
   * closed -- `audit tests` logging what it wrote, or correcting a closure
   * line that claimed an issue still open. It renders `- [ ] … evidence for
   * <issueId> <date>` (closedDate is then the logged date), consumes no
   * close receipt, and every ledger reader treats it as not-a-closure. An
   * evidence line that speaks AFTER a closure line for the same taskRef
   * (by commit ancestry, then date, then file order -- #445) supersedes
   * that closure: readers report the issue not closed.
   */
  kind?: LedgerKind;
  /** Free-text note on an evidence line (e.g. "supersedes the closure line"). Evidence kind only. */
  note?: string;
}

export type LedgerKind = "close" | "evidence";

/** Short-SHA form used in the ledger line -- matches `git log --abbrev=7` convention. */
function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/** The one shape a commit reference takes on the way in (#428): 7 to 40 hex
 *  characters, the same pattern resync.ts and distill-manifest.ts read back
 *  off the line. Anything else -- HEAD, a branch, a tag, an option -- is
 *  refused before the string reaches a git argument or a stamp. */
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i;

/**
 * Refuses a commit reference that is not a hash, with the field named so
 * the caller knows which end of the range to fix. Shared by the ledger's
 * own validation (base and head of the range) and the claim block in
 * index.ts (the stamp the close fold will read the range from). A moving
 * reference would make the range a different thing each time it is read;
 * an option-shaped one would make `git log` do whatever the option says
 * (asserted: ledger.test.ts "a commit reference is a hash, nothing else").
 *
 * :param value: the string the caller supplied
 * :param field: its name in the caller's input ("baseCommit", "claim.baseCommit")
 * :returns the trimmed hash
 */
export function assertCommitHash(value: string, field: string): string {
  const v = value.trim();
  if (!COMMIT_HASH.test(v)) {
    throw new CairnError("CONFIG_INVALID",
      `${field} is not a commit hash (7 to 40 hex characters): ${JSON.stringify(v.slice(0, 40))}`,
      "pass the sha git reports (git rev-parse HEAD) -- a branch, tag or HEAD moves, so it is refused");
  }
  return v;
}

/** The shape a tracker id takes on the way in (#469): an optional leading
 *  "#", then one alphanumeric, then alphanumerics, dots, underscores and
 *  hyphens -- GitHub's `#469`/`469`, Jira's `PROJ-105`, Linear's `ENG-12`,
 *  Trello's 24-hex card id, a Notion uuid. No whitespace, no slash, no
 *  separator, so the id can neither spell a field run nor climb out of the
 *  receipts folder it keys (close-receipt.ts). */
const ISSUE_ID = /^#?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The shape the close date takes (#469, #472): an ISO calendar date, or
 *  that date with a `T` time -- hours and minutes, optional seconds and
 *  fraction, optional `Z` or offset. The close fold writes the full
 *  timestamp (Date.toISOString()); a hand-called ledger_append may still
 *  pass the bare day. Anything else -- prose, a slash date, a space before
 *  the time -- is refused: the readers compare this field lexically to rank
 *  two lines for one task, and only an ISO string compares as time. */
const CLOSED_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Refuses an issue id outside ISSUE_ID, with the field named. The closing
 * audit of phase 30 forged a passing observation through this field: an
 * honest summary, honest failing evidence, and an id that spelled the
 * separator run followed by a fake tail and another issue number (#469).
 * The sanitizer below would now collapse that run to plain text; the shape
 * check refuses it outright, before any receipt is read or a line written
 * (asserted: ledger.test.ts "the issue id and close date are typed at the
 * writer too").
 *
 * :param value: the string the caller supplied
 * :param field: its name in the caller's input ("issueId")
 * :returns the trimmed id
 */
function assertIssueId(value: string, field: string): string {
  const v = (value ?? "").trim();
  if (!ISSUE_ID.test(v)) {
    throw new CairnError("CONFIG_INVALID",
      `${field} is not a tracker issue id (#?alnum then alnum . _ -): ${JSON.stringify(v.slice(0, 60))}`,
      "pass the id as the tracker spells it (#469, PROJ-105, ENG-12) -- no spaces, slashes or separators");
  }
  return v;
}

/** Refuses a close date outside CLOSED_DATE, with the field named (#469). */
function assertClosedDate(value: string, field: string): string {
  const v = (value ?? "").trim();
  if (!CLOSED_DATE.test(v)) {
    throw new CairnError("CONFIG_INVALID",
      `${field} is not an ISO date or timestamp (YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.sss]][Z|+HH:MM]): `
        + JSON.stringify(v.slice(0, 60)),
      "pass new Date().toISOString() (the close fold's shape), or the bare YYYY-MM-DD day");
  }
  return v;
}

/** Collapses embedded newlines (and the whitespace around them) to a single space, so a
 *  multi-line field (e.g. a pasted commit-message summary) can never break the ledger's
 *  one-line-per-entry invariant. */
function sanitize(field: string): string {
  return field.replace(/\s*\n\s*/g, " ").trim();
}

/** Every slot on the line loses em dashes — " — " is the ledger line's
 *  field separator, so one inside a command, result, task reference or
 *  summary would shift every field after it for the readers
 *  (distill-manifest, resync). The task reference and summary go through
 *  it too (#426): a summary carrying its own "commits .. — observed exit=0
 *  — closed" run would otherwise sit ahead of the server's real
 *  observation on the line. Asserted by test/ledger.test.ts "a summary
 *  shaped like a passing ledger tail cannot forge the observation". The
 *  issue id and close date go through it as well (#469), behind the shape
 *  checks above that already refuse a separator -- the second layer costs
 *  nothing and the verify line for #469 greps for it. */
function sanitizeSegment(field: string): string {
  return sanitize(field).replace(/—/g, "-");
}

/**
 * The evidence segment: `evidence <command> => <result> — ` or
 * `waived <reason> — `, placed before `<issueId> closed` exactly like the
 * tdd segment. Refuses neither (PRECONDITION_FAILED — the gate) and both
 * (CONFIG_INVALID — a contradiction).
 */
function evidenceSegment(entry: LedgerEntryInput): string {
  const has = entry.evidence !== undefined;
  const waived = entry.evidenceWaived !== undefined;
  if (has && waived) {
    throw new CairnError("CONFIG_INVALID",
      "evidence and evidenceWaived are mutually exclusive",
      "pass the evidence you have, or a waiver reason — not both");
  }
  if (has) {
    const cmd = sanitizeSegment(entry.evidence!.command ?? "");
    const res = sanitizeSegment(entry.evidence!.result ?? "");
    if (!cmd || !res) {
      throw new CairnError("PRECONDITION_FAILED",
        "close evidence needs both a command (what was run) and a result (what it showed)",
        "e.g. { command: \"npm test\", result: \"1408 passed\" }");
    }
    return `evidence ${cmd} => ${res} — `;
  }
  if (waived) {
    const reason = sanitizeSegment(entry.evidenceWaived!);
    if (!reason) {
      throw new CairnError("PRECONDITION_FAILED",
        "an evidence waiver needs a reason", "say why this close needed no run — \"docs only\", \"plan text only\"");
    }
    return `waived ${reason} — `;
  }
  throw new CairnError("PRECONDITION_FAILED",
    "close evidence missing: state what was run and what it showed, or waive with a reason",
    "ledger_append(evidence: { command, result }) from the run that justified the close, "
      + "or evidenceWaived: \"<why no run was needed>\" for docs/planning-only issues");
}

/** Every refusal the line can raise, checked before anything is consumed --
 *  a refused append must leave the close receipt where it found it. */
function validateEntry(entry: LedgerEntryInput): void {
  const kind = entry.kind ?? "close";
  if (kind !== "close" && kind !== "evidence") {
    throw new CairnError("CONFIG_INVALID",
      `kind '${String(kind)}' is not a ledger line kind`, "pass kind: \"close\" or \"evidence\"");
  }
  if (entry.note !== undefined && kind !== "evidence") {
    throw new CairnError("CONFIG_INVALID",
      "note is only written on evidence lines",
      "pass kind: \"evidence\" with the note, or drop the note from the closure line");
  }
  if ((entry.redCommit === undefined) !== (entry.greenCommit === undefined)) {
    throw new CairnError("CONFIG_INVALID",
      "redCommit/greenCommit: both or neither",
      "pass the failing-test commit AND the passing commit, or omit both");
  }
  // Both ends of the range are hashes (#428) -- checked here, before any
  // git call, so the close fold refuses while the issue is still open. The
  // tdd pair is held to the same shape (#469): a symbolic or option-shaped
  // ref on the line would be read back as a range by resync.
  assertCommitHash(entry.baseCommit, "baseCommit");
  assertCommitHash(entry.headCommit, "headCommit");
  if (entry.redCommit !== undefined) {
    assertCommitHash(entry.redCommit, "redCommit");
    assertCommitHash(entry.greenCommit!, "greenCommit");
  }
  // The two fields beside the server's own segments are typed too (#469):
  // the id the readers key on and the date they rank by.
  assertIssueId(entry.issueId, "issueId");
  assertClosedDate(entry.closedDate, "closedDate");
  evidenceSegment(entry);
}

function formatEntry(entry: LedgerEntryInput, actuals: string, observed = ""): string {
  const tdd = entry.redCommit
    ? `tdd ${shortSha(sanitize(entry.redCommit))}..${shortSha(sanitize(entry.greenCommit!))} — `
    : "";
  const evidence = evidenceSegment(entry);
  if ((entry.kind ?? "close") === "evidence") {
    // No closure claim anywhere on the line: an unchecked box, no actuals
    // (nothing closed, so no receipt to render), and an "evidence for" tail
    // in place of "<issueId> closed". The readers key off exactly this tail.
    const note = entry.note !== undefined && sanitizeSegment(entry.note)
      ? `note ${sanitizeSegment(entry.note)} — ` : "";
    return `- [ ] ${sanitizeSegment(entry.taskRef)} — ${sanitizeSegment(entry.summary)} — commits `
      + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
      + `${tdd}${evidence}${note}evidence for ${sanitizeSegment(entry.issueId)} ${sanitizeSegment(entry.closedDate)}\n`;
  }
  return `- [x] ${sanitizeSegment(entry.taskRef)} — ${sanitizeSegment(entry.summary)} — commits `
    + `${shortSha(sanitize(entry.baseCommit))}..${shortSha(sanitize(entry.headCommit))} — `
    + `${tdd}${evidence}${observed}${actuals}${sanitizeSegment(entry.issueId)} closed ${sanitizeSegment(entry.closedDate)}\n`;
}

/**
 * The `verify:` command a phase's PLAN.md declared for one issue (#206),
 * or null when the plan names none. One parser for the whole server
 * (#357): plan_check's `declaredVerifyIn` reads the task block, and the
 * last clause in it wins.
 */
export function declaredVerifyFor(
  projectDir: string, phaseDir: string, issueId: string,
): string | null {
  const planPath = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(planPath)) return null;
  return declaredVerifyIn(readFileSync(planPath, "utf8").split("\n"), issueId);
}

/**
 * Whether the evidence actually run cites what the plan declared.
 *
 * Deliberately a REPORT, never a refusal. Declared commands are written in
 * shorthand ("npm test") while evidence records what was really typed
 * ("npx vitest run --exclude '**\/*.live.test.ts'"), so a string gate here
 * would fail honest closes constantly and teach people to pad the field.
 * The comparison is loose on purpose — a shared significant token is
 * enough to say "this is the same check" — and the judgement of whether a
 * mismatch matters belongs to verify, where a human reads it.
 */
function citesDeclared(declared: string, evidenceCommand: string): boolean {
  const tokens = (t: string) => new Set(
    t.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g)?.filter(
      (w) => !["run", "npm", "npx", "the", "and", "--exclude", "test"].includes(w)) ?? []);
  const d = tokens(declared);
  const e = tokens(evidenceCommand);
  for (const t of d) if (e.has(t)) return true;
  // Nothing distinctive matched. "npm test" against "npx vitest run
  // --exclude ..." is the common honest case: both name the suite, neither
  // shares a distinctive token once the stoplist has done its work. Treat
  // "both are the test suite" as the same check, then fall back to exact
  // equality for anything else.
  const SUITE = /\b(?:test|tests|vitest|jest|mocha|pytest|suite)\b/i;
  if (SUITE.test(declared) && SUITE.test(evidenceCommand)) return true;
  return declared.trim().toLowerCase() === evidenceCommand.trim().toLowerCase();
}

function ledgerHeader(phase: { number: number; name: string }): string {
  return `# Phase ${phase.number}: ${phase.name} — Ledger\n\n`
    + `<!-- append-only; one line per verified task; server appends, never rewrites -->\n\n`;
}

/**
 * Every refusal appendLedger can raise -- the phase dir exists, the entry is
 * well formed -- with nothing written and nothing consumed. appendLedger runs
 * it first; the close fold (#365) runs it BEFORE the tracker close too, so a
 * ledger line that would be refused refuses the whole call while the issue
 * is still open, instead of leaving a close with no line behind it.
 */
export function checkLedgerEntry(projectDir: string, phaseDir: string,
  entry: LedgerEntryInput): { number: number; name: string } {
  const phase = projectStatus(projectDir).phases.find((p) => p.dir === phaseDir);
  if (!phase) {
    throw new CairnError("NOT_FOUND",
      `no phase dir '${phaseDir}' found under .cairn/plans/phases`,
      "run plan_scaffold_phase (or plan_status to list known phases), then retry ledger_append");
  }
  validateEntry(entry);
  return phase;
}

/**
 * Appends one formatted line to a phase's LEDGER.md, creating the file (with
 * header) on first append. Never rewrites existing content -- append-only,
 * so the ledger stays a trustworthy record even if a session crashes
 * mid-task. Ledger rides into git with the closing commit; the server just
 * writes the bytes.
 */
export function appendLedger(projectDir: string, phaseDir: string,
  entry: LedgerEntryInput): {
    path: string; line: string;
    /** Why this line carries no receipt facts, when it doesn't (#233). */
    degraded?: string[];
    /** The duration on the line and the rung that produced it (#232). */
    measured: Measured;
    /** What PLAN.md said would prove this task (#206), when it said anything. */
    declaredVerify?: string;
    /** Whether the evidence run cites that declaration. Reported, never enforced. */
    evidenceCitesDeclared?: boolean;
    /** What the server saw re-running the declared verify (#357), or why it ran
     *  nothing. Present only when `verify.rerun` is on and the line is a close. */
    observed?: Observation;
    /** The close claimed a pass the re-run did not reproduce. Reported, never refused. */
    observedMismatch?: boolean;
  } {
  const phase = checkLedgerEntry(projectDir, phaseDir, entry);
  const declaredVerify = declaredVerifyFor(projectDir, phaseDir, entry.issueId);
  const path = join(plansRoot(projectDir), "phases", phaseDir, "LEDGER.md");
  const span = () => gitSpan(projectDir, sanitize(entry.baseCommit), sanitize(entry.headCommit));
  let line: string;
  let wall: Measured;
  let degraded: string | undefined;
  let observation: Observation | null = null;
  if ((entry.kind ?? "close") === "evidence") {
    // An evidence line closes nothing (#256), so it must not eat the close
    // receipt a real close of this issue may still be waiting to render.
    wall = span();
    line = formatEntry(entry, "");
  } else {
    // The close receipt (#233): consumed only once the line is known to be
    // writable. takeReceipt never throws -- a missing or broken receipt
    // degrades the segment, it never fails the append.
    // The re-run (#357) happens here, inside the one write path, so the
    // folded close (#365) and a standalone ledger_append both observe. It
    // never throws and is null when rerun is off -- the line then carries
    // no observed segment at all, byte-identical to before. Its provenance
    // is the owner's approval stamp (#423), read by the server itself;
    // nothing on the entry is consulted for it.
    observation = observeDeclaredVerify({
      projectDir, phaseDir, issueId: sanitize(entry.issueId), evidence: entry.evidence,
      declared: declaredVerify,
    });
    const taken = takeReceipt(projectDir, sanitize(entry.issueId));
    // Duration ladder (#232): the close measured rungs one and two when it
    // could; rung three needs the commit range, which only this append holds.
    // A missing receipt does not cost the duration -- git still has it.
    const fromClose = taken.receipt?.measured;
    wall = fromClose && fromClose.source !== "none" && fromClose.minutes !== null
      ? fromClose : span();
    line = formatEntry(entry, actualsSegment(taken.receipt
      ? { receipt: taken.receipt, wall } : { degraded: taken.degraded!, wall }),
    observation ? observedSegment(observation) : "");
    degraded = taken.degraded;
  }
  if (existsSync(path)) {
    appendFileSync(path, line);
  } else {
    writeFileSync(path, ledgerHeader(phase) + line);
  }
  return {
    path, line: line.trimEnd(),
    ...(degraded ? { degraded: [degraded] } : {}),
    measured: wall,
    ...(declaredVerify === null ? {} : {
      declaredVerify,
      evidenceCitesDeclared: entry.evidence
        ? citesDeclared(declaredVerify, entry.evidence.command)
        : false,
    }),
    ...(observation ? { observed: observation, observedMismatch: isObservedMismatch(observation) } : {}),
  };
}
