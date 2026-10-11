#!/usr/bin/env node

/**
 * Purpose: the one shell reader the PreToolUse guards share (#270) -- splits
 *   a Bash command line into simple commands the way a shell would, closely
 *   enough to find the command words and what a command writes, and peels
 *   the wrappers (sudo -u root, env -i, timeout 5, and program runners like
 *   xcrun, arch -arm64 or script -q /dev/null, #307) that run a later word
 *   as the real command. The run guard and the harness guard both read
 *   commands through here, so a parsing fix reaches both; two hand-rolled
 *   readers drifted until #254's wrapper fix reached only one of them.
 *
 *   The guards still read a little differently, and each says how through
 *   the `read` options it passes. Every option is a gap one of the pre-#270
 *   readers had, kept so the extraction changed no allowed or refused
 *   result. Closing one is a guard behaviour change, and lands as its own
 *   tested fix.
 *
 *   Not a full shell grammar. No imports and no I/O -- pure functions, so a
 *   guard that loads this still runs from a bare node, and setup's copy of
 *   every hooks/scripts/*.mjs carries it into Cursor projects.
 *
 * removeWhen: no cairn hook reads Bash command lines any more -- the run
 *   guard and the harness guard have both met their own removeWhen.
 * Author(s): John Reed
 */

// Constants

// Shells whose -c string is a command line of its own (look names up by commandName).
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

// Shell options that take the next word as their value (-o pipefail).
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

// A NAME=value word in command position: an assignment, not the command.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Reserved words that open, continue or close a compound command; the
// command word comes after them (#285).
const RESERVED = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until",
  "do", "done", "esac"]);

/**
 * Prefixes that run a later word as the real command, each with the flags
 * that swallow a value (`sudo -u root`, `env -u NAME`, `nice -n 5`). A
 * wrapper's other flags are skipped as plain switches. `positional` counts
 * the bare words a wrapper takes before the command (timeout's duration).
 * Missing these flags is how `sudo -u root tee hooks/a` slipped past (#254).
 * `opt` letters take an optional value, only ever the rest of their cluster
 * (`-i{}`), and a long flag with an optional value takes it only after `=`
 * (`--replace=R`) -- never the next word, which is the command (#285).
 *
 * The rest say what a flag's value does, by option name (`-o`, `--output`):
 *   long      may hold one-dash names too (`xcrun -sdk X`, `arch -arch X`),
 *             read whole, never as a cluster of letters.
 *   num       letters whose value is the next word only when it is a number
 *             (macOS script -t 30; util-linux spells its file -tFILE).
 *   writes    the value is a file the wrapper itself writes (time -o).
 *   dir       the value is the folder the command runs in (env -C, sudo -D).
 *   split     the value is split into more words (env -S).
 *   assign    the value is a NAME=value the command runs with (arch -e).
 *   cmd       the value is a command line run by a shell (script -c, flock
 *             -c), and so is the word after the positionals (`flock F -c X`).
 *   record    the positional word is a file the wrapper writes (script's
 *             typescript), unless a `reads` flag plays one back (script -p).
 *   joins     the rest is joined into one line for a shell (watch).
 *   as        the name it goes by: Homebrew installs GNU tools g-prefixed.
 * Program runners joined the table in #307 (xcrun, arch, caffeinate,
 * script, flock and kin): absent from it, `xcrun git reset --hard` read as
 * a command named xcrun, and both guards let it through.
 */
