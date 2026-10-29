#!/usr/bin/env node

/**
 * Purpose: PostToolUse + PostToolUseFailure hook -- append one observation row per
 *   Edit/Write/Bash call to .cairn/observations/observations.jsonl: which
 *   tool, which target, did it error. Raw material for retro's candidate-card
 *   review (repeated error->fix churn, hotspot files) -- observations NEVER
 *   inject into context or become memory on their own; retro is the gate.
 *   Only fires in cairn-initialized projects (.cairn/ exists). Capped,
 *   fire-and-forget, invisible on failure.
 *
 *   Which event carries which flag (#323): Claude Code emits NO PostToolUse
 *   event for a call that fails -- a failed call arrives as PostToolUseFailure
 *   instead, with no tool_response at all (just an `error` string and
 *   `is_interrupt`). So every PostToolUseFailure row is error: true, and a
 *   PostToolUse row is error: true only when a harness that does deliver
 *   failures there (Cursor's adapter, a tool_response carrying is_error /
 *   success:false / a non-zero exit_code) says so. Before this both events
 *   were not wired and the flag was dead -- always false. One exception
 *   (#324): a PostToolUseFailure with is_interrupt true is the owner hitting
 *   Escape, not the tool failing -- that row keeps error: false and carries
 *   interrupted: true instead, so retro never reads a cancellation as churn.
 * derives: axiom 4 (recorded-run)
 * Author(s): John Reed
 */

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { metricsSegments } from "./lib.mjs";

// Retention guard (CRN-27), segmented (#351). The live file is CLOSED --
// renamed to a stamped segment, never rewritten -- once it passes MAX_LINES,
// and on that rotation the oldest closed segments go once the newer ones
// already hold KEEP_CLOSED_LINES rows. So the log keeps roughly the old
// 1000..2000-row window, and a row is only ever dropped by deleting a whole
// segment nobody appends to any more.
const MAX_LINES = 1000;
const KEEP_CLOSED_LINES = 1000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** A short, leak-safe target label: file basename-ish path or command head. */
function targetOf(payload) {
  const input = payload.tool_input ?? {};
  if (typeof input.file_path === "string") return input.file_path.slice(-120);
  if (typeof input.command === "string") return input.command.slice(0, 80);
  return undefined;
}

/** The owner cancelled the call (Escape) -- a PostToolUseFailure that is not an error. */
function interrupted(payload) {
  return payload.is_interrupt === true;
}

function errored(payload) {
  if (interrupted(payload)) return false;
  // A failed call only ever arrives on PostToolUseFailure -- that event IS the flag.
  if (payload.hook_event_name === "PostToolUseFailure") return true;
  if (typeof payload.error === "string" && payload.tool_response == null) return true;
  const resp = payload.tool_response;
  if (resp == null) return false;
  if (resp.is_error === true || resp.success === false) return true;
  if (typeof resp.exit_code === "number" && resp.exit_code !== 0) return true;
  return false;
}

/** Non-blank line count of `path`; 0 for a missing file. */
function lineCount(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Fixed-width UTC stamp for a closed segment: 20260920-143000. Fixed width
 *  is what makes a lexical sort chronological -- same as the metrics log. */
function segmentStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Close the live file once it passes MAX_LINES, AFTER this row landed.
 *
 * Concurrency -- the three handoff questions:
 *   atomicity -- the handoff is one appendFileSync of one short line under
 *     O_APPEND; the rename below is one syscall. Nothing reads, trims and
 *     writes back, so there is no read-modify-write to lose a row in.
 *   visibility -- a reader may see a torn last row; observations.ts counts it
 *     and skips its age. A hook that opened the live file just before another
 *     renamed it still writes into the same inode, now the closed segment --
 *     the row moves with the file, it is never lost.
 *   ordering -- none across sessions. Rows carry their own ts; readers take
 *     the oldest ts, never file position, so two writers interleaving is fine.
 * Two hooks can both see the count past the cap; the loser renames the fresh
 * (empty or near-empty) live file or finds it gone, and either way keeps
 * every row. A fresh empty live file is opened with "a", which never truncates.
 * Returns true when this call closed a segment.
 */
function rotate(path) {
  if (lineCount(path) <= MAX_LINES) return false;

  const stem = path.replace(/\.jsonl$/, "");
  const stamp = segmentStamp(new Date());
  // The counter is always present so every closed name is the same width.
  for (let n = 0; n < 100; n++) {
    const candidate = `${stem}.${stamp}-${String(n).padStart(2, "0")}.jsonl`;
    if (existsSync(candidate)) continue;
    try {
      renameSync(path, candidate);
    } catch {
      return false; // another hook rotated first -- its rename kept every row
    }
    closeSync(openSync(path, "a"));
    return true;
  }
  return false; // 100 rotations inside one second -- keep the data, skip the roll
}

/**
 * Drop closed segments older than the newest KEEP_CLOSED_LINES rows. Walks
 * newest first and counts rows, not files, so a tiny segment left by two
 * hooks racing the same rotation never evicts a full one. The live file is
 * never a candidate.
 */
function prune(path) {
  const closed = metricsSegments(path).slice(0, -1).reverse();
  let kept = 0;
  for (const segment of closed) {
    if (kept >= KEEP_CLOSED_LINES) {
      rmSync(segment, { force: true });
      continue;
    }
    kept += lineCount(segment);
  }
}

function main() {
  const payload = readStdin();
  if (!payload?.tool_name) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (!existsSync(join(projectDir, ".cairn"))) return; // cairn projects only

  const dir = join(projectDir, ".cairn", "observations");
  const path = join(dir, "observations.jsonl");
  const row = {
    ts: new Date().toISOString(),
    session_id: payload.session_id,
    tool: payload.tool_name,
    target: targetOf(payload),
    error: errored(payload),
  };
  if (interrupted(payload)) row.interrupted = true;
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");

  // Pruning reads every segment, so it runs only on the rare rotation.
  if (rotate(path)) prune(path);
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
