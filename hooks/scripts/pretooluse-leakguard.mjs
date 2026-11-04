#!/usr/bin/env node

/**
 * Purpose: PreToolUse leak guard (#2221) -- blocks `git commit` tool calls
 *   whose STAGED diff would leak cairn-internal refs (.cairn/ paths, phase
 *   refs, cairn labels, tracker ids) into source files. Exit 2 blocks the
 *   tool call; ANY internal error exits 0 -- never block work by accident.
 *
 *   Path-scoped exemption (#140): staged files under server/src/ and
 *   server/dist/ skip the `cairn-path` pattern only (via patternsForFile) --
 *   the server manages the .cairn dirs, so its source legitimately names
 *   them; the guard protects outbound text, not the implementation. All
 *   other patterns still apply to those files, and every other path keeps
 *   full strictness. See leak-patterns.mjs for the full rationale.
 *
 *   Breaker (#358): a block is handed to breaker.mjs, which appends its
 *   audit row (the pattern names and a digest of the command, never the
 *   leaking text) and, while a batch run is live, counts it toward
 *   freezing the run.
 *
 *   Root (#459): CLAUDE_PROJECT_DIR when set, else the repository top
 *   level (`git rev-parse --show-toplevel`) from the payload cwd, else the
 *   nearest folder above it holding .claude, else the cwd -- lib.mjs
 *   projectRoot, shared with the harness guard (asserted: hooks.test.ts,
 *   the #383 nested rows run once more with the variable stripped).
 *
 *   Secrets (#280): key-shaped secrets -- a cloud access key, a GitHub or
 *   Slack token, a private-key header, a key|secret|token assignment with
 *   a long opaque value -- are leak patterns too, shared with the server's
 *   outbound screen through leak-patterns.mjs. The refusal names the file
 *   and line and withholds the value (asserted: hooks.test.ts "the leak
 *   guard refuses key-shaped secrets"). The Not seen block below is what
 *   the set does not read.
 *
 * removeWhen: never for the scan itself; this hook can retire if the
 *   platform offers a pre-commit content policy cairn can register
 *   patterns with.
 * derives: axiom 1 (tracker-truth)
 * Author(s): John Reed
 */