export const WRAPPERS = new Map([
  ["sudo", { short: "ugpChDRTUrt", long: ["--user", "--group", "--host", "--prompt",
    "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout"],
  dir: ["-D", "--chdir"] }],
  ["doas", { short: "uC", long: [] }],
  // macOS env -P names the PATH to search for the command
  ["env", { short: "uCSP", long: ["--unset", "--chdir", "--split-string"], dir: ["-C", "--chdir"],
    split: ["-S", "--split-string"] }],
  ["nice", { short: "n", long: ["--adjustment"] }],
  ["timeout", { short: "sk", long: ["--signal", "--kill-after"], positional: 1 }],
  // GNU and BSD (-J -R -S) flags; -e -i -l, --eof --replace --max-lines: optional values
  ["xargs", { short: "ILnPsdEaJRS", opt: "eil", long: ["--max-args", "--max-procs",
    "--max-chars", "--delimiter", "--arg-file", "--process-slot-var"] }],
  ["exec", { short: "a", long: [] }],
  ["time", { short: "fo", long: ["--format", "--output"], writes: ["-o", "--output"] }],
  ["command", { short: "", long: [] }],
  ["nohup", { short: "", long: [] }],
  ["builtin", { short: "", long: [] }],
  ["setsid", { short: "", long: [] }],
  // zsh precommand modifiers
  ["noglob", { short: "", long: [] }],
  ["nocorrect", { short: "", long: [] }],
  ["stdbuf", { short: "ioe", long: ["--input", "--output", "--error"] }],
  // macOS program runners (#307): an Xcode tool, a chosen architecture, kept awake, throttled, sandboxed
  ["xcrun", { short: "", long: ["--sdk", "-sdk", "--toolchain", "-toolchain"] }],
  ["arch", { short: "", long: ["-arch", "-d", "-e"], assign: ["-e"] }],
  ["caffeinate", { short: "tw", long: [] }],
  ["taskpolicy", { short: "dgcpmjPStl", long: [] }],
  ["sandbox-exec", { short: "fnpD", long: [] }],
  // script: macOS/BSD `script [-aq] [-t time] file command...`, util-linux `script -c 'cmd' file`
  ["script", { short: "cIOBTEmot", num: "t", positional: 1, record: true, reads: ["-p"],
    long: ["--command", "--log-in", "--log-out", "--log-io", "--log-timing", "--echo",
      "--logging-format", "--output-limit"], cmd: ["-c", "--command"],
    writes: ["-I", "-O", "-B", "-T", "-t", "--log-in", "--log-out", "--log-io", "--log-timing", "--timing"] }],
  // flock LOCK command..., flock LOCK -c 'cmd'
  ["flock", { short: "wEc", long: ["--wait", "--timeout", "--conflict-exit-code", "--command"],
    positional: 1, cmd: ["-c", "--command"] }],
  ["chroot", { short: "Ggu", long: ["--userspec", "--groups"], positional: 1 }],
  ["unbuffer", { short: "", long: [] }],
  ["ionice", { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] }],
  ["chrt", { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"], positional: 1 }],
  ["taskset", { short: "", long: [], positional: 1 }],
  // watch runs its words as one shell line, over and over
  ["watch", { short: "nqs", opt: "d", long: ["--interval", "--equexit", "--shotsdir"], joins: true }],
]);
for (const name of ["env", "nice", "nohup", "stdbuf", "timeout", "xargs", "time", "chroot"]) {
  WRAPPERS.set(`g${name}`, { ...WRAPPERS.get(name), as: name });
}

/**
 * A command word's name the way a Mac finds the program (#300): the path
 * dropped and the letter case folded, since a case-insensitive volume runs
 * `SUDO`, `/usr/bin/GIT` and `Env` as sudo, git and env. Upper then lower
 * also folds the long s and the Kelvin sign, which APFS reads as s and k --
 * `ſudo` is sudo too. Look a name up in WRAPPERS or SHELLS through here.
 */
export function commandName(word) {
  return String(word ?? "").split("/").pop().toUpperCase().toLowerCase();
}

/**
 * Index of the `)` closing a `$(` whose body starts at `i` -- nesting-aware,
 * so parens inside quotes, inner substitutions and backticks don't close it
 * early. Unterminated runs to the end of the line.
 */
function closeParen(line, i) {
  let depth = 1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const j = line.indexOf("'", i + 1); i = j < 0 ? line.length : j; continue; }
    if (c === "`") { i = closeTick(line, i + 1); continue; }
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === "$" && line[i + 1] === "(") i = closeParen(line, i + 2);
        else if (line[i] === "`") i = closeTick(line, i + 1);
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return line.length;
}

