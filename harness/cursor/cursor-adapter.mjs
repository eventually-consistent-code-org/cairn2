#!/usr/bin/env node

/**
 * Purpose: Cursor hooks adapter (CRN-71 wave 3) -- one entry point for every
 *   Cursor hook event. Translates Cursor's hook payload (hook_event_name,
 *   workspace_roots, command/file_path/...) into the Claude-hook shape
 *   cairn's hook scripts already consume, runs the right script, and
 *   translates exit codes back into Cursor's response contract
 *   ({permission} for before* events, {additional_context} for sessionStart).
 *   Any internal error answers safely (allow / {}) -- hooks must never
 *   break the session because THEY broke -- except preToolUse, below.
 *
 *   preToolUse (#269) runs the two guards that only Claude Code ran before:
 *   Shell goes to the run guard and the harness guard as a Bash call, the
 *   file tools go to the harness guard, and every MCP:<name> call goes to
 *   both as the MCP call Claude Code would send (#313): mcp__cursor__<name>,
 *   its tool_input untouched, so #310's path and command-field rules judge
 *   it the same way. That entry is set failClosed, and anything short of a
 *   clean answer from a guard (a crash, a timeout, a missing script) denies
 *   here too -- a guard that didn't run never reads as allow.
 *   Confirmed in Cursor's hooks docs: preToolUse fires for every tool;
 *   tool_name is Shell, Read, Write, Grep, Delete, Task or MCP:<name>;
 *   Shell's tool_input carries command and working_directory; the answer
 *   is {permission: allow|deny, user_message, agent_message}; failClosed
 *   blocks on a hook crash or timeout.
 *   Assumed (the docs show no Write or Delete payload): the file path's
 *   field name -- PATH_KEYS, tried in order -- and the tool names Edit,
 *   StrReplace and MultiEdit, mapped in case edits arrive under them. A
 *   file-tool call with none of those fields is denied, so a wrong guess
 *   fails loud, not open. Delete is judged as an `rm -rf` of its path.
 * Author(s): John Reed
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Constants

// Cursor tools that change a file, and the fields its path may arrive in.
const FILE_TOOLS = new Set(["Write", "Edit", "StrReplace", "MultiEdit", "Delete"]);
const PATH_KEYS = ["file_path", "path", "target_file", "filePath", "targetFile", "file", "target", "uri"];

// Scripts live next to this adapter when installed (.cursor/hooks/cairn/),
// or in hooks/scripts/ when running from a cairn repo clone.
const here = dirname(fileURLToPath(import.meta.url));
function scriptPath(name) {
  const installed = join(here, name);
  if (existsSync(installed)) return installed;
  return join(here, "..", "..", "hooks", "scripts", name);
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Runs a cairn hook script with a Claude-shaped payload on stdin.
function runScript(name, childPayload, projectDir) {
  return spawnSync(process.execPath, [scriptPath(name)], {
    input: JSON.stringify(childPayload),
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

// A preToolUse denial in Cursor's shape.
function deny(userMessage, agentMessage) {
  respond({ permission: "deny", user_message: userMessage, agent_message: agentMessage.trim() });
}

// Every file path a Cursor file-tool call names, under any of PATH_KEYS.
function filePaths(input) {
  const out = [];
  for (const k of PATH_KEYS) {
    const v = input?.[k];
    if (typeof v !== "string" || !v) continue;
    out.push(v.startsWith("file:") ? fileURLToPath(v) : v);
  }
  return [...new Set(out)];
}

// A path as one single-quoted shell word.
function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// preToolUse (#269): the run guard and the harness guard, Claude-shaped.
function preToolUse(payload, projectDir) {
  const tool = payload?.tool_name ?? "";
  const input = payload?.tool_input ?? {};
  // only a string folder: an MCP input is free-form, and a guard handed an object for cwd would crash open
  const cwd = [input.working_directory, payload?.cwd].find((d) => typeof d === "string" && d) || projectDir;
  const checks = [];
  if (tool === "Shell") {
    const bash = { tool_name: "Bash", tool_input: { command: input.command ?? "" }, cwd };
    checks.push(["run guard", "pretooluse-runguard.mjs", bash], ["harness guard", "pretooluse-harnessguard.mjs", bash]);
  } else if (FILE_TOOLS.has(tool)) {
    const paths = filePaths(input);
    if (!paths.length) {
      deny("cairn harness guard couldn't read which file this changes, so it was blocked.",
        `cairn harness guard: Cursor's ${tool} call named no file path cairn knows how to read ` +
        `(tool_input fields: ${Object.keys(input).join(", ") || "none"}), so the guard can't tell ` +
        "whether it changes the hook config. Owner: update cairn, or run the change yourself.");
    }
    for (const p of paths) {
      const child = tool === "Delete"
        ? { tool_name: "Bash", tool_input: { command: `rm -rf -- ${shellQuote(p)}` }, cwd }
        : { tool_name: "Write", tool_input: { file_path: p }, cwd };
      checks.push(["harness guard", "pretooluse-harnessguard.mjs", child]);
    }
  } else if (tool.startsWith("MCP:")) {
    // #313: a read passes both guards on its own; a write or a command line meets them
    const mcp = { tool_name: `mcp__cursor__${tool.slice(4).trim()}`, tool_input: input, cwd };
    checks.push(["run guard", "pretooluse-runguard.mjs", mcp], ["harness guard", "pretooluse-harnessguard.mjs", mcp]);
  }
  for (const [name, script, child] of checks) {
    const r = runScript(script, child, projectDir);
    if (r.status === 2) deny(`cairn ${name} blocked this.`, r.stderr || `cairn ${name}: refused.`);
    if (r.status !== 0) {
      deny(`cairn ${name} failed to run, so this was blocked.`,
        `cairn ${name} didn't give an answer (exit ${r.status ?? r.signal ?? "unknown"}), so this ` +
        "call is blocked rather than let through unchecked.");
    }
  }
  respond({ permission: "allow" });
}

let event = "";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  event = payload?.hook_event_name ?? "";
  const projectDir = payload?.workspace_roots?.[0] ?? payload?.cwd ?? process.cwd();

  if (event === "preToolUse") preToolUse(payload, projectDir);

  if (event === "sessionStart") {
    const r = runScript("sessionstart-continuity.mjs", payload, projectDir);
    // The script emits Claude's {hookSpecificOutput: {additionalContext}} --
    // remap to Cursor's {additional_context}; silence means nothing to add.
    try {
      const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
      if (ctx) respond({ additional_context: ctx });
    } catch { /* no banner, no handoff */ }
    respond({});
  }

  if (event === "beforeShellExecution") {
    const r = runScript("pretooluse-leakguard.mjs", {
      tool_name: "Bash",
      tool_input: { command: payload.command ?? "" },
      cwd: payload.cwd,
    }, projectDir);
    if (r.status === 2) {
      respond({
        permission: "deny",
        user_message: "cairn leak guard blocked this commit — staged changes reference cairn internals.",
        agent_message: (r.stderr || "cairn leak guard: staged changes leak internal refs.").trim(),
      });
    }
    respond({ permission: "allow" });
  }

  if (event === "afterShellExecution" || event === "afterFileEdit") {
    const childPayload = event === "afterShellExecution"
      ? {
          tool_name: "Bash",
          tool_input: { command: payload.command ?? "" },
          tool_response: { output: payload.output ?? "" },
          session_id: payload.conversation_id,
        }
      : {
          tool_name: "Edit",
          tool_input: { file_path: payload.file_path ?? "", edits: payload.edits ?? [] },
          tool_response: {},
          session_id: payload.conversation_id,
        };
    runScript("posttooluse-breadcrumb.mjs", childPayload, projectDir);
    runScript("posttooluse-observe.mjs", childPayload, projectDir);
    respond({});
  }

  if (event === "preCompact") {
    runScript("precompact-refresh.mjs", payload, projectDir);
    respond({});
  }

  // stop is deliberately unwired: the cost tracker reads Claude's transcript
  // JSONL for token usage, and Cursor's transcript format is not that.
  respond({});
} catch {
  // a broken adapter never lets a tool call through unchecked (#269)
  if (event === "preToolUse") deny("cairn's Cursor adapter failed, so this was blocked.", "cairn adapter error.");
  respond({});
}
