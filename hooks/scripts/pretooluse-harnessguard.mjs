#!/usr/bin/env node

/**
 * Purpose: PreToolUse harness guard (#208) -- refuses agent writes to the
 *   files that define the agent's own harness: the hook directory, the MCP
 *   server config, the settings cascade, the plugin manifest, and the
 *   ship-gate stamp and run manifests the run guard trusts (#263: under
 *   CAIRN_HOME and ~/.cairn; the run report stays writable, and the
 *   server's own writes never pass a hook). An agent that can rewrite its
 *   own hooks can switch off every other control in one edit, so this is
 *   the backstop the rule-to-control check points at. Exit 2 blocks; ANY
 *   internal error exits 0. Residual (#263): run_manifest set_status
 *   running->stopped is a legal server call and lifts the mid-run push block.
 *
 *   Threat model, stated plainly so nobody over-trusts it: the realistic
 *   attack is INDIRECT -- text the agent reads (an issue body, a review
 *   comment, a fetched page) steering it into a harness edit it would not
 *   otherwise make. This guard turns that from a silent success into a
 *   refusal the human sees. It is NOT a sandbox: the
 *   CAIRN_HARNESS_EDIT=1 escape exists for the human, and text that can
 *   steer the agent can also ask for the prefix -- which exempts only the
 *   one command it prefixes (#265). Visibility is the control; isolation is
 *   the operating system's job. Bash is read the way a shell would read it
 *   (shell-words.mjs, shared with the run guard, #270) to find what it
 *   WRITES: redirects, and the operands of commands that change files (rm,
 *   sed -i, cp/mv/rsync into a folder, curl -o, tar -C, a patch's files,
 *   find -delete/-exec, paths piped to xargs), through wrappers, bash -c,
 *   su -c and a heredoc fed to a shell. A relative path is judged from the
 *   payload cwd and every folder a cd, env -C or git -C on the line can
 *   reach, in any order (#258); after a cd the guard can't follow, it is
 *   refused. Removing a protected folder, or one holding it, counts. Other
 *   heredocs are data; a path only READ passes (#240). Not seen: a write
 *   inside an interpreter (python -c) or $(...), an archive's members,
 *   piped paths an upstream command finds itself (git ls-files | xargs rm).
 *
 * removeWhen: the platform isolates agent config at the OS level, so the
 *   agent process cannot write its own hooks or settings (ADR 0016).
 * Author(s): John Reed
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SHELLS, braceExpand, shellCommandString, shellReadsStdin, shellSegments, suCommandString, unwrap,
} from "./shell-words.mjs";

// Constants

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

// Names a wildcard is tested against inside .claude/ and .claude-plugin/.
const SETTINGS_NAMES = ["settings.json", "settings.local.json"];
const MANIFEST_NAMES = ["plugin.json", "marketplace.json"];

// Stand-ins for names the command line doesn't spell out, each matching
// any name, dotfiles included. ANY: what `rsync src/ dir` or `cp -r src/.
// dir` drops in dir. STDIN: a path xargs reads from its input (#258).
// WALK: a path find walks to, its `{}` (#258).
const ANY = "\u0001";
const STDIN = "\u0002";
const WALK = "\u0003";
const STANDINS = [ANY, STDIN, WALK];
const HAS_STANDIN = /[*?[\u0001-\u0003]/;

// `$1`, `${2}`, `$@`, `$*` -- a nested shell's positional arguments.
const POSITIONAL = /\$\{?[0-9@*]\}?/g;

// The folder after a directory change the guard can't follow (#258). Paths
// resolved from it stay under it, so a write there is told apart and refused.
const LOST = join(sep, "\u0004");

// The most folders a line is tracked as maybe being in before it counts as lost.
const MAX_PLACES = 16;

// Reserved words that open a loop, whose body may run any number of times.
const LOOPS = new Set(["while", "until", "for", "select"]);

// A function's name before its `()` -- what a lone word ending at `(` is.
const FUNC_NAME = /^[A-Za-z_][\w.:-]*$/;

// Operators that feed one command's output to the next one's input.
const PIPE = new Set(["|", "|&"]);

// The most of one file the guard reads (a patch, a list of paths).
const READ_CAP = 32 * 1024 * 1024;

// Descriptors and devices, never a file this guard cares about.
const DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// A NAME=value word in command position.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * How this guard reads a command line (shell-words.mjs): redirect targets
 * and heredocs are modelled, and ( ) and backticks end a command, so
 * `(cd hooks && rm x)` is a cd and an rm (#258). # comments and quoted
 * $(...) are word text, so a write hidden in a substitution is not seen.
 */
const READ = { redirects: true, subshells: true };

// find: name tests, the primaries that take a value, and the ones that act.
const FIND_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
  "-regex", "-iregex", "-lname", "-ilname"]);
const FIND_VALUE = new Set(["-newer", "-anewer", "-cnewer", "-type", "-xtype", "-size", "-perm",
  "-user", "-group", "-uid", "-gid", "-maxdepth", "-mindepth", "-mtime", "-atime", "-ctime",
  "-mmin", "-amin", "-cmin", "-used", "-links", "-inum", "-samefile", "-fstype", "-context",
  "-printf", "-files0-from", "-regextype"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_WRITES = new Set(["-fprint", "-fprint0", "-fls", "-fprintf"]);

// Commands that remove, create, or change every path operand they are given.
const REMOVES = new Set(["rm", "rmdir", "unlink", "shred"]);
const CREATES = new Set(["mkdir", "touch"]);
const CHANGES = new Set(["tee", "truncate", "chmod", "chown", "chgrp"]);

// Commands that read their sources and write a destination (or -t DIR),
// with the flags that swallow a value -- so `--exclude x` never reads as
// the destination.
const RSYNC_VALUE = [
  "--rsh", "--exclude", "--include", "--filter", "--files-from", "--exclude-from",
  "--include-from", "--password-file", "--log-file", "--log-file-format", "--backup-dir",
  "--temp-dir", "--partial-dir", "--compare-dest", "--link-dest", "--copy-dest",
  "--block-size", "--max-size", "--min-size", "--timeout", "--contimeout", "--port",
  "--chmod", "--chown", "--remote-option", "--out-format", "--suffix", "--rsync-path",
  "--bwlimit", "--iconv", "--usermap", "--groupmap", "--sockopts", "--modify-window",
  "--info", "--debug", "--checksum-choice", "--compress-choice", "--compress-level",
  "--skip-compress", "--max-delete", "--protocol", "--outbuf", "--stop-after", "--stop-at",
  "--write-batch", "--only-write-batch", "--read-batch", "--early-input", "--address",
];
const COPIES = new Map([
  ["cp", { short: "St", long: ["--target-directory", "--suffix"] }],
  ["mv", { short: "St", long: ["--target-directory", "--suffix"] }],
  ["ln", { short: "St", long: ["--target-directory", "--suffix"] }],
  ["install", { short: "Stmog", long: ["--target-directory", "--suffix", "--mode", "--owner",
    "--group", "--strip-program"] }],
  ["rsync", { short: "efBTM", long: RSYNC_VALUE }],
]);
// rsync flags whose value is a file or folder rsync writes.
const RSYNC_WRITES = ["--log-file", "--write-batch", "--only-write-batch", "--backup-dir"];

// Downloaders: the value-taking flags, and the ones that name a file written.
const CURL = {
  short: "AbcCdDeEFHKmoPQrtTuUwxXyYz",
  long: ["--output", "--output-dir", "--cookie-jar", "--dump-header", "--trace", "--trace-ascii",
    "--stderr", "--libcurl", "--etag-save", "--etag-compare", "--hsts", "--alt-svc", "--url",
    "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--header",
    "--user-agent", "--referer", "--user", "--request", "--cookie", "--form", "--form-string",
    "--config", "--max-time", "--connect-timeout", "--proxy", "--proxy-user", "--cert", "--key",
    "--cacert", "--capath", "--retry", "--retry-delay", "--retry-max-time", "--range",
    "--upload-file", "--write-out", "--resolve", "--connect-to", "--limit-rate", "--max-filesize",
    "--interface", "--oauth2-bearer", "--json", "--variable", "--continue-at", "--quote",
    "--time-cond", "--max-redirs", "--noproxy", "--unix-socket", "--preproxy", "--proxy-header"],
};
const CURL_WRITES = ["-c", "--cookie-jar", "-D", "--dump-header", "--trace", "--trace-ascii",
  "--stderr", "--libcurl", "--etag-save", "--hsts", "--alt-svc"];
const CURL_REMOTE_NAME = ["-O", "--remote-name", "--remote-name-all", "-J", "--remote-header-name"];
const WGET = {
  short: "OoaPeiBtTwQUlARDIX",
  long: ["--output-document", "--output-file", "--append-output", "--directory-prefix",
    "--execute", "--input-file", "--base", "--tries", "--timeout", "--wait", "--quota",
    "--user-agent", "--level", "--accept", "--reject", "--domains", "--include-directories",
    "--exclude-directories", "--save-cookies", "--load-cookies", "--rejected-log", "--header",
    "--user", "--password", "--post-data", "--post-file", "--body-data", "--body-file",
    "--method", "--referer", "--limit-rate", "--warc-file", "--cut-dirs"],
};
const WGET_WRITES = ["-o", "--output-file", "-a", "--append-output", "--save-cookies",
  "--rejected-log"];

// Archivers and patch tools.
const TAR = {
  short: "fCTXbKNgLFHVI",
  long: ["--file", "--directory", "--files-from", "--exclude-from", "--exclude", "--transform",
    "--xform", "--strip-components", "--blocking-factor", "--starting-file", "--newer",
    "--after-date", "--newer-mtime", "--listed-incremental", "--tape-length", "--info-script",
    "--new-volume-script", "--format", "--label", "--use-compress-program", "--owner",
    "--group", "--mode", "--mtime", "--to-command", "--index-file", "--rmt-command",
    "--rsh-command", "--volno-file", "--checkpoint-action", "--warning", "--record-size",
    "--suffix", "--sort", "--quoting-style"],
};
const PATCH = {
  short: "iodpDFrBzVYg",
  long: ["--input", "--output", "--directory", "--strip", "--ifdef", "--fuzz", "--reject-file",
    "--prefix", "--suffix", "--version-control", "--basename-prefix", "--get", "--quoting-style"],
};
const GIT_APPLY = { short: "pC", long: ["--directory", "--include", "--exclude", "--whitespace",
  "--build-fake-ancestor"] };

// git's global options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace",
  "--config-env", "--super-prefix"]);

