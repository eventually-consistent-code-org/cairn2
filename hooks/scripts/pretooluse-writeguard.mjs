#!/usr/bin/env node

/**
 * Purpose: PreToolUse write guard (#454) -- write authority by agent type.
 *   A review seat, or the fresh, bounded read-only verifier the review and
 *   audit verbs dispatch to disprove a finding, is read-only by prose and
 *   by its tool list; nothing caught one that edited the patch it was
 *   asked to verify, or the source its verdict was about. This guard reads the hook payload's `agent_type` and refuses
 *   an Edit, Write or NotebookEdit, or a redirect-shaped shell write, that
 *   lands under the project from a type the policy lists as read-only, or
 *   limits to a few path globs (the designer and its draft folder). The
 *   main session carries no `agent_type` and is never limited; a harness
 *   that sends no field is unchanged. Exit 2 blocks; ANY internal error
 *   exits 0 -- never block work because the guard broke.
 *
 *   Trust path: `agent_type` is set by the harness, never by the subagent
 *   (present inside subagents per the Claude Code hooks docs read
 *   2026-11-03 -- a dated claim, so every test here is a synthetic
 *   payload). The path is the subagent's own tool input and is resolved
 *   against the call's cwd, every cd on the line considered, before it is
 *   judged. The policy is `guards.writers` in cairn.json, read raw (hooks
 *   never import the server), with a shipped default when the key is
 *   absent: the file sits under the project, so a limited type cannot
 *   widen its own grant through this guard; #281 makes the key owner-only
 *   at the config tool. There is no escape prefix: the way to proceed
 *   deliberately is for the dispatching session to make the change.
 *
 *   Breaker (#358): a refusal is handed to breaker.mjs, which appends its
 *   audit row (guard, effect, a digest of the input, never the path) and,
 *   while a batch run is live, counts it toward freezing the run.
 *
 * removeWhen: the harness scopes a subagent's write tools by agent type
 *   itself (a per-agent allow list the dispatching session cannot widen
 *   mid-run), in every harness cairn runs in.
 * derives: axiom 5 (owner-ground); axiom 3 (data-not-directive)
 * Author(s): John Reed
 */

/**
 * Policy -- `guards.writers` in cairn.json, each key replacing the shipped
 *   default for that key (the audit.debt.markers convention, never a merge):
 *     readOnly: ["cairn-uat"]            types, or globs over types (`seat-*`),
 *                                        that may write nothing under the project
 *     paths: { "cairn-designer": [...] } a type (or glob) to the root-relative
 *                                        path globs it may write; a glob naming
 *                                        a folder covers everything under it
 *   readOnly wins over a paths grant for the same type; a type neither
 *   names is allowed. A key of the wrong shape leaves its default standing.
 *   Writes outside the project are not this guard's: the harness guard
 *   owns the files that configure the agent, wherever they live.
 *
 * Coverage -- what the Bash leg reads, through shell-words.mjs (shared with
 *   the run and harness guards, so a shape closed there closes here): the
 *   `>` `>>` `&>` `>|` redirect targets of every simple command, a heredoc
 *   redirected onto a file, the body of each `$(...)` and backtick, `tee`'s
 *   operands, and the file a wrapper itself writes (`time -o`). Each
 *   relative target is resolved from the call's cwd and from every folder
 *   a literal `cd` or `pushd` earlier on the line may have left the shell
 *   in (a cd can fail, so all of them). A cd the shell computes (`cd "$X"`,
 *   `cd -`, a substitution) makes a later relative target unreadable, and
 *   a limited type's unreadable target is refused, not guessed (asserted:
 *   writeguard.test.ts, "a redirect after a cd the guard can't read").
 *
 *   Not seen, dated 2026-11-04 (#454), closed by decision under ADR 0016 --
 *   each is a shape the guard knows it does not read, written here rather
 *   than half-guarded; a test pins this block so a deleted line is red:
 *   - a program's own output file: `sed -i`, `cp`, `mv`, `install`,
 *     `rsync`, `dd of=`, `git apply`, `patch`. The redirect is the one
 *     shell write shape read, as the issue scoped it; a copier list for
 *     every project file would never close, and the harness guard's cp/mv
 *     reading covers the few named files that configure the agent.
 *   - a write in an interpreter: `python -c`, `node -e`, a script run by
 *     name. Code in another language is out of scope for every guard.
 *   - an MCP file tool (a desktop-commander write_file): the matcher is the
 *     issue's four core tools; the harness guard's path-field reading can
 *     be added under `mcp__.*` by a later issue.
 *   - a symlink inside the project that points outside it, or the reverse:
 *     the written spelling is judged, not the inode.
 *   - a harness that sends no agent_type (Cursor and the rest): allowed, as
 *     the issue scopes it; a per-harness field mapping is a later issue.
 *   - a verifier or seat dispatched as a general-purpose subagent
 *     shares the dispatching session's type, so the type is no handle;
 *     only a dispatch under a named agent type (cairn-uat today) is read-only.
 *
 * Asserted: server/test/writeguard.test.ts -- the synthetic payloads (a
 *   read-only type exits 2, no type exits 0, a malformed cairn.json exits
 *   0), the refused/twin matrix from the root and a nested cwd, the
 *   breaker rows, and the hooks.json entry.
 */

