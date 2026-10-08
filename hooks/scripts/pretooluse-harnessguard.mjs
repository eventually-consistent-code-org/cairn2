#!/usr/bin/env node

/**
 * Purpose: PreToolUse harness guard (#208) -- refuses agent writes to the
 *   files that define the agent's own harness: the hook directory, the MCP
 *   server config, the settings cascade, and the plugin manifest. An agent
 *   that can rewrite its own hooks can switch off every other control in a
 *   single edit, so this is the backstop the rule-to-control check points
 *   at. Exit 2 blocks the tool call; ANY internal error exits 0 -- never
 *   block work because the guard itself broke.
 *
 *   Threat model, stated plainly so nobody over-trusts it: the realistic
 *   attack is INDIRECT -- instructions embedded in text the agent reads
 *   (an issue body, a review comment, a fetched page) steering it into a
 *   harness edit it would not otherwise make. This guard turns that from a
 *   silent success into a refusal the human sees. It is NOT a sandbox: the
 *   CAIRN_HARNESS_EDIT=1 escape exists for the human, and text that can
 *   steer the agent can also ask for the prefix. Visibility is the control;
 *   isolation is the operating system's job. The Bash coverage reads the
 *   command the way a shell would (through shell-words.mjs, the reader the
 *   run guard shares, #270), closely enough to find what it WRITES:
 *   redirect targets, and the path operands of commands that change files
 *   (tee, mv, rm, sed -i, the destination of cp, and so on), seen through
 *   wrappers and their flags (sudo -u root, env -i, timeout 5) and through
 *   a shell's -c string (bash -lc counts, #254). Quoted text,
 *   heredoc bodies and here-strings are data. A protected path that is only
 *   READ -- run, grepped, piped to head -- passes (#240). It is still not a
 *   full shell parser: a write hidden inside an interpreter (python -c,
 *   node -e) or a $(...) substitution is not seen.
 *
 * removeWhen: the platform isolates agent config at the OS level, so the
 *   agent process cannot write its own hooks or settings (ADR 0016).
 * Author(s): John Reed
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SHELLS, shellCommandString, shellSegments, unwrap } from "./shell-words.mjs";

/**
 * Protected shapes, matched against a path relative to the project root
 * (POSIX separators). Kept as one list so the refusal line can name which
 * rule fired and `audit security --surface` has one place to read.
 */
const PROTECTED = [
  { re: /^hooks\//, what: "the hook directory" },
  { re: /^\.mcp\.json$/, what: "the MCP server config" },
  { re: /^(?:.*\/)?\.claude\/settings(?:\.[\w-]+)?\.json$/, what: "a settings file" },
  { re: /^(?:.*\/)?\.claude-plugin\/[^/]+\.json$/, what: "the plugin manifest" },
];

/** The user's machine-wide settings, protected wherever the project sits. */
function isGlobalSettings(abs) {
  const home = resolve(homedir());
  return abs === join(home, ".claude", "settings.json") ||
    abs === join(home, ".claude", "settings.local.json");
}

/** Project-relative POSIX path, or null when the path escapes the project. */
function projectRelative(abs, projectDir) {
  const rel = relative(resolve(projectDir), abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** The protected-rule description for this path, or null when it is ordinary. */
function protectedBy(rawPath, projectDir) {
  if (!rawPath) return null;
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(projectDir, rawPath);
  if (isGlobalSettings(abs)) return "your machine-wide Claude settings";
  const rel = projectRelative(abs, projectDir);
  if (rel === null) return null; // outside the project -- not this guard's business
  for (const p of PROTECTED) if (p.re.test(rel)) return p.what;
  return null;
}

// Commands that change every path operand they are given.
const WRITES_ALL = new Set([
  "tee", "mv", "rm", "rmdir", "unlink", "truncate", "chmod", "chown", "chgrp",
  "touch", "mkdir", "shred",
]);
// Commands that only READ their sources and write the last operand (or -t).
const WRITES_DEST = new Set(["cp", "install", "ln", "rsync"]);

/**
 * How this guard reads a command line (shell-words.mjs): redirect targets
 * and heredocs are modelled; ( ), backticks, # comments and quoted $(...)
 * are word text, so a write hidden in a substitution is not seen.
 */
const READ = { redirects: true };

/** The paths one segment would write to. Generous inside a write command;
 *  silent for a command that only reads. */
function writeTargets(seg, depth = 0) {
  const targets = seg.redirects.filter((r) => !/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(r));
  const { words: w, writes } = unwrap(seg.words, READ);
  targets.push(...writes);
  if (!w.length) return targets;
  const cmd = w[0].split("/").pop();
  const args = w.slice(1);
  const operands = args.filter((a) => !a.startsWith("-"));
  // A command handed to another shell as a string is still a command: read
  // it the same way, one level down. (The old text-match missed these too.)
  if (depth < 3 && (SHELLS.has(cmd) || cmd === "eval")) {
    const inner = cmd === "eval" ? args.join(" ") : shellCommandString(args);
    if (inner) {
      for (const s of shellSegments(inner, READ)) targets.push(...writeTargets(s, depth + 1));
    }
    return targets;
  }
  if (WRITES_ALL.has(cmd)) {
    targets.push(...operands);
  } else if (WRITES_DEST.has(cmd)) {
    const t = args.indexOf("-t");
    if (t >= 0 && args[t + 1]) targets.push(args[t + 1]);
    else if (operands.length) targets.push(operands[operands.length - 1]);
  } else if ((cmd === "sed" || cmd === "perl") &&
      args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    targets.push(...operands);
  } else if (cmd === "dd") {
    for (const a of args) if (a.startsWith("of=")) targets.push(a.slice(3));
  } else if (cmd === "git") {
    // skip git's own -C <dir> / -c <k=v> before the subcommand
    const rest = args.slice();
    while (rest.length && (rest[0] === "-C" || rest[0] === "-c")) rest.splice(0, 2);
    const sub = rest[0];
    if (["checkout", "restore", "rm", "mv"].includes(sub)) {
      targets.push(...rest.slice(1).filter((a) => !a.startsWith("-")));
    }
  }
  return targets;
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = payload?.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "NotebookEdit" && tool !== "Bash") {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const command = payload?.tool_input?.command ?? "";

  // Two override shapes, both explicit and both the human's to set: the
  // session-wide environment variable, and -- for Bash only -- the same
  // prefix convention the leak guard uses.
  if (process.env.CAIRN_HARNESS_EDIT === "1") process.exit(0);
  if (tool === "Bash" && /^\s*CAIRN_HARNESS_EDIT=1\s/.test(command)) process.exit(0);

  let hitPath = null;
  let hitWhat = null;

  if (tool === "Bash") {
    // Only what the command WRITES is checked; reading a hook file is
    // ordinary work and must stay frictionless (#240).
    outer: for (const seg of shellSegments(command, READ)) {
      for (const t of writeTargets(seg)) {
        const what = protectedBy(t, projectDir);
        if (what) { hitPath = t; hitWhat = what; break outer; }
      }
    }
  } else {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const what = protectedBy(p, projectDir);
    if (what) { hitPath = p; hitWhat = what; }
  }

  if (!hitWhat) process.exit(0);

  console.error(
    `cairn harness guard: this would change ${hitWhat} — the configuration that decides ` +
    "what this agent is allowed to do.",
  );
  console.error(`  file: ${hitPath}`);
  console.error("  if you asked for this, set CAIRN_HARNESS_EDIT=1 for the session (or prefix a");
  console.error("  shell command with it) and run it again. If you did not ask for this, something");
  console.error("  the agent read did — check where the instruction came from before allowing it.");
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