/** Index of the unescaped backtick closing one whose body starts at `i`. */
function closeTick(line, i) {
  for (; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "`") return i;
  }
  return line.length;
}

/**
 * Index of a word list's command word, past the reserved words and grouping
 * in front of it (#285): `if` `then` `elif` `else` `while` `until` `do` `!`
 * `{` and the closers, a `for NAME in ...` (or select) header up to its
 * `do`, `case WORD in` (each pattern ends at its `)`, a subshell break),
 * `function NAME`, `coproc` with the name before its body, and zsh's
 * `repeat N`. Before #285 the first word was the command, so `if git reset
 * --hard; then` read as a command named `if` and nothing refused it.
 */
function commandStart(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (RESERVED.has(w)) i++;
    else if (w === "for" || w === "select") {
      i += 2; // the keyword and the loop's NAME
      if (words[i] === "in") i = words.length; // its word list runs to the `;` or newline
    } else if (w === "case") i += 3;
    else if (w === "repeat") i += 2; // zsh: repeat N cmd, repeat N do ... done
    else if (w === "function") i += words[i + 2] === "()" ? 3 : 2;
    else if (w === "coproc") i += words[i + 2] === "{" ? 2 : 1;
    else break;
  }
  return Math.min(i, words.length);
}

/**
 * Splits a shell command line into simple-command segments, each
 * { words, reserved, redirects, heredocs: [{ delim, body }], herestrings,
 * inputs, op }. Single and double quotes and backslashes are honoured, so
 * quoted text stays inside its word: `git commit -m "explain git reset
 * --hard"` is one git commit with a message, never a reset, and a `>` in a
 * quoted pattern is text. Segments break at ; & | and newlines, plus
 * whatever `read` turns on. `words` start at the command word: the
 * reserved words and grouping in front of it (`if`, `do`, `{`, a `for`
 * header -- see commandStart) move to `reserved`, so they never stand in
 * for the command (#285). `op` is the operator that ended the segment (`|`
 * `|&` `||` `&&` `;` `&`, a newline, a subshell character, or null at the
 * end), so a reader can tell a pipeline from a list (#258):
 *
 *   redirects      `>` `>>` `&>` `>|` targets go to `redirects` (`N>&M` names
 *                  a descriptor, not a file); `<` operands go to `inputs` and
 *                  `<<<` text to `herestrings` -- read, never words; a `<<`
 *                  heredoc body is data -- skipped through its delimiter line
 *                  and kept on its segment. Off: those characters are word
 *                  text and body lines are commands.
 *   subshells      `(` `)` and an unquoted backtick end a command.
 *   comments       an unquoted `#` at a word start comments out its line.
 *   substitutions  `$(...)` and backticks inside double quotes are run by
 *                  the shell (#257): the word keeps the text, and each body
 *                  is split as a command line of its own and appended.
 *   continuation   backslash-newline joins lines, and a lone trailing
 *                  backslash is dropped. Off: the backslash is word text.
 *   posixEscapes   inside double quotes a backslash escapes only " \ $ and
 *                  a backtick, and is text before anything else. Off: it
 *                  escapes any character.
 *   anyWhitespace  every whitespace character separates words. Off: only
 *                  space and tab do.
 */
