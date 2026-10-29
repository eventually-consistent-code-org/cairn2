/**
 * Purpose: signal→seat dispatch — derives normalized scope signals from a
 * diff summary, selects which roster seats fire under the dispatch dial,
 * and resolves the model a seat's work routes to. Pure over its inputs
 * (no I/O): the caller loads the roster and yield stats and passes them
 * in. The model-routing blast-radius rule ALWAYS beats a seat's model
 * preference — encoded here, not left to verb prose.
 * Author(s): John Reed
 */
import type { Seat } from "./schema.js";
import type { Roster, RosterSeat } from "./roster.js";
import { type YieldCounters } from "./yield.js";
export declare const DIFF_SMALL_MAX = 50;
export declare const DIFF_LARGE_MIN = 500;
export declare const YIELD_EXEMPT_SEAT_NAMES: ReadonlySet<string>;
export interface DiffSummary {
    /** Changed file paths, repo-relative. */
    files: string[];
    insertions: number;
    deletions: number;
}
/** The dispatch dial. `off` (the DEFAULT) = full roster fires — today's
 * behavior. `auto` = signal/yield selection below. `inherit` = follow
 * cairn.json `seats.dispatch`, itself defaulting to off. */
export type DispatchDial = "auto" | "inherit" | "off";
export interface GatedSeat {
    name: string;
    reason: "no-matching-signals" | "low-yield";
    /** One human-readable line — lands verbatim in the review record. */
    note: string;
}
export interface SeatSelection {
    /** The dial after `inherit` resolution — what actually governed. */
    effectiveDial: "auto" | "off";
    /** Valid seats that fire this pass, in roster order. */
    fired: RosterSeat[];
    /** Valid seats gated this pass — every one reported, never silent. */
    gated: GatedSeat[];
}
/**
 * Derives the normalized signal set for one diff summary. Emits ONLY the
 * standard vocabulary documented above; output is deduped and sorted.
 * Negative or missing line counts read as 0 — garbage in never widens
 * the diff-size signals.
 *
 * :param diff: changed paths + insertion/deletion totals
 * :returns: sorted unique signal names
 */
export declare function deriveSignals(diff: DiffSummary): string[];
/**
 * Picks which roster seats fire this pass.
 *
 * Selection rules:
 * - dial `off` (the DEFAULT): every valid seat fires — today's full-panel
 *   behavior, untouched.
 * - dial `inherit`: resolves to cairn.json `seats.dispatch` (carried on the
 *   roster), itself defaulting to off.
 * - dial `auto`:
 *   - a seat with NO signals declared always fires — declaring signals is
 *     how a seat opts into gating (signal AND yield);
 *   - a seat whose signals intersect the derived set fires, unless the
 *     yield gate holds: >= YIELD_MIN_DISPATCHES dispatches recorded AND
 *     survival rate < YIELD_GATE_RATE — then it's gated with an explicit
 *     note. The security seat and any dose "full" seat are never
 *     yield-gated (the conservative floor);
 *   - a seat whose signals miss entirely is gated "no-matching-signals".
 * - invalid roster entries neither fire nor gate — the roster's own notes
 *   already report them.
 * Every gated seat comes back with a reportable note — never silent.
 *
 * :param roster: resolved roster (loadRoster)
 * :param signals: derived signal set (deriveSignals)
 * :param opts.dial: auto | inherit | off
 * :param opts.yields: per-seat yield counters (loadYield().seats) —
 *   consulted ONLY in auto dial; omit to skip yield gating
 * :returns: fired seats (roster order) + gated seats with notes
 */
export declare function selectSeats(roster: Roster, signals: string[], opts: {
    dial: DispatchDial;
    yields?: Record<string, YieldCounters>;
}): SeatSelection;
/** Work class of the output a seat is producing, per the four-class
 * cairn-planning model-routing rubric: `gate` = judgment gates (output that
 * gates a lifecycle transition: verify/ship); `complex` = complex synthesis
 * (architecture trade-offs, a change that adds a mechanism or a seam);
 * `routine` = routine synthesis (briefs, analysis, docs); `mechanical` =
 * enumerate/locate. */
export type WorkClass = "mechanical" | "routine" | "complex" | "gate";
/** A routed model: a named tier, or `strongest` = the strongest model
 * available (as of 2026-10, Fable, a tier above opus) — the caller passes
 * that model's id, or omits the model when the session already runs it. */
export type RoutedModel = "haiku" | "sonnet" | "opus" | "strongest";
export interface ModelResolution {
    model: RoutedModel;
    /** True when the rubric overrode the seat's declared preference. */
    overrode: boolean;
    reason: string;
}
/** The server-side copy of the rubric table. `label` is the row's work-class
 * cell in skills/cairn-planning/SKILL.md; a test pins this table equal to
 * that one so the two cannot drift. */
export declare const ROUTING_TABLE: Record<WorkClass, {
    label: string;
    model: RoutedModel;
    effort: "low" | "medium" | "high";
}>;
/**
 * Resolves the model a seat's work routes to. The seat's `model` field is
 * ADVISORY ONLY — the cairn-planning blast-radius rule always wins:
 * output that gates a lifecycle transition (work class `gate`) routes to
 * the strongest tier regardless of any seat preference, and no preference
 * ever routes a work class BELOW its rubric floor (downgrade only
 * mechanical work). A preference at or above the floor is honored.
 * Verbs consume this as guidance; the rule lives here so it is tested,
 * not re-derived in prose.
 *
 * :param seat: validated seat definition (its `model` is the preference)
 * :param workClass: mechanical | routine | complex | gate
 * :returns: the routed model + whether the seat's preference was overridden
 */
export declare function resolveSeatModel(seat: Seat, workClass: WorkClass): ModelResolution;
