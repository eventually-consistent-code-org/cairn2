#!/usr/bin/env node

/**
 * Purpose: the one shell reader the PreToolUse guards share (#270) -- splits
 *   a Bash command line into simple commands the way a shell would, closely
 *   enough to find the command words and what a command writes, and peels
 *   the wrappers (sudo -u root, env -i, timeout 5 ...) that run a later word
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

// Shells whose -c string is a command line of its own.
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
 */
export const WRAPPERS = new Map([
  ["sudo", { short: "ugpChDRTUrt", long: ["--user", "--group", "--host", "--prompt",
    "--close-from", "--chdir", "--role", "--type", "--other-user", "--command-timeout"] }],
  ["doas", { short: "uC", long: [] }],
  ["env", { short: "uCS", long: ["--unset", "--chdir", "--split-string"] }],
  ["nice", { short: "n", long: ["--adjustment"] }],
  ["timeout", { short: "sk", long: ["--signal", "--kill-after"], positional: 1 }],
  // GNU and BSD (-J -R -S) flags; -e -i -l, --eof --replace --max-lines: optional values
  ["xargs", { short: "ILnPsdEaJRS", opt: "eil", long: ["--max-args", "--max-procs",
    "--max-chars", "--delimiter", "--arg-file", "--process-slot-var"] }],
  ["exec", { short: "a", long: [] }],
  ["time", { short: "fo", long: ["--format", "--output"] }],
  ["command", { short: "", long: [] }],
  ["nohup", { short: "", long: [] }],
  ["builtin", { short: "", long: [] }],
  ["setsid", { short: "", long: [] }],
  ["stdbuf", { short: "ioe", long: ["--input", "--output", "--error"] }],
]);

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
 * `function NAME`, and `coproc` with the name before its body. Before #285
 * the first word was the command, so `if git reset --hard; then` read as a
 * command named `if` and nothing refused it.
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
 * env -S string is split the way `read` reads words.
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
    const name = w[0].split("/").pop();
    const spec = WRAPPERS.get(name);
    if (!spec) break;
    w.shift();
    const args = [];
    const take = () => { const x = w.shift(); args.push(x); return x; };
    wrappers.push({ name, args });
    let positional = spec.positional ?? 0;
    // Read the wrapper's own options, stopping at its first bare word.
    while (w.length) {
      const a = w[0];
      if (a === "--") { take(); break; }
      if (a === "-") { take(); continue; } // `env -` is `env -i`
      if (a.startsWith("--")) {
        take();
        const eq = a.indexOf("=");
        const flag = eq < 0 ? a : a.slice(0, eq);
        let val = eq < 0 ? null : a.slice(eq + 1);
        if (eq < 0 && spec.long.includes(flag) && w.length) val = take();
        if (val !== null && name === "env" && flag === "--split-string") w = splitWords(val, read).concat(w);
        if (val !== null && name === "time" && flag === "--output") writes.push(val);
        if (val !== null && flag === "--chdir" && (name === "env" || name === "sudo")) dirs.push(val);
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        take();
        // A short cluster: the first value-taking letter eats the rest of
        // the cluster, or the next word when it ends the cluster -- unless
        // its value is optional, when the next word is never it.
        for (let k = 1; k < a.length; k++) {
          if (spec.opt?.includes(a[k])) break;
          if (!spec.short.includes(a[k])) continue;
          const val = k + 1 < a.length ? a.slice(k + 1) : (w.length ? take() : null);
          if (val !== null && name === "env" && a[k] === "S") w = splitWords(val, read).concat(w);
          if (val !== null && name === "time" && a[k] === "o") writes.push(val);
          if (val !== null && a[k] === (name === "env" ? "C" : name === "sudo" ? "D" : "")) dirs.push(val);
          break;
        }
        continue;
      }
      break;
    }
    while (positional-- > 0 && w.length) take();
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
