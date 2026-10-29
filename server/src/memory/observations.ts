import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { metricsSegments } from "../core/metrics.js";

/**
 * The observation buffer's own state (#173). The PostToolUse hook appends a
 * row per Edit/Write/Bash call to `.cairn/observations/observations.jsonl`
 * and retro is the only reader — so when retro never runs, the buffer grows
 * silently until the hook's retention guard quietly drops the oldest closed
 * segment. Work that was never reviewed disappears without anyone being told.
 *
 * The log is segmented (#351): past its cap the hook renames the live file to
 * a stamped closed segment (`observations.<stamp>.jsonl`) and appends to a
 * fresh one, so the buffer is the live file plus every closed segment, in the
 * same shape as the metrics log (`metricsSegments`).
 * Invariant: retro is the single consumer — the only thing that deletes rows —
 * and hooks only ever append or rename, which is why no lock exists.
 *
 * This module is the announcement: a count and an oldest-entry age that
 * `mem_stats` reports and the recall banner escalates into "run retro".
 * Capture stays passive and review stays retro-gated — nothing here reads a
 * row's contents, promotes anything to memory, or truncates the file.
 *
 * Deliberately independent of the FTS index, for the same reason the card
 * audit is (see audit.ts): the index needs a compiled native binding that
 * can be missing, and a backlog warning that dies exactly when memory is
 * unhealthy is the wrong shape. Everything here reads one plain file.
 */

/** Rows in the buffer before the banner starts asking for a retro. */
export const OBSERVATION_WARN_THRESHOLD = 25;

const DAY_MS = 86_400_000;

/** The live file the PostToolUse observe hook appends to. Single source of truth. */
export const observationsPath = (projectDir: string): string =>
  join(projectDir, ".cairn", "observations", "observations.jsonl");

export interface ObservationBacklog {
  /** Rows currently in the buffer, live file plus closed segments — every
   *  non-blank line, parseable or not. */
  count: number;
  /** ISO timestamp of the oldest row, or null when the buffer is empty/undated. */
  oldest: string | null;
  /** Whole days since that oldest row; 0 when there is nothing to age. */
  oldestAgeDays: number;
  /** The configured threshold this count is measured against. */
  threshold: number;
  /** count >= threshold — the banner speaks up only past this line. */
  overThreshold: boolean;
}

/**
 * The configured warn threshold, falling back to the shipped default for a
 * project with no (or unreadable) cairn.json. A backlog report must not fail
 * on config the way a tracker call would — the whole point is to keep
 * reporting when other things are broken.
 *
 * :param projectDir: repository root
 * :returns: positive row count at which the banner warns
 */
export function observationThreshold(projectDir: string): number {
  try {
    return loadConfig(projectDir).memory.observationWarnThreshold;
  } catch {
    return OBSERVATION_WARN_THRESHOLD;
  }
}

/**
 * Reads the buffer — every segment, oldest first, live file last — and
 * reports its size and age. Never throws: a missing file or segment is
 * empty, and a row that will not parse still counts as a row the buffer is
 * holding (it is occupying the retention budget either way) — it just cannot
 * contribute an age. The oldest age is the minimum ts across all segments.
 *
 * :param projectDir: repository root
 * :param now: injectable clock for age math
 * :returns: the backlog block reported by mem_stats and read by the banner
 */
export function observationBacklog(
  projectDir: string,
  now: number = Date.now(),
): ObservationBacklog {
  const threshold = observationThreshold(projectDir);
  let lines: string[] = [];
  for (const segment of metricsSegments(observationsPath(projectDir))) {
    try {
      lines = lines.concat(readFileSync(segment, "utf8").split("\n"));
    } catch {
      // missing live file (just rotated) or a segment pruned mid-read -- empty
    }
  }

  let count = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let oldest: string | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    count++;
    let ts: unknown;
    try {
      ts = (JSON.parse(line) as { ts?: unknown }).ts;
    } catch {
      continue; // half-written row from a killed hook -- counted, undated
    }
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = ts;
    }
  }

  // Floored at 0 so a row written a clock-skew second into the future reads
  // as "today" rather than as a negative age.
  const oldestAgeDays =
    oldest === null ? 0 : Math.max(0, Math.floor((now - oldestMs) / DAY_MS));

  return { count, oldest, oldestAgeDays, threshold, overThreshold: count >= threshold };
}