// Imports

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { projectRoot, readCairnConfig } from "./lib.mjs";
import { commandName, shellSegments, unwrap } from "./shell-words.mjs";

// #358 -- the breaker loads on its own: a breaker.mjs that is missing or
// broken leaves this guard refusing exactly as before, never crashed
const BREAKER = await import("./breaker.mjs").catch(() => null);

// Constants

/** The tools whose writes are judged: the three file editors and the shell. */
const CORE = new Set(["Edit", "Write", "NotebookEdit"]);

/** What the shell reader is asked to read: the run guard's set plus redirects. */
const READ = {
  redirects: true, subshells: true, substitutions: true, heredocs: true, comments: true,
  continuation: true, posixEscapes: true, anyWhitespace: true,
};

/** Descriptors and devices -- never a file this guard cares about. */
const DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** A folder word the shell works out at run time: a variable, a substitution, `-`, `~user`. */
const COMPUTED = /[$`]|^-$|^~[^/]/;

/** Past this many candidate folders a line counts as unreadable. */
const MAX_PLACES = 16;

/** The planning folder's draft sessions -- spelled apart from the folder name
 *  on purpose: the commit leak guard refuses the joined literal in a hook. */
const DRAFT_GLOB = [".cairn", "draft", "**"].join("/");

/** The shipped policy: the acceptance agent writes nothing; the designer writes its draft folder. */
const DEFAULT_WRITERS = Object.freeze({
  readOnly: Object.freeze(["cairn-uat"]),
  paths: Object.freeze({ "cairn-designer": Object.freeze([DRAFT_GLOB]) }),
});

// Policy

/** `guards.writers`, each key the owner's when it has the right shape, else the shipped default. */
function writersPolicy(config) {
  const given = config?.guards?.writers;
  const readOnly = Array.isArray(given?.readOnly) && given.readOnly.every((t) => typeof t === "string")
    ? given.readOnly : DEFAULT_WRITERS.readOnly;
  const paths = given?.paths && typeof given.paths === "object" && !Array.isArray(given.paths)
    && Object.values(given.paths).every((v) => Array.isArray(v) && v.every((g) => typeof g === "string"))
    ? given.paths : DEFAULT_WRITERS.paths;
  return { readOnly, paths };
}

/** `*` in a type glob matches any run of characters; everything else is literal. */
function typeMatches(glob, type) {
  const re = "^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(re).test(type);
}

/** A path glob as a regular expression: `**` any depth, `*` and `?` within one segment. */
function pathRe(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

/** True when the root-relative path, or a folder above it, matches the glob. */
function pathMatches(glob, rel) {
  const re = pathRe(glob.replace(/^\.\//, "").replace(/\/+$/, ""));
  const parts = rel.split("/");
  for (let n = parts.length; n >= 1; n--) if (re.test(parts.slice(0, n).join("/"))) return true;
  return false;
}

/** The grant for one type: read-only, a list of path globs, or null when the policy names it nowhere. */
function grantFor(type, policy) {
  if (policy.readOnly.some((g) => typeMatches(g, type))) return { kind: "read-only" };
  const key = Object.keys(policy.paths).find((g) => typeMatches(g, type));
  return key ? { kind: "paths", key, globs: policy.paths[key] } : null;
}

// Paths

function expandHome(raw) {
  return raw.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, () => resolve(homedir()));
}

/** The root-relative spelling of an absolute path under one of the roots, or null outside them all. */
function underRoot(abs, roots) {
  for (const root of roots) {
    const rel = relative(root, abs);
    if (rel === "") return ".";
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  }
  return null;
}

/**
 * The files a shell line writes, each with the folders it may be written
 * from: `dirs` is every folder the shell may stand in at that point (the
 * call's cwd and each literal cd so far), or null once a cd the guard
 * can't read has run -- a later relative target is then unreadable.
 */
function shellWrites(command, cwd) {
  const out = [];
  let dirs = [cwd];
  for (const seg of shellSegments(command, READ)) {
    const { words, writes, dirs: moved } = unwrap(seg.words, READ);
    const name = commandName(words[0]);
    // a redirect is the shell's, from where it stands; a wrapper's own write
    // and tee's operands land where the wrapper moved the command (env -C DIR)
    for (const r of seg.redirects) if (r && !r.startsWith("&") && !DEVICE.test(r)) out.push({ raw: r, dirs });
    const own = [...writes, ...(name === "tee" ? words.slice(1).filter((a) => !a.startsWith("-")) : [])];
    const from = dirs === null ? null : [...new Set([...dirs, ...moved.map((d) => resolve(cwd, expandHome(d)))])];
    for (const f of own) out.push({ raw: f, dirs: from });
    if ((name === "cd" || name === "pushd") && dirs !== null) {
      const arg = words.slice(1).find((a) => !a.startsWith("-") || a === "-") ?? "~";
      if (COMPUTED.test(arg)) { dirs = null; continue; }
      const next = [...new Set([...dirs, ...dirs.map((d) => resolve(d, expandHome(arg)))])];
      dirs = next.length > MAX_PLACES ? null : next;
    }
  }
  return out;
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = payload?.tool_name;
  if (tool !== "Bash" && !CORE.has(tool)) process.exit(0);
  // the main session carries no agent_type; a harness that sends none is unchanged
  const type = payload?.agent_type;
  if (typeof type !== "string" || !type) process.exit(0);

  // #459 -- the root the harness names, else the one git or a .claude folder marks above the cwd
  const projectDir = projectRoot(payload);
  // absent or malformed cairn.json: not a project this guard judges -- fail open
  const config = readCairnConfig(projectDir);
  if (config === null) process.exit(0);
  const grant = grantFor(type, writersPolicy(config));
  if (!grant) process.exit(0);

  const roots = [resolve(projectDir)];
  try { roots.push(realpathSync(projectDir)); } catch { /* the written spelling is enough */ }
  const cwd = payload?.cwd ? resolve(projectDir, String(payload.cwd)) : resolve(projectDir);

  /** The refusal for one root-relative path, or null when the grant allows it. */
  const judge = (rel) => {
    if (grant.kind === "read-only") return { rel, why: "read-only" };
    return grant.globs.some((g) => pathMatches(g, rel)) ? null : { rel, why: "outside" };
  };

  let hit = null;
  if (tool === "Bash") {
    for (const { raw, dirs } of shellWrites(payload?.tool_input?.command ?? "", cwd)) {
      const target = expandHome(raw);
      if (dirs === null && !isAbsolute(target)) { hit = { rel: raw, why: "unreadable" }; break; }
      for (const dir of isAbsolute(target) ? [cwd] : dirs) {
        const rel = underRoot(resolve(dir, target), roots);
        if (rel !== null) hit = judge(rel);
        if (hit) break;
      }
      if (hit) break;
    }
  } else {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const rel = p ? underRoot(resolve(cwd, expandHome(String(p))), roots) : null;
    if (rel !== null) hit = judge(rel);
  }
  if (!hit) process.exit(0);

  // one plain line naming the type, the path and the way to proceed deliberately; the key second
  const key = grant.kind === "read-only" ? "guards.writers.readOnly" : `guards.writers.paths["${grant.key}"]`;
  if (hit.why === "unreadable") {
    console.error(`cairn write guard: agent type '${type}' is limited under this project, and this line redirects into ` +
      `${hit.rel} from a folder the guard can't read (a cd it can't resolve) — spell the folder out, or hand the change to the dispatching session.`);
  } else if (hit.why === "read-only") {
    console.error(`cairn write guard: agent type '${type}' is read-only under this project — it may not write ${hit.rel}. ` +
      "Hand the change to the dispatching session (the main session is never limited).");
  } else {
    console.error(`cairn write guard: agent type '${type}' may write only ${grant.globs.join(", ")} under this project, not ${hit.rel}. ` +
      "Hand the change to the dispatching session (the main session is never limited).");
  }
  console.error(`  the key that would allow it: ${key} in cairn.json (the owner's edit; #281 keeps it owner-only at the config tool).`);

  // #358 -- the audit row and the breaker's count: the type and the effect, never the path.
  // #432 -- in its own try, result used only when it is the promised array of lines.
  let more = [];
  try {
    const got = BREAKER?.recordRefusal({
      guard: "write", payload, effect: "writes-outside-grant",
      reason: `agent type ${type} wrote outside its grant (${hit.why})`, projectDir,
    });
    if (Array.isArray(got)) more = got;
  } catch {
    // the breaker's own failure: the refusal stands, nothing more is said
  }
  for (const line of more) console.error(line);
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