// The most entries listed under one protected folder outside the project
// before the rest counts as unlisted -- and so as reachable (see walkHit).
const LIST_CAP = 500;

// Variables -- the folders every rule is measured against, set per payload.
// Each holds the path as given and its real path, when a symlink differs.
let ROOTS = [];
let HOMES = [];
// Protected places outside the project (#263), each { dir, what, tree }:
// `tree` protects everything under dir, else only the *.json files
// directly in it (the way the run guard reads runs/).
let ZONES = [];
// The protected paths find could walk to, listed once per run, and the
// zones too big to list in full.
let ENTRIES = null;
let UNLISTED = [];

// Paths

/** The real path of the deepest folder that exists, with the rest put back. */
function canonical(abs) {
  const rest = [];
  let head = abs;
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch { /* not there yet */ }
    const up = dirname(head);
    if (up === head) return abs;
    rest.unshift(basename(head));
    head = up;
  }
}

/** Both spellings of a folder, deduped. */
function spellings(dir) {
  const abs = resolve(dir);
  const real = canonical(abs);
  return real === abs ? [abs] : [abs, real];
}

/** True for the lost folder, or a path resolved from it. */
function isLost(abs) {
  return abs === LOST || abs.startsWith(LOST + sep);
}

/** A path as the command would reach it from `dir`. */
function resolveIn(dir, raw) {
  if (isAbsolute(raw)) return resolve(raw);
  const abs = resolve(dir, raw);
  // `..` never climbs out of a folder the guard lost track of
  return isLost(dir) && !isLost(abs) ? LOST : abs;
}

/** Candidate folder lists merged, every lost one as LOST; past MAX_PLACES the line counts as lost. */
function union(...lists) {
  const all = [...new Set(lists.flat().map((p) => (isLost(p) ? LOST : p)))];
  return all.length > MAX_PLACES ? [LOST] : all;
}

/** Project-relative POSIX path, or null when the path escapes the project. */
function projectRelative(abs) {
  for (const root of ROOTS) {
    const rel = relative(root, abs);
    const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!escapes) return rel.split(sep).join("/");
  }
  return null;
}

/** True when `abs` is `dir` or any folder above it. */
function holds(abs, dir) {
  return abs === dir || dir.startsWith(abs.endsWith(sep) ? abs : abs + sep);
}

/** ~, $HOME and ${HOME} at the front of a path, spelled out the way the shell does (#258, #263). */
function expandHome(raw) {
  return raw.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, () => resolve(homedir()));
}

/**
 * The protected places outside the project (#263): the ship-gate stamp
 * and the run manifests the run guard trusts, in every cairn home they
 * can live in -- CAIRN_HOME (the run guard reads it) and ~/.cairn (the
 * server writes it). The run report beside the manifests stays writable.
 */
function outsideZones() {
  const zones = [];
  const add = (dir, what, tree) => {
    for (const d of spellings(dir)) zones.push({ dir: d, what, tree });
  };
  for (const base of [process.env.CAIRN_HOME, ...HOMES.map((h) => join(h, ".cairn"))]) {
    if (!base) continue;
    add(join(base, "ship-gate"), "the ship-gate stamp", true);
    add(join(base, "runs"), "the run manifests", false);
  }
  return zones;
}

/** The protected place outside the project a path lies inside, or null. */
function zoneOf(abs) {
  for (const z of ZONES) {
    if (abs === z.dir || !holds(z.dir, abs)) continue;
    if (z.tree || (dirname(abs) === z.dir && abs.endsWith(".json"))) return z.what;
  }
  return null;
}

/**
 * Text of a regular file, or null when it can't be read. Devices, FIFOs
 * and huge files are never read: `git apply /dev/zero` would hang the
 * guard past its timeout, and a timed-out guard lets the line through.
 */
function readText(abs) {
  try {
    const st = statSync(abs);
    return st.isFile() && st.size <= READ_CAP ? readFileSync(abs, "utf8") : null;
  } catch {
    return null;
  }
}

// Rules

/** The file itself is protected (the check every version of this guard made). */
function fileRule(abs) {
  for (const home of HOMES) {
    if (abs === join(home, ".claude", "settings.json") ||
      abs === join(home, ".claude", "settings.local.json")) return "your machine-wide Claude settings";
  }
  const zone = zoneOf(abs);
  if (zone) return zone;
  const rel = projectRelative(abs);
  if (rel === null) return null; // elsewhere outside the project -- not this guard's business
  for (const p of PROTECTED) if (p.re.test(rel)) return p.what;
  return null;
}

