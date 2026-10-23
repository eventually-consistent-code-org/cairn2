#!/usr/bin/env node

/**
 * Purpose: which file each harness reads at session start, and whether the
 *   cairn spine (the AGENTS.md fragment) is reachable from it (#398).
 *   cairn-setup uses it to install and check; gen-agents --check uses it for
 *   the readers leg. Builtins only, no top-level side effects.
 *
 *   The gap this closes: Claude Code reads AGENTS.md only when no CLAUDE.md
 *   is in scope (a claim, as of 2026-10, per the Claude Code memory docs), so
 *   in a project with both files the one harness the plugin targets never
 *   saw the spine. The fix is an `@AGENTS.md` import at the top
 *   of CLAUDE.md, between the same cairn markers the fragment uses.
 * Author(s): John Reed
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Constants
export const BEGIN = "<!-- cairn:begin";
export const END = "<!-- cairn:end -->";

// Three lines on purpose: the import lands on line 2, inside `head -3`, the
// first thing in the file and where the readers leg looks for it.
export const IMPORT_BLOCK = `${BEGIN} — managed by cairn-setup; imports the cairn spine for Claude Code -->\n@AGENTS.md\n${END}\n`;

// An import line: `@AGENTS.md` or `@./AGENTS.md` alone on its line, indented
// less than four spaces (four or more is an indented code block).
const IMPORT_RE = /^ {0,3}@(?:\.\/)?AGENTS\.md\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

// The readers table. Every row is a CLAIM about a third party's loader --
// which file that harness reads at session start -- so each carries the date
// and what it rests on (claims rule 1: a claim about a third party can never
// be the asserted kind). What the readers leg ASSERTS is the cairn side: that
// cairn-setup writes that file and the fragment is reachable from it.
export const READERS = [
  {
    harness: "grok", loadFile: "AGENTS.md", via: "direct", path: "AGENTS.md → fragment",
    claim: "as of 2026-10, per the Grok Build note cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "copilot", loadFile: ".github/copilot-instructions.md", via: "direct",
    path: ".github/copilot-instructions.md → fragment",
    claim: "as of 2026-10, per the GitHub Copilot custom-instructions docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "codex", loadFile: "AGENTS.md", via: "direct", path: "AGENTS.md → fragment",
    claim: "as of 2026-10, per the Codex AGENTS.md docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "gemini", loadFile: "GEMINI.md", via: "direct", path: "GEMINI.md → fragment",
    claim: "as of 2026-10, per the Gemini CLI context-file docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "cursor", loadFile: "AGENTS.md", via: "direct", path: "AGENTS.md → fragment",
    claim: "as of 2026-10, per the Cursor rules docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "opencode", loadFile: "AGENTS.md", via: "direct", path: "AGENTS.md → fragment",
    claim: "as of 2026-10, per the OpenCode rules docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "zed", loadFile: "AGENTS.md", via: "direct", path: "AGENTS.md → fragment",
    claim: "as of 2026-10, per the Zed rules docs cairn-setup was written against (CRN-71); not re-read 2026-10-22",
  },
  {
    harness: "claude", loadFile: "CLAUDE.md", via: "import", path: "CLAUDE.md → @AGENTS.md → fragment",
    claim: "as of 2026-10, per the Claude Code memory docs (AGENTS.md is read only when no CLAUDE.md is in scope; imports in code fences are skipped), verified in #398 on 2026-10-16",
  },
];

/** Where the cairn marker span sits in a file body.
 *  :returns null (no begin marker), {orphan: true} (begin with no end after
 *  it), or {start, end} with end just past the end marker */
export function fragmentSpan(body) {
  const start = body.indexOf(BEGIN);
  if (start < 0) return null;
  const endAt = body.indexOf(END, start);
  if (endAt < 0) return { orphan: true };
  return { start, end: endAt + END.length };
}

/** Install or replace the marker-delimited fragment inside a body.
 *  :returns {next} or {error} -- an orphaned begin marker is never guessed at */
export function spliceFragment(body, fragment) {
  const span = fragmentSpan(body);
  if (span?.orphan) return { error: "has a cairn:begin marker with no matching end" };
  if (span) return { next: body.slice(0, span.start) + fragment.trimEnd() + body.slice(span.end) };
  return { next: body.length ? `${body.trimEnd()}\n\n${fragment}` : fragment };
}

/** Find the `@AGENTS.md` import in a CLAUDE.md body, the way the import
 *  parser sees it: lines inside a fenced code block or an HTML comment are
 *  not imports.
 *  :returns {line, hidden} -- 1-based line of the first live import (or null),
 *  and of the first import line a fence or comment hides (or null) */
