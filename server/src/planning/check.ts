// The plan check: reports PLAN.md findings -- contract drift, unanchored
// thresholds, a missing approaches block, a task that never says how it
// will be proved. It reports; it never refuses (ADR 0017).
//
// removeWhen: models write plans that anchor thresholds, weigh approaches
// and declare their proving command unprompted -- shown by a milestone of
// planned phases where this check finds nothing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { hasLedgerUnion, LEDGER_UNION_LINE, parsePhaseDirName, phaseDirPrefix, plansRoot } from "./artifacts.js";
import { parseLedger, type ParsedClosure } from "./distill-manifest.js";
import { parseFrontmatter, parsePlanDoc } from "./frontmatter.js";

export interface PlanFinding {
  /**
   * contract-drift / unanchored-threshold: PLAN.md text findings.
   * missing-approaches (phase 23): a planned, non-quick phase whose
   * CONTEXT.md lacks the "Approaches considered" block — two-plus
   * candidates and a chosen line — the divergent-design step the plan
   * verb owes before PLAN.md exists.
   * missing-verify (phase 24.5): a task line in a planned, non-quick,
   * unverified PLAN.md that never says how it will be proved. Criteria
   * written after the fact are chosen to fit what happened.
   * tdd-missing / evidence-missing / closure-superseded (#366): the
   * LEDGER.md gates verify holds a phase to -- a `tdd:` id whose closing
   * line has no red..green pair, a planned issue whose closing line has
   * neither evidence nor a waiver, a closure an evidence-only line for the
   * same task later corrected. Anchored on the ledger line, or on the
   * PLAN.md frontmatter that declared the id when no closing line exists.
   * observed-mismatch (#357): a standing closing line carrying the
   * `observed-mismatch` marker -- the server re-ran the declared verify at
   * close and saw a non-zero exit or a timeout. Severity `important`.
   */
  type: "contract-drift" | "unanchored-threshold" | "missing-approaches"
    | "missing-verify" | "tdd-missing" | "evidence-missing" | "closure-superseded"
    | "observed-mismatch" | "ledger-attribute-missing";
  /**
   * Set only where a kind carries one; `observed-mismatch` is `important`,
   * `ledger-attribute-missing` (#361: a LEDGER.md without the union merge
   * attribute) is `minor`.
   */
  severity?: "important" | "minor";
  plan: string; line: number; detail: string;
  counterpart?: { plan: string; line: number };
}

// The approaches block, as data: an H2 whose text is "Approaches
// considered", ≥2 H3 candidates under it, and one "chosen:" line before
// the next H2. Case-insensitive on the headings; bold markers tolerated.
export const APPROACHES_HEADING = /^##\s+approaches considered\s*$/i;
const CANDIDATE_HEADING = /^###\s+\S/;
const CHOSEN_LINE = /^\s*(?:\*\*)?chosen(?:\*\*)?\s*:/i;
const ANY_H2 = /^##\s+\S/;
export const APPROACHES_MIN_CANDIDATES = 2;

/**
 * A plan task line: a top-level bullet naming the tracker issue it
 * advances, e.g. `- **#216 — run guard** (2pt / ~1.5h). …`. Bold is the
 * house style but not required — a plain `- #7 do the thing` is still a
 * task and still owes a declaration. What is required is the issue
 * reference, so that a narrative bullet opening with a number ("- 5 things
 * to watch") is never mistaken for work.
 */
