#!/usr/bin/env node

/**
 * Purpose: PostToolUse loop check (#214) -- notices when the same tool is
 *   called with the same input several times in a row and says so, once.
 *   An agent stuck re-running an identical call is not making progress: the
 *   result will not change, so the input has to, or the problem belongs in
 *   a trace. Advisory only -- this hook NEVER blocks a call.
 *
 *   State is one small file per project, holding the current streak (tool +
 *   input hash + count) and the session it belongs to. Any different call
 *   resets the streak, and a new session starts clean. The nudge fires at
 *   exactly the threshold, not on every call past it: the point is to be
 *   noticed once, not to nag a legitimate repetition into the ground.
 *
 *   Fire-and-forget like its sibling breadcrumb hook: one small read and
 *   one small write, no git and no network, so it stays well inside the
 *   same wall-clock budget, and any error is a silent no-op.
 *
 * removeWhen: the platform detects and surfaces repeated identical tool
 *   calls itself.
 * derives: axiom 2 (mechanism-vs-judgment)
 * Author(s): John Reed
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loopStatePath, atomicWriteJson } from "./lib.mjs";

/** Consecutive identical calls before the advisory fires. */
const THRESHOLD = 3;

/**
 * Key-sorted JSON so that two structurally identical inputs hash alike
 * regardless of key order. Depth-limited: tool inputs are shallow, and a
 * cycle must never cost the session a stack overflow.
 */
function stableStringify(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], depth + 1)}`).join(",")}}`;
}

function callHash(toolName, toolInput) {
  return createHash("sha256")
    .update(`${toolName}\0${stableStringify(toolInput ?? null)}`)
    .digest("hex")
    .slice(0, 16);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // absent or corrupt -- either way, this call starts a fresh streak
  }
}

function main() {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const toolName = payload?.tool_name;
  if (!toolName) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? payload?.cwd ?? process.cwd();
  const session = payload?.session_id ?? "";
  const path = loopStatePath(projectDir);

  const prev = readState(path);
  const hash = callHash(toolName, payload?.tool_input);
  const continues = prev && prev.hash === hash && prev.session === session;
  const count = continues ? (prev.count ?? 0) + 1 : 1;

  atomicWriteJson(path, { version: 1, session, hash, tool: toolName, count });

  // Exactly at the threshold: one line, then quiet for the rest of the streak.
  if (count !== THRESHOLD) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `Heads up: that was ${THRESHOLD} identical ${toolName} calls in a row — same tool, ` +
        "same input. The result will not change on a fourth. Change something about the " +
        "input, try a different approach, or if this is a bug you are chasing, open a trace " +
        "so the evidence is kept.",
    },
  }));
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
