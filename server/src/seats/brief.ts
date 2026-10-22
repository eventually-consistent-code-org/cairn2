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

// Imports
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CairnError } from "../errors.js";
import type { Seat } from "./schema.js";


// Constants

// The template lives in the plugin's templates tree, not server/ —
// resolved relative to this module, which sits three levels below the
// repo/plugin root from both src/seats/ and dist/seats/ (same trick as
// roster.ts and peers/findings.ts).
const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const TEMPLATE_PATH = join("templates", "wave-brief.md");


// Types

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


// Composition

/**
 * Renders the seat-framing section at the seat's declared dose:
 * minimal = lens only; standard = + categories + honesty line;
 * full = + scale anchors + the lens prose body.
 *
 * :param seat: validated seat definition
 * :param body: the lens prose below the seat's frontmatter (full dose only)
 * :returns: the markdown framing section
 */
function seatFraming(seat: Seat, body?: string): string {
  const lines = [`## Seat: ${seat.name}`, "", `Lens: ${seat.lens}`];
  if (seat.dose !== "minimal") {
    lines.push(`Categories: ${seat.categories.join(", ")}`);
    lines.push(`Honesty: ${seat.scale.honesty}`);
  }
  if (seat.dose === "full") {
    const a = seat.scale.anchors;
    const anchors = [`10 — ${a.ten}`];
    if (a.five) anchors.push(`5 — ${a.five}`);
    if (a.zero) anchors.push(`0 — ${a.zero}`);
    lines.push(`Anchors: ${anchors.join("; ")}`);
    if (body?.trim()) {
      lines.push("", body.trim());
    }
  }
  return lines.join("\n");
}

/**
 * Renders the "what this seat remembers" section — one line per
 * role-scoped card, newest-first order left to the caller. A stale card
 * (provenance rotted) is marked inline so the reader weighs it lightly.
 *
 * Every line here carries a date and possibly a staleness mark, which is
 * exactly the content that must not sit in the brief's cacheable prefix
 * — so this renders into its own {{seat_memory}} slot below the plan
 * excerpt, not into the seat framing at the top.
 *
 * :param cards: role-scoped card summaries, already staleness-checked
 * :returns: the markdown memory section
 */
function roleMemory(cards: RoleCard[]): string {
  const lines = ["## What this seat remembers", ""];
  for (const c of cards) {
    const meta = [c.created];
    if (c.confidence) meta.push(`confidence ${c.confidence}`);
    if (c.stale) meta.push("STALE — verify before leaning on it");
    lines.push(`- (${meta.join("; ")}) ${c.body.trim().replace(/\s*\n\s*/g, " ")}`);
  }
  return lines.join("\n");
}

/**
 * Renders the {{model}} line — which model this worker runs on and which
 * resolution step picked it, plus the one rule that follows from it: a
 * worker sizes its own delegation to its tier. Per-task content, so it
 * renders beside the rules at the bottom, never into the cached prefix.
 *
 * :param route: the resolved route, or undefined when nobody routed it
 * :returns: the one-line model note
 */
function modelLine(route?: ModelRoute): string {
  // Who picked the tier, in the words the wave report's `by` column uses
  let tier = route?.model ?? "the session model";
  let why: string;
  if (!route) {
    tier = "the session model, inherited";
    why = "no routing was resolved for this task";
  } else if (route.by === "pin") {
    why = route.model ? "pinned by agents.model" : "agents.model is inherit";
  } else if (route.by === "annotation") {
    why = "the task's `model:` annotation";
  } else if (route.by === "rubric") {
    why = `${route.workClass ?? "its"} work, by the routing rubric`;
  } else {
    tier = "the session model, inherited";
    why = "the task could not be classified";
  }
  return `Model: ${tier} — ${why}. Any subagent you spawn runs at or below this tier.`;
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
export function composeBrief(input: BriefInput): string {
  const rootDir = input.rootDir ?? DEFAULT_ROOT_DIR;
  const path = join(rootDir, TEMPLATE_PATH);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CairnError(
      "NOT_FOUND",
      "wave-brief template not found",
      `expected it at ${TEMPLATE_PATH}`,
    );
  }

  // The doc comment atop the template is for template editors, not
  // workers — strip it (and only it) before filling, so the slot names
  // it mentions don't get filled as if they were live slots.
  text = text.replace(/^<!--[\s\S]*?-->\s*/, "");

  // Two slots, split on cacheability: the seat framing is the same bytes
  // for every worker in a wave (prefix, keep it static), the seat's
  // memory carries card dates and staleness marks (dynamic, keep it out
  // of the prefix). Either absent just drops its slot out.
  const slots: Record<string, string> = {
    seat_framing: input.seat ? seatFraming(input.seat, input.seatBody) : "",
    issue: input.issue,
    plan_excerpt: input.planExcerpt,
    seat_memory: input.roleCards?.length ? roleMemory(input.roleCards) : "",
    // Always filled: a brief nobody routed says it inherits, rather than
    // leaving the worker to guess its tier (#406)
    model: modelLine(input.model),
    rules: input.rules ?? "",
  };
  for (const [key, value] of Object.entries(slots)) {
    text = text.split(`{{${key}}}`).join(value);
  }

  // Empty slots leave stacked blank lines behind — collapse, don't ship.
  // {{rules}} is the last line in the file now, so trim the tail too.
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n");
}
