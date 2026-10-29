/**
 * Purpose: the spend ledger for headless batch runs (#131) — the OUTER,
 *   cross-phase budget ceiling. At every phase/wave boundary the executor
 *   re-reads actual spend from the metrics jsonl the Stop hook writes and
 *   asks checkBudget() whether the NEXT unit of work may start. Verdict is
 *   "stop" the moment spent >= ceiling: no new phase/wave ever starts past
 *   the ceiling, in-flight work finishes — the documented guarantee is
 *   bounded overshoot <= one wave.
 *
 *   Metrics rows are CUMULATIVE per session: correct totals take the LATEST
 *   row per session_id (never the sum of all rows). Sessions that began
 *   after the run opened count in full; sessions that already existed at
 *   run-open (the DRIVING session — its cumulative row predates the run)
 *   count as the DELTA past a baseline snapshot taken at openRunLedger,
 *   floored at 0 (#143 — before the baseline, the driver's spend read zero
 *   all run). Wave subagents write no metrics rows at all, so the executor
 *   reports each wave's agent token total through recordBoundary's
 *   agentTokens — those accumulate as their own spend component. Spend
 *   numbers are approximate list-price estimates, same caveat as
 *   cost-report.mjs.
 *
 *   TOKEN UNIT (#152): the token component counts input + output tokens
 *   ONLY — the exact unit token-estimate.ts publishes, so a ceiling staged
 *   from an estimate range is judged in the same currency it was quoted in.
 *   Cache write/read traffic is EXCLUDED from the token count and lives in
 *   the USD component instead (est_cost_usd already prices it), because a
 *   cache-heavy driving session meters tens of millions of cache-read
 *   tokens against pennies of real cost. Baselines and deltas are computed
 *   on this same unit.
 *
 *   The Claude Code Workflow primitive exposes its own budget global in
 *   workflow scripts (budget.total / budget.spent() / budget.remaining();
 *   over-budget agent() calls THROW). That is the INNER, in-run ceiling —
 *   the executor passes checkBudget().innerBudgetSuggestion down as the
 *   invoking run's budget (#133 wires it); this ledger stays the outer
 *   authority across phases.
 *
 * removeWhen: the platform's in-run budget becomes a hard, cross-session
 *   spend ceiling that stops headless work at a clean checkpoint and
 *   reports what it spent — then this outer ledger only duplicates it
 *   (ADR 0008).
 * Author(s): John Reed
 */

// Imports
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
import { metricsSegments } from "../core/metrics.js";
import { repositoryPath } from "./run-manifest.js";

// Constants

/** Tokens in a metrics row that count toward the token ceiling — input +
 * output ONLY, the same unit token-estimate.ts uses, so ceilings staged from
 * estimate ranges hold. Cache traffic is deliberately excluded from the
 * token unit (a cache-heavy driver would otherwise blow a sane ceiling in
 * minutes, #152) — it still costs money, and the USD component prices it
 * honestly through est_cost_usd. */
const TOKEN_FIELDS = ["input_tokens", "output_tokens"] as const;

// Paths

