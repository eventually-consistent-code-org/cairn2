/**
 * Purpose: seat roster resolution — shipped defaults (templates/seats/ in
 * the plugin) merged with project seats (.cairn/roles/, a read path only:
 * the server never writes there), then filtered/ordered by cairn.json's
 * optional `seats` block. Per-file tolerance is the design center: one bad
 * seat file skips that seat with a note, never the roster.
 * Author(s): John Reed
 */

// Imports
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { parseSeatDoc, type Seat, type Stage } from "./schema.js";


// Constants

// Shipped defaults live in the plugin's templates tree, not server/ —
// resolved relative to this module, which sits three levels below the
// repo/plugin root from both src/seats/ and dist/seats/ (same trick as
// peers/findings.ts).
const DEFAULT_ROOT_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const SHIPPED_SUBDIR = join("templates", "seats");
const PROJECT_SUBDIR = join(".cairn", "roles");


// Types

export interface RosterSeat {
  /** Seat name (frontmatter `name` when valid, file stem when not). */
  name: string;
  source: "default" | "project";
  /** False means the definition failed validation — skipped, never fatal. */
  valid: boolean;
  note?: string;
  /** Validated definition — present only when valid. */
  seat?: Seat;
  /** The lens prose below the frontmatter — present only when valid. */
  body?: string;
  /** Where the definition file lives. */
  path: string;
}

export interface Roster {
  seats: RosterSeat[];
  /** Roster-level advisories (e.g. an enabled name that matched nothing). */
  notes: string[];
  /** What a verb's `inherit` dial resolves to: cairn.json seats.dispatch,
   * or `auto` when unset (#345) -- the cheaper, reliable path is the
   * default; `off` is the explicit opt-in for the full roster. */
  dispatch: "auto" | "off";
}


// Loading

/**
 * Reads every *.md seat definition under one directory, in filename order.
 * A file that fails validation becomes a valid:false entry carrying the
 * error message — the rest of the directory still loads.
 *
 * :param dirPath: directory to scan (missing/unreadable = empty, not fatal)
 * :param source: provenance stamped on every entry
 * :returns: one entry per file, valid or not
 */
function readSeatDir(
  dirPath: string,
  source: "default" | "project",
): RosterSeat[] {
  let files: string[];
  try {
    files = readdirSync(dirPath)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const out: RosterSeat[] = [];
  for (const f of files) {
    const path = join(dirPath, f);
    try {
      const { seat, body } = parseSeatDoc(readFileSync(path, "utf8"), path);
      out.push({ name: seat.name, source, valid: true, seat, body, path });
    } catch (e) {
      out.push({
        name: basename(f, ".md"),
        source,
        valid: false,
        note: e instanceof CairnError ? e.message : String(e),
        path,
      });
    }
  }
  return out;
}

/**
 * Resolves the merged seat roster for a project.
 *
 * Resolution rules:
 * - shipped defaults load from templates/seats/ (filename order), project
 *   seats from .cairn/roles/ — a project seat whose NAME matches a default
 *   replaces it in place (source flips to "project"); a new name appends
 * - a duplicate name within the same source keeps the first file; the later
 *   one lands as valid:false with a note
 * - an invalid file never shadows anything — the seat it would have defined
 *   is skipped with a note, the roster still loads
 * - cairn.json's optional `seats` block then filters/orders: `enabled`
 *   picks the roster (in its order; unknown names become roster notes),
 *   `disabled` removes names; absent block = every default enabled, i.e.
 *   today's behavior
 *
 * :param projectDir: project root (must hold cairn.json)
 * :param rootDir: plugin root override — test seam for the shipped dir
 * :returns: the resolved roster, invalid entries included for visibility
 */
export function loadRoster(
  projectDir: string,
  rootDir: string = DEFAULT_ROOT_DIR,
): Roster {
  const config = loadConfig(projectDir).seats;
  const notes: string[] = [];

  // Merge defaults + project by name, project winning in place.
  const merged: RosterSeat[] = [];
  const indexByName = new Map<string, number>();
  const entries = [
    ...readSeatDir(join(rootDir, SHIPPED_SUBDIR), "default"),
    ...readSeatDir(join(projectDir, PROJECT_SUBDIR), "project"),
  ];
  for (const entry of entries) {
    if (!entry.valid) {
      merged.push(entry);
      continue;
    }
    const existing = indexByName.get(entry.name);
    if (existing === undefined) {
      indexByName.set(entry.name, merged.length);
      merged.push(entry);
    } else if (merged[existing].source === entry.source) {
      // Same-source duplicate: first file wins, later one skipped with a note.
      merged.push({
        ...entry,
        valid: false,
        seat: undefined,
        body: undefined,
        note: `duplicate seat name '${entry.name}' — already defined by ${merged[existing].path}; this file is ignored`,
      });
    } else {
      // Project over default, position kept.
      merged[existing] = entry;
    }
  }

  // Enablement filtering — valid entries only; invalid ones stay visible.
  let seats = merged;
  if (config?.enabled) {
    const chosen: RosterSeat[] = [];
    for (const name of config.enabled) {
      const idx = indexByName.get(name);
      const match = idx === undefined ? undefined : merged[idx];
      if (match?.valid) {
        chosen.push(match);
      } else {
        notes.push(
          `enabled seat '${name}' matched no valid definition in templates/seats/ or .cairn/roles/ — skipped`,
        );
      }
    }
    seats = [...chosen, ...merged.filter((e) => !e.valid)];
  }
  if (config?.disabled?.length) {
    const disabled = new Set(config.disabled);
    seats = seats.filter((e) => !(e.valid && disabled.has(e.name)));
  }

  return { seats, notes, dispatch: config?.dispatch ?? "auto" };
}


// Stage filtering

/**
 * Picks the roster seats that convene at one stage, roster order kept.
 * Review's diff panel is exactly seatsForStage(roster, "review"): stage
 * `review` (the default) or `any`. Plan-stage seats never join the diff
 * panel — they convene at plan time via seatsForStage(roster, "plan").
 * Valid seats only; invalid entries stay on the roster itself for the
 * caller's visibility reporting.
 *
 * :param roster: resolved roster (loadRoster)
 * :param stage: the convening stage — review or plan (never "any": that
 *   value belongs to seat definitions, meaning "both stages")
 * :returns: the seats seated at that stage, in roster order
 */
export function seatsForStage(
  roster: Roster,
  stage: Exclude<Stage, "any">,
): RosterSeat[] {
  return roster.seats.filter(
    (s): s is RosterSeat & { seat: Seat } =>
      s.valid &&
      s.seat !== undefined &&
      (s.seat.stage === stage || s.seat.stage === "any"),
  );
}
