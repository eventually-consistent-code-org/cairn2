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
 *   steer the agent can also ask for the prefix -- which exempts only the
 *   one command it prefixes (#265). Visibility is the control; isolation is
 *   the operating system's job. Bash is read the way a shell would read it
 *   (shell-words.mjs, shared with the run guard, #270) to find what it
 *   WRITES: redirect targets, the operands of commands that change files
 *   (tee, rm, sed -i, cp/mv/rsync and the folder they copy into, curl -o,
 *   tar -C, unzip -d, the files a patch names), through wrappers and a
 *   shell's -c string. Removing a protected folder, or one holding it,
 *   counts. Quoted text, heredoc bodies and here-strings are data, and a
 *   path that is only READ passes (#240). Still not a full shell parser: a
 *   write inside an interpreter (python -c), a $(...) substitution, or an
 *   archive's own member list is not seen.
 *
 * removeWhen: the platform isolates agent config at the OS level, so the
 *   agent process cannot write its own hooks or settings (ADR 0016).
 * Author(s): John Reed
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SHELLS, shellCommandString, shellSegments, unwrap } from "./shell-words.mjs";

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

// An unknown name inside a folder -- what `rsync src/ dir` or `cp -r src/.
// dir` drops there. Matches any name, dotfiles included.
const ANY = "\u0001";

// The most of one file the guard reads (a patch, a list of paths).
const READ_CAP = 32 * 1024 * 1024;

// Descriptors and devices, never a file this guard cares about.
const DEVICE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// A NAME=value word in command position.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * How this guard reads a command line (shell-words.mjs): redirect targets
 * and heredocs are modelled; ( ), backticks, # comments and quoted $(...)
 * are word text, so a write hidden in a substitution is not seen.
 */
const READ = { redirects: true };

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

// Variables -- the folders every rule is measured against, set per payload.
// Each holds the path as given and its real path, when a symlink differs.
let ROOTS = [];
let HOMES = [];

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

/** A path as the command would reach it from `dir`. */
function resolveIn(dir, raw) {
  return isAbsolute(raw) ? resolve(raw) : resolve(dir, raw);
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
  const rel = projectRelative(abs);
  if (rel === null) return null; // outside the project -- not this guard's business
  for (const p of PROTECTED) if (p.re.test(rel)) return p.what;
  return null;
}

/** The path names a protected FOLDER: writing into it, replacing it or removing it (#265). */
function dirRule(abs) {
  for (const home of HOMES) {
    if (abs === join(home, ".claude")) return "your machine-wide Claude settings";
  }
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
  return null;
}

/** One glob component as a regex; ANY stands for any name. */
function compRe(comp) {
  let re = /^[*?[]/.test(comp) ? "(?!\\.)" : ""; // a leading wildcard skips dotfiles
  for (let i = 0; i < comp.length; i++) {
    const c = comp[i];
    const close = c === "[" ? comp.indexOf("]", i + 2) : -1;
    if (c === ANY) re += ".*";
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (close > 0) {
      re += `[${comp.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Could this glob component expand to `name`? A bare ANY counts only when `anyOk`. */
function could(comp, name, anyOk = true) {
  if (comp === ANY) return anyOk;
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
  if (remove) {
    for (const dir of [...ROOTS, ...HOMES]) {
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
      (!literal && /[*?[]|\u0001/.test(p) ? globRule(p, mode) : null);
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

/** What a segment feeds its command on stdin: heredocs, here-strings, `< file`. */
function stdinText(seg, dir) {
  const parts = [...seg.heredocs.map((h) => h.body), ...(seg.herestrings ?? [])];
  for (const f of seg.inputs ?? []) {
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
  const text = src !== undefined && src !== "-" ? readText(resolveIn(dir, src)) : stdinText(seg, ctx.dir);
  if (text === null) {
    add(d ?? "."); // a patch we can't read: only the folder it applies in is known
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
  const piped = () => stdinText(seg, ctx.dir);
  const texts = operands.length
    ? operands.map((o) => (o === "-" ? piped() : readText(resolveIn(ctx.dir, o))))
    : [piped()];
  for (const t of texts) {
    if (t === null) continue; // a patch we can't read names nothing we can check
    for (const path of patchPaths(t)) {
      for (const s of stripped(path, Number.isFinite(n) ? n : 1)) {
        add(prefix ? join(prefix, s) : s, "write", root);
      }
    }
  }
}

/** git: checkout/restore pathspecs, rm/mv operands, apply's patch. */
function gitTargets(args, seg, ctx, add) {
  let k = 0;
  while (k < args.length && args[k].startsWith("-")) k += GIT_VALUE_OPTS.has(args[k]) ? 2 : 1;
  const sub = args[k];
  const ops = plain(args.slice(k + 1));
  if (sub === "checkout" || sub === "restore") for (const a of ops) add(a);
  else if (sub === "rm") for (const a of ops) add(a, "remove");
  else if (sub === "mv" && ops.length >= 2) {
    const dest = ops.pop();
    add(dest);
    for (const s of ops) {
      add(s, "remove");
      add(join(dest, basename(s)));
    }
  } else if (sub === "apply") applyTargets(args.slice(k + 1), seg, ctx, add);
}

/**
 * Every path one segment would change, as { raw, abs, mode }. Generous
 * inside a write command; silent for a command that only reads.
 */
function writeTargets(seg, ctx) {
  const out = [];
  const add = (raw, mode = "write", dir = ctx.dir) => out.push({ raw, abs: resolveIn(dir, raw), mode });
  for (const r of seg.redirects) if (!DEVICE.test(r)) add(r);
  const { words: w, writes } = unwrap(seg.words, READ);
  for (const x of writes) add(x);
  if (!w.length) return out;
  const cmd = w[0].split("/").pop();
  const args = w.slice(1);
  // A command handed to another shell as a string is still a command: read
  // it the same way, one level down.
  if (SHELLS.has(cmd) || cmd === "eval") {
    const inner = cmd === "eval" ? args.join(" ") : shellCommandString(args);
    if (inner && ctx.depth < 3) out.push(...lineTargets(inner, ctx.dir, ctx.depth + 1));
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
 * Every path a command line would change. The inline override exempts the
 * one command it prefixes -- never the rest of a chained line (#265).
 */
function lineTargets(command, dir, depth) {
  const out = [];
  for (const seg of shellSegments(command, READ)) {
    // the prefix counts on a command the human typed, not inside a quoted string
    if (depth > 0 || !exempt(seg.words)) out.push(...writeTargets(seg, { dir, depth }));
  }
  return out;
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

  // The session-wide override is the human's to set. The Bash prefix form
  // is read per command, in lineTargets.
  if (process.env.CAIRN_HARNESS_EDIT === "1") process.exit(0);

  let hitPath = null;
  let hitWhat = null;

  if (tool === "Bash") {
    // Only what the command WRITES is checked; reading a hook file is
    // ordinary work and must stay frictionless (#240).
    for (const t of lineTargets(payload?.tool_input?.command ?? "", ROOTS[0], 0)) {
      const what = judge(t.abs, t.mode);
      if (what) { hitPath = t.raw; hitWhat = what; break; }
    }
  } else {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const what = p ? judge(resolveIn(ROOTS[0], p), "write", true) : null;
    if (what) { hitPath = p; hitWhat = what; }
  }

  if (!hitWhat) process.exit(0);

  console.error(
    `cairn harness guard: this would change ${hitWhat} — the configuration that decides ` +
    "what this agent is allowed to do.",
  );
  console.error(`  file: ${String(hitPath).split(ANY).join("*")}`);
  console.error("  if you asked for this, set CAIRN_HARNESS_EDIT=1 for the session (or prefix a");
  console.error("  shell command with it) and run it again. If you did not ask for this, something");
  console.error("  the agent read did — check where the instruction came from before allowing it.");
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