const TASK_LINE = /^-\s+(?:\*\*#?|#)(\d+(?:\.\d+)?)[\s—-]/;

/**
 * The declaration itself (#357: the one parser -- plan_check, the ledger
 * append and the close-time re-run all read through it). A clause is a
 * backtick span whose WHOLE content is `verify: <command>`, and the span
 * either opens its line (indentation allowed: the house form, the clause
 * on its own line under the task) or closes it (the inline form at the end
 * of a bullet). Prose that mentions a `verify:` span mid-sentence is never
 * the declaration: an empty span ("two `verify:` parsers exist") has no
 * command, and a span inside a sentence neither opens nor closes the line.
 */
const VERIFY_SPAN_OPENS = /^\s*`verify:[ \t]*([^`\s][^`]*)`/i;
const VERIFY_SPAN_CLOSES = /`verify:[ \t]*([^`\s][^`]*)`[\s.]*$/i;

/**
 * The declared command on one line, or null when the line carries no
 * declaration (see the span rule above).
 *
 * :param line: one PLAN.md line
 * :returns the command, trimmed, or null
 */
export function verifyClauseOf(line: string): string | null {
  const m = VERIFY_SPAN_OPENS.exec(line) ?? VERIFY_SPAN_CLOSES.exec(line);
  return m ? m[1].trim() : null;
}

/** Where a task's text ends: the next task bullet (bold or plain), or any heading. */
const TASK_ENDS = /^(?:-\s+(?:\*\*#|\*\*\d|#)|#{1,6}\s)/;

/**
 * The `verify:` command PLAN.md declares for one issue (#206), or null.
 * The search covers the task's own block -- its bullet line down to the
 * next task bullet or heading -- and the LAST clause in that block wins,
 * so a task that restates its check after a revision reads the restated
 * one.
 *
 * :param lines: PLAN.md split into lines
 * :param issueId: the tracker id, with or without a leading "#"
 * :returns the declared command, or null when the task declares none
 */
export function declaredVerifyIn(lines: string[], issueId: string): string | null {
  const id = issueId.trim().replace(/^#/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) =>
    new RegExp(`^-\\s+(?:\\*\\*#?|#)${id}[\\s—-]`).test(l));
  if (start === -1) return null;
  let found: string | null = null;
  for (let i = start; i < lines.length; i++) {
    if (i > start && TASK_ENDS.test(lines[i])) break;
    found = verifyClauseOf(lines[i]) ?? found;
  }
  return found;
}

/**
 * Whether a declared command is a plain shell line the server may run
 * verbatim at close (#357), rather than prose or a template. Refused: more
 * than one line, an em/en dash or ellipsis (plan prose, never shell), a
 * `<placeholder>`, and a manual-check opener ("manual", "none", "n/a",
 * "tbd", "todo"). Everything else is the owner's own shell line.
 *
 * :param command: the declared command
 * :returns true when it is safe to hand to a shell as written
 */
export function isPlainShellLine(command: string): boolean {
  const c = command.trim();
  if (!c || /[\r\n]/.test(c)) return false;
  if (/[—–…]/.test(c) || /\.\.\.(?:\s|$)/.test(c)) return false;
  if (/<[A-Za-z][\w.-]*>/.test(c)) return false;
  return !/^(?:manual|none|n\/a|tbd|todo)\b/i.test(c);
}

/**
 * Task lines in a plan that never declare how they will be proved.
 *
 * The declaration may appear anywhere in the task's own paragraph, not
 * only on the bullet's first line — plan prose wraps, and forcing the
 * clause onto line one would push authors toward one-line tasks, which is
 * worse writing for a marginal parsing gain.
 *
 * :param lines: PLAN.md split into lines
 * :returns: one entry per undeclared task — the line to anchor on and the issue id
 */
export function judgeVerifyDeclarations(lines: string[]): { line: number; issue: string }[] {
  const out: { line: number; issue: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE.exec(lines[i]);
    if (!m) continue;
    let declared = verifyClauseOf(lines[i]) !== null;
    for (let j = i + 1; !declared && j < lines.length && !TASK_ENDS.test(lines[j]); j++) {
      declared = verifyClauseOf(lines[j]) !== null;
    }
    if (!declared) out.push({ line: i + 1, issue: m[1] });
  }
  return out;
}

/**
 * Judges a CONTEXT.md's approaches block. Null when it satisfies the
 * shape; otherwise the line to anchor the finding on and what's missing.
 *
 * :param lines: CONTEXT.md split into lines
 * :returns: null, or { line, detail }
 */
export function judgeApproaches(lines: string[]): { line: number; detail: string } | null {
  const start = lines.findIndex((l) => APPROACHES_HEADING.test(l));
  if (start === -1) {
    return { line: 1, detail: "CONTEXT.md has no '## Approaches considered' block — two-plus candidates with trade-offs and a chosen line" };
  }
  let candidates = 0;
  let chosen = false;
  for (let i = start + 1; i < lines.length && !ANY_H2.test(lines[i]); i++) {
    if (CANDIDATE_HEADING.test(lines[i])) candidates++;
    if (CHOSEN_LINE.test(lines[i])) chosen = true;
  }
  const missing: string[] = [];
  if (candidates < APPROACHES_MIN_CANDIDATES) {
    missing.push(`${candidates} candidate heading${candidates === 1 ? "" : "s"} (needs ${APPROACHES_MIN_CANDIDATES}+ '### ' entries)`);
  }
  if (!chosen) missing.push("no 'chosen:' line");
  if (missing.length === 0) return null;
  return { line: start + 1, detail: `'Approaches considered' block is incomplete — ${missing.join("; ")}` };
}

// Path-like token — used both to spot a shared fixture between plans and to
// anchor a threshold to something concrete (a benchmark file, a spec doc).
const PATHLIKE = /\S+\.(?:md|json|ts|js|mjs|csv|txt)/;
const ANCHOR_WORDS = /\b(?:benchmark|fixture|measured|per spec|spec §|source:)\b/i;
const THRESHOLD_SRC = "(?:<=|>=|<|>|≤|≥|under|over|at least|at most|within)"
  + "\\s*\\d+(?:\\.\\d+)?\\s*(?:ms|s|%|rps|qps|kb|mb|gb|tok|tokens|rows|items)\\b";
const THRESHOLD = new RegExp(THRESHOLD_SRC, "gi");
const THRESHOLD_TEST = new RegExp(THRESHOLD_SRC, "i"); // stateless existence check
const CONTRACT = /^(\s*)- (Produces|Consumes): (.*)$/;
const FENCE = /^\s*```/;
const SYMBOL = /`([A-Za-z_$][\w$]*)`|([A-Za-z_$][\w$]*)\(/g;

interface Contract {
  kind: "Produces" | "Consumes";
  plan: string;      // path relative to projectDir
  line: number;       // 1-indexed
  text: string;       // raw joined contract text (incl. continuation lines)
  symbols: Set<string>;
}

const leadingSpaces = (line: string): number => /^(\s*)/.exec(line)![1].length;

// Every `identifier` and every identifier( token, deduped.
function extractSymbols(text: string): Set<string> {
  const symbols = new Set<string>();
  for (const m of text.matchAll(SYMBOL)) symbols.add(m[1] ?? m[2]);
  return symbols;
}

// Walk a PLAN.md's lines and pull out every Produces/Consumes contract,
// including its continuation lines (more-indented, or inside a code fence
// opened on/after the contract line).
function extractContracts(lines: string[], planRel: string): Contract[] {
  const contracts: Contract[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = CONTRACT.exec(lines[i]);
    if (!m) { i++; continue; }
    const indent = m[1].length;
    const kind = m[2] as "Produces" | "Consumes";
    const startLine = i;
    const parts = [m[3]];
    // A fence can open ON the contract line itself (e.g. a "- Produces:"
    // bullet ending with ```) — an odd count of ``` markers on this line
    // means the fence is still open, so continuation lines start in-fence
    // exactly as if the fence had opened on a later line.
    let inFence = (lines[i].match(/```/g) ?? []).length % 2 === 1;
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (inFence) {
        parts.push(next);
        j++;
        if (FENCE.test(next)) inFence = false;
        continue;
      }
      if (next.trim() === "") {
        // Blank line ends the contract unless the next non-blank line is
        // still more-indented (blank-line + outdent ends it).
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k >= lines.length || leadingSpaces(lines[k]) <= indent) break;
        j++;
        continue;
      }
      const nextIndent = leadingSpaces(next);
      if (nextIndent > indent) {
        parts.push(next);
        if (FENCE.test(next)) inFence = true;
        j++;
        continue;
      }
      break; // outdent (or a sibling `- ` bullet at the same indent) ends it
    }
    contracts.push({
      kind, plan: planRel, line: startLine + 1,
      text: parts.join("\n"), symbols: extractSymbols(parts.join("\n")),
    });
    i = j;
  }
  return contracts;
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

