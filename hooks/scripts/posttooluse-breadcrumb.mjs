#!/usr/bin/env node

/**
 * Purpose: PostToolUse hook -- after an Edit/Write/Bash tool call, refresh the
 *   project's ~/.cairn/handoff/*.json breadcrumb (created, source,
 *   uncommitted_files) so a crash still leaves a recent handoff behind.
 *   Throttled to at most one write per 60s via the handoff file's own mtime,
 *   since PostToolUse can fire many times a minute. Fire-and-forget: any
 *   error, or no handoff to patch, is a silent no-op -- a hook must never be
 *   visible to the user or block their session.
 * derives: axiom 4 (recorded-run)
 * Author(s): John Reed
 */

import { handoffPath, mtimeMs, readJson, atomicWriteJson, uncommittedFiles } from "./lib.mjs";

const THROTTLE_MS = 60_000;

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const path = handoffPath(projectDir);

  const existingMtime = mtimeMs(path);
  if (existingMtime === null) return; // no handoff yet -- breadcrumbs never scaffold one
  if (Date.now() - existingMtime < THROTTLE_MS) return; // throttled

  const existing = readJson(path);
  const merged = {
    ...existing,
    created: new Date().toISOString(),
    source: "posttooluse",
    uncommitted_files: uncommittedFiles(projectDir),
  };
  atomicWriteJson(path, merged);
}

try {
  main();
} catch {
  // swallowed by design -- hook failures must be invisible.
}
process.exit(0);