/** The path names a protected FOLDER: writing into it, replacing it or removing it (#265). */
function dirRule(abs) {
  for (const home of HOMES) {
    if (abs === join(home, ".claude")) return "your machine-wide Claude settings";
  }
  const zone = ZONES.find((z) => z.dir === abs);
  if (zone) return zone.what;
  const rel = projectRelative(abs);
  if (!rel) return null;
  if (rel === "hooks") return "the hook directory";
  const name = rel.split("/").pop();
  if (name === ".claude") return "a Claude settings directory";
  if (name === ".claude-plugin") return "the plugin manifest";
  return null;
}

/** Removing the project, or any folder above it, removes everything in it (#265). */
function holderRule(abs) {
  if (ROOTS.some((root) => holds(abs, root))) {
    return "the folder holding the hook directory and settings";
  }
  if (HOMES.some((home) => holds(abs, home))) {
    return "the folder holding your machine-wide Claude settings";
  }
  const zone = ZONES.find((z) => holds(abs, z.dir));
  return zone ? `the folder holding ${zone.what}` : null;
}

/** Could this name, once the shell expands it in `dir`, be a *.json file there? */
function couldManifest(comp, dir) {
  if (STANDINS.includes(comp) || comp.endsWith(".json")) return true;
  let names = [];
  try { names = readdirSync(dir); } catch { /* nothing there to expand to */ }
  return names.some((n) => n.endsWith(".json") && could(comp, n));
}

/** The protected place outside the project a wildcard path could reach (#263). */
function zoneGlob(p, remove) {
  for (const z of ZONES) {
    const d = z.dir.split(sep).filter(Boolean);
    const n = d.length;
    if (!n || p.length < n || !d.slice(0, -1).every((x, j) => could(p[j], x))) continue;
    if (p.length === n) {
      if (could(p[n - 1], d[n - 1], remove)) return z.what;
    } else if (could(p[n - 1], d[n - 1]) &&
      (z.tree || (p.length === n + 1 && couldManifest(p[n], z.dir)))) return z.what;
  }
  return null;
}

/** One glob component as a regex; a stand-in matches any name. */
function compRe(comp) {
  let re = /^[*?[]/.test(comp) ? "(?!\\.)" : ""; // a leading wildcard skips dotfiles
  for (let i = 0; i < comp.length; i++) {
    const c = comp[i];
    const close = c === "[" ? comp.indexOf("]", i + 2) : -1;
    if (STANDINS.includes(c)) re += ".*";
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (close > 0) {
      re += `[${comp.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Could this glob component expand to `name`? A bare stand-in counts only when `anyOk`. */
function could(comp, name, anyOk = true) {
  if (STANDINS.includes(comp)) return anyOk;
  try { return compRe(comp).test(name); } catch { return true; }
}

/**
 * The rule a wildcard path could hit once the shell expands it: `*` at the
 * project root can name hooks/, `.claude/*.json` a settings file, `rm -rf
 * ../*` the project itself. An unknown name (ANY) can be a settings file
 * inside .claude/, but names a whole protected folder only when removing.
 */
function globRule(abs, mode) {
  const remove = mode === "remove";
  const rel = projectRelative(abs);
  if (rel !== null) {
    const c = rel ? rel.split("/") : [];
    if (c.length && could(c[0], "hooks")) return "the hook directory";
    if (c.length === 1 && could(c[0], ".mcp.json")) return "the MCP server config";
    for (let i = 0; i < c.length; i++) {
      for (const [dir, names, what] of [[".claude", SETTINGS_NAMES, "a settings file"],
        [".claude-plugin", MANIFEST_NAMES, "the plugin manifest"]]) {
        // the folder itself, or a settings / manifest file directly inside it
        if (i === c.length - 1 && could(c[i], dir, remove)) return dirRule(join(ROOTS[0], dir));
        const named = i === c.length - 2 && names.some((n) => could(c[i + 1], n));
        if (named && could(c[i], dir)) return what;
      }
    }
  }
  const p = abs.split(sep).filter(Boolean);
  const under = (dir) => {
    const d = dir.split(sep).filter(Boolean);
    return p.length >= d.length && d.every((x, j) => could(p[j], x));
  };
  for (const home of HOMES) {
    const n = home.split(sep).filter(Boolean).length;
    if (!under(home) || !could(p[n] ?? "", ".claude")) continue;
    if ((p.length === n + 1 && could(p[n], ".claude", remove)) ||
      (p.length === n + 2 && SETTINGS_NAMES.some((s) => could(p[n + 1], s)))) {
      return "your machine-wide Claude settings";
    }
  }
  const zone = zoneGlob(p, remove);
  if (zone) return zone;
  if (remove) {
    for (const dir of [...ROOTS, ...HOMES, ...ZONES.map((z) => z.dir)]) {
      const d = dir.split(sep).filter(Boolean);
      if (p.length <= d.length && p.every((x, j) => could(x, d[j]))) return holderRule(dir);
    }
  }
  return null;
}

/**
 * Which protected thing a path would change, or null. `mode` is what the
 * command does to it: write (the file, or into the folder it names),
 * create (mkdir/touch -- an empty folder changes nothing), or remove.
 * Both the path as written and its real path are checked, so a symlinked
 * project folder can't hide either spelling.
 */
function judge(abs, mode, literal = false) {
  for (const p of spellings(abs)) {
    const what = fileRule(p) ??
      (mode !== "create" ? dirRule(p) : null) ??
      (mode === "remove" ? holderRule(p) : null) ??
      (!literal && HAS_STANDIN.test(p) ? globRule(p, mode) : null);
    if (what) return what;
  }
  return null;
}

// Reading commands

/**
 * Splits a command's arguments into options and operands, GNU style:
 * clusters (`-sSLo f`) give the rest of the word, or the next word, to the
 * first value-taking letter; `--name value` takes the next word only for a
 * listed long option; `--` ends the options.
 */
function parseOpts(args, spec = {}) {
  const short = spec.short ?? "";
  const long = spec.long ?? [];
  const opts = [];
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { operands.push(...args.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      let value = eq < 0 ? null : a.slice(eq + 1);
      if (value === null && long.includes(name) && i + 1 < args.length) value = args[++i];
      opts.push({ name, value });
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (!short.includes(a[k])) { opts.push({ name: `-${a[k]}`, value: null }); continue; }
        const value = k + 1 < a.length ? a.slice(k + 1) : (i + 1 < args.length ? args[++i] : null);
        opts.push({ name: `-${a[k]}`, value });
        break;
      }
      continue;
    }
    operands.push(a);
  }
  return { opts, operands };
}

/** The last value given for any of these option names. */
function optValue(opts, ...names) {
  let v;
  for (const o of opts) if (names.includes(o.name) && o.value !== null) v = o.value;
  return v;
}

/** True when any of these option names was given. */
function hasOpt(opts, ...names) {
  return opts.some((o) => names.includes(o.name));
}

/** Plain operands: every word that isn't a flag, and everything after `--`. */
function plain(args) {
  const k = args.indexOf("--");
  const head = (k < 0 ? args : args.slice(0, k)).filter((a) => !a.startsWith("-"));
  return k < 0 ? head : head.concat(args.slice(k + 1));
}

/** The file name curl -O / wget would save a URL as. */
function urlName(url) {
  const path = String(url).replace(/[?#].*$/, "").replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, "");
  return path.slice(path.lastIndexOf("/") + 1) || null;
}

/**
 * Every path a patch names: `diff --git` pairs, ---/+++ (and context-diff
 * ***) header pairs, rename/copy lines, and Index: lines.
 */
function patchPaths(text) {
  const clean = (s) => s.replace(/\t.*$/, "").trim().replace(/^"(.*)"$/, "$1");
  const lines = text.split(/\r?\n/);
  const paths = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^diff --git (.+)$/.exec(l))) {
      paths.push(...(m[1].match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(clean));
    } else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(l)) || (m = /^Index: (.+)$/.exec(l))) {
      paths.push(clean(m[1]));
    } else if ((m = /^(?:---|\*\*\*) (.+)$/.exec(l)) && /^(?:\+\+\+|---) /.test(lines[i + 1] ?? "")) {
      paths.push(clean(m[1]), clean(lines[i + 1].slice(4)));
      i++;
    }
  }
  return paths.filter((p) => p && p !== "/dev/null");
}

/**
 * A patch path after stripping `n` leading components (-pN). With no -p,
 * GNU patch keeps only the base name and BSD patch may keep the whole
 * path, so both are checked.
 */
function stripped(path, n) {
  if (n === null || !Number.isFinite(n)) return [path, basename(path)];
  let s = path;
  for (let k = 0; k < n; k++) {
    const j = s.indexOf("/");
    if (j < 0) return [];
    s = s.slice(j + 1).replace(/^\/+/, "");
  }
  return [s];
}

/**
 * What a command reads on stdin, or null when it can't be read: its own
 * heredocs, here-strings and `< file`, else the files a `cat` piping into
 * it names (`cat fix.diff | patch -p1`, #258).
 */
function stdinText(seg, dir, up = []) {
  const parts = [...seg.heredocs.map((h) => h.body), ...(seg.herestrings ?? [])];
  const files = [...(seg.inputs ?? [])];
  const feeder = up.length ? unwrap(up[up.length - 1].words, READ).words : [];
  if (!parts.length && !files.length && basename(feeder[0] ?? "") === "cat") {
    const last = up[up.length - 1];
    parts.push(...last.heredocs.map((h) => h.body), ...(last.herestrings ?? []));
    files.push(...plain(feeder.slice(1)), ...(last.inputs ?? []));
  }
  for (const f of files) {
    const t = readText(resolveIn(dir, f));
    if (t !== null) parts.push(t);
  }
  return parts.length ? parts.join("\n") : null;
}

/** The nearest folder at or above `dir` holding a .git, else `dir`. */
function gitRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return dir;
  }
}