// A threshold is anchored when the same line, or the line directly above or
// below it, names a path-like fixture or one of the anchor words. A
// neighboring line only lends its anchor if it isn't itself a separate,
// self-contained threshold statement — otherwise two independent
// requirements sitting on adjacent lines would anchor each other by accident.
function isAnchored(lines: string[], idx: number, hasThreshold: boolean[]): boolean {
  if (PATHLIKE.test(lines[idx]) || ANCHOR_WORDS.test(lines[idx])) return true;
  for (const i of [idx - 1, idx + 1]) {
    if (i < 0 || i >= lines.length || hasThreshold[i]) continue;
    if (PATHLIKE.test(lines[i]) || ANCHOR_WORDS.test(lines[i])) return true;
  }
  return false;
}

function scanThresholds(lines: string[], planRel: string): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const hasThreshold = lines.map((line) => THRESHOLD_TEST.test(line));
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(THRESHOLD)) {
      if (!isAnchored(lines, idx, hasThreshold)) {
        findings.push({ type: "unanchored-threshold", plan: planRel, line: idx + 1, detail: m[0] });
      }
    }
  });
  return findings;
}

interface ScannedPlan {
  rel: string; lines: string[]; text: string; contracts: Contract[];
  /** The sibling CONTEXT.md path (may not exist). */
  contextPath: string;
  /** True when PLAN.md lists issues and depth is not quick — the gate applies. */
  gated: boolean;
  /** VERIFICATION.md exists — the phase has already been proved. */
  verified: boolean;
  /** The phase directory (absolute) and its number, null when the name doesn't parse. */
  phaseDir: string; phase: number | null;
}