/**
 * Secrets -- what the five shapes do not read.
 *
 *   Not seen, dated 2026-11-04 (#280, by decision under ADR 0016 -- each
 *   is a shape the secret patterns know they do not read, written here
 *   rather than half-guarded; a test pins this block, so a deleted line
 *   is red: hooks.test.ts "the leak guard refuses key-shaped secrets"):
 *   - a secret in an allowlisted path: markdown, docs/ and the globs in
 *     leakGuard.allow skip every pattern, the secret ones with them --
 *     the allowlist is per path, never per kind, as #140 settled it.
 *   - a secret in the commit message: the guard reads the staged diff,
 *     never the -m text.
 *   - an encoded or split value: base64, hex-wrapped, or a token built
 *     from pieces at runtime reads as opaque text, not as a key.
 *   - a prefix this set does not know: five shapes ship (a cloud access
 *     key, GitHub and Slack tokens, a private-key header, an assignment);
 *     another vendor's prefix is a leakGuard.extraPatterns line, and a
 *     repository's history is a job for a real secret scanner.
 *   - a value under twenty characters, or one without both a letter and
 *     a digit: the assignment shape trades those for precision.
 *
 *   A refused secret is a secret to rotate: the guard keeps it out of the
 *   next commit, not out of the shell history or the editor's swap file.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildPatterns, scanLines, isAllowedPath, patternsForFile } from "./leak-patterns.mjs";
import { projectRoot } from "./lib.mjs";

// #358 -- the breaker loads on its own: a breaker.mjs that is missing or
// broken leaves this guard refusing exactly as before, never crashed
const BREAKER = await import("./breaker.mjs").catch(() => null);

// Best-effort shell tokenizer -- splits on whitespace and chain operators
// (&&, ||, ;, |, &) while keeping quoted strings intact. Only used to decide
// whether a `git commit` invocation is "widened" (see isWidenedCommit); not
// a general-purpose shell parser, and this whole module fails open on its
// own error. That is the guard's half only: since Claude Code 2.1.299 the
// platform fails closed when it cannot reach the guard or read its answer
// (onFailure stays unset in hooks.json by design, ADR 0016; dated claim
// about the harness, 2026-10-14, #371).
function tokenizeShell(command) {
  const re = /"(?:[^"\\]|\\.)*"|'[^']*'|&&|\|\||[;|&]|\S+/g;
  const tokens = [];
  let m;
  while ((m = re.exec(command)) !== null) tokens.push(m[0]);
  return tokens;
}

const CHAIN_OPS = new Set(["&&", "||", ";", "|", "&"]);

// `git commit -a`/`-am`/`--all` auto-stages tracked modifications AFTER we'd
// read the index, and `git commit <pathspec>` commits named files regardless
// of what's staged -- both slip past a `--cached` diff. Detect either shape
// from the command text so the caller can widen the scan.
function isWidenedCommit(command) {
  const tokens = tokenizeShell(command);
  const commitIdx = tokens.findIndex((t) => t === "commit");
  if (commitIdx === -1) return false;
  const args = [];
  for (let i = commitIdx + 1; i < tokens.length; i++) {
    if (CHAIN_OPS.has(tokens[i])) break;
    args.push(tokens[i]);
  }
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-m" || t === "--message") { i++; continue; } // skip flag + its arg
    if (/^--message=/.test(t)) continue;
    if (/^-[a-z]*a/i.test(t)) return true; // short-flag cluster containing "a" (-a, -am, -qam, ...)
    if (t === "--all") return true;
    if (t.startsWith("-")) continue; // some other flag -- ignore
    return true; // bare non-flag token after `commit` -> a pathspec
  }
  return false;
}

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const command = payload?.tool_input?.command ?? "";
  if (payload?.tool_name !== "Bash") process.exit(0);
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0);
  // spec: the override must PREFIX the command -- a quoted mention elsewhere
  // (e.g. a commit message about the flag) must not bypass the guard.
  if (/^\s*CAIRN_LEAK_OK=1\s/.test(command)) process.exit(0);

  // #459 -- the root the harness names, else the one git or a .claude folder
  // marks above the shell's cwd; never the subfolder the shell stands in
  const projectDir = projectRoot(payload);
  const cfgPath = join(projectDir, "cairn.json");
  if (!existsSync(cfgPath)) process.exit(0);
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (config?.leakGuard?.enabled === false) process.exit(0);

  // `git commit -a`/`-am`/`--all` or a pathspec commits tracked changes that
  // were never staged -- widen the scan to `git diff HEAD` (staged + unstaged
  // tracked changes, a superset of what such a commit would include) so they
  // can't sidestep the `--cached` index snapshot. Empty repo (no HEAD yet):
  // fall back to `--cached`.
  const execDiff = (target) => execFileSync("git",
    ["diff", target, "-U0", "--diff-filter=ACM"],
    { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

  let diff;
  if (isWidenedCommit(command)) {
    try {
      diff = execDiff("HEAD");
    } catch {
      diff = execDiff("--cached");
    }
  } else {
    diff = execDiff("--cached");
  }

  const patterns = buildPatterns(config);
  const allow = config?.leakGuard?.allow ?? [];
  const hits = [];
  const kinds = new Set(); // the pattern names that hit -- what the breaker's row may say
  let file = null;
  let skipped = true;
  let activePatterns = patterns; // per-file view: path-scoped exemptions applied
  let lineNo = 0; // file line number of the NEXT added line (from hunk headers)
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      skipped = isAllowedPath(file, allow);
      activePatterns = patternsForFile(file, patterns);
      continue;
    }
    // hunk header: `@@ -a,b +c,d @@` -- c is the file line of the first
    // added line in the hunk (at -U0 there are no context lines to skip).
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = parseInt(hunk[1], 10);
      continue;
    }
    if (skipped || !line.startsWith("+") || line.startsWith("+++")) continue;
    for (const h of scanLines([line.slice(1)], activePatterns)) {
      hits.push(`${file}:${lineNo}: [${h.name}] ${h.match}`);
      kinds.add(h.name);
    }
    lineNo++;
  }

  if (hits.length > 0) {
    console.error("cairn leak guard: staged changes leak internal refs or secrets —");
    for (const h of hits) console.error(`  ${h}`);
    console.error("fix the lines (a real secret: rotate it too), allowlist the path via `/cairn tune`, or prefix the command with CAIRN_LEAK_OK=1 to override once.");
    // #358 -- the audit row and the breaker's count: pattern names only, never a file or a match.
    // #432 -- in its own try, result used only when it is the promised array of
    // lines: a breaker that loaded but misbehaves must not reach the outer catch,
    // whose fail-open exit 0 would turn this refusal into an allow
    // (asserted: hooks.test.ts, "missing, broken or misbehaving").
    const reason = `staged lines leak internal refs (${[...kinds].sort().join(", ")})`;
    let more = [];
    try {
      const got = BREAKER?.recordRefusal({ guard: "leak", payload, effect: "leaks-internal-refs", reason, projectDir });
      if (Array.isArray(got)) more = got;
    } catch {
      // the breaker's own failure: the refusal stands, nothing more is said
    }
    for (const line of more) console.error(line);
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