// Streams: what find walks and what xargs reads (#258)

/**
 * find's start paths, name tests, and what it does to each path it walks:
 * -delete, -exec/-execdir/-ok/-okdir (with `{}` as WALK), -fprint files.
 */
function parseFind(args) {
  let i = 0;
  // global options (-H -L -P -O3 -D opts) come before the start paths
  while (i < args.length && (/^-(H|L|P|O\d*)$/.test(args[i]) || args[i] === "-D")) {
    i += args[i] === "-D" ? 2 : 1;
  }
  const starts = [];
  while (i < args.length && !/^[-(!]/.test(args[i])) starts.push(args[i++]);
  const spec = {
    starts: starts.length ? starts : ["."], tests: [], negated: false, remove: false, execs: [], files: [],
  };
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "!" || a === "-not") spec.negated = true;
    else if (FIND_TESTS.has(a)) {
      spec.tests.push({ kind: a.replace(/^-i?/, ""), ci: a.startsWith("-i"), pat: args[++i] ?? "" });
    } else if (a === "-delete") spec.remove = true;
    else if (FIND_EXEC.has(a)) {
      // the command runs once per path (or batch, with +), {} standing for it
      const words = [];
      for (i++; i < args.length && args[i] !== ";" && args[i] !== "+"; i++) {
        words.push(args[i].split("{}").join(WALK));
      }
      spec.execs.push(words);
    } else if (FIND_WRITES.has(a)) {
      spec.files.push(args[++i] ?? "");
      if (a === "-fprintf") i++;
    } else if (FIND_VALUE.has(a)) i++;
  }
  return spec;
}

