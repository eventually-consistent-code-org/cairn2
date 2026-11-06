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
 *   A nested line is read the same way (#511), through the reader's own
 *   helpers, with the words spelled first (spellWords): `sh -c`, `bash -lc`,
 *   `eval` (whose cd and assignments stay in this shell), `su -c`, a heredoc
 *   or here-string fed to a shell, a wrapper's command line, a pager variable,
 *   an option that runs a program (argCommands), and a runner's inner lines
 *   (runnerCommands: `op run --`, `find -exec`, `trap`). Refused unread, since
 *   each hands a shell a line nobody can see: a shell string holding a word the
 *   reader calls wild (`eval "$(cmd)"`), a pipe into a shell (`cmd | sh`), a
 *   nest past MAX_NEST, a line past MAX_READ or MAX_SEGMENTS (the hook's own
 *   timeout would wave it through), a substitution past the reader's depth,
 *   and tee fed by xargs. Asserted: writeguard.test.ts, "a redirect inside a
 *   nested shell". TEXT_ARGS names the programs whose words are code or text,
 *   never a line (`awk '$1 > 5'` passes); a quoted argument of a program off
 *   that list reads as a line, so `npx x --grep 'a > b'` is refused, visibly,
 *   by decision (asserted: "an unknown program's quoted argument").
 *
 *   A target is spelled through the reader before it is judged (#512): what
 *   the line assigned, every value of it; $HOME, ~ and $PWD anywhere in the
 *   word, $PWD once per folder the shell may stand in; a brace; a name the
 *   line never assigned both typed and gone. Slashes then collapse, so
 *   `/$PWD/src/a.ts` is the project file it is. What stays unspelled, or a
 *   glob, with a root at or below the literal folder before it (headReaches)
 *   is unreadable and refused: `/$X/a`, `/$(pwd)/a`, `/U*\/proj/a`, `../$X/a`.
 *   Asserted: writeguard.test.ts, "a target is spelled through the reader".
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
 *   - dated 2026-11-05 (#511): a shell's script from a file, however named
 *     (`sh x.sh`, `source x.sh`, `sh < x.sh`, `bash <(cmd)`), which is the
 *     script-by-name line above; a line in a name only the session holds
 *     (`eval "$CMD"`, the #291 decision); a command word the shell computes
 *     (`$(which tee) x`); a git alias that runs a shell (`git -c alias.x=!...`),
 *     since git's words are text here. Pinned: "the Not seen shapes stay passing".
 *   - an MCP file tool (a desktop-commander write_file): the matcher is the
 *     issue's four core tools; the harness guard's path-field reading can
 *     be added under `mcp__.*` by a later issue.
 *   - a symlink inside the project that points outside it, or the reverse:
 *     the written spelling is judged, not the inode.
 *   - dated 2026-11-05 (#512): a value only the run knows, in a path whose
 *     literal head sits off to the side (`/opt/$X/y`, X holding a climb);
 *     `>&` onto a file, which the reader takes for a descriptor; a quoted
 *     `'$HOME/x'`, read as spelled, since a target carries no quoting past
 *     the parser. Pinned, with the /tmp link spelling of the line above, by
 *     "the Not seen shapes stay passing" under "a target is spelled".
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
import {
  SHELLS, argCommands, assignVars, braceExpand, commandName, evalCommandString, expandAssigned, lineVars, pagerCommands, runnerCommands, seedVars,
  shellCommandString, shellReadsStdin, shellSegments, spellWords, suCommandString, tooDeep, unwrap,
} from "./shell-words.mjs";

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

/** In a target the reader spelled, the first thing only the run can fill in: an expansion left as typed, or a glob. */
const UNSPELLED = /\$[({A-Za-z_0-9@*]|`|[*?[]/;

/** Past this many candidate folders a line counts as unreadable. */
const MAX_PLACES = 16;

/** How the reader spells a line's variables here. */
const SPELL = { read: READ, cap: MAX_PLACES };

/** How many shells within shells are read; a shell past this is refused unread, a runner's candidate left alone. */
const MAX_NEST = 8;

/**
 * What one call may cost, nested re-reads included. A hook that runs out of
 * time is passed over by the harness (hooks docs, read 2026-11-05: a dated
 * claim), so a line built to outlast the guard is refused rather than read.
 */
const MAX_READ = 1_000_000;
const MAX_SEGMENTS = 4096;

/**
 * Programs whose words are code in another language, a pattern, or text --
 * never a shell line -- beyond the reader's ARG_SAFE, so `awk '$1 > 5'` and
 * `git commit -m 'a > b'` hold no redirect (#511). A program off this list
 * errs toward a visible refusal, so a gap here is an annoyance, never a hole.
 */
const TEXT_ARGS = /^(?:python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua|awk|gawk|mawk|nawk|sed|gsed|git|curl|wget|psql|mysql|sqlite3|test|\[\[?|export|declare|typeset|readonly|local|set|unset|read)$/;

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
    // a name that merely starts with two dots (`..foo`) is under the root (#512)
    if (!/^\.\.(?:[/\\]|$)/.test(rel) && !isAbsolute(rel)) return rel.split("\\").join("/");
  }
  return null;
}

/** `~` in front of a path, in every value $HOME holds on the line; as typed when the line made $HOME unreadable. */
function spellTilde(raw, vars) {
  if (!/^~(?=\/|$)/.test(raw)) return [raw];
  const homes = vars.get("HOME");
  return Array.isArray(homes) ? homes.map((h) => h + raw.slice(1)) : [raw];
}

/**
 * True when what the shell fills in decides whether a path lands under a
 * root (#512): the literal folder before the first unspelled thing is a root
 * or above one, so `/$X/src/a.ts`, `/Users/$USER/proj/a.ts`, `/U*\/proj/a.ts`
 * and `../$X/a.ts` can each be a project file. Under a folder off to the side
 * (`/opt/$X/y`, `/tmp/$(date).log`) it can't, short of a climb in the value.
 */
function headReaches(target, dir, roots) {
  const at = target.search(UNSPELLED);
  if (at < 0) return false;
  const folder = resolve(dir, target.slice(0, target.lastIndexOf("/", at) + 1));
  return roots.some((root) => underRoot(root, [folder]) !== null);
}

/** `vars` with $PWD every folder the shell may stand in: gone once a cd the guard can't read has run, left alone if the line made it wild. */
function standing(vars, dirs) {
  const held = vars.get("PWD");
  if (held !== undefined && !Array.isArray(held)) return vars;
  const out = new Map(vars);
  if (dirs === null) out.delete("PWD");
  else out.set("PWD", [...new Set([...(held ?? []), ...dirs])]);
  return out;
}

/**
 * The files a shell line writes, each with the folders it may be written
 * from: `dirs` is every folder the shell may stand in at that point (the
 * call's cwd and each literal cd so far), or null once a cd the guard
 * can't read has run -- a later relative target is then unreadable. `lost`
 * marks one the guard can't place at all: refused whatever it says.
 *
 * Every nested line is walked here too (#511), from the folders and the
 * variables its caller stood in, the same way the run guard and the harness
 * guard walk one. One pass, single writer: `out` and `seen` are this call's.
 */
function shellWrites(command, cwd) {
  const out = [];
  const seen = new Set();
  let chars = 0;
  let count = 0;
  const unread = (what) => out.push({ raw: what, dirs: null, lost: true });
  // a redirect target carries no spans past the parser, so it is spelled here, name by name
  const place = (raw, dirs, vars) => {
    for (const word of braceExpand(raw)) {
      const { raws, lost } = expandAssigned(word, vars, MAX_PLACES);
      for (const one of raws) {
        for (const target of spellTilde(one, vars)) if (!DEVICE.test(target)) out.push({ raw: target, dirs, lost });
      }
    }
  };

  /** One line read from `from` ({ dirs, vars }): what it leaves the shell with, which only eval's caller keeps. */
  const walk = (line, from, depth, wilds) => {
    chars += line.length;
    const segs = chars > MAX_READ ? null : shellSegments(line, READ);
    count += segs?.length ?? 0;
    if (segs === null || count > MAX_SEGMENTS) { unread("a line longer than the guard reads"); return from; }
    if (tooDeep(segs)) { unread("a line nested deeper than the guard reads"); return from; }
    let { dirs } = from;
    let vars = seedVars(segs, from.vars, SPELL);
    let upstream = null;
    for (const seg of segs) {
      const piped = upstream;
      upstream = seg.op === "|" || seg.op === "|&" ? seg : null;
      // a redirect is the shell's, from where it stands
      for (const r of seg.redirects) if (r && !r.startsWith("&")) place(r, dirs, vars);
      let moves = dirs;
      // each way the words can read, spelled through what the line assigned
      for (const { words: spelled, wild } of spellWords(seg, vars, { cap: MAX_PLACES, wild: wilds })) {
        const { words, writes, dirs: moved, assigns, wrappers } = unwrap(spelled, READ);
        const name = commandName(words[0]);
        const args = words.slice(1);
        // a wrapper's own write and tee's operands land where the wrapper
        // moved the command (env -C DIR), and so does a line it nests
        const there = dirs === null ? null
          : [...new Set([...dirs, ...moved.flatMap((d) => spellTilde(d, vars).flatMap((m) => dirs.map((b) => resolve(b, m))))])];
        const own = [...writes, ...(name === "tee" ? args.filter((a) => !a.startsWith("-")) : [])];
        for (const f of own) for (const target of spellTilde(f, vars)) out.push({ raw: target, dirs: there });
        if (name === "tee" && wrappers.some((w) => commandName(w.name) === "xargs")) unread("the files xargs hands tee");

        const below = { dirs: there, vars: standing(assignVars(assigns, vars, SPELL), there) };
        const deeper = new Set([...wilds, ...wild]);
        const nest = (inner) => {
          // a program's later words re-read as suffixes of each other, so each is read once per place and per spelling
          const key = JSON.stringify([inner, there, [...below.vars], [...deeper]], (_, v) => (typeof v === "symbol" ? "?" : v));
          if (seen.has(key)) return;
          seen.add(key);
          walk(inner, below, depth + 1, deeper);
        };
        if (depth < MAX_NEST) for (const inner of pagerCommands(assigns, words)) nest(inner);

        if (SHELLS.has(name) || name === "eval" || name === "su") {
          const script = name === "eval" ? evalCommandString(args)
            : name === "su" ? suCommandString(args) : shellCommandString(args);
          // a value the reader can't spell is read again as a line, so it may hold a redirect
          const lostWord = script ? args.find((a) => a && wild.has(a) && script.includes(a)) : undefined;
          if (lostWord !== undefined) unread(lostWord);
          else if (script && depth >= MAX_NEST) unread("a line nested deeper than the guard reads");
          else if (script && name === "eval") {
            // eval runs in this shell: its cd and its assignments are the line's own
            ({ dirs: moves, vars } = walk(script, { dirs: moves, vars }, depth + 1, deeper));
          } else if (script) nest(script);
          else if (name === "su" || shellReadsStdin(args)) {
            // no string: its own heredoc or the one piped in, else whatever a pipe feeds it
            const fed = [seg, ...(piped ? [piped] : [])].flatMap((s) => [...s.heredocs.map((h) => h.body), ...(s.herestrings ?? [])]);
            if (fed.length && depth >= MAX_NEST) unread("a line nested deeper than the guard reads");
            else if (fed.length) for (const doc of fed) nest(doc);
            else if (piped) unread("what a pipe feeds a shell");
          }
        } else if (name === "cd" || name === "pushd") {
          if (moves !== null) {
            const arg = args.find((a) => !a.startsWith("-") || a === "-") ?? "~";
            const spots = spellTilde(arg, vars);
            const next = spots.some((s) => COMPUTED.test(s) || s.startsWith("~")) ? null
              : [...new Set([...moves, ...spots.flatMap((s) => moves.map((d) => resolve(d, s)))])];
            moves = next === null || next.length > MAX_PLACES ? null : next;
          }
        } else if (depth < MAX_NEST) {
          // the program's later words may be the real command (#311); only the
          // option that runs one, on a program whose words are text
          for (const inner of TEXT_ARGS.test(name) ? argCommands(words) : runnerCommands(words)) nest(inner);
        }
      }
      dirs = moves;
      vars = standing(lineVars(seg, vars, SPELL), dirs);
    }
    return { dirs, vars };
  };
  // $HOME and $PWD are known to every guard (the phase's reader decision), so they spell like what the line assigned
  walk(command, { dirs: [cwd], vars: new Map([["HOME", [resolve(homedir())]], ["PWD", [cwd]]]) }, 0, new Set());
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
    for (const { raw, dirs, lost } of shellWrites(payload?.tool_input?.command ?? "", cwd)) {
      if (lost || (dirs === null && !isAbsolute(raw))) { hit = { rel: raw, why: "unreadable" }; break; }
      for (const dir of isAbsolute(raw) ? [cwd] : dirs) {
        const rel = underRoot(resolve(dir, raw), roots);
        if (rel !== null) hit = judge(rel);
        else if (headReaches(raw, dir, roots)) hit = { rel: raw, why: "unreadable" };
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
    console.error(`cairn write guard: agent type '${type}' is limited under this project, and this line writes through ` +
      `${hit.rel}, which the guard can't read (a cd, a variable or a nested line it can't resolve) — spell it out, or hand the change to the dispatching session.`);
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
