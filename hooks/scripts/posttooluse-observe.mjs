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
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_LINES = 2000;
const KEEP_LINES = 1000;

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

  // Retention guard (CRN-27): the log must not grow unbounded.
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_LINES) {
    writeFileSync(path, lines.slice(-KEEP_LINES).join("\n") + "\n");
  }
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