/** fnmatch(3) without FNM_PATHNAME, as find's -name and -path use it. */
function fnmatchRe(pat, ci) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    const close = c === "[" ? pat.indexOf("]", i + 2) : -1;
    if (c === "\\" && i + 1 < pat.length) re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (close > 0) {
      re += `[${pat.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, ci ? "i" : "");
}

/** Does this find test select `entry` (printed by find as `shown`)? Unreadable tests select. */
function testSelects(t, entry, shown) {
  if (t.kind === "lname") return false; // symlink targets; the protected files are not links
  try {
    if (t.kind === "regex") return new RegExp(`^(?:${t.pat})$`, t.ci ? "i" : "").test(shown);
    return fnmatchRe(t.pat, t.ci).test(t.kind === "name" ? basename(entry) : shown);
  } catch {
    return true;
  }
}

/** Everything under `dir`, nearest first, up to LIST_CAP entries; true when some was left unlisted. */
function listTree(dir, out) {
  const queue = [dir];
  let n = 0;
  while (queue.length) {
    const d = queue.shift();
    let found = [];
    try { found = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of found) {
      if (++n > LIST_CAP) return true;
      out.push(join(d, e.name));
      if (e.isDirectory()) queue.push(join(d, e.name));
    }
  }
  return false;
}

/** The folder a find start names whose whole contents are protected, or null. */
function treeRule(abs) {
  const zone = ZONES.find((z) => z.tree && z.dir === abs);
  if (zone) return zone.what;
  return dirRule(abs) === "the hook directory" ? "the hook directory" : null;
}

/**
 * Every protected path find could reach: the fixed surfaces, what hooks/
 * holds on disk, and the protected places outside the project (#263) --
 * a zone too big to list goes in UNLISTED.
 */
function protectedEntries() {
  if (ENTRIES) return ENTRIES;
  ENTRIES = [];
  for (const z of ZONES) {
    if (!existsSync(z.dir)) continue;
    ENTRIES.push(z.dir);
    if (z.tree) {
      if (listTree(z.dir, ENTRIES)) UNLISTED.push(z);
      continue;
    }
    let names = [];
    try { names = readdirSync(z.dir); } catch { /* not a folder */ }
    for (const n of names) if (n.endsWith(".json")) ENTRIES.push(join(z.dir, n));
  }
  for (const root of ROOTS) {
    ENTRIES.push(join(root, "hooks"), join(root, "hooks", "hooks.json"), join(root, ".mcp.json"),
      join(root, ".claude"), ...SETTINGS_NAMES.map((n) => join(root, ".claude", n)),
      join(root, ".claude-plugin"), ...MANIFEST_NAMES.map((n) => join(root, ".claude-plugin", n)));
    const stack = [join(root, "hooks")];
    while (stack.length && ENTRIES.length < 2000) {
      const d = stack.pop();
      let found = [];
      try { found = readdirSync(d, { withFileTypes: true }); } catch { /* no such folder */ }
      for (const e of found) {
        ENTRIES.push(join(d, e.name));
        if (e.isDirectory()) stack.push(join(d, e.name));
      }
    }
  }
  for (const home of HOMES) {
    ENTRIES.push(join(home, ".claude"), ...SETTINGS_NAMES.map((n) => join(home, ".claude", n)));
  }
  return ENTRIES;
}

/**
 * Would find, walking from `dir`, reach a protected path its tests select?
 * A start inside hooks/ (or a protected file or folder tree) is hit
 * whatever the tests say; a start holding one is hit when a test can
 * select it, when nothing narrows the walk (no name test, or a negated
 * one), or when it holds a zone too big to list.
 */
function walkHit(spec, dir) {
  for (const s of spec.starts) {
    const start = resolveIn(dir, expandHome(s)); // `find ~/.cairn` walks the home folder (#263)
    const inside = fileRule(start) ?? treeRule(start);
    if (inside) return { path: s, what: inside };
    const entries = protectedEntries();
    const unlisted = UNLISTED.find((z) => holds(start, z.dir));
    if (unlisted) return { path: s, what: unlisted.what };
    for (const entry of entries) {
      if (!holds(start, entry)) continue;
      const shown = s.replace(/\/+$/, "") + entry.slice(start.length);
      if (spec.negated || !spec.tests.length || spec.tests.some((t) => testSelects(t, entry, shown))) {
        return { path: shown, what: judge(entry, "remove") ?? "the hook directory" };
      }
    }
  }
  return null;
}

/** xargs's command line with its stdin paths in place: at the end, or where -I's (BSD -J's) string sits. */
function withStdin(words, xargsArgs) {
  let rep = null;
  for (let i = 0; i < xargsArgs.length; i++) {
    const a = xargsArgs[i];
    if (a === "-I" || a === "-J") rep = xargsArgs[i + 1] ?? null;
    else if (a.startsWith("-I") || a.startsWith("-J")) rep = a.slice(2);
    else if (a === "-i" || a === "--replace") rep = "{}";
    else if (a.startsWith("--replace=")) rep = a.slice("--replace=".length);
    else if (a.startsWith("-i")) rep = a.slice(2);
  }
  return rep ? words.map((x) => x.split(rep).join(STDIN)) : words.concat(STDIN);
}

/** The files xargs -a / --arg-file reads its paths from instead of stdin. */
function argFiles(xargsArgs) {
  const files = [];
  for (let i = 0; i < xargsArgs.length; i++) {
    const a = xargsArgs[i];
    if (a === "-a" || a === "--arg-file") files.push(xargsArgs[i + 1] ?? "");
    else if (a.startsWith("--arg-file=")) files.push(a.slice("--arg-file=".length));
    else if (/^-a./.test(a)) files.push(a.slice(2));
  }
  return files.filter(Boolean);
}

/**
 * A protected path named by what feeds a command's stdin, or null: its
 * own heredoc, here-string, `< file` or xargs -a file, and every upstream
 * command of the pipeline -- its words, and for find, what it walks
 * (#258). Paths an upstream command discovers itself (git ls-files,
 * grep -rl .) can't be seen.
 */
function feedHit(feed, mode) {
  const texts = [...feed.seg.heredocs.map((h) => h.body), ...(feed.seg.herestrings ?? [])];
  // the shell opens `< file` where it is; env -C may have moved xargs, so -a files are read from both
  const shell = feed.shellDir ?? feed.dir;
  const files = [...(feed.seg.inputs ?? []).map((f) => resolveIn(shell, f)),
    ...(feed.argFiles ?? []).flatMap((f) => [resolveIn(feed.dir, f), resolveIn(shell, f)])];
  for (const f of new Set(files)) {
    const t = readText(f);
    if (t !== null) texts.push(t);
  }
  const words = [];
  for (const u of feed.up) {
    const w = unwrap(u.words, READ).words;
    if (basename(w[0] ?? "") === "find") {
      const hit = walkHit(parseFind(w.slice(1)), feed.dir);
      if (hit) return hit;
      continue;
    }
    words.push(...w.slice(1));
    texts.push(...u.heredocs.map((h) => h.body), ...(u.herestrings ?? []));
  }
  for (const t of texts) words.push(...t.split(/\s+/));
  for (const x of words) {
    if (!x || x.startsWith("-")) continue;
    const what = judge(resolveIn(feed.dir, x), mode);
    if (what) return { path: x, what };
  }
  return null;
}

// Write models, one per command family. Each calls add(raw, mode, dir).

/** cp, mv, ln, install, rsync: the destination, where each source lands in it, and mv's sources. */
function copyTargets(cmd, args, add) {
  const { opts, operands } = parseOpts(args, COPIES.get(cmd));
  const rsync = cmd === "rsync";
  if (cmd === "install" && hasOpt(opts, "-d", "--directory")) {
    for (const o of operands) add(o, "create");
    return;
  }
  if (rsync) for (const o of opts) if (RSYNC_WRITES.includes(o.name) && o.value) add(o.value);
  let dest = optValue(opts, "-t", "--target-directory");
  let srcs = operands;
  if (dest === undefined) {
    if (operands.length >= 2) {
      dest = operands[operands.length - 1];
      srcs = operands.slice(0, -1);
    } else if (cmd === "ln" && operands.length === 1) dest = "."; // ln -s x: a link named x, here
    else return;
  }
  const remote = (p) => rsync && /^[^/]*:/.test(p);
  if (cmd === "mv" || (rsync && hasOpt(opts, "--remove-source-files"))) {
    for (const s of srcs) if (!remote(s)) add(s, "remove");
  }
  if (remote(dest)) return;
  add(dest, rsync && opts.some((o) => o.name.startsWith("--delete")) ? "remove" : "write");
  // Where each source lands: dest/<its name>, or an unknown name when a
  // folder's CONTENTS are copied (rsync src/, cp src/., -T).
  const contents = !rsync && hasOpt(opts, "-T", "--no-target-directory");
  for (const s of srcs) {
    const local = rsync ? s.replace(/^[^/]*:/, "") : s;
    if (contents || local.endsWith("/.") || (rsync && local.endsWith("/"))) add(join(dest, ANY));
    else if (hasOpt(opts, "--parents")) add(join(dest, local));
    else if (basename(local)) add(join(dest, basename(local)));
  }
}

/** curl: -o files, the -O download folder and names, and the other files it can write. */
function curlTargets(args, ctx, add) {
  const { opts, operands } = parseOpts(args, CURL);
  const outDir = optValue(opts, "--output-dir");
  const into = outDir === undefined ? ctx.dir : resolveIn(ctx.dir, outDir);
  for (const o of opts) {
    if (o.value === null || o.value === "-") continue;
    if (o.name === "-o" || o.name === "--output") add(o.value, "write", into);
    else if (CURL_WRITES.includes(o.name)) add(o.value);
  }
  if (!hasOpt(opts, ...CURL_REMOTE_NAME)) return;
  add(outDir ?? "."); // the download lands in this folder, under a name the server picks
  const urls = operands.concat(opts.filter((o) => o.name === "--url" && o.value).map((o) => o.value));
  for (const u of urls) {
    const name = urlName(u);
    if (name) add(name, "write", into);
  }
}

/** wget: -O, else the -P (or current) folder and each URL's name, plus its log files. */
function wgetTargets(args, ctx, add) {
  const { opts, operands } = parseOpts(args, WGET);
  for (const o of opts) if (WGET_WRITES.includes(o.name) && o.value && o.value !== "-") add(o.value);
  if (hasOpt(opts, "--spider")) return;
  const doc = optValue(opts, "-O", "--output-document");
  if (doc !== undefined) {
    if (doc !== "-") add(doc);
    return;
  }
  const prefix = optValue(opts, "-P", "--directory-prefix");
  const into = prefix === undefined ? ctx.dir : resolveIn(ctx.dir, prefix);
  add(prefix ?? ".");
  for (const u of operands) {
    const name = urlName(u);
    if (name) add(name, "write", into);
  }
}

/** tar: extraction into each -C folder (or here) and named members; -f when creating. */
function tarTargets(args, ctx, add) {
  let a = args.slice();
  if (a.length && !a[0].startsWith("-")) {
    // old-style bundle (`tar xzf a.tgz`): each value letter takes the next word
    const bundle = a.shift();
    const expanded = [];
    for (const ch of bundle) {
      expanded.push(`-${ch}`);
      if (TAR.short.includes(ch)) expanded.push(a.shift() ?? "");
    }
    a = expanded.concat(a);
  }
  const { opts, operands } = parseOpts(a, TAR);
  if (hasOpt(opts, "-c", "-r", "-u", "-A", "--create", "--append", "--update", "--catenate",
    "--concatenate")) {
    for (const o of opts) {
      if (["-f", "--file", "--index-file"].includes(o.name) && o.value && o.value !== "-") add(o.value);
    }
    return;
  }
  if (!hasOpt(opts, "-x", "--extract", "--get")) return;
  if (hasOpt(opts, "-O", "--to-stdout", "--to-command")) return; // nothing lands on disk
  let dir = ctx.dir;
  let moved = false;
  for (const o of opts) {
    if ((o.name === "-C" || o.name === "--directory") && o.value) {
      add(o.value, "write", dir);
      dir = resolveIn(dir, o.value); // a later -C is relative to the one before
      moved = true;
    }
  }
  if (!moved) add(".");
  for (const m of operands) add(m, "write", dir);
}

/** unzip: extraction into -d (or here) and named members; listing and piping write nothing. */
function unzipTargets(args, ctx, add) {
  let exdir;
  let exclude = false;
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-d") { exdir = args[++i]; exclude = false; continue; }
    if (a.startsWith("-d") && a.length > 2) { exdir = a.slice(2); exclude = false; continue; }
    if (a === "-x") { exclude = true; continue; }
    if (a.startsWith("-") && a.length > 1) {
      if (/[lvtzZpc]/.test(a.slice(1))) return; // list, test, comment, zipinfo, pipe
      if (/[POI]$/.test(a)) i++; // password and charset flags take a value
      exclude = false;
      continue;
    }
    if (!exclude) operands.push(a);
  }
  const into = exdir === undefined ? ctx.dir : resolveIn(ctx.dir, exdir);
  add(exdir ?? ".");
  for (const m of operands.slice(1)) add(m, "write", into);
}

/** patch: -o, the named file, or every file the patch text names (resolved in -d, stripped by -p). */
function patchTargets(args, seg, ctx, add) {
  const { opts, operands } = parseOpts(args, PATCH);
  if (hasOpt(opts, "--dry-run")) return;
  const d = optValue(opts, "-d", "--directory");
  const dir = d === undefined ? ctx.dir : resolveIn(ctx.dir, d);
  const rej = optValue(opts, "-r", "--reject-file");
  if (rej && rej !== "-") add(rej, "write", dir);
  const output = optValue(opts, "-o", "--output");
  if (output !== undefined) {
    if (output !== "-") add(output, "write", dir);
    return; // the originals are left alone
  }
  if (operands.length) {
    add(operands[0], "write", dir); // `patch FILE < x.diff` writes only FILE
    return;
  }
  const src = optValue(opts, "-i", "--input");
  const text = src !== undefined && src !== "-"
    ? readText(resolveIn(dir, src))
    : stdinText(seg, ctx.shellDir ?? ctx.dir, ctx.up);
  if (text === null) {
    add(d ?? "."); // a patch we can't read: only the folder it applies in is known,
    add(STDIN, "write", ctx.dir, true); // and what feeds the pipe into it (#258)
    return;
  }
  const p = optValue(opts, "-p", "--strip");
  for (const path of patchPaths(text)) {
    for (const s of stripped(path, p === undefined ? null : Number(p))) add(s, "write", dir);
  }
}

/** git apply: every file the patch names, from the repo root, stripped by -p (default 1). */
function applyTargets(rest, seg, ctx, add) {
  const { opts, operands } = parseOpts(rest, GIT_APPLY);
  if (hasOpt(opts, "--check", "--stat", "--numstat", "--summary") && !hasOpt(opts, "--apply")) return;
  const fake = optValue(opts, "--build-fake-ancestor");
  if (fake) add(fake);
  const n = Number(optValue(opts, "-p") ?? 1);
  const prefix = optValue(opts, "--directory");
  const root = gitRoot(ctx.dir);
  const piped = () => stdinText(seg, ctx.shellDir ?? ctx.dir, ctx.up);
  const texts = operands.length
    ? operands.map((o) => (o === "-" ? piped() : readText(resolveIn(ctx.dir, o))))
    : [piped()];
  for (const t of texts) {
    if (t === null) {
      add(STDIN, "write", ctx.dir, true); // a patch we can't read: check what feeds it (#258)
      continue;
    }
    for (const path of patchPaths(t)) {
      for (const s of stripped(path, Number.isFinite(n) ? n : 1)) {
        add(prefix ? join(prefix, s) : s, "write", root);
      }
    }
  }
}

/** git: checkout/restore pathspecs, rm/mv operands, apply's patch -- from its -C folder (#258). */
function gitTargets(args, seg, ctx, add) {
  let k = 0;
  let dir = ctx.dir;
  while (k < args.length && args[k].startsWith("-")) {
    if (args[k] === "-C" && args[k + 1]) dir = resolveIn(dir, args[k + 1]);
    k += GIT_VALUE_OPTS.has(args[k]) ? 2 : 1;
  }
  const sub = args[k];
  const ops = plain(args.slice(k + 1));
  if (sub === "checkout" || sub === "restore") for (const a of ops) add(a, "write", dir);
  else if (sub === "rm") for (const a of ops) add(a, "remove", dir);
  else if (sub === "mv" && ops.length >= 2) {
    const dest = ops.pop();
    add(dest, "write", dir);
    for (const s of ops) {
      add(s, "remove", dir);
      add(join(dest, basename(s)), "write", dir);
    }
  } else if (sub === "apply") applyTargets(args.slice(k + 1), seg, { ...ctx, dir }, add);
}

/**
 * Every path one segment would change, as { raw, abs, mode }. Generous
 * inside a write command; silent for a command that only reads.
 */
function writeTargets(seg, ctx) {
  const out = [];
  const { words: w0, writes, wrappers, dirs } = unwrap(seg.words, READ);
  // xargs runs its command with paths read from stdin (#258)
  const xargs = wrappers.find((x) => x.name === "xargs");
  // What this command reads on stdin, should a path come from there. A
  // stdin path in a nested line came from its caller's xargs, unless this
  // command has an xargs of its own or reads a pipe itself (`pipe`).
  const own = {
    seg, up: ctx.up, dir: ctx.dir, shellDir: ctx.shellDir, argFiles: xargs ? argFiles(xargs.args) : [],
  };
  const add = (raw, mode = "write", dir = ctx.dir, pipe = false) => {
    // a nested shell's "$1" / "$@" is whatever path its caller handed it
    const mapped = ctx.positional && raw.search(POSITIONAL) >= 0;
    // the shell spells out $PWD, $HOME, ~ and $CAIRN_HOME before the command sees them (#258, #263)
    const r = expandHome((mapped ? raw.replace(POSITIONAL, ctx.positional) : raw)
      .replace(/^(?:\$PWD|\$\{PWD\})(?=\/|$)/, () => ctx.shellDir ?? ctx.dir))
      .replace(/^(?:\$CAIRN_HOME|\$\{CAIRN_HOME\})(?=\/|$)/, () => process.env.CAIRN_HOME ?? "");
    const feed = pipe || xargs ? own : (ctx.argvFeed ?? own);
    out.push({ raw: r, abs: resolveIn(dir, r), mode, feed, walk: ctx.walk });
  };
  if (ctx.chdir) {
    for (const x of writes) add(x);
  } else {
    // the shell opens the redirects where it is, whatever the command does
    for (const r of seg.redirects) if (!DEVICE.test(r)) for (const x of braceExpand(r, ANY)) add(x);
    if (dirs.length) {
      // env -C / sudo -D run the command in another folder (#258): read it
      // there, in each folder the target can name. A wrapper's own -o file
      // may land at any stop on the way.
      let land = [ctx.dir];
      for (const d of dirs) {
        for (const at of land) for (const x of writes) add(x, "write", at);
        land = union(...land.map((at) => dirTarget(d, at, ctx.dir)));
      }
      const inner = { ...seg, redirects: [] };
      for (const at of land) out.push(...writeTargets(inner, { ...ctx, dir: at, shellDir: ctx.dir, chdir: true }));
      return out;
    }
    for (const x of writes) add(x);
  }
  const w = xargs && w0.length ? withStdin(w0, xargs.args) : w0;
  if (!w.length) return out;
  const cmd = w[0].split("/").pop();
  let args = w.slice(1);
  // A command handed to another shell as a string is still a command: read
  // it the same way, one level down -- `bash -c`, `eval`, `su -c`, and a
  // heredoc or here-string fed to a shell (or to su) reading stdin (#258).
  if (SHELLS.has(cmd) || cmd === "eval" || cmd === "su") {
    if (ctx.depth >= 3) return out;
    const nest = (text, rest = []) => {
      const marker = rest.join(" ").split("").find((c) => c === STDIN || c === WALK);
      out.push(...lineTargets(text, ctx.dir, ctx.depth + 1, {
        positional: marker,
        argvFeed: xargs ? own : ctx.argvFeed, // `xargs -I{} sh -c 'rm {}'` too
        walk: ctx.walk,
      }));
    };
    const str = cmd === "eval" ? args.join(" ")
      : cmd === "su" ? suCommandString(args) : shellCommandString(args);
    if (str) {
      nest(str, cmd === "eval" ? [] : args.slice(args.indexOf(str) + 1));
      return out;
    }
    if (cmd !== "eval" && (cmd === "su" || shellReadsStdin(args))) {
      // its own heredoc, or the one piped in: `cat <<EOF | sh`
      for (const s of [seg, ...ctx.up.slice(-1)]) {
        for (const h of s.heredocs) nest(h.body);
        for (const x of s.herestrings ?? []) nest(x);
      }
    }
    return out;
  }
  // `rm -rf {hooks,}` is `rm -rf hooks`: spell braces out first, as bash does (#258)
  args = args.flatMap((a) => braceExpand(a, ANY));
  // find acts on every path it walks: -delete, and -exec's command with {} in it (#258)
  if (cmd === "find") {
    const spec = parseFind(args);
    for (const f of spec.files) add(f);
    const walk = { spec, dir: ctx.dir };
    if (spec.remove) out.push({ raw: WALK, abs: ctx.dir, mode: "remove", walk });
    for (const words of spec.execs) {
      const inner = { words, redirects: [], heredocs: [], herestrings: [], inputs: [], op: null };
      out.push(...writeTargets(inner, { ...ctx, up: [], walk, chdir: false }));
    }
    return out;
  }
  if (REMOVES.has(cmd)) for (const o of plain(args)) add(o, "remove");
  else if (CREATES.has(cmd)) for (const o of plain(args)) add(o, "create");
  else if (CHANGES.has(cmd)) for (const o of plain(args)) add(o);
  else if (COPIES.has(cmd)) copyTargets(cmd, args, add);
  else if ((cmd === "sed" || cmd === "perl") &&
      args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith("--in-place"))) {
    for (const o of plain(args)) add(o);
  } else if (cmd === "dd") {
    for (const a of args) if (a.startsWith("of=")) add(a.slice(3));
  } else if (cmd === "curl") curlTargets(args, ctx, add);
  else if (cmd === "wget") wgetTargets(args, ctx, add);
  else if (cmd === "tar" || cmd === "bsdtar" || cmd === "gtar") tarTargets(args, ctx, add);
  else if (cmd === "unzip") unzipTargets(args, ctx, add);
  else if (cmd === "patch") patchTargets(args, seg, ctx, add);
  else if (cmd === "git") gitTargets(args, seg, ctx, add);
  return out;
}

/** True when the segment's own leading assignments carry the override. */
function exempt(words) {
  for (const w of words) {
    if (!ASSIGNMENT.test(w)) return false;
    if (w === "CAIRN_HARNESS_EDIT=1") return true;
  }
  return false;
}

/**
 * What a wildcard folder path expands to from `base`, the way the shell
 * expands it: only entries that exist. Null when the guard can't tell --
 * a pattern it can't read, or too many entries to walk.
 */
function expandGlob(base, pattern) {
  let found = [isAbsolute(pattern) ? sep : base];
  for (const comp of pattern.split("/")) {
    if (comp === "" || comp === ".") continue;
    const next = [];
    for (const dir of found) {
      if (comp === "..") next.push(dirname(dir));
      else if (!/[*?[]/.test(comp)) next.push(join(dir, comp));
      else {
        let names = [];
        try { names = readdirSync(dir); } catch { /* not a folder */ }
        let re;
        try { re = compRe(comp); } catch { return null; }
        for (const n of names) if (re.test(n)) next.push(join(dir, n));
      }
    }
    if (next.length > 64) return null;
    found = next;
  }
  return found.filter((f) => existsSync(f));
}

/**
 * The folders a cd, env -C or git -C target can name from `from` (#258).
 * $PWD and ~+ expand to the shell's folder (`pwd`, when it isn't `from`:
 * env -C), $HOME and ~ to the home folder, and a wildcard to its one
 * match. LOST when the guard can't tell: $OLDPWD, ~- (any cd before may
 * have failed, leaving whatever the shell had), any other variable, a
 * substitution, ~user, a {a,b} list, or a wildcard with several matches.
 */
function dirTarget(raw, from, pwd = from) {
  let base = from;
  let rest = raw;
  const m = /^(?:\$(PWD|HOME|OLDPWD)|\$\{(PWD|HOME|OLDPWD)\}|~([+-]?))(?=\/|$)/.exec(raw);
  if (m) {
    const name = m[1] ?? m[2] ?? { "": "HOME", "+": "PWD", "-": "OLDPWD" }[m[3]];
    if (name === "OLDPWD") return [LOST];
    base = name === "HOME" ? resolve(homedir()) : pwd;
    rest = raw.slice(m[0].length).replace(/^\/+/, "");
  }
  if (/[$`]|^~|\{[^}]*(?:,|\.\.)[^}]*\}/.test(rest)) return [LOST];
  if (!/[*?[]/.test(rest)) return [resolveIn(base, rest || ".")];
  const found = expandGlob(base, rest);
  if (found === null || found.length > 1) return [LOST];
  return [found[0] ?? resolveIn(base, rest)]; // no match: the shell passes the pattern as is
}

