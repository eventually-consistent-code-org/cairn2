/**
 * Purpose: the per-seat yield store — dispatch that prunes itself with
 * evidence. One versioned JSON file per project under ~/.cairn/yield/
 * (outside the repo, budget-ledger's conventions: injectable base dir,
 * per-machine path hashing, atomic tmp+rename writes, zod-validated
 * versioned schema). Per seat it counts dispatched / findingsRaised /
 * findingsSurvived; selection (signals.ts) consults these ONLY in auto
 * dial and gates a seat whose evidence says it isn't earning its pass.
 *
 * Posture on corruption: yield stats are advisory EVIDENCE, not config —
 * a corrupt file loads as a fresh empty state with a note, never a throw
 * (missing evidence means no pruning; it must never break a review).
 * That's a deliberate divergence from budget-ledger, where a corrupt
 * ledger guards real money and fails loud.
 *
 * removeWhen: a full panel on every diff costs little enough that gating
 * saves nothing worth the risk of muting a seat — the dial then stays at
 * off and this store has no reader (ADR 0011).
 * Author(s): John Reed
 */
import { z } from "zod";
/** Minimum dispatches before yield evidence may gate a seat — under this,
 * the sample is too small to prune on. */
export declare const YIELD_MIN_DISPATCHES = 10;
/** The gate line: a seat whose survival rate (surviving findings per
 * dispatch) sits UNDER this, with enough history, gets gated in auto
 * dial — fewer than one surviving finding per ten dispatches is the
 * evidence it isn't earning its pass. */
export declare const YIELD_GATE_RATE = 0.1;
export interface YieldCounters {
    /** Times this seat was dispatched into a pass. */
    dispatched: number;
    /** Findings the seat raised, any severity. */
    findingsRaised: number;
    /**
     * Findings that survived VERIFICATION — went through a refutation
     * panel in audit_record and were not refuted. Credited by the server
     * as a side effect of the record write (phase 21), never asserted by
     * the pass; dispatched/findingsRaised stay the pass's own deltas.
     */
    findingsSurvived: number;
}
export interface YieldState {
    version: 1;
    project: string;
    seats: Record<string, YieldCounters>;
}
export declare const YieldStateSchema: z.ZodType<YieldState>;
/** One pass's increments for one seat — all fields are DELTAS (added to
 * the stored counters), defaulting to 0. */
export interface YieldDelta {
    seat: string;
    dispatched?: number;
    findingsRaised?: number;
    findingsSurvived?: number;
}
/** ~/.cairn/yield/<projectKey>.json — one store per repository (#362),
 * outside the repo. baseDir injectable for tests (budget-ledger convention). */
export declare function yieldStatePath(projectDir: string, baseDir?: string): string;
/**
 * Loads the project's yield store. Missing file = fresh empty state.
 * Corrupt or wrong-versioned file = fresh empty state PLUS a note naming
 * the problem — advisory evidence never breaks the caller (see module
 * doc for why this diverges from budget-ledger's fail-loud posture).
 *
 * :param projectDir: project root (keys the per-machine file)
 * :param baseDir: state root override — test seam (default ~/.cairn)
 * :returns: the state plus a note when the file couldn't be trusted
 */
export declare function loadYield(projectDir: string, baseDir?: string): {
    state: YieldState;
    note?: string;
};
/**
 * Applies one pass's per-seat increments and persists atomically.
 * Load-modify-write against the file on disk; a corrupt existing file is
 * replaced by a fresh state carrying only these deltas (its note surfaces
 * through the return value's `note`).
 *
 * :param projectDir: project root
 * :param deltas: per-seat increments — integers >= 0 only
 * :param baseDir: state root override — test seam (default ~/.cairn)
 * :returns: the persisted state (+ load note when the old file was bad)
 * :raises CairnError: CONFIG_INVALID on a malformed delta
 */
export declare function recordYield(projectDir: string, deltas: YieldDelta[], baseDir?: string): {
    state: YieldState;
    note?: string;
};
/**
 * Survival rate — surviving findings per dispatch (the currency the gate
 * judges in). Null when the seat has never been dispatched: no evidence
 * is not the same as zero yield.
 *
 * :param c: one seat's counters
 * :returns: findingsSurvived / dispatched, or null when dispatched is 0
 */
export declare function yieldRate(c: YieldCounters): number | null;