/**
 * The pre-phase-23 exemption, stated once. The close-evidence gate shipped
 * in phase 23, so a phase numbered 23 or below that is already verified
 * closed its issues before the gate existed (phase 23's own lines
 * included), and the ledger is append-only, so those lines can never grow
 * the segment: exempt. An unverified phase is held to the gate whatever its
 * number. The tdd and superseded gates have no exemption.
 */
export const EVIDENCE_GATE_SHIPPED = 23;

const bareId = (id: string): string => id.trim().replace(/^#/, "");

/**
 * The LEDGER.md gates for one phase: tdd-missing, evidence-missing,
 * closure-superseded and observed-mismatch, read off the same parse
 * distill_manifest uses.
 *
 * A phase with no LEDGER.md yet reports nothing — plan_check runs at plan
 * time too, before any task has closed. Once the ledger exists every
 * planned id owes its closing line, so an id with none is reported against
 * the PLAN.md frontmatter line that declared it.
 *
 * :param projectDir: project root, for the relative paths findings carry
 * :param p: the scanned plan
 * :returns the gate findings, unsorted
 */
function judgeLedgerGates(projectDir: string, p: ScannedPlan): PlanFinding[] {
  const ledgerPath = join(p.phaseDir, "LEDGER.md");
  if (!existsSync(ledgerPath)) return [];
  let data: Record<string, string | string[]>;
  try {
    data = parseFrontmatter(p.text).data;
  } catch {
    return []; // a malformed plan is reported elsewhere, never bricked on here
  }
  const list = (v: string | string[] | undefined): string[] =>
    (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(bareId).filter(Boolean);
  const issues = new Set(list(data.issues));
  const tdd = new Set(list(data.tdd));
  const declaredAt = (key: string): number => p.lines.findIndex((l) => l.startsWith(`${key}:`)) + 1 || 1;

  // Last standing closure per issue, and last superseded one -- file order
  // is chronological, so a later line is the one that speaks.
  const { entries, superseded } = parseLedger(p.phaseDir);
  const byIssue = (rows: ParsedClosure[]): Map<string, ParsedClosure> =>
    new Map(rows.map((r) => [bareId(r.issueId), r]));
  const standing = byIssue(entries);
  const corrected = byIssue(superseded);
  const exempt = p.verified && p.phase !== null && p.phase <= EVIDENCE_GATE_SHIPPED;
  const ledger = relative(projectDir, ledgerPath);

  const out: PlanFinding[] = [];
  for (const id of new Set([...issues, ...tdd])) {
    const closing = standing.get(id);
    const gone = corrected.get(id);
    if (!closing && gone) {
      // One cause, one finding: the closure doesn't stand, so its segments
      // can't satisfy the other two gates either.
      out.push({
        type: "closure-superseded", plan: ledger, line: gone.line,
        detail: `#${id}'s closure is corrected by the evidence-only line ${gone.supersededBy} for the same task — `
          + "it reads as NOT closed; append a fresh closing line",
        counterpart: { plan: ledger, line: gone.supersededBy! },
      });
      continue;
    }
    if (issues.has(id) && !exempt && !closing?.closeEvidence) {
      out.push(closing
        ? { type: "evidence-missing", plan: ledger, line: closing.line,
          detail: `#${id}'s closing line has neither an \`evidence <command> => <result>\` nor a \`waived <reason>\` segment` }
        : { type: "evidence-missing", plan: p.rel, line: declaredAt("issues"),
          detail: `#${id} has no closing line in LEDGER.md` });
    }
    if (tdd.has(id) && !closing?.tdd) {
      out.push(closing
        ? { type: "tdd-missing", plan: ledger, line: closing.line,
          detail: `#${id} is a tdd: task but its closing line has no red..green commit pair` }
        : { type: "tdd-missing", plan: p.rel, line: declaredAt("tdd"),
          detail: `#${id} is a tdd: task with no closing line in LEDGER.md` });
    }
  }
  // Observed mismatch (#357): the standing close for an issue claimed a
  // pass its close-time re-run did not reproduce. Every standing close is
  // read, planned or not -- the line is the server's own observation. A
  // later passing close for the same issue is the one that speaks.
  for (const [id, closing] of standing) {
    if (!closing.observedMismatch) continue;
    out.push({
      type: "observed-mismatch", severity: "important", plan: ledger, line: closing.line,
      detail: `#${id} closed on claimed evidence, but the server's re-run of the declared verify `
        + `observed exit ${closing.observedExit ?? "unknown"} — read both before trusting the close`,
    });
  }
  return out;
}

/**
 * Whether the approaches gate applies to a plan: it lists tracker issues
 * (it has been planned, not merely scaffolded) and its resolved depth —
 * PLAN.md `depth:` frontmatter, else standard (cairn.json carries no depth
 * key, so the frontmatter is all the server can see) — is not quick.
 * Unparseable frontmatter never gates: plan_check reports, it doesn't
 * brick on a malformed plan.
 */
function isGated(text: string): boolean {
  try {
    const { frontmatter } = parsePlanDoc(text);
    return frontmatter.issues.length > 0 && (frontmatter.depth ?? "standard") !== "quick";
  } catch {
    return false;
  }
}

export function planCheck(projectDir: string, phase?: number):
  { findings: PlanFinding[]; scanned: number } {
  const phasesDir = join(plansRoot(projectDir), "phases");
  if (!existsSync(phasesDir)) return { findings: [], scanned: 0 };

  // Reuse phaseDirName's own pad-and-append scheme instead of re-deriving it
  // here -- the old String(phase).padStart(2,"0") built "1.5-", which never
  // matches the real "01.5-slug" directory a decimal phase actually scaffolds
  // to (CRN-40). phaseDirPrefix throws CONFIG_INVALID for an invalid phase
  // (e.g. 1.55), same as every other phase-consuming call in this codebase.
  const prefix = phase !== undefined ? phaseDirPrefix(phase) : null;
  const plans: ScannedPlan[] = [];
  for (const entry of readdirSync(phasesDir)) {
    if (prefix && !entry.startsWith(prefix)) continue;
    const path = join(phasesDir, entry, "PLAN.md");
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const rel = relative(projectDir, path);
    const lines = text.split("\n");
    plans.push({
      rel, lines, text, contracts: extractContracts(lines, rel),
      contextPath: join(phasesDir, entry, "CONTEXT.md"), gated: isGated(text),
      verified: existsSync(join(phasesDir, entry, "VERIFICATION.md")),
      phaseDir: join(phasesDir, entry), phase: parsePhaseDirName(entry)?.number ?? null,
    });
  }

  const findings: PlanFinding[] = [];

  // Thresholds — independent per plan.
  for (const p of plans) findings.push(...scanThresholds(p.lines, p.rel));

  // Approaches considered (phase 23) — one finding per gated plan whose
  // CONTEXT.md lacks the block. Anchored on CONTEXT.md, since that's the
  // file that owes the text. A VERIFIED phase is exempt for the same
  // reason the declared-verification gate exempts it: the phase already
  // passed its gate, so asking it for a design block after the fact is
  // noise on every scan until the milestone archives it.
  for (const p of plans) {
    if (!p.gated || p.verified) continue;
    const ctxLines = existsSync(p.contextPath) ? readFileSync(p.contextPath, "utf8").split("\n") : [];
    const verdict = judgeApproaches(ctxLines);
    if (verdict) {
      findings.push({ type: "missing-approaches", plan: relative(projectDir, p.contextPath),
        line: verdict.line, detail: verdict.detail });
    }
  }

  // Declared verification (phase 24.5) — one finding per undeclared task
  // in a gated plan. A VERIFIED phase is exempt: its proving already
  // happened and is written up, so asking it to declare intent after the
  // fact is noise on every scan until the milestone closes.
  for (const p of plans) {
    if (!p.gated || p.verified) continue;
    for (const { line, issue } of judgeVerifyDeclarations(p.lines)) {
      findings.push({
        type: "missing-verify", plan: p.rel, line,
        detail: `task #${issue} does not say how it will be proved — add a \`verify: <command>\` ` +
          "clause; criteria written after the work are chosen to fit what happened",
      });
    }
  }

  // Ledger gates (#366) — what verify holds a phase to, read off the
  // ledger the server wrote rather than by eye.
  for (const p of plans) findings.push(...judgeLedgerGates(projectDir, p));

  // Ledger merge attribute (#361) -- one finding per phase whose LEDGER.md
  // exists while the planning root lacks the union line. The fix is one line.
  if (!hasLedgerUnion(projectDir)) {
    for (const p of plans) {
      const ledgerPath = join(p.phaseDir, "LEDGER.md");
      if (!existsSync(ledgerPath)) continue;
      findings.push({
        type: "ledger-attribute-missing", severity: "minor",
        plan: relative(projectDir, ledgerPath), line: 1,
        detail: `LEDGER.md merges by conflict without the union attribute -- add \`${LEDGER_UNION_LINE}\` ` +
          "to .cairn/plans/.gitattributes (plan_scaffold_phase writes it)",
      });
    }
  }

  // Contract drift — pair every Produces against every Consumes in a
  // different plan that shares a symbol, flag on the consumer's line.
  const seen = new Set<string>();
  for (const producerPlan of plans) {
    for (const producer of producerPlan.contracts) {
      if (producer.kind !== "Produces") continue;
      for (const consumerPlan of plans) {
        if (consumerPlan.rel === producerPlan.rel) continue;
        for (const consumer of consumerPlan.contracts) {
          if (consumer.kind !== "Consumes") continue;
          const sharedSymbol = [...producer.symbols].find((s) => consumer.symbols.has(s));
          if (!sharedSymbol) continue;
          const key = `${producer.plan}:${producer.line}>${consumer.plan}:${consumer.line}`;
          if (seen.has(key)) continue;
          if (normalize(producer.text) === normalize(consumer.text)) continue;
          const producerFixtures: string[] = producerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
          const consumerFixtures: string[] = consumerPlan.text.match(new RegExp(PATHLIKE, "g")) ?? [];
          if (producerFixtures.some((f) => consumerFixtures.includes(f))) continue;
          seen.add(key);
          findings.push({
            type: "contract-drift", plan: consumer.plan, line: consumer.line,
            detail: `consumed contract for \`${sharedSymbol}\` differs from producer in ${producer.plan}:${producer.line}`,
            counterpart: { plan: producer.plan, line: producer.line },
          });
        }
      }
    }
  }

  // Fully explicit tie-break — byte-equal output is a binding constraint, so
  // sort order must never fall back on readdir/filesystem enumeration order.
  const cmp = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
  findings.sort((a, b) =>
    cmp(a.plan, b.plan) || (a.line - b.line) || cmp(a.type, b.type)
    || cmp(a.counterpart?.plan ?? "", b.counterpart?.plan ?? "")
    || ((a.counterpart?.line ?? 0) - (b.counterpart?.line ?? 0))
    || cmp(a.detail, b.detail));
  return { findings, scanned: plans.length };
}