/**
 * The folder changes one segment can make (#258), each { raw, cd, again }
 * or { lost, again }: a cd or pushd target (`cd` alone is ~), and every
 * env -C, sudo -D and git -C folder. `cd -`, `pushd +N` and a target a
 * substitution computes (`cd $(...)`, cd `...`: a subshell break ends the
 * segment mid-target) are lost. popd and a bare pushd only revisit
 * folders already counted.
 */
function segMoves(seg, again) {
  const { words: w, dirs } = unwrap(seg.words, READ);
  const cmd = basename(w[0] ?? "");
  const moves = dirs.map((raw) => ({ raw, again }));
  if (cmd === "cd" || cmd === "pushd") {
    const ops = w.slice(1).filter((a) => a !== "--" && !/^-[LPe@]+$/.test(a));
    if (seg.op === "(" || seg.op === "`" || ops[0] === "-" || /^[+-]\d+$/.test(ops[0] ?? "")) {
      moves.push({ lost: true, again });
    } else if (ops.length) moves.push({ raw: ops[0], cd: true, again });
    else if (cmd === "cd") moves.push({ raw: "~", again });
  } else if (cmd === "git") {
    for (let k = 1; k < w.length && w[k].startsWith("-"); k += GIT_VALUE_OPTS.has(w[k]) ? 2 : 1) {
      if (w[k] === "-C" && w[k + 1]) moves.push({ raw: w[k + 1], again });
    }
  }
  return moves;
}