export function shellSegments(command, read = {}) {
  const segs = [];
  const subs = []; // bodies of quoted command substitutions, split at the end
  const pending = []; // heredocs whose bodies start on the next line
  let words = [];
  let redirects = [];
  let heredocs = [];
  let herestrings = [];
  let inputs = [];
  let cur = null;
  // what the next completed word is: word | redirect | skip | heredoc | herestring | input
  let next = "word";
  let strip = false; // `<<-` strips leading tabs before matching the delimiter

  const pushWord = () => {
    if (cur === null) return;
    if (next === "redirect") redirects.push(cur);
    else if (next === "heredoc") {
      const doc = { delim: cur, body: "" };
      heredocs.push(doc);
      pending.push({ doc, strip });
    } else if (next === "herestring") herestrings.push(cur);
    else if (next === "input") inputs.push(cur);
    else if (next === "word") words.push(cur);
    next = "word";
    cur = null;
  };
  const endSeg = (op = null) => {
    pushWord();
    if (words.length || redirects.length) {
      const at = commandStart(words);
      segs.push({ words: words.slice(at), reserved: words.slice(0, at), redirects, heredocs,
        herestrings, inputs, op });
    }
    words = [];
    redirects = [];
    heredocs = [];
    herestrings = [];
    inputs = [];
  };
  const blank = read.anyWhitespace ? (c) => /\s/.test(c) : (c) => c === " " || c === "\t";
  const breaks = read.subshells ? ";&|()`" : ";&|";

  let i = 0;
  while (i < command.length) {
    const c = command[i];
    const n = command[i + 1];

    // 'single quotes' -- everything literal up to the next quote
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? command.length : j;
      cur = (cur ?? "") + command.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    // "double quotes" -- literal but for escapes and, if read, substitutions
    if (c === '"') {
      let s = "";
      i++;
      while (i < command.length && command[i] !== '"') {
        const d = command[i];
        const e = command[i + 1];
        if (d === "\\" && i + 1 < command.length && (!read.posixEscapes || '"\\$`'.includes(e))) {
          s += e;
          i += 2;
          continue;
        }
        // "$( ... )" and "` ... `" run a command -- keep the text in the
        // word, and queue the body to be read as a command line itself
        if (read.substitutions && d === "$" && e === "(") {
          const end = closeParen(command, i + 2);
          subs.push(command.slice(i + 2, end));
          s += command.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        if (read.substitutions && d === "`") {
          const end = closeTick(command, i + 1);
          subs.push(command.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
          s += command.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        s += d;
        i++;
      }
      cur = (cur ?? "") + s;
      i++;
      continue;
    }

    // backslash outside quotes -- the next character is literal
    if (c === "\\") {
      if (n !== undefined && n !== "\n") {
        cur = (cur ?? "") + n;
        i += 2;
        continue;
      }
      if (read.continuation) { i += 2; continue; }
      cur = (cur ?? "") + c;
      i++;
      continue;
    }

    if (c === "\n") {
      endSeg("\n");
      // Heredoc bodies begin on the next line; they are data, so skip each
      // one through its delimiter line, keeping the text on its segment.
      while (pending.length) {
        const { doc, strip: tabs } = pending.shift();
        const start = i + 1;
        let k = start;
        for (;;) {
          const nl = command.indexOf("\n", k);
          const line = command.slice(k, nl < 0 ? command.length : nl);
          const done = (tabs ? line.replace(/^\t+/, "") : line) === doc.delim;
          if (done || nl < 0) {
            doc.body = command.slice(start, done ? k : command.length);
            i = nl < 0 ? command.length : nl;
            break;
          }
          k = nl + 1;
        }
      }
      i++;
      continue;
    }

    if (blank(c)) { pushWord(); i++; continue; }

    if (read.redirects && (c === ">" || (c === "&" && n === ">"))) {
      // a bare number right before `>` is the descriptor, not a word
      if (cur !== null && /^\d+$/.test(cur)) cur = null; else pushWord();
      let j = i + (c === "&" ? 2 : 1);
      if (command[j] === ">" || command[j] === "|") j++;
      if (command[j] === "&") { next = "skip"; i = j + 1; continue; } // >&2: a descriptor
      next = "redirect";
      i = j;
      continue;
    }

    if (read.redirects && c === "<") {
      pushWord();
      if (command.startsWith("<<<", i)) { next = "herestring"; i += 3; continue; }
      if (n === "<") {
        strip = command[i + 2] === "-";
        next = "heredoc";
        i += strip ? 3 : 2;
        continue;
      }
      next = "input"; // `< file` is read
      i++;
      continue;
    }

    if (breaks.includes(c)) {
      // name the operator; the second character of `||` `&&` `|&` ends an
      // empty segment, which is never kept, so it can't overwrite this one
      const pair = c + (n ?? "");
      endSeg(pair === "||" || pair === "&&" || pair === "|&" ? pair : c);
      i++;
      continue;
    }

    if (read.comments && c === "#" && cur === null) {
      const j = command.indexOf("\n", i);
      i = j < 0 ? command.length : j;
      continue;
    }

    cur = (cur ?? "") + c;
    i++;
  }
  endSeg();
  for (const body of subs) segs.push(...shellSegments(body, read));
  return segs;
}

// The most words one brace expansion is spelled out to.
const BRACE_CAP = 64;

/**
 * The `{...}` in `word` that bash would expand, as { start, end, alts }, or
 * null: a comma list (`{hooks,}`) or a sequence (`{1..3}`, `{a..c}`). A
 * `${...}` is a parameter, and a brace with neither is literal (`{}`).
 * `alts` is null for a sequence too long to spell out.
 */
function braceAt(word) {
  for (let i = word.indexOf("{"); i >= 0; i = word.indexOf("{", i + 1)) {
    if (word[i - 1] === "$") continue;
    let depth = 0;
    const commas = [];
    let end = -1;
    for (let j = i; j < word.length && end < 0; j++) {
      if (word[j] === "{") depth++;
      else if (word[j] === "}" && --depth === 0) end = j;
      else if (word[j] === "," && depth === 1) commas.push(j);
    }
    if (end < 0) return null;
    const body = word.slice(i + 1, end);
    if (commas.length) {
      const cuts = [i, ...commas, end];
      return { start: i, end, alts: cuts.slice(1).map((c, k) => word.slice(cuts[k] + 1, c)) };
    }
    const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(body);
    if (!m) continue;
    const num = /\d/.test(m[1]);
    if (num !== /\d/.test(m[2])) continue;
    const [a, b] = num ? [Number(m[1]), Number(m[2])] : [m[1].charCodeAt(0), m[2].charCodeAt(0)];
    if (Math.abs(b - a) >= BRACE_CAP) return { start: i, end, alts: null };
    const alts = [];
    for (let v = a; ; v += a <= b ? 1 : -1) {
      alts.push(num ? String(v) : String.fromCharCode(v));
      if (v === b) break;
    }
    return { start: i, end, alts };
  }
  return null;
}

/**
 * The words one word brace-expands to, the way bash spells them out before
 * running a command (#258): `rm -rf {hooks,}` removes hooks. Past BRACE_CAP
 * words, or for a sequence too long to list, the rest of the brace is
 * `wild` -- a stand-in the caller treats as any name.
 */
export function braceExpand(word, wild = "*") {
  const out = [];
  const walk = (w) => {
    const b = braceAt(w);
    if (!b) { out.push(w); return; }
    const alts = b.alts && out.length + b.alts.length <= BRACE_CAP ? b.alts : [wild];
    for (const alt of alts) walk(w.slice(0, b.start) + alt + w.slice(b.end + 1));
  };
  walk(word);
  return out;
}

/** Words of a string as the shell would split them (env -S). */
function splitWords(str, read) {
  return shellSegments(str, read).flatMap((s) => s.words);
}

/**
 * Peels assignments and wrappers (with their flags) off the front of a
 * word list, leaving the real command first. Returns the remaining words,
 * every NAME=value applied to the command along the way (`sudo FOO=1 env
 * BAR=2 cmd` carries both), any file a wrapper itself writes (GNU `time -o
 * FILE`), each wrapper peeled with the option words it took (#258:
 * xargs's -I string says where its stdin lands), and the folders a wrapper
 * moves the command into, in order (`env -C DIR`, `sudo -D DIR`, #258). An
 * env -S string is split the way `read` reads words. A wrapper is known by
 * its commandName, in any letter case (`SUDO`, `/usr/bin/Env`, #300), and
 * reported under it -- a g-prefixed GNU tool under its plain name (#307);
 * the words left over keep the spelling they were typed in. A wrapper that
 * runs a command line through a shell (script -c, flock -c, watch, #307)
 * leaves `sh -c LINE` as the command, which both guards already read.
 */
export function unwrap(words, read = {}) {
  let w = words.slice();
  const assigns = [];
  const writes = [];
  const wrappers = [];
  const dirs = [];
  for (;;) {
    while (w.length && ASSIGNMENT.test(w[0])) assigns.push(w.shift());
    if (!w.length) break;
    const spec = WRAPPERS.get(commandName(w[0]));
    if (!spec) break;
    const name = spec.as ?? commandName(w[0]);
    w.shift();
    const args = [];
    const take = () => { const x = w.shift(); args.push(x); return x; };
    wrappers.push({ name, args });
    let positional = spec.positional ?? 0;
    let line = null; // a command line the wrapper hands a shell
    let reading = false; // a flag that makes the positional a file read, not written
    // What one option's value does, by the option's name (see WRAPPERS).
    const act = (flag, val) => {
      if (val === null) return;
      // script -t 30 is a flush interval; only util-linux's -tFILE names a file
      const numeric = flag.length === 2 && spec.num?.includes(flag[1]) && /^\d+$/.test(val);
      if (spec.split?.includes(flag)) w = splitWords(val, read).concat(w);
      if (spec.writes?.includes(flag) && !numeric) writes.push(val);
      if (spec.dir?.includes(flag)) dirs.push(val);
      if (spec.assign?.includes(flag)) assigns.push(val);
      if (spec.cmd?.includes(flag)) line = val;
    };
    // Read the wrapper's own options, stopping at its first bare word.
    while (w.length) {
      const a = w[0];
      if (a === "--") { take(); break; }
      if (a === "-") { take(); continue; } // `env -` is `env -i`
      const eq = a.indexOf("=");
      const flag = eq < 0 ? a : a.slice(0, eq);
      if (a.startsWith("--") || (a.startsWith("-") && spec.long.includes(flag))) {
        take();
        let val = eq < 0 ? null : a.slice(eq + 1);
        if (eq < 0 && spec.long.includes(flag) && w.length) val = take();
        if (spec.reads?.includes(flag)) reading = true;
        act(flag, val);
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        take();
        // A short cluster: the first value-taking letter eats the rest of
        // the cluster, or the next word when it ends the cluster -- unless
        // its value is optional, when the next word is never it, or must be
        // a number and the next word isn't one.
        for (let k = 1; k < a.length; k++) {
          if (spec.reads?.includes(`-${a[k]}`)) reading = true;
          if (spec.opt?.includes(a[k])) break;
          if (!spec.short.includes(a[k])) continue;
          const next = spec.num?.includes(a[k]) && !/^\d/.test(w[0] ?? "") ? null : w[0];
          const val = k + 1 < a.length ? a.slice(k + 1) : (next !== undefined && next !== null ? take() : null);
          act(`-${a[k]}`, val);
          break;
        }
        continue;
      }
      break;
    }
    while (positional-- > 0 && w.length) {
      const x = take();
      if (spec.record && !reading) writes.push(x);
    }
    // flock LOCK -c 'cmd': the command line comes after the lock file
    if (spec.cmd && w.length) {
      const eq = w[0].indexOf("=");
      if (spec.cmd.includes(w[0])) {
        take();
        if (w.length) line = take();
      } else if (eq > 0 && spec.cmd.includes(w[0].slice(0, eq))) line = take().slice(eq + 1);
    }
    if (line !== null) w = ["sh", "-c", line, ...w];
    else if (spec.joins && w.length) w = ["sh", "-c", w.join(" ")];
    // `time` is a keyword too: `time { git reset --hard; }` times the group (#285)
    if (name === "time") w = w.slice(commandStart(w));
  }
  return { words: w, assigns, writes, wrappers, dirs };
}

/**
 * The command string a shell runs with -c, or null when there is none.
 * `args` are the words after the shell's name. Any short cluster carrying
 * `c` counts (-c, -lc, -ec); the string is the first bare word after the
 * options, never a guess at an index (#254).
 */
export function shellCommandString(args) {
  let sawC = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--" || a === "-") return sawC ? (args[k + 1] ?? null) : null;
    if (SHELL_VALUE_OPTS.has(a)) { k++; continue; }
    if (a.startsWith("--")) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === "-" && a.includes("c")) sawC = true;
      continue;
    }
    return sawC ? a : null; // first bare word: the -c string, or a script path
  }
  return null;
}