/** Filename-safe runId — anything exotic collapses to '-'; the raw run_id
 * stays inside the file and is verified on load, so a collision here can't
 * silently merge two runs. */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** ~/.cairn/budget/<projectKey>-<runId>.json — one ledger file per run,
 * outside the repo, per repository like the run it meters (#362). baseDir
 * injectable for tests. */
export function budgetLedgerPath(
  projectDir: string, runId: string, baseDir: string = join(homedir(), ".cairn"),
): string {
  return repositoryPath(projectDir, "budget", `-${safeRunId(runId)}.json`, baseDir);
}

/** The metrics jsonl the Stop hook writes — same path scheme as
 * hooks/scripts/lib.mjs's metricsPath, with the base dir injectable. */
export function budgetMetricsPath(
  projectDir: string, baseDir: string = join(homedir(), ".cairn"),
): string {
  return repositoryPath(projectDir, "metrics", ".jsonl", baseDir);
}

// Schema — versioned state file, same safeParse precedent as continuity.ts's
// Handoff. Current version is 2 (adds baselines + the agent-token spend
// component, #143); a v1 file still loads — empty baselines, zero agent
// tokens, and a note — so a run staged before the upgrade keeps its history.

/** Baseline snapshot of one pre-existing session's cumulative totals at
 * run-open — that session's spend counts as the delta past this. */
export interface BudgetBaseline {
  tokens: number;
  usd: number;
}

export interface BudgetBoundary {
  ts: string; // from metrics rows (latest in-scope row), never Date.now
  phase: number | string;
  wave?: number | string;
  note?: string;
  sessions: number;
  agent_tokens?: number; // this boundary's reported wave-agent total (increment)
  spent_tokens: number;
  spent_usd: number;
  verdict: "proceed" | "stop";
}

export interface BudgetLedgerState {
  version: 2;
  run_id: string;
  project: string;
  opened: string; // run start ts — new sessions after it count in full
  ceiling_tokens?: number;
  ceiling_usd?: number;
  /** Latest-row totals per session that already existed at run-open, keyed
   * by session_id — those sessions count as the delta past this snapshot. */
  baselines: Record<string, BudgetBaseline>;
  session_tokens: number; // metrics-derived component (deltas applied)
  agent_tokens: number; // accumulated wave-agent totals from boundaries
  spent_tokens: number; // session_tokens + agent_tokens
  spent_usd: number;
  boundaries: BudgetBoundary[]; // append-only history, LEDGER.md's spirit
}

const BudgetBoundarySchema: z.ZodType<BudgetBoundary> = z.object({
  ts: z.string(),
  phase: z.union([z.number(), z.string()]),
  wave: z.union([z.number(), z.string()]).optional(),
  note: z.string().optional(),
  sessions: z.number(),
  agent_tokens: z.number().int().min(0).optional(),
  spent_tokens: z.number(),
  spent_usd: z.number(),
  verdict: z.enum(["proceed", "stop"]),
});

const BudgetBaselineSchema: z.ZodType<BudgetBaseline> = z.object({
  tokens: z.number(),
  usd: z.number(),
});

export const BudgetLedgerSchema: z.ZodType<BudgetLedgerState> = z.object({
  version: z.literal(2),
  run_id: z.string(),
  project: z.string(),
  opened: z.string(),
  ceiling_tokens: z.number().optional(),
  ceiling_usd: z.number().optional(),
  baselines: z.record(z.string(), BudgetBaselineSchema),
  session_tokens: z.number(),
  agent_tokens: z.number(),
  spent_tokens: z.number(),
  spent_usd: z.number(),
  boundaries: z.array(BudgetBoundarySchema),
});

/** The v1 shape (#131, pre-baselines) — still readable so an in-flight run
 * staged before the upgrade keeps its ceilings and boundary history. */
const BudgetLedgerV1Schema = z.object({
  version: z.literal(1),
  run_id: z.string(),
  project: z.string(),
  opened: z.string(),
  ceiling_tokens: z.number().optional(),
  ceiling_usd: z.number().optional(),
  spent_tokens: z.number(),
  spent_usd: z.number(),
  boundaries: z.array(BudgetBoundarySchema),
});

/** Note attached when a v1 file loads — surfaced through checkBudget. */
const V1_MIGRATION_NOTE =
  "ledger migrated from v1 — no baselines were snapshotted at run-open, so "
  + "pre-existing sessions stay excluded (v1 behavior) and agent tokens start at 0";

/** Open handle: the ledger state plus the resolved file paths it lives at. */
export interface RunLedger {
  path: string;
  metricsPath: string;
  state: BudgetLedgerState;
  /** Set when the file loaded through the v1 fallback — carried into
   * checkBudget's note so the migration is visible, never silent. */
  migrationNote?: string;
}

export interface BudgetCheck {
  runId: string;
  /** Metrics-derived component: latest row per session, baseline deltas
   * applied for sessions that predate the run. */
  sessionTokens: number;
  /** Accumulated wave-agent totals reported through recordBoundary. */
  agentTokens: number;
  /** sessionTokens + agentTokens — the number the ceilings judge. */
  spentTokens: number;
  spentUsd: number;
  ceilingTokens?: number;
  ceilingUsd?: number;
  remainingTokens?: number;
  remainingUsd?: number;
  verdict: "proceed" | "stop";
  /** Present when spent EXCEEDS a ceiling — the honest overshoot record.
   * Bounded <= one wave because no new work starts on "stop". */
  overshoot?: { tokens?: number; usd?: number };
  /** What the executor passes down as the Workflow in-run budget (the inner
   * ceiling, #133) — the remaining headroom for the next wave. */
  innerBudgetSuggestion?: { tokens?: number; usd?: number };
  note?: string;
}

// Internals

const round4 = (n: number): number => Number(n.toFixed(4));

/** Reads and validates the ledger file at `path`; null when absent. A v1
 * file loads through the fallback schema — empty baselines, zero agent
 * tokens — with a migration note (backward compatible, never silent). */
function readLedgerFile(
  path: string,
): { state: BudgetLedgerState; migrationNote?: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("BUDGET_INVALID",
      `budget ledger at ${path} is not valid JSON: ${e}`,
      "inspect or discard ~/.cairn/budget/…");
  }
  const result = BudgetLedgerSchema.safeParse(parsed);
  if (result.success) return { state: result.data };

  // v1 fallback — a run staged before the baseline upgrade keeps its
  // ceilings and boundary history; the missing pieces default honestly.
  const v1 = BudgetLedgerV1Schema.safeParse(parsed);
  if (v1.success) {
    const { version: _v, ...rest } = v1.data;
    return {
      state: {
        ...rest,
        version: 2,
        baselines: {},
        session_tokens: v1.data.spent_tokens,
        agent_tokens: 0,
      },
      migrationNote: V1_MIGRATION_NOTE,
    };
  }

  throw new CairnError("BUDGET_INVALID",
    `budget ledger at ${path} failed schema validation: ${result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    "inspect or discard ~/.cairn/budget/…");
}

/** Atomic write — tmp then rename, same as continuity's handoff writer. */
function writeLedgerFile(path: string, state: BudgetLedgerState): void {
  mkdirSync(dirname(path), { recursive: true });
  // pid + random suffix, never a fixed name (#351): the file is shared by
  // every worktree of the repository (#362), so two writers can overlap
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Collapses the metrics jsonl to the LATEST row per session_id plus each
 * session's first-row ts. Missing file or corrupt lines contribute nothing,
 * same posture as cost-report.
 *
 * Every segment is read, oldest first (#237). That matters twice here. The
 * latest row wins as before, so a spanning session is replaced rather than
 * summed. But firstTs is what scopes a session to the run, and reading only
 * the live segment put a pre-run session's FIRST row after the run opened —
 * so its whole cumulative total counted against this run's ceiling. That is
 * the one direction of this bug that inflates rather than under-reports. */
function collapseMetrics(metricsPath: string): {
  firstTs: Map<string, number>;
  latest: Map<string, Record<string, unknown>>;
} {
  const firstTs = new Map<string, number>();
  const latest = new Map<string, Record<string, unknown>>();
  for (const segment of metricsSegments(metricsPath)) {
    let raw: string;
    try {
      raw = readFileSync(segment, "utf8");
    } catch {
      continue; // pruned or never written -- not an error
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // skip corrupt line, same posture as cost-report
      }
      const sid = row.session_id;
      if (typeof sid !== "string") continue;
      if (!firstTs.has(sid)) {
        firstTs.set(sid, new Date(String(row.ts ?? "")).getTime());
      }
      latest.set(sid, row); // later lines win — append order
    }
  }
  return { firstTs, latest };
}

/** One row's countable totals — input+output tokens (the estimator's unit;
 * cache traffic counts only through est_cost_usd) plus est cost. */
function rowTotals(row: Record<string, unknown>): { tokens: number; usd: number } {
  let tokens = 0;
  for (const f of TOKEN_FIELDS) tokens += Number(row[f] ?? 0) || 0;
  return { tokens, usd: Number(row.est_cost_usd ?? 0) || 0 };
}

/** Baseline snapshot at run-open: the CURRENT latest-row totals per session
 * already in the metrics file. Sessions here count as deltas from now on. */
function snapshotBaselines(metricsPath: string): Record<string, BudgetBaseline> {
  const { latest } = collapseMetrics(metricsPath);
  const baselines: Record<string, BudgetBaseline> = {};
  for (const [sid, row] of latest) {
    const t = rowTotals(row);
    baselines[sid] = { tokens: t.tokens, usd: round4(t.usd) };
  }
  return baselines;
}

/**
 * Actual session spend since the run opened: latest row per session_id
 * (rows are cumulative — summing every row would multiply-count), where
 * sessions whose FIRST row landed at or after `opened` count in full, and
 * sessions captured in the run-open `baselines` snapshot count as the delta
 * past their baseline, floored at 0 (#143 — this is how the DRIVING
 * session's spend registers even though its cumulative row predates the
 * run). Sessions that predate the run with no baseline stay excluded.
 * Deterministic given file content.
 */
function measureSpend(
  metricsPath: string, openedTs: string,
  baselines: Record<string, BudgetBaseline>,
): { tokens: number; usd: number; sessions: number; latestTs?: string } {
  const opened = new Date(openedTs).getTime();
  const { firstTs, latest } = collapseMetrics(metricsPath);

  let tokens = 0;
  let usd = 0;
  let sessions = 0;
  let latestTs: string | undefined;
  for (const [sid, row] of latest) {
    const began = firstTs.get(sid) ?? NaN;
    const t = rowTotals(row);
    let dTokens: number;
    let dUsd: number;
    if (began >= opened) {
      // session began during the run — its whole total is this run's spend
      dTokens = t.tokens;
      dUsd = t.usd;
    } else if (baselines[sid]) {
      // pre-existing session (the driver) — only spend past the baseline,
      // floored: a truncated/rotated metrics file never goes negative
      dTokens = Math.max(0, t.tokens - baselines[sid].tokens);
      dUsd = Math.max(0, t.usd - baselines[sid].usd);
      if (dTokens === 0 && dUsd === 0) continue; // idle so far — not counted
    } else {
      continue; // pre-run session with no baseline — not this run's spend
    }
    sessions += 1;
    tokens += dTokens;
    usd += dUsd;
    const ts = String(row.ts ?? "");
    if (ts && (!latestTs || ts > latestTs)) latestTs = ts;
  }
  return { tokens, usd: round4(usd), sessions, latestTs };
}

// API

/**
 * Creates or loads the run's ledger file under <baseDir>/budget/. Passing
 * ceilings on an existing run updates them (a re-staged run may tighten or
 * loosen the cap); everything else about an existing ledger — opened ts,
 * spend, boundary history — is preserved. `startedAt` seeds `opened` on
 * first create only, so tests and resumed runs stay deterministic.
 *
 * :param projectDir: the project the metrics roll up under
 * :returns RunLedger handle for recordBoundary / checkBudget
 */
export function openRunLedger(
  projectDir: string,
  opts: {
    runId: string;
    ceilingTokens?: number;
    ceilingUsd?: number;
    startedAt?: string;
    baseDir?: string;
  },
): RunLedger {
  if (!opts.runId || !opts.runId.trim()) {
    throw new CairnError("BUDGET_INVALID", "runId must be a non-empty string");
  }
  const baseDir = opts.baseDir ?? join(homedir(), ".cairn");
  const path = budgetLedgerPath(projectDir, opts.runId, baseDir);
  const metricsPath = budgetMetricsPath(projectDir, baseDir);

  const existing = readLedgerFile(path);
  if (existing && existing.state.run_id !== opts.runId) {
    // two distinct runIds collapsed to the same sanitized filename
    throw new CairnError("BUDGET_INVALID",
      `ledger at ${path} belongs to run '${existing.state.run_id}', not '${opts.runId}'`,
      "pick a runId that differs in more than punctuation");
  }

  // First create snapshots baselines: the CURRENT latest-row totals of every
  // session already in the metrics file (the driving session included) —
  // their spend from here on counts as the delta past this snapshot (#143).
  const state: BudgetLedgerState = existing?.state ?? {
    version: 2,
    run_id: opts.runId,
    project: basename(resolve(projectDir)),
    opened: opts.startedAt ?? new Date().toISOString(),
    baselines: snapshotBaselines(metricsPath),
    session_tokens: 0,
    agent_tokens: 0,
    spent_tokens: 0,
    spent_usd: 0,
    boundaries: [],
  };
  if (opts.ceilingTokens !== undefined) state.ceiling_tokens = opts.ceilingTokens;
  if (opts.ceilingUsd !== undefined) state.ceiling_usd = opts.ceilingUsd;

  writeLedgerFile(path, state);
  const ledger: RunLedger = { path, metricsPath, state };
  if (existing?.migrationNote) ledger.migrationNote = existing.migrationNote;
  return ledger;
}

/**
 * Refreshes the ledger's spent totals from the metrics file, in memory only
 * (no boundary row, no write) — status displays poll through this without
 * growing the history.
 */
export function refreshSpend(ledger: RunLedger): RunLedger {
  const spend = measureSpend(
    ledger.metricsPath, ledger.state.opened, ledger.state.baselines);
  ledger.state.session_tokens = spend.tokens;
  ledger.state.spent_tokens = spend.tokens + ledger.state.agent_tokens;
  ledger.state.spent_usd = spend.usd;
  return ledger;
}

/**
 * A phase/wave boundary: re-read actual spend, update the totals, append one
 * boundary row (append-only — history is never rewritten), persist, and
 * return the verdict. This is THE decision point of a headless run: the
 * caller never starts new work on "stop".
 *
 * Wave subagents write no metrics rows (#143) — the executor reports each
 * completed wave's agent token total via `agentTokens`; those accumulate as
 * the ledger's own agent-spend component, summed into spent_tokens.
 */
export function recordBoundary(
  ledger: RunLedger,
  b: {
    phase: number | string; wave?: number | string; note?: string;
    agentTokens?: number;
  },
): BudgetCheck {
  if (b.agentTokens !== undefined
      && (!Number.isInteger(b.agentTokens) || b.agentTokens < 0)) {
    throw new CairnError("BUDGET_INVALID",
      `agentTokens must be an integer >= 0, got ${b.agentTokens}`);
  }
  ledger.state.agent_tokens += b.agentTokens ?? 0;

  const spend = measureSpend(
    ledger.metricsPath, ledger.state.opened, ledger.state.baselines);
  ledger.state.session_tokens = spend.tokens;
  ledger.state.spent_tokens = spend.tokens + ledger.state.agent_tokens;
  ledger.state.spent_usd = spend.usd;

  const check = checkBudget(ledger);
  const boundary: BudgetBoundary = {
    // timestamp comes from the rows (latest in-scope), falling back to the
    // run's opened ts — decision math never touches the wall clock.
    ts: spend.latestTs ?? ledger.state.opened,
    phase: b.phase,
    ...(b.wave !== undefined ? { wave: b.wave } : {}),
    ...(b.note !== undefined ? { note: b.note } : {}),
    sessions: spend.sessions,
    ...(b.agentTokens !== undefined ? { agent_tokens: b.agentTokens } : {}),
    spent_tokens: ledger.state.spent_tokens,
    spent_usd: spend.usd,
    verdict: check.verdict,
  };
  ledger.state.boundaries.push(boundary);
  writeLedgerFile(ledger.path, ledger.state);
  return check;
}

/**
 * The proceed/stop verdict against the run's ceilings. Pure over the ledger
 * state — deterministic, no clock, no I/O. "stop" the moment spent >= EITHER
 * ceiling; overshoot reported per-axis when spent exceeds one. No ceilings
 * set → always "proceed", with a note saying the run is uncapped.
 */
export function checkBudget(ledger: RunLedger): BudgetCheck {
  const s = ledger.state;
  const out: BudgetCheck = {
    runId: s.run_id,
    sessionTokens: s.session_tokens,
    agentTokens: s.agent_tokens,
    spentTokens: s.spent_tokens,
    spentUsd: s.spent_usd,
    verdict: "proceed",
  };
  if (ledger.migrationNote) out.note = ledger.migrationNote;

  if (s.ceiling_tokens === undefined && s.ceiling_usd === undefined) {
    const uncapped = "no ceiling set — budget check always proceeds";
    out.note = out.note ? `${out.note}; ${uncapped}` : uncapped;
    return out;
  }

  const overshoot: { tokens?: number; usd?: number } = {};
  const suggestion: { tokens?: number; usd?: number } = {};

  if (s.ceiling_tokens !== undefined) {
    out.ceilingTokens = s.ceiling_tokens;
    out.remainingTokens = Math.max(0, s.ceiling_tokens - s.spent_tokens);
    suggestion.tokens = out.remainingTokens;
    if (s.spent_tokens >= s.ceiling_tokens) out.verdict = "stop";
    if (s.spent_tokens > s.ceiling_tokens) {
      overshoot.tokens = s.spent_tokens - s.ceiling_tokens;
    }
  }
  if (s.ceiling_usd !== undefined) {
    out.ceilingUsd = s.ceiling_usd;
    out.remainingUsd = round4(Math.max(0, s.ceiling_usd - s.spent_usd));
    suggestion.usd = out.remainingUsd;
    if (s.spent_usd >= s.ceiling_usd) out.verdict = "stop";
    if (s.spent_usd > s.ceiling_usd) {
      overshoot.usd = round4(s.spent_usd - s.ceiling_usd);
    }
  }

  if (Object.keys(overshoot).length) out.overshoot = overshoot;
  // headroom only makes sense while the run may continue
  if (out.verdict === "proceed") out.innerBudgetSuggestion = suggestion;
  return out;
}
