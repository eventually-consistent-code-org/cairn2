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
import { z } from "zod";
/** ~/.cairn/budget/<projectKey>-<runId>.json — one ledger file per run,
 * outside the repo, per repository like the run it meters (#362). baseDir
 * injectable for tests. */
export declare function budgetLedgerPath(projectDir: string, runId: string, baseDir?: string): string;
/** The metrics jsonl the Stop hook writes — same path scheme as
 * hooks/scripts/lib.mjs's metricsPath, with the base dir injectable. */
export declare function budgetMetricsPath(projectDir: string, baseDir?: string): string;
/** Baseline snapshot of one pre-existing session's cumulative totals at
 * run-open — that session's spend counts as the delta past this. */
export interface BudgetBaseline {
    tokens: number;
    usd: number;
}
export interface BudgetBoundary {
    ts: string;
    phase: number | string;
    wave?: number | string;
    note?: string;
    sessions: number;
    agent_tokens?: number;
    spent_tokens: number;
    spent_usd: number;
    verdict: "proceed" | "stop";
}
export interface BudgetLedgerState {
    version: 2;
    run_id: string;
    project: string;
    opened: string;
    ceiling_tokens?: number;
    ceiling_usd?: number;
    /** Latest-row totals per session that already existed at run-open, keyed
     * by session_id — those sessions count as the delta past this snapshot. */
    baselines: Record<string, BudgetBaseline>;
    session_tokens: number;
    agent_tokens: number;
    spent_tokens: number;
    spent_usd: number;
    boundaries: BudgetBoundary[];
}
export declare const BudgetLedgerSchema: z.ZodType<BudgetLedgerState>;
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
    overshoot?: {
        tokens?: number;
        usd?: number;
    };
    /** What the executor passes down as the Workflow in-run budget (the inner
     * ceiling, #133) — the remaining headroom for the next wave. */
    innerBudgetSuggestion?: {
        tokens?: number;
        usd?: number;
    };
    note?: string;
}
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
export declare function openRunLedger(projectDir: string, opts: {
    runId: string;
    ceilingTokens?: number;
    ceilingUsd?: number;
    startedAt?: string;
    baseDir?: string;
}): RunLedger;
/**
 * Refreshes the ledger's spent totals from the metrics file, in memory only
 * (no boundary row, no write) — status displays poll through this without
 * growing the history.
 */
export declare function refreshSpend(ledger: RunLedger): RunLedger;
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
export declare function recordBoundary(ledger: RunLedger, b: {
    phase: number | string;
    wave?: number | string;
    note?: string;
    agentTokens?: number;
}): BudgetCheck;
/**
 * The proceed/stop verdict against the run's ceilings. Pure over the ledger
 * state — deterministic, no clock, no I/O. "stop" the moment spent >= EITHER
 * ceiling; overshoot reported per-axis when spent exceeds one. No ceilings
 * set → always "proceed", with a note saying the run is uncapped.
 */
export declare function checkBudget(ledger: RunLedger): BudgetCheck;
