/**
 * Purpose: wave-brief composition — `work`'s per-issue dispatch briefs,
 * composed from templates/wave-brief.md plus an optional roster seat
 * (and that seat's role-scoped memory cards) instead of freehand
 * retyping. Same {{slot}} mechanism as the peers
 * templates: every occurrence of a provided slot is replaced, and the
 * seat framing rides at the seat's declared dose. No tool surface — the
 * work verb reads the template + seat_roster directly; this module is
 * the tested reference composition (and the future server-side path).
 * Author(s): John Reed
 */
import type { Seat } from "./schema.js";
export interface RoleCard {
    /** The card body — the remembered fact itself. */
    body: string;
    /** The card's confidence grade, when it carries one. */
    confidence?: "high" | "medium" | "low";
    /** Card creation date (YYYY-MM-DD, from the card frontmatter). */
    created: string;
    /** Provenance-checked staleness — true marks the line as possibly rotten. */
    stale: boolean;
}
/**
 * Where a worker's model came from — the steps of work.md's resolution,
 * in its order: the agents.model pin, the task's `model:` annotation, the
 * rubric's work class, or inherit (a task nobody could classify).
 */
export type ModelSource = "pin" | "annotation" | "rubric" | "inherit";
export interface ModelRoute {
    /**
     * The model the worker runs on — a tier alias (haiku, sonnet, opus) or
     * the strongest tier's model id. Absent = the session model, inherited.
     */
    model?: string;
    /** Which resolution step decided it. */
    by: ModelSource;
    /** The work class the rubric read — rubric resolutions only. */
    workClass?: string;
}
export interface BriefInput {
    /** Validated roster seat — absent means a generic (seatless) brief. */
    seat?: Seat;
    /** The seat's lens prose body — rides into the brief only at dose "full". */
    seatBody?: string;
    /**
     * Role-scoped memory cards (scopeRole = seat name) — rendered as a short
     * "what this seat remembers" section below the plan excerpt. Absent or
     * empty skips the section entirely: output stays byte-identical to a
     * roleCards-less compose.
     */
    roleCards?: RoleCard[];
    /** Tracker issue content: id, title, body — lands verbatim under Task. */
    issue: string;
    /** This issue's PLAN.md task text (+ any locked decisions that bind it). */
    planExcerpt: string;
    /** Wave-specific rule details: base sha, setup commands, trailer block. */
    rules?: string;
    /**
     * The worker's resolved model (#406) — one line in the {{model}} slot
     * beside the rules. Absent renders the inherit line, so a brief nobody
     * routed says so rather than staying silent about its tier.
     */
    model?: ModelRoute;
    /** Repo/plugin root override — test seam for the template location. */
    rootDir?: string;
}
/**
 * Composes one wave dispatch brief from templates/wave-brief.md.
 *
 * Seatless composition fills the framing slot empty — the generic brief,
 * structurally identical to the hand-written ones this replaces. With a
 * seat, the framing section leads, quoting lens/categories/honesty at
 * the seat's dose. An unprovided optional slot renders empty (never a
 * dangling {{marker}}) — except {{model}}, which always renders a line,
 * the inherit line when no route is given; blank-line runs left by empty
 * slots collapse, and a trailing run is trimmed — the standing rules
 * land last, so an empty {{rules}} must not leave the brief ending in
 * whitespace.
 *
 * Section order is the template's, not this function's: static framing
 * first (the cacheable prefix), then issue and plan, then the dated
 * seat memory, and the invariants last at the attention peak — the
 * model line among them, {{rules}} after it. Both files move together
 * or the composed brief and the template disagree.
 *
 * :param input: seat (optional), issue content, plan excerpt, rules, model route
 * :returns: the filled brief text, ready to hand a wave worker
 * :raises CairnError: code NOT_FOUND when the template file is missing
 */
export declare function composeBrief(input: BriefInput): string;