export function scanImport(body) {
  let fence = null;
  let inComment = false;
  let line = null;
  let hidden = null;
  const lines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const isImport = IMPORT_RE.test(raw);

    // Inside a fence: only a closing fence of the same char, at least as long, ends it
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(raw)) fence = null;
      else if (isImport && hidden === null) hidden = i + 1;
      continue;
    }

    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      else if (isImport && hidden === null) hidden = i + 1;
      continue;
    }

    const open = FENCE_OPEN_RE.exec(raw);
    if (open) {
      fence = open[1];
      continue;
    }
    if (raw.trimStart().startsWith("<!--") && !raw.includes("-->")) {
      inComment = true;
      continue;
    }
    if (isImport && line === null) line = i + 1;
  }
  return { line, hidden };
}

/** Put the import block at the top of a CLAUDE.md body, idempotently.
 *  A file that already starts with the block is left as is; so is one whose
 *  owner wrote their own live import outside the markers. A cairn block lower
 *  in the file moves to the top.
 *  :returns {next, note} or {error} */
export function spliceImport(body) {
  if (body.startsWith(IMPORT_BLOCK)) return { next: body, note: "import already current" };
  const span = fragmentSpan(body);
  if (span?.orphan) return { error: "has a cairn:begin marker with no matching end" };
  const own = scanImport(body).line;
  if (!span && own !== null) {
    return { next: body, note: `already imports AGENTS.md at line ${own} (outside cairn markers, left as written)` };
  }
  const rest = span
    ? body.slice(0, span.start) + body.slice(span.end).replace(/^\n/, "")
    : body;
  const tail = rest.replace(/^\n+/, "");
  return { next: IMPORT_BLOCK + (tail.length ? `\n${tail}` : ""), note: "import installed at the top" };
}

/** Read a project-relative file, or null when it does not exist. */
function readOrNull(projectDir, rel) {
  const p = join(projectDir, rel);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Does a direct-read file carry the fragment?
 *  :param fragment when given, the span must equal it (freshness), not just exist */
function reachDirect(projectDir, rel, fragment) {
  const body = readOrNull(projectDir, rel);
  if (body === null) return { state: "absent", detail: `${rel} not installed here` };
  const span = fragmentSpan(body);
  if (!span) return { state: "broken", detail: `${rel} carries no cairn section` };
  if (span.orphan) return { state: "broken", detail: `${rel} has a cairn:begin marker with no matching end` };
  if (fragment !== undefined && body.slice(span.start, span.end) !== fragment.trimEnd()) {
    return { state: "broken", detail: `${rel} cairn section is stale vs harness/AGENTS-cairn.md` };
  }
  return { state: "reaches", detail: `${rel} carries the fragment` };
}

/** Is the spine reachable from this row's load file in a project?
 *  :param row a READERS row ({loadFile, via})
 *  :param opts.fragment compare the span for freshness when given
 *  :param opts.top the import must sit within the first three lines
 *  :returns {state: "absent" | "reaches" | "broken", detail} */
export function reachFrom(projectDir, row, { fragment, top = false } = {}) {
  if (row.via !== "import") return reachDirect(projectDir, row.loadFile, fragment);

  const body = readOrNull(projectDir, row.loadFile);
  if (body === null) {
    // No CLAUDE.md in scope: Claude Code reads AGENTS.md directly
    const r = reachDirect(projectDir, "AGENTS.md", fragment);
    if (r.state === "reaches") return { state: "reaches", detail: `no ${row.loadFile}; AGENTS.md read directly and carries the fragment` };
    return { state: r.state, detail: `no ${row.loadFile}; ${r.detail}` };
  }

  const { line, hidden } = scanImport(body);
  if (line === null) {
    const why = hidden === null ? "" : ` (line ${hidden} sits inside a code fence or HTML comment, where imports are not read)`;
    return { state: "broken", detail: `${row.loadFile} has no @AGENTS.md import${why}` };
  }
  if (top && line > 3) {
    return { state: "broken", detail: `${row.loadFile} imports AGENTS.md at line ${line}, not within the first three lines` };
  }
  const target = reachDirect(projectDir, "AGENTS.md", fragment);
  if (target.state === "reaches") return { state: "reaches", detail: `${row.loadFile} imports AGENTS.md (line ${line}), which carries the fragment` };
  if (target.state === "absent") return { state: "broken", detail: `${row.loadFile} imports AGENTS.md, which does not exist` };
  return { state: "broken", detail: `${row.loadFile} imports AGENTS.md, but ${target.detail}` };
}