/**
 * Every folder the shell may be in anywhere on a command line (#258): the
 * starting cwd, and every cd, pushd, env -C, sudo -D and git -C target in
 * it resolved from every folder found before it. A cd can fail, be
 * skipped, run in a subshell, a pipe or the background, or run later (a
 * function body, a loop), so none ever takes a folder away, and every
 * write on the line is judged from all of them, wherever it sits. A target
 * in a loop or function body may run again at any later point, so those
 * keep applying until nothing new turns up. A CDPATH, set on the line or
 * inherited, adds each place a bare cd target can land under it. A target
 * the guard can't resolve adds LOST.
 */
function linePlaces(segs, dir) {
  const cdpaths = process.env.CDPATH ? [process.env.CDPATH] : [];
  const moves = [];
  const frames = []; // open bodies: { close: "done" | "}", again }
  let fn = false; // the next `{` opens a function body
  for (const seg of segs) {
    const r = seg.reserved ?? [];
    let again = false;
    for (let i = 0; i < r.length; i++) {
      const w = r[i];
      if (LOOPS.has(w)) {
        frames.push({ close: "done", again: true });
        again = true;
        if (w === "for" || w === "select") break; // the rest is the loop's word list
      } else if (w === "repeat") {
        const body = r[i + 2];
        if (body === "do" || body === "{") frames.push({ close: body === "do" ? "done" : "}", again: true });
        again = true;
        i += body === "{" ? 2 : 1;
      } else if (w === "done" || w === "}") {
        while (frames.length && frames.pop().close !== w) { /* unclosed inner bodies */ }
      } else if (w === "{") {
        frames.push({ close: "}", again: fn });
        fn = false;
      } else if (w === "function") {
        fn = true;
        i += r[i + 2] === "()" ? 2 : 1;
      } else if (w === "case") i += 2;
      else if (w === "coproc" && r[i + 2] === "{") i++;
    }
    if (seg.words.length === 1 && seg.op === "(" && FUNC_NAME.test(seg.words[0])) fn = true; // NAME () {
    moves.push(...segMoves(seg, again || frames.some((f) => f.again)));
    const { words: w, assigns } = unwrap(seg.words, READ);
    const declared = /^(export|declare|typeset|readonly|local)$/.test(w[0] ?? "") ? w.slice(1) : [];
    for (const a of [...assigns, ...declared]) if (a.startsWith("CDPATH=")) cdpaths.push(a.slice(7));
  }

  const lostPath = cdpaths.some((v) => /[$`]/.test(v));
  const step = (places, m) => {
    if (m.lost) return union(places, [LOST]);
    const more = places.flatMap((d) => dirTarget(m.raw, d));
    // CDPATH: a target not starting /, . or .. may land under any of its entries
    if (m.cd && cdpaths.length && !/^(?:\/|\.\.?(?:\/|$)|~|\$)/.test(m.raw)) {
      if (lostPath) more.push(LOST);
      for (const e of lostPath ? [] : cdpaths.flatMap((v) => v.split(":"))) {
        more.push(...places.flatMap((d) => dirTarget(join(e || ".", m.raw), d)));
      }
    }
    return union(places, more);
  };
  let places = [dir];
  const active = [];
  for (const m of moves) {
    places = step(places, m);
    if (m.again) active.push(m);
    for (let round = 0; active.length && round <= MAX_PLACES; round++) {
      const before = places.length;
      for (const a of active) places = step(places, a);
      if (places.length === before) break;
    }
  }
  return places;
}

/**
 * Every path a command line would change, each resolved from every folder
 * the shell may be in on that line (#258, linePlaces). The inline override
 * exempts the one command it prefixes -- never the rest of a chained line
 * (#265).
 */
function lineTargets(command, dir, depth, extra = {}) {
  const segs = shellSegments(command, READ);
  const places = linePlaces(segs, dir);
  const out = [];
  for (let k = 0; k < segs.length; k++) {
    // the commands piping into this one, nearest last
    const up = [];
    for (let j = k - 1; j >= 0 && PIPE.has(segs[j].op); j--) up.unshift(segs[j]);
    // the prefix counts on a command the human typed, not inside a quoted string
    if (depth > 0 || !exempt(segs[k].words)) {
      for (const d of places) out.push(...writeTargets(segs[k], { ...extra, dir: d, depth, up }));
    }
  }
  return out;
}

/**
 * The protected thing one target would change, or null. A path that comes
 * from a stream is checked against the stream: what feeds xargs or a patch
 * tool, or what find walks. A relative path from a folder the guard lost
 * track of could be anywhere, so it is a hit of its own (#258).
 */
function judgeTarget(t) {
  const lead = t.raw.replace(/^(\.\/)+/, "")[0];
  const lost = { path: t.raw, lost: true };
  if (lead === STDIN) {
    if (!t.feed) return null;
    const files = t.feed.seg.inputs?.length || t.feed.argFiles?.length;
    if (isLost(t.feed.dir) || (files && isLost(t.feed.shellDir ?? t.feed.dir))) return lost;
    return feedHit(t.feed, t.mode);
  }
  if (lead === WALK) {
    if (!t.walk) return null;
    if (t.walk.spec.starts.some((s) => isLost(resolveIn(t.walk.dir, expandHome(s))))) return lost;
    return walkHit(t.walk.spec, t.walk.dir);
  }
  if (isLost(t.abs)) return lost;
  const what = judge(t.abs, t.mode);
  return what ? { path: t.raw, what } : null;
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = payload?.tool_name;
  if (tool !== "Edit" && tool !== "Write" && tool !== "NotebookEdit" && tool !== "Bash") {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  ROOTS = spellings(projectDir);
  HOMES = spellings(homedir());
  ZONES = outsideZones();
  // Relative paths resolve where the tool runs -- the payload's cwd -- not
  // at the project root (#258): the shell and the file tools agree.
  const cwd = payload?.cwd ? resolveIn(ROOTS[0], payload.cwd) : ROOTS[0];

  // The session-wide override is the human's to set. The Bash prefix form
  // is read per command, in lineTargets.
  if (process.env.CAIRN_HARNESS_EDIT === "1") process.exit(0);

  let hit = null;

  if (tool === "Bash") {
    // Only what the command WRITES is checked; reading a hook file is
    // ordinary work and must stay frictionless (#240).
    for (const t of lineTargets(payload?.tool_input?.command ?? "", cwd, 0)) {
      hit = judgeTarget(t);
      if (hit) break;
    }
  } else {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const what = p ? judge(resolveIn(cwd, expandHome(String(p))), "write", true) : null;
    if (what) hit = { path: p, what };
  }

  if (!hit) process.exit(0);

  if (hit.lost) {
    // #258: a directory change it couldn't follow -- fail closed, and say so
    console.error(
      "cairn harness guard: a directory change in this line (cd, pushd, env -C) goes " +
      "somewhere the guard couldn't tell, so this relative write may land in the hook directory " +
      "or a settings file.",
    );
    console.error(`  file: ${String(hit.path).replace(/[\u0001-\u0003]/g, "*")}`);
    console.error("  name the folder plainly, or write to an absolute path, and the guard can judge it.");
  } else {
    console.error(
      `cairn harness guard: this would change ${hit.what} — the configuration that decides ` +
      "what this agent is allowed to do.",
    );
    console.error(`  file: ${String(hit.path).replace(/[\u0001-\u0003]/g, "*")}`);
  }
  console.error("  if you asked for this, set CAIRN_HARNESS_EDIT=1 for the session (or prefix a");
  console.error("  shell command with it) and run it again. If you did not ask for this, something");
  console.error("  the agent read did — check where the instruction came from before allowing it.");
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