/**
 * True when a shell given these args reads its commands from stdin -- no
 * -c string and no script path, or an explicit -s -- so a heredoc or
 * here-string fed to it is a script, not data (#258).
 */
export function shellReadsStdin(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--" || a === "-") return k + 1 >= args.length;
    if (SHELL_VALUE_OPTS.has(a)) { k++; continue; }
    if (a.startsWith("--")) continue;
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a[0] === "-" && a.includes("c")) return false;
      if (a[0] === "-" && a.includes("s")) return true;
      continue;
    }
    return false; // a script path
  }
  return true;
}

// The fields a tool's input names a shell command in (#310), and the code
// languages that are a shell.
const COMMAND_FIELDS = ["command", "cmd", "shell_command"];
const SHELL_LANGS = new Set(["shell", "bash", "sh", "zsh"]);

/** A word quoted so shellSegments reads it back as that one word. */
function quoteWord(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The command lines a non-Bash tool's input hands a shell (#310), each as
 * { line, cwd }: a `command`, `cmd` or `shell_command` string (with an
 * `args` list after it, quoted word by word), each one in a `commands`
 * list (strings, or objects carrying one of those fields), and `code`
 * whose `language` is a shell. `cwd` is the folder the input names for
 * them, or null. Code in any other language, or keystrokes sent to a
 * running process, is not a command line this reader can see.
 */
export function toolCommands(input) {
  if (!input || typeof input !== "object") return [];
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  const lines = [];
  const take = (o) => {
    for (const f of COMMAND_FIELDS) {
      if (typeof o?.[f] !== "string") continue;
      const args = Array.isArray(o.args) ? o.args.filter((a) => typeof a === "string") : [];
      lines.push([o[f], ...args.map(quoteWord)].join(" "));
    }
  };
  take(input);
  if (Array.isArray(input.commands)) {
    for (const c of input.commands) {
      if (typeof c === "string") lines.push(c);
      else take(c);
    }
  }
  if (typeof input.code === "string" && SHELL_LANGS.has(String(input.language ?? "").toLowerCase())) {
    lines.push(input.code);
  }
  return lines.map((line) => ({ line, cwd }));
}

// su options that take the next word as their value.
const SU_VALUE_OPTS = "sgGw";

/**
 * The command string `su` runs, or null (#258). Found wherever it sits:
 * `su -c CMD`, `su - user -c CMD`, `su --command=CMD`, `su -lc CMD`, and
 * `su user -c CMD`, where the user's shell gets the -c.
 */
export function suCommandString(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "-c" || a === "--command" || a === "--session-command") return args[k + 1] ?? null;
    if (a.startsWith("--command=")) return a.slice("--command=".length);
    if (a.startsWith("--session-command=")) return a.slice("--session-command=".length);
    if (/^--(shell|group|supp-group|whitelist-environment)$/.test(a)) { k++; continue; }
    if (!/^-[A-Za-z]+$/.test(a)) continue; // the user name, or words for the shell
    for (let i = 1; i < a.length; i++) {
      if (a[i] === "c") return a.slice(i + 1) || (args[k + 1] ?? null);
      if (SU_VALUE_OPTS.includes(a[i])) { if (i + 1 === a.length) k++; break; }
    }
  }
  return null;
}
