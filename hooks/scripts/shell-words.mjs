#!/usr/bin/env node

/**
 * Purpose: the one shell reader the PreToolUse guards share (#270) -- splits
 *   a Bash command line into simple commands the way a shell would, closely
 *   enough to find the command words and what a command writes, and peels
 *   the wrappers (sudo -u root, env -i, timeout 5, and program runners like
 *   xcrun, arch -arm64 or script -q /dev/null, #307; strace, runuser and kin,
 *   #311) that run a later word as the real command. For a runner outside
 *   that table, runnerCommands (#311) still hands back the inner command its
 *   later words form, so the table stops growing one runner at a time, and
 *   argCommands and pagerCommands (#315) hand back the program a reading
 *   command's option or a pager variable runs (man -P, GIT_PAGER=). One
 *   MCP-input reader, toolCommandLines, finds the command lines a non-Bash
 *   tool hands a shell (#310, #311). The run guard and the harness guard
 *   both read commands through here, so a parsing fix reaches both; two
 *   hand-rolled readers drifted until #254's wrapper fix reached only one.
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

// A NAME=value word in command position: an assignment, not the command --
// `X+=y` and `a[0]=y` too (#494), which the shell reads the same way.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

// What follows `>&` when it is no file (#523): `>&2`, a close `>&-`, a move `>&3-`.
const DESCRIPTOR = /^(?:\d+-?|-)$/;

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
  // Linux tracers, sandboxers and privilege switches (#311): each starts a
  // later word as the real command. Their value-taking options are consumed
  // so the command isn't misread (strace/ltrace -o is a file they write);
  // runuser's and sg's -c string is a nested command line, like script -c.
  // The long tail of runners the issue names (op run, uv run, bundle exec,
  // tmux new-session, osascript ...) isn't modelled here one entry at a time
  // -- runnerCommands backstops them, so the table stops growing.
  ["strace", { short: "oepsabEOPITux", writes: ["-o"], long: ["--output", "--trace", "--expr",
    "--string-limit", "--columns", "--attach", "--user", "--env", "--seccomp-bpf"] }],
  ["ltrace", { short: "oepsSuFX", writes: ["-o"], long: ["--output", "--expr", "--filter", "--config"] }],
  ["valgrind", { short: "", long: [] }],
  ["firejail", { short: "", long: [] }],
  ["unshare", { short: "", long: ["--map-user", "--map-group", "--setuid", "--setgid", "--wd", "--root"] }],
  ["nsenter", { short: "t", long: ["--target"] }],
  ["pkexec", { short: "", long: ["--user"] }],
  ["runuser", { short: "cugGsw", long: ["--user", "--group", "--supp-group", "--shell",
    "--whitelist-environment", "--command"], cmd: ["-c", "--command"] }],
  ["sg", { short: "", long: ["--command"], positional: 1, cmd: ["-c", "--command"] }],
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

// How many `"$(` inside each other closeParen follows on the stack: well past
// SUBSTITUTION_DEPTH, and well short of a stack overflow, which a guard would
// have read as its own error and failed open on (#522).
const MAX_QUOTED = 256;

/**
 * Index of the `)` closing a `$(` whose body starts at `i` -- nesting-aware,
 * so parens inside quotes, inner substitutions, a `${...}` (#527) and backticks
 * don't close it early. Unterminated runs to the end of the line.
 */
function closeParen(line, i, quoted = 0) {
  // nested past the reader's own depth anyway: runs to the end, and the reader marks it (#522)
  if (quoted > MAX_QUOTED) return line.length;
  let depth = 1;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c === "'") { const j = line.indexOf("'", i + 1); i = j < 0 ? line.length : j; continue; }
    if (c === "`") { i = closeTick(line, i + 1); continue; }
    if (c === "$" && line[i + 1] === "{") { i = closeBrace(line, i + 2, false, quoted + 1); continue; }
    if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\") i++;
        else if (line[i] === "$" && line[i + 1] === "(") i = closeParen(line, i + 2, quoted + 1);
        else if (line[i] === "$" && line[i + 1] === "{") i = closeBrace(line, i + 2, true, quoted + 1);
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
 * The bodies of the substitutions an unquoted heredoc body runs (#322):
 * each `$(...)`, backtick and `$((...))` in it, in order, read as a
 * $(...) on the line is. The shell expands such a body the way it does a
 * double-quoted string -- a backslash escapes the next character, quotes
 * are plain text, and a substitution's own quoting is honoured (closeParen)
 * -- so `print('$(rm -rf hooks)')` holds the rm. A quoted-delimiter body
 * is never scanned: its text is literal.
 */
function heredocBodies(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    const n = body[i + 1];
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && n === "(") {
      const end = closeParen(body, i + 2);
      const inner = body.slice(i + 2, end);
      out.push(body[i + 2] === "(" ? inner.replace(/^\((.*)\)$/s, "$1") : inner);
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = closeTick(body, i + 1);
      out.push(body.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
      i = end + 1;
      continue;
    }
    i++;
  }
  return out;
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
function commandStart(words, from = 0) {
  let i = from;
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
 * The text a `$'...'` holds, as the shell decodes it (#494): `$'--hard'` is
 * --hard, and so is `$'\x2d\x2dhard'`. `body` runs from just past the
 * opening quote; returns { text, end }, `end` the closing quote's index.
 */
function ansiQuoted(body) {
  const CODES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" };
  let text = "";
  let i = 0;
  for (; i < body.length && body[i] !== "'"; i++) {
    if (body[i] !== "\\") { text += body[i]; continue; }
    const rest = body.slice(i + 1);
    const m = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(rest);
    if (m) {
      const code = m[1] ?? m[2] ?? m[3];
      const point = code === undefined ? parseInt(m[4], 8) : parseInt(code, 16);
      text += point <= 0x10ffff ? String.fromCodePoint(point) : "";
      i += m[0].length;
    } else if (rest[0] !== undefined) {
      text += CODES[rest[0]] ?? rest[0];
      i++;
    }
  }
  return { text, end: i };
}

/**
 * Splits a shell command line into simple-command segments, each
 * { words, quotes, reserved, redirects, heredocs: [{ delim, body, quoted }],
 * herestrings, inputs, op }. `quotes` runs beside `words`: what each word's
 * quoting said, as [start, end, kind] spans of its text -- `'` for a stretch
 * the shell keeps literal (single quotes, a backslash), `"` for a double-quoted
 * one, which a variable fills without splitting -- or null for a word with no
 * quote in it (#494, read by spellWords). Single and double quotes and backslashes are honoured, so
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
 *   redirects      `>` `>>` `&>` `>|` and zsh's `>!` targets go to `redirects`,
 *                  and so does what follows `>&` unless it is a number or `-`, a
 *                  descriptor: bash and zsh write any other word as a file (#523,
 *                  asserted against both by hooks.test.ts). `<` operands go to `inputs` and
 *                  `<<<` text to `herestrings` -- read, never words; a `<<`
 *                  heredoc body is data -- skipped through its delimiter line
 *                  and kept on its segment (see heredocs). Off: those
 *                  characters are word text and body lines are commands.
 *   heredocs       just the `<<` part of redirects: a heredoc body is data
 *                  on its segment, never command lines, while `<`, `<<<`
 *                  and `>` stay word text. An unquoted delimiter (`<<EOF`)
 *                  leaves the shell expanding the body before the command
 *                  reads it, so each `$(...)`, backtick and `$((...))` in
 *                  the body runs: with substitutions on, each is queued
 *                  like one on the line (#322). A quoted delimiter
 *                  (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) keeps the body literal,
 *                  so nothing in it is read; `quoted` says which.
 *   subshells      `(` and `)` end a command: `(cd x && rm y)` is a cd and
 *                  an rm. Off: they are word text.
 *   comments       an unquoted `#` at a word start comments out its line.
 *   substitutions  `$(...)` and backtick bodies, quoted or not, are run by
 *                  the shell (#257): each is split as a command line of its
 *                  own and appended after the line's segments. So are the
 *                  bodies of `<(...)`, `>(...)` and `$((...))` (#320): a
 *                  substitution runs inside arithmetic, and a body that
 *                  isn't arithmetic is a command substitution after all.
 *                  Bodies nest up to SUBSTITUTION_DEPTH levels; past that
 *                  a `deep` segment stands in (#321, tooDeep) and nothing
 *                  below it is read.
 *
 * Whatever `read` says, a `$(...)`, backtick, `$((...))`, `<(...)` or
 * `>(...)` outside quotes is one word, however many words run inside it
 * (#319): the shell replaces the whole thing before the command sees its
 * arguments, so `cp $(echo x) hooks/hooks.json` is a cp with two operands,
 * never three commands -- and the literal target after it is never lost.
 * Nesting and quotes inside are honoured, and `foo$(x)bar` stays one word.
 *   continuation   backslash-newline joins lines, and a lone trailing
 *                  backslash is dropped. Off: the backslash is word text.
 *   posixEscapes   inside double quotes a backslash escapes only " \ $ and
 *                  a backtick, and is text before anything else. Off: it
 *                  escapes any character.
 *   anyWhitespace  every whitespace character separates words. Off: only
 *                  space and tab do.
 *   budget         one call's readBudget (#522): every read is charged to it,
 *                  a heredoc body excepted, and once it is spent a `deep`
 *                  segment stands in for whatever was left (tooDeep). Off: the
 *                  line is read whatever it costs. `guess` marks a runner's guess
 *                  being read: its characters and the clock count, its segments
 *                  don't, or every line of a long `python -c` would spend the
 *                  budget of a command count on words that are no commands.
 *   plainQuote     a `'` in a double-quoted `${...}` is plain text, as a POSIX sh
 *                  and zsh read it. Off: it pairs, as bash reads it. Set only by
 *                  the reader, on a line whose reading depends on it (#527).
 */
export function shellSegments(command, read = {}, depth = 0) {
  const budget = read.budget ?? null;
  if (budget) {
    budget.raw += command.length;
    if (overBudget(budget)) return [deepSegment()];
  }
  // what this read may still charge, and the heredoc text it has skipped: data, and never charged
  const room = budget ? MAX_READ - budget.chars : Infinity;
  let data = 0;
  const segs = [];
  const subs = []; // bodies of command substitutions, split at the end
  const pending = []; // heredocs whose bodies start on the next line
  let words = [];
  let quotes = []; // beside `words`: what each word's quoting said (#494)
  let redirects = [];
  let heredocs = [];
  let herestrings = [];
  let inputs = [];
  let cur = null;
  let spans = []; // the same, for the word being read
  // what the next completed word is: word | redirect | dup | heredoc | herestring | input
  let next = "word";
  let strip = false; // `<<-` strips leading tabs before matching the delimiter
  let quoted = false; // any quote or backslash in the delimiter word keeps the body literal

  const pushWord = () => {
    if (cur === null) return;
    if (next === "redirect") redirects.push(boundNames(cur, spans));
    else if (next === "dup") {
      if (!DESCRIPTOR.test(cur)) redirects.push(boundNames(cur, spans));
    } else if (next === "heredoc") {
      const doc = { delim: cur, body: "", quoted };
      heredocs.push(doc);
      pending.push({ doc, strip });
      quoted = false;
    } else if (next === "herestring") herestrings.push(cur);
    else if (next === "input") inputs.push(cur);
    else if (next === "word") {
      words.push(cur);
      quotes.push(spans.length ? spans : null);
    }
    next = "word";
    cur = null;
    spans = [];
  };
  // `text` joins the word being read, its quoting noted
  const addQuoted = (text, kind) => {
    const from = (cur ?? "").length;
    cur = (cur ?? "") + text;
    spans.push([from, from + text.length, kind]);
  };
  const endSeg = (op = null) => {
    pushWord();
    if (words.length || redirects.length) {
      const at = commandStart(words);
      segs.push({ words: words.slice(at), quotes: quotes.slice(at), reserved: words.slice(0, at), redirects, heredocs,
        herestrings, inputs, op });
      if (budget && !read.guess) budget.segments++;
    }
    words = [];
    quotes = [];
    redirects = [];
    heredocs = [];
    herestrings = [];
    inputs = [];
  };
  const blank = read.anyWhitespace ? (c) => /\s/.test(c) : (c) => c === " " || c === "\t";
  const breaks = read.subshells ? ";&|()" : ";&|";
  // A substitution's text joins the word being read; its body is read as a command line after the line.
  const substitute = (end, body) => {
    if (body !== null && read.substitutions) subs.push(body);
    cur = (cur ?? "") + command.slice(i, end + 1);
    i = end + 1;
  };
  // Where a `${` closes, noting a line whose shells part over a `'` in it: the
  // line is then read their way too, so what either runs reaches the guard (#527).
  let parted = false;
  const braceEnd = (at, dq) => {
    const end = closeBrace(command, at, dq, 0, read.plainQuote);
    if (!read.plainQuote && closeBrace(command, at, dq, 0, true) !== end) parted = true;
    return end;
  };

  let i = 0;
  while (i < command.length) {
    if (budget && (i - data > room || budget.segments > MAX_SEGMENTS)) {
      budget.chars += i - data;
      budget.over = true;
      segs.push(deepSegment());
      return segs;
    }
    const c = command[i];
    const n = command[i + 1];

    // a quote or backslash anywhere in a heredoc's delimiter word keeps
    // its body literal (#322): `<<'EOF'`, `<<"EOF"`, `<<E'O'F`, `<<\EOF`
    if (next === "heredoc" && (c === "'" || c === '"' || (c === "\\" && n !== undefined && n !== "\n"))) {
      quoted = true;
    }

    // 'single quotes' -- everything literal up to the next quote
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? command.length : j;
      addQuoted(command.slice(i + 1, end), "'");
      i = end + 1;
      continue;
    }

    // $'...' -- the shell decodes the escapes, and the text is literal;
    // $"..." is a plain double-quoted string (#494)
    if (c === "$" && n === "'") {
      const { text, end } = ansiQuoted(command.slice(i + 2));
      addQuoted(text, "'");
      i += 2 + end + 1;
      continue;
    }
    if (c === "$" && n === '"') { i++; continue; }

    // "double quotes" -- literal but for escapes and, if read, substitutions
    if (c === '"') {
      let s = "";
      const escaped = []; // where an escape left a character the shell keeps literal
      i++;
      while (i < command.length && command[i] !== '"') {
        const d = command[i];
        const e = command[i + 1];
        if (d === "\\" && i + 1 < command.length && (!read.posixEscapes || '"\\$`'.includes(e))) {
          escaped.push(s.length);
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
        // "${ ... }" has quoting of its own, so a `"` in its default closes nothing out here (#527)
        if (d === "$" && e === "{") {
          const end = braceEnd(i + 2, true);
          const text = command.slice(i, end + 1);
          if (read.substitutions) for (const body of heredocBodies(text)) subs.push(body);
          s += text;
          i = end + 1;
          continue;
        }
        s += d;
        i++;
      }
      const from = (cur ?? "").length;
      // an escaped `$` first: the first span covering a character is its kind
      for (const at of escaped) spans.push([from + at, from + at + 1, "'"]);
      addQuoted(s, '"');
      i++;
      continue;
    }

    // ${ ... } outside quotes -- whatever is in the braces stays in the word
    // (#494): `${X:-a b}` is one expansion, never `${X:-a` and `b}`, and a
    // substitution in it runs like any other
    if (c === "$" && n === "{") {
      const end = braceEnd(i + 2, false);
      const text = command.slice(i, end + 1);
      if (read.substitutions) for (const body of heredocBodies(text)) subs.push(body);
      cur = (cur ?? "") + text;
      i = end + 1;
      continue;
    }

    // $( ... ), $(( ... )), <( ... ) and >( ... ) outside quotes -- one word
    // to the matching paren (#319), and each body runs, so each is queued
    // (#320). A `$((...))` is read as a command line too, whatever it is: a
    // $(...) or backtick inside arithmetic runs, and a shell that can't
    // parse the body as arithmetic falls back to a command substitution
    // holding a subshell, so `$((git reset --hard))` may well be the reset.
    if ((c === "$" || c === "<" || c === ">") && n === "(") {
      const end = closeParen(command, i + 2);
      const body = command.slice(i + 2, end);
      substitute(end, c === "$" && command[i + 2] === "(" ? body.replace(/^\((.*)\)$/s, "$1") : body);
      continue;
    }

    // ` ... ` outside quotes -- one word to the closing backtick (#319)
    if (c === "`") {
      const end = closeTick(command, i + 1);
      substitute(end, command.slice(i + 1, end).replace(/\\([`\\$])/g, "$1"));
      continue;
    }

    // backslash outside quotes -- the next character is literal
    if (c === "\\") {
      if (n !== undefined && n !== "\n") {
        addQuoted(n, "'");
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
      // The shell expands an unquoted body before the command reads it,
      // so each substitution in one runs: queue its body like one on the
      // line (#322). A quoted delimiter keeps the body literal.
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
            data += doc.body.length;
            if (!doc.quoted && read.substitutions) for (const body of heredocBodies(doc.body)) subs.push(body);
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
      if (cur !== null && /^\d+$/.test(cur)) { cur = null; spans = []; } else pushWord();
      let j = i + (c === "&" ? 2 : 1);
      if (command[j] === ">") j++;
      if (command[j] === "|" || command[j] === "!") j++; // >|, and zsh's >! and >>!
      next = "redirect";
      if (command[j] === "&") {
        next = "dup"; // a descriptor (>&2) or a file (>& f): the word says which
        j++;
        if (command[j] === "|" || command[j] === "!") j++; // zsh's >&| and >&!
      }
      i = j;
      continue;
    }

    // `<` is read when redirects are; `<<` (not `<<<`) when heredocs alone are (#322)
    if (c === "<" && (read.redirects
      || (read.heredocs && n === "<" && command[i + 2] !== "<" && command[i - 1] !== "<"))) {
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
  if (budget) {
    budget.chars += Math.max(0, command.length - data);
    if (overBudget(budget)) { segs.push(deepSegment()); return segs; }
  }
  if (parted) for (const seg of shellSegments(command, { ...read, plainQuote: true }, depth)) segs.push(seg);
  // Each body is read once, as a line of its own, one level deeper. Past
  // SUBSTITUTION_DEPTH levels the rest is not read at all (#321): a deep
  // segment stands in for it, and the guards refuse the line on sight.
  for (const body of subs) {
    if (depth >= SUBSTITUTION_DEPTH) { segs.push(deepSegment()); break; }
    for (const seg of shellSegments(body, read, depth + 1)) segs.push(seg);
  }
  return segs;
}

/**
 * How many levels of substitution bodies are read: `echo $(a $(b $(c)))`
 * is three. A line nested deeper is pathological -- each level is one more
 * pass over the rest of the line, and the guards' own re-reads of a
 * runner's inner line multiplied that until 120 levels held a guard for
 * nine seconds (#321) -- so the reader stops here and marks the line, and
 * a marked line is refused unread (tooDeep).
 */
export const SUBSTITUTION_DEPTH = 8;

/**
 * How many lines within lines a guard reads, the one depth all three hold
 * (#521): a shell's -c string, an eval, a heredoc fed to a shell, a pager
 * value, a runner's inner line. Past it the line is refused unread, the way a
 * body past SUBSTITUTION_DEPTH is. Before #521 the run and harness guards just
 * stopped reading at three, and passed what they had not read, so four `sh -c`
 * around a hard reset was the bypass. Asserted: runguard-guards.test.ts and
 * hooks.test.ts "(#521)", writeguard.test.ts "a nest deeper than the guard reads".
 */
export const MAX_NEST = SUBSTITUTION_DEPTH;

/**
 * How many runner guesses in a row a guard re-reads (#521). runnerCommands is a
 * guess at which later word is the command, so each bare word of `foo a b c`
 * opens another line that is no nest at all, and a long word list reaches any
 * depth: that is a limit to stop at, never one to refuse at. A shell string
 * starts the count again, so a runner at the bottom of a nest is still read. What
 * this leaves unread is in each guard's Not seen block (asserted: "(#521)").
 */
export const RUNNER_HOPS = 3;

/**
 * What one tool call may cost to read, nested re-reads included, so a line
 * built to outlast a guard's hook timeout is refused rather than read. On
 * `PreToolUse`, a timed-out command hook doesn't block the call (a dated claim:
 * read 2026-11-06 from the Claude Code hooks reference, Timeouts section), so a
 * limit a line can run past is a bypass, and every guard holds this one (#522):
 * asserted by shell-words.test.ts, runguard-guards.test.ts and hooks.test.ts
 * "(#522)". A heredoc's body is data and never counts against MAX_READ, only
 * against MAX_RAW, the most text a line can hold at all. A body fed to a shell is
 * read as a line, and counts then. This charges reading and git questions, not what
 * a guard does with what it read, which is bounded where it happens (#528): the
 * folders and locations in the run guard, a typed pattern in the harness guard.
 */
export const MAX_READ = 1_000_000;
export const MAX_SEGMENTS = 4096;
const MAX_RAW = 16 * MAX_READ;

/**
 * When a line that has done real work stops being read, in ms since the guard's
 * process started: half of a 3000 ms timeout, so the refusal lands with room on a
 * loaded machine, where the counts above can't promise a time and a git process
 * per question costs the most. hooks.json says 3000, and the Claude Code hooks
 * reference reads that field in seconds (a dated claim, read 2026-11-06), so there
 * a stall may hold the session instead of timing out; a refusal this early is right
 * on either reading. Under the WORK figures the clock is never read, so an `ls` on
 * a loaded machine can't be refused for the load: it has too little to do to overrun.
 */
const READ_MS = 1500;
const WORK = { chars: 20_000, segments: 128, asks: 32 };

/** One call's budget: the guard's READ carries it, and every read and git question is charged to it. */
export function readBudget(deadline = READ_MS) {
  return { chars: 0, segments: 0, raw: 0, asks: 0, deadline, over: false };
}

/** True once a call has spent its budget, and from then on: a spent budget is never unspent. */
export function overBudget(budget) {
  if (!budget || budget.over) return Boolean(budget?.over);
  const worked = budget.chars >= WORK.chars || budget.segments >= WORK.segments || budget.asks >= WORK.asks;
  budget.over = budget.chars > MAX_READ || budget.segments > MAX_SEGMENTS || budget.raw > MAX_RAW
    || (worked && performance.now() > budget.deadline);
  return budget.over;
}

/** Why a line went unread, for a guard's refusal: past the budget, or past the depth. */
export function unreadWhy(budget) {
  return budget?.over
    ? `runs longer than the guard reads in a hook's time (${MAX_READ} characters, ${MAX_SEGMENTS} commands)`
    : `nests commands deeper than the guard reads (${MAX_NEST} levels)`;
}

/**
 * True the first time a runner's guess is read this close to the runner (#522):
 * its later words re-read as suffixes of each other, so each is read once, and
 * again only if it turns up with more guesses left. `family` is one runner's.
 */
export function freshGuess(family, key, hops) {
  const had = family.get(key);
  if (had !== undefined && had <= hops) return false;
  family.set(key, hops);
  return true;
}

/** The segment that stands in for the bodies the reader stopped at. */
const deepSegment = () => ({ words: [], quotes: [], reserved: [], redirects: [], heredocs: [], herestrings: [],
  inputs: [], op: null, deep: true });

/** True when a line's segments hold a body nested deeper than the reader reads (#321). */
export function tooDeep(segs) {
  return segs.some((s) => s.deep === true);
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
  // one pass, every brace matched as it closes: a scan per `{` is quadratic on `{{{{...}}}}` (#522)
  const braces = [];
  const open = [];
  for (let j = word.indexOf("{"); j >= 0 && j < word.length; j++) {
    if (word[j] === "{") {
      const b = { i: j, end: -1, commas: [] };
      braces.push(b);
      open.push(b);
    } else if (word[j] === "}" && open.length) open.pop().end = j;
    else if (word[j] === "," && open.length) open.at(-1).commas.push(j);
  }
  for (const { i, end, commas } of braces) {
    if (word[i - 1] === "$") continue;
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
 * True when a word holds a `{...}` with a comma or a `..` in it, a list the shell
 * may spell out. One pass, where the regular expression it replaced walked to the
 * end of the word from every `{`, so a `cd` word of open braces held a guard (#528).
 */
export function holdsBraceList(word) {
  let from = 0;
  for (let close = word.indexOf("}"); close >= 0; close = word.indexOf("}", from)) {
    const open = word.indexOf("{", from);
    if (open >= 0 && open < close) {
      const body = word.slice(open + 1, close);
      if (body.includes(",") || body.includes("..")) return true;
    }
    from = close + 1;
  }
  return false;
}

/**
 * The words one word brace-expands to, the way bash spells them out before
 * running a command (#258): `rm -rf {hooks,}` removes hooks. Past BRACE_CAP
 * words, or for a sequence too long to list, the rest of the brace is
 * `wild` -- a stand-in the caller treats as any name.
 */
export function braceExpand(word, wild = "*") {
  // more braces than BRACE_CAP words could ever spell, read as such without walking them (#522)
  let braces = 0;
  for (let i = word.indexOf("{"); i >= 0; i = word.indexOf("{", i + 1)) {
    if (++braces > BRACE_CAP) return [wild];
  }
  const out = [];
  // past this many steps a word has more braces than BRACE_CAP words can spell (#522)
  let steps = 0;
  const walk = (w) => {
    if (++steps > 2 * BRACE_CAP) {
      if (steps === 2 * BRACE_CAP + 1) out.push(wild);
      return;
    }
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
  // `w` is read from `at` and never shifted: a shift per word is quadratic on a long line (#522)
  let w = words;
  let at = 0;
  const assigns = [];
  const writes = [];
  const wrappers = [];
  const dirs = [];
  for (;;) {
    while (at < w.length && ASSIGNMENT.test(w[at])) assigns.push(w[at++]);
    if (at >= w.length || overBudget(read.budget)) break;
    const spec = WRAPPERS.get(commandName(w[at]));
    if (!spec) break;
    const name = spec.as ?? commandName(w[at]);
    at++;
    const args = [];
    const take = () => { const x = w[at++]; args.push(x); return x; };
    wrappers.push({ name, args });
    let positional = spec.positional ?? 0;
    let line = null; // a command line the wrapper hands a shell
    let reading = false; // a flag that makes the positional a file read, not written
    // What one option's value does, by the option's name (see WRAPPERS).
    const act = (flag, val) => {
      if (val === null) return;
      // script -t 30 is a flush interval; only util-linux's -tFILE names a file
      const numeric = flag.length === 2 && spec.num?.includes(flag[1]) && /^\d+$/.test(val);
      if (spec.split?.includes(flag)) { w = splitWords(val, read).concat(w.slice(at)); at = 0; }
      if (spec.writes?.includes(flag) && !numeric) writes.push(val);
      if (spec.dir?.includes(flag)) dirs.push(val);
      if (spec.assign?.includes(flag)) assigns.push(val);
      if (spec.cmd?.includes(flag)) line = val;
    };
    // Read the wrapper's own options, stopping at its first bare word.
    while (at < w.length) {
      const a = w[at];
      if (a === "--") { take(); break; }
      if (a === "-") { take(); continue; } // `env -` is `env -i`
      const eq = a.indexOf("=");
      const flag = eq < 0 ? a : a.slice(0, eq);
      if (a.startsWith("--") || (a.startsWith("-") && spec.long.includes(flag))) {
        take();
        let val = eq < 0 ? null : a.slice(eq + 1);
        if (eq < 0 && spec.long.includes(flag) && at < w.length) val = take();
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
          const next = spec.num?.includes(a[k]) && !/^\d/.test(w[at] ?? "") ? null : w[at];
          const val = k + 1 < a.length ? a.slice(k + 1) : (next !== undefined && next !== null ? take() : null);
          act(`-${a[k]}`, val);
          break;
        }
        continue;
      }
      break;
    }
    while (positional-- > 0 && at < w.length) {
      const x = take();
      if (spec.record && !reading) writes.push(x);
    }
    // flock LOCK -c 'cmd': the command line comes after the lock file
    if (spec.cmd && at < w.length) {
      const eq = w[at].indexOf("=");
      if (spec.cmd.includes(w[at])) {
        take();
        if (at < w.length) line = take();
      } else if (eq > 0 && spec.cmd.includes(w[at].slice(0, eq))) line = take().slice(eq + 1);
    }
    if (line !== null) { w = ["sh", "-c", line, ...w.slice(at)]; at = 0; }
    else if (spec.joins && at < w.length) { w = ["sh", "-c", w.slice(at).join(" ")]; at = 0; }
    // `time` is a keyword too: `time { git reset --hard; }` times the group (#285)
    if (name === "time") at = commandStart(w, at);
  }
  return { words: w.slice(at), assigns, writes, wrappers, dirs };
}

// Spelling a line's variables (#291, #494, #509)

// In a target the reader spelled, the first thing only the run can fill in: an expansion left as typed, or a glob.
const UNSPELLED = /\$[({A-Za-z_0-9@*]|`|[*?[]/;

/**
 * The literal folder in front of the first thing only the run can fill in, with
 * its slash, or null for a target with none (#512, #524): `/` for `/$X/a`,
 * `/opt/` for `/opt/$X/a`, and "" for `$X/a`. Whether a root sits at or below it
 * is the guard's to say, since what the shell fills in then decides where the
 * write lands (writeguard.test.ts "a target is spelled", hooks.test.ts "(#524)").
 */
export function literalHead(target) {
  const at = target.search(UNSPELLED);
  return at < 0 ? null : target.slice(0, target.lastIndexOf("/", at) + 1);
}

// The most spellings of one word before the rest count as lost.
const SPELL_CAP = 16;

// The longest a spelled value or word is carried: `B=$A$A; C=$B$B ...` doubles a
// value per assignment, in a few characters each, and past this it is unreadable (#522).
const MAX_VALUE = 65536;

// Names the shell always holds, so neither can be read as nothing.
const ALWAYS_SET = new Set(["HOME", "PWD"]);

/**
 * What a variable holds when the line assigned it from something the guard
 * can't read and no folder can be said to be safe from it (#509): a `read`,
 * `printf -v`, `mapfile`, `getopts`, a `+=`, an array, a transforming
 * `declare`, or any operator on an assigned name. null in `vars` is the older
 * case, a $(...) or backtick (#291): `F=$(mktemp); echo x > $F` is a daily
 * shape, pinned to pass, where these lead a write nowhere the guard can place.
 * Both are wild to spellWords.
 */
export const UNREADABLE = Symbol("unreadable");

/**
 * The variables one line holds, over the ones its caller stood in (#522): writes
 * land here and the caller's stay as they were, which a copy of the map per
 * assignment used to promise at a cost that grew with the square of the line. A
 * read walks up, at most one step per level of nesting. An entry deleted here
 * hides the caller's.
 */
class Scope {
  constructor(parent) {
    this.parent = parent ?? null;
    this.own = new Map();
  }

  get(name) {
    return this.own.has(name) ? this.own.get(name) : this.parent?.get(name);
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  set(name, value) {
    this.own.set(name, value);
    return this;
  }

  delete(name) {
    this.own.set(name, undefined);
  }
}

/** A scope of its own for a line or command under `vars`, which it never writes to. */
export const childVars = (vars) => new Scope(vars);

/** True for a `vars` entry the guard can't spell: assigned from a substitution, or UNREADABLE. */
const isWild = (v) => v === null || v === UNREADABLE;

// Set while a word is spelled, and never in a word: a place an unquoted value splits.
const BREAK = "\0";

/**
 * A redirect target carries no spans past the parser, so a name its quoting
 * ends is braced here (#494): `"$H"oks` is ${H}oks, never a name H-o-k-s, and
 * every guard reading seg.redirects then spells it right. Without this, `H=ho;
 * echo x > "$H"oks/hooks.json` reads as an unknown name and passes, while the
 * same word on `cp` is refused (hooks.test.ts #509, shell-words.test.ts).
 */
function boundNames(word, spans) {
  if (!spans.length) return word;
  let out = "";
  let at = 0;
  for (const ref of expansions(word, spans)) {
    if (ref.kind !== "name" || word[ref.start + 1] === "{" || !/\w/.test(word[ref.end] ?? "")) continue;
    out += `${word.slice(at, ref.start)}\${${ref.name}}`;
    at = ref.end;
  }
  return out + word.slice(at);
}

// What closeBrace has open: a `${` outside double quotes, one inside them, and a `"` inside a `${`.
const IN_BRACE = 0;
const IN_QUOTED_BRACE = 1;
const IN_QUOTE = 2;

/**
 * Index of the `}` closing a `${` whose body starts at `i`, read as the shell
 * reads it (#527): a brace inside quotes or a substitution closes nothing, and
 * every level keeps its own quoting. `dq` says the `${` itself stands inside
 * double quotes. There a `"` still opens a quote, and shells part over a `'`: bash
 * pairs it, so `"${X:-'"'}"` is one word, while a POSIX sh and zsh read it as plain
 * text (`plain`), and the reader reads such a line both ways (shellSegments). One
 * pass with no stack of its own, so a thousand nested defaults cost what one long
 * word does. Before #527 a quoted `}` closed the `${`, its partner quote opened a
 * string to the end of the line, and every command after it read as text: `echo
 * ${J:-'{}'}; git reset --hard`. Asserted against the shells themselves by
 * shell-words.test.ts "(#527)".
 */
function closeBrace(word, i, dq = false, quoted = 0, plain = false) {
  const open = [dq ? IN_QUOTED_BRACE : IN_BRACE];
  for (; i < word.length; i++) {
    const c = word[i];
    const n = word[i + 1];
    const at = open[open.length - 1];
    if (c === "\\") i++;
    else if (c === "`") i = closeTick(word, i + 1);
    else if (c === "$" && n === "(") i = closeParen(word, i + 2, quoted + 1);
    else if (c === "$" && n === "{") {
      open.push(at === IN_BRACE ? IN_BRACE : IN_QUOTED_BRACE);
      i++;
    } else if (at === IN_QUOTE) {
      if (c === '"') open.pop();
    } else if (c === '"') open.push(IN_QUOTE);
    else if (c === "}") {
      open.pop();
      if (!open.length) return i;
    } else if (at === IN_BRACE && c === "$" && n === "'") {
      for (i += 2; i < word.length && word[i] !== "'"; i++) if (word[i] === "\\") i++;
    } else if (c === "'" && (at === IN_BRACE || !plain)) {
      const j = word.indexOf("'", i + 1);
      i = j < 0 ? word.length : j;
    }
  }
  return word.length;
}

/**
 * What one `${...}` body asks for, as the ref expansions lists: a plain
 * name, a positional, or an operator (`op`) on a name -- anything with more
 * in the braces than the name, indirection (${!N}), a length (${#N}) and an
 * array element (${N[0]}) among them. A `def` is the word a default-taking
 * operator (`:-`, `-`, `:=`, `=`, `:+`, `+`) gives the shell when the name is
 * not set. Null for what no value can come from (`${#}`, `${?}`).
 */
function braceRef(body) {
  const m = /^([!#]?)([A-Za-z_]\w*|[0-9]+|[@*])?([^]*)$/.exec(body);
  if (m[2] === undefined) return null;
  if (!/^[A-Za-z_]/.test(m[2])) return m[1] === "#" ? null : { kind: "positional" };
  if (!m[1] && !m[3]) return { kind: "name", name: m[2] };
  const def = m[1] ? null : /^:?[-=+]([^]*)$/.exec(m[3]);
  return { kind: "op", name: m[2], def: def ? def[1].replace(/["']/g, "") : undefined };
}

/**
 * Every expansion in a word, in order, as { start, end, kind, dq, name, def }:
 * `kind` is `sub` for a $(...) or backtick, `name` for $NAME and ${NAME},
 * `op` for an operator on a name (braceRef), `positional` for $1, $@, $*.
 * `spans` is the word's quoting from shellSegments: nothing in a literal
 * stretch expands, and `dq` marks one a value fills without splitting.
 * Arithmetic and process substitution are skipped -- a number and a /dev/fd
 * path are no flag, and the reader queues their bodies as commands anyway.
 */
function expansions(word, spans) {
  const out = [];
  // what each character's quoting says, the first span covering it winning, worked
  // out once for the word: a search of the spans per `$` is quadratic on one long word (#522)
  let quoting = null;
  const quoted = () => {
    if (quoting) return quoting;
    const kind = new Array(word.length);
    const end = new Array(word.length);
    for (const [a, b, k] of spans ?? []) {
      for (let i = a; i < b; i++) if (kind[i] === undefined) { kind[i] = k; end[i] = b; }
    }
    quoting = { kind, end, starts: (spans ?? []).map(([a]) => a).sort((a, b) => a - b), next: 0 };
    return quoting;
  };
  const quoteAt = (i) => quoted().kind[i];
  // a name stops where its quoting does: `"$F"x` is $F, then an x. `i` only grows, so `next` only does
  const nameEnd = (i) => {
    const q = quoted();
    if (q.end[i] !== undefined) return q.end[i];
    while (q.next < q.starts.length && q.starts[q.next] <= i) q.next++;
    return q.next < q.starts.length ? Math.min(word.length, q.starts[q.next]) : word.length;
  };
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const n = word[i + 1];
    if (c !== "$" && c !== "`" && !((c === "<" || c === ">") && n === "(")) continue;
    const q = quoteAt(i);
    if (q === "'") continue;
    const dq = q === '"';
    if (c === "`") {
      const end = closeTick(word, i + 1);
      out.push({ start: i, end: end + 1, kind: "sub", dq });
      i = end;
    } else if (c !== "$") {
      if (!dq) i = closeParen(word, i + 2);
    } else if (n === "(") {
      const end = closeParen(word, i + 2);
      if (word[i + 2] !== "(") out.push({ start: i, end: end + 1, kind: "sub", dq });
      i = end;
    } else if (n === "{") {
      const end = closeBrace(word, i + 2, dq);
      const ref = braceRef(word.slice(i + 2, end));
      if (ref) out.push({ start: i, end: end + 1, dq, ...ref });
      i = end;
    } else if (n !== undefined && /[0-9@*]/.test(n)) {
      out.push({ start: i, end: i + 2, kind: "positional", dq });
      i++;
    } else {
      const m = /^[A-Za-z_]\w*/.exec(word.slice(i + 1, nameEnd(i)));
      if (!m) continue;
      out.push({ start: i, end: i + 1 + m[0].length, kind: "name", name: m[0], dq });
      i += m[0].length;
    }
  }
  return out;
}

/**
 * What a ref holds on this line: undefined when the line never assigned the
 * name, UNREADABLE for any operator on a name it did, else the `vars` entry.
 */
function refValue(ref, vars) {
  if (ref.kind === "op") return vars?.has(ref.name) ? UNREADABLE : undefined;
  return vars?.get(ref.name);
}

/**
 * `raw` with every variable the line assigned earlier spelled out (#291):
 * each $NAME / ${NAME} whose NAME is in `vars`, in every value a loop gave
 * it, so `D=hooks; echo x > $D/hooks.json` is judged at hooks/. One the
 * line assigned from a substitution (null in `vars`), at the front of the
 * path with a folder after it, leads the write where the guard can't
 * follow -- `lost`, as a cd it can't read (#258) and a substitution leading
 * a path (#319) do; elsewhere in the path it stays as typed, judged under
 * the folder before it, as `/tmp/$(date).bak` is. An UNREADABLE one at the
 * front is `lost` with or without a folder after it (#509). A variable the
 * line never assigned stays as typed (the guard's Not seen block), and is also
 * read with the name gone, since an unset name is no part of the path at all
 * (`> $X.claude/settings.json`, #494), but a default written in the word is a
 * value too (`${X:-hooks}`), so it is judged as well. Past `cap` values the
 * rest is lost too. `typed` lists the readings with every name still as typed.
 */
export function expandAssigned(raw, vars, cap = SPELL_CAP, nest = 0) {
  const typed = spellRaw(raw, vars, cap, false, nest);
  if (!typed.open) return { raws: typed.raws, typed: typed.raws, lost: typed.lost };
  const gone = spellRaw(raw, vars, cap, true, nest);
  return { raws: [...new Set([...typed.raws, ...gone.raws.filter(Boolean)])], typed: typed.raws, lost: typed.lost || gone.lost };
}

function spellRaw(raw, vars, cap, vanish, nest) {
  let raws = [""];
  let lost = false;
  let open = false;
  let at = 0;
  for (const ref of expansions(raw)) {
    const text = raw.slice(at, ref.start);
    const typed = raw.slice(ref.start, ref.end);
    const front = /^(?:\.\/)*$/.test(raw.slice(0, ref.start));
    at = ref.end;
    const vals = ref.kind === "sub" || ref.kind === "positional" ? undefined : refValue(ref, vars);
    // a substitution or positional stays as typed, never read as nothing: it has its own rules
    const unset = ref.kind !== "sub" && ref.kind !== "positional" && vals === undefined && !ALWAYS_SET.has(ref.name);
    open ||= unset;
    const asTyped = unset && vanish ? "" : typed;
    if (vals === undefined && ref.def !== undefined && nest >= MAX_NEST) { // defaults in defaults, past the depth (#522)
      lost = true;
      raws = raws.map((r) => r + text + typed);
    } else if (vals === undefined && ref.def !== undefined) { // never assigned, with a default in the word
      const inner = expandAssigned(ref.def, vars, cap, nest + 1);
      lost ||= inner.lost;
      raws = raws.flatMap((r) => [r + text + asTyped, ...inner.raws.map((v) => r + text + v)]);
    } else if (vals === undefined) { // never assigned on the line
      raws = raws.map((r) => r + text + asTyped);
    } else if (isWild(vals)) { // assigned from something the guard can't read
      if (front && (vals === UNREADABLE || raw.slice(at).includes("/"))) lost = true;
      raws = raws.map((r) => r + text + typed);
    } else {
      raws = raws.flatMap((r) => vals.map((v) => r + text + v));
    }
    if (raws.length > cap) { lost = true; raws = raws.slice(0, cap); }
    if (raws.some((r) => r.length > MAX_VALUE)) return { raws: [raw], lost: true, open };
  }
  return { raws: raws.map((r) => r + raw.slice(at)), lost, open };
}

/**
 * The values one assignment's right-hand side can take (#291), spelled out
 * through the variables assigned before it and the ones the guard knows
 * (`known`: the harness guard's ~, $HOME, $CAIRN_HOME ...), one per value
 * a loop variable in it holds. Null when a $(...) or backtick computes it,
 * or a variable it names was itself; UNREADABLE when an operator or an
 * UNREADABLE variable does, or a positional (#509).
 */
function valueOf(v, vars, { known = (x) => x, cap = SPELL_CAP } = {}) {
  if (/\$\(|`/.test(v)) return null;
  const refs = expansions(v);
  const held = refs.map((r) => (r.kind === "positional" ? UNREADABLE : refValue(r, vars)));
  if (held.includes(null)) return null;
  if (held.includes(UNREADABLE)) return UNREADABLE;
  const { raws, lost } = expandAssigned(v, vars, cap);
  return lost ? null : v.length > MAX_VALUE ? UNREADABLE : raws.map((x) => known(x));
}

/**
 * Sets `name` in `vars`, keeping what it held (#494): a line's later
 * assignment may sit in a branch that never runs (`F=--hard; false && F=x`),
 * so every value it was ever given counts. Wild wins; past `cap` values it is
 * as good as unreadable.
 */
function remember(vars, name, vals, cap = SPELL_CAP) {
  const had = vars.get(name);
  if (had === undefined) vars.set(name, vals);
  else if (had === UNREADABLE || vals === UNREADABLE) vars.set(name, UNREADABLE);
  else if (had === null || vals === null) vars.set(name, null);
  else {
    const all = [...new Set([...had, ...vals])];
    vars.set(name, all.length > cap ? UNREADABLE : all);
  }
}

/**
 * `vars` with each NAME=value of `assigns` set, in order, each read through
 * the ones before it (#291). `X+=y` and `a[0]=y` build on a value the guard
 * won't work out: UNREADABLE (#509).
 */
export function assignVars(assigns, vars, opts = {}) {
  // no assignment, nothing to scope: only a prefix on a command needs a scope of its own (#522)
  if (!assigns.length) return vars ?? new Scope(null);
  const out = new Scope(vars);
  assignInto(out, assigns, opts);
  return out;
}

/** Each NAME=value of `assigns` written into `out`, in order, each read through the ones before it. */
function assignInto(out, assigns, opts) {
  for (const a of assigns) {
    const eq = a.indexOf("=");
    if (eq <= 0) continue;
    const m = /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+)?$/.exec(a.slice(0, eq));
    if (!m) continue;
    remember(out, m[1], m[2] || m[3] ? UNREADABLE : valueOf(a.slice(eq + 1), out, opts), opts.cap);
  }
}

// The letters of `read` and `mapfile` that take a value, which is no variable's name.
const READ_VALUED = "dinNptu";
const MAPFILE_VALUED = "dnOsuCc";

/**
 * The names a command that isn't an assignment sets (#509), each from
 * something the guard can't read: `read` (REPLY with no name), `mapfile` and
 * `readarray` (MAPFILE), `printf -v`, `getopts`. A `cd` and its kin move
 * $OLDPWD to a folder the line left.
 */
function readNames(w) {
  const skipping = (valued, fallback) => {
    const names = [];
    for (let k = 1; k < w.length; k++) {
      if (w[k].startsWith("-")) {
        if (valued.includes(w[k].at(-1))) k++;
      } else if (/^[A-Za-z_]\w*$/.test(w[k])) names.push(w[k]);
    }
    return names.length ? names : [fallback];
  };
  switch (w[0]) {
    case "read": return skipping(READ_VALUED, "REPLY");
    case "mapfile":
    case "readarray": return skipping(MAPFILE_VALUED, "MAPFILE");
    case "getopts": return w[2] ? [w[2]] : [];
    case "printf": {
      const m = /^-v(.*)$/.exec(w[1] ?? "");
      return m ? [m[1] || w[2]].filter(Boolean) : [];
    }
    case "cd":
    case "pushd":
    case "popd": return ["OLDPWD"];
    default: return [];
  }
}

/**
 * The variables one segment leaves set for the commands after it (#291):
 * a bare NAME=value (one or several), an export, declare, typeset,
 * readonly or local one, and a `for NAME in WORDS` (or select) header,
 * which gives NAME each word in turn -- every word, since the body runs
 * for each. A prefix assignment on a real command (`D=x cmd`) is that
 * command's alone, as the shell gives it: the guard hands it to the line
 * the command nests, and nothing after it sees it. `opts`: `read`, how the
 * guard reads a line, `known` and `cap`, as valueOf takes them.
 *
 * Unreadable, past that (#509): an array (`a=(x y)`, `declare -a`), a
 * `declare -n` or one that transforms its value (-i -l -u -c), a `for NAME`
 * with no word list (the positionals), and each of readNames'. An `eval`'s
 * line assigns in this shell too, so it is read for them (#494).
 */
export function lineVars(seg, vars, opts = {}) {
  const { words: w, assigns } = unwrap(seg.words, opts.read);
  // the scope seedVars made for this line is written in place, so a line's cost
  // grows with its length (#522); a plain map stays as it was, a scope over it coming back
  const out = vars instanceof Scope ? vars : new Scope(vars);
  const unreadable = (names) => {
    for (const n of names) remember(out, n, UNREADABLE, opts.cap);
  };
  // `a=(x y)`: the reader ends the word at the `(`, so the value is never in it
  const array = (word) => seg.op === "(" && word === seg.words.at(-1) && /^[A-Za-z_]\w*\+?=$/.test(word);
  if (!w.length) {
    assignInto(out, assigns.filter((a) => !array(a)), opts);
    unreadable(assigns.filter(array).map((a) => a.replace(/\+?=$/, "")));
  } else if (/^(export|declare|typeset|readonly|local)$/.test(w[0])) {
    const given = w.slice(1).filter((a) => ASSIGNMENT.test(a));
    const transforms = w.slice(1).some((a) => /^-[a-zA-Z]*[aAinluc]/.test(a));
    const plain = new Set(transforms ? [] : given.filter((a) => !array(a)));
    assignInto(out, plain, opts);
    unreadable(given.filter((a) => !plain.has(a)).map((a) => a.slice(0, a.indexOf("=")).replace(/(\[.*\])?\+?$/, "")));
  } else if (w[0] === "eval") {
    for (const inner of shellSegments(evalCommandString(w.slice(1)) ?? "", opts.read ?? {})) lineVars(inner, out, opts);
  } else {
    unreadable(readNames(w));
  }
  const r = seg.reserved ?? [];
  const at = r.findIndex((x) => x === "for" || x === "select");
  if (at >= 0 && r[at + 1] !== undefined) {
    if (r[at + 2] === "in") {
      const vals = r.slice(at + 3).filter((x) => x !== "do").map((x) => valueOf(x, out, opts));
      remember(out, r[at + 1], vals.includes(UNREADABLE) ? UNREADABLE : vals.includes(null) ? null : vals.flat(), opts.cap);
    } else unreadable([r[at + 1]]);
  }
  return out;
}

// Reserved words whose body runs again, later or alongside: order on the line can't be trusted.
const LOOPS = new Set(["while", "until", "for", "select", "repeat", "function", "coproc"]);

/**
 * The variables a line starts from (#494): `vars`, and when a loop or a
 * function body can run after what the line assigns below it (`f() { git
 * reset $F; }; F=--hard; f`), everything the line assigns anywhere. A scope of
 * the line's own over `vars`, or `vars` itself under `opts.shared`, as an eval
 * has it: what it assigns is its caller's (#522).
 */
export function seedVars(segs, vars, opts = {}) {
  const out = opts.shared && vars instanceof Scope ? vars : new Scope(vars);
  const repeats = segs.some((s) => (s.reserved ?? []).some((w) => LOOPS.has(w))
    || (s.op === "(" && s.words.length === 1 && /^[A-Za-z_][\w.:-]*$/.test(s.words[0])));
  if (repeats) for (const s of segs) lineVars(s, out, opts);
  return out;
}

/**
 * One word spelled through `vars` (#494): { alts, wild }. `alts` holds a word
 * list per value it can take, an unquoted value split the way the shell splits
 * it and a double-quoted one kept whole; a value that leaves an unquoted word
 * empty leaves no word. An assignment word never splits, and with several
 * values stays as typed (a folder the guard then calls lost). `wild` says part
 * of it can't be spelled: it stays as typed. $IFS, which the line never set,
 * is the break it stands for. A word with no expansion and no quote has its
 * braces spelled (`{--hard,}`), as the shell does first, unless `braces` is
 * off: a guard that spells them itself keeps its own marker for "anything".
 */
function spellWord(word, spans, vars, { cap, braces, vanish = false, nest = 0 }) {
  const refs = expansions(word, spans);
  const assign = ASSIGNMENT.test(word);
  if (!refs.length) return { alts: [spans || assign || !braces ? [word] : braceExpand(word)], wild: false, open: false };
  const fill = (v, dq) => (dq || assign ? v : v.split(/\s+/).join(BREAK));
  let raws = [""];
  let wild = false;
  let open = false;
  let at = 0;
  for (const ref of refs) {
    const text = word.slice(at, ref.start);
    const typed = word.slice(ref.start, ref.end);
    at = ref.end;
    const vals = ref.kind === "sub" || ref.kind === "positional" ? null : refValue(ref, vars);
    const unset = vals === undefined && !ALWAYS_SET.has(ref.name);
    open ||= unset;
    const asTyped = unset && vanish ? "" : typed;
    if (vals === undefined && ref.name === "IFS" && ref.kind === "name") {
      raws = raws.map((r) => r + text + (ref.dq ? " " : BREAK));
    } else if (vals === undefined && ref.def !== undefined && nest >= MAX_NEST) { // defaults in defaults, past the depth (#522)
      wild = true;
      raws = raws.map((r) => r + text + typed);
    } else if (vals === undefined && ref.def !== undefined) {
      const inner = spellWord(ref.def, null, vars, { cap, braces, vanish, nest: nest + 1 });
      wild ||= inner.wild;
      const defs = inner.alts.map((list) => list.map((v) => fill(v, ref.dq)).join(ref.dq ? " " : BREAK));
      raws = raws.flatMap((r) => [r + text + asTyped, ...defs.map((v) => r + text + v)]);
    } else if (vals === undefined) {
      raws = raws.map((r) => r + text + asTyped);
    } else if (isWild(vals)) {
      wild = true;
      raws = raws.map((r) => r + text + typed);
    } else {
      raws = raws.flatMap((r) => vals.map((v) => r + text + fill(v, ref.dq)));
    }
    if (raws.length > cap || raws.some((r) => r.length > MAX_VALUE)) return { alts: [[word]], wild: true, open };
  }
  raws = raws.map((r) => r + word.slice(at));
  if (assign) return { alts: [raws.length === 1 ? [raws[0].split(BREAK).join(" ")] : [word]], wild, open };
  // quoting can leave an empty word (`""`); a bare value that was empty leaves none
  const alts = raws.map((r) => {
    const list = r.split(BREAK).filter((x) => x !== "");
    return list.length || !spans ? list : [""];
  });
  return { alts, wild, open };
}

/**
 * A segment's words spelled through what the line assigned (#494), before
 * any guard judges them: one { words, wild } per way the words can read, a
 * variable a loop gave several values adding a reading each, so `for s in log
 * reset; do git $s --hard; done` is read as both. `wild` is the Set of the
 * words -- as typed -- the reader can't spell: a substitution, a positional,
 * a variable assigned from something it can't read, any operator on a name
 * the line assigned. A name the line never assigned is not wild: it is read
 * twice, because the shell gives it one of two things. Its value, which only
 * the session knows, stays as typed (the Not seen decision of #291, and `open`
 * lists those words for a guard that can't afford to not know, #501). Or
 * nothing, which the reader does know: `git $X reset --hard` with X unset is
 * `git reset --hard`, so a second set of readings has the name gone, a bare
 * word dropped and a quoted one left empty, as bash does (asserted against
 * bash by runguard-guards.test.ts #494). $HOME and $PWD are always set and
 * never vanish. `opts.wild` carries the wild words of a line a runner re-reads,
 * its words requoted (#311). Past SPELL_CAP readings a word stays as typed, wild.
 */
export function spellWords(seg, vars, opts = {}) {
  const cap = opts.cap ?? SPELL_CAP;
  const braces = opts.braces ?? true;
  const read = (vanish) => {
    let readings = [{ words: [], wild: new Set(), open: new Set() }];
    seg.words.forEach((word, k) => {
      let { alts, wild, open } = spellWord(word, seg.quotes?.[k] ?? null, vars, { cap, braces, vanish });
      if (readings.length * alts.length > cap) { alts = [[word]]; wild = true; }
      if (opts.wild?.has(word)) wild = true;
      const note = (reading, list) => {
        for (const w of list) {
          reading.words.push(w);
          if (wild) reading.wild.add(w);
          if (open && !vanish) reading.open.add(w);
        }
      };
      // a reading copied only where a word really has several values, so a word per
      // copy of everything before it stays off a long line (#522); the cap bounds the rest
      if (alts.length === 1) {
        for (const r of readings) note(r, alts[0]);
        return;
      }
      readings = readings.flatMap((r) => alts.map((list) => {
        const out = { words: [...r.words], wild: new Set(r.wild), open: new Set(r.open) };
        note(out, list);
        return out;
      }));
    });
    return readings;
  };
  const typed = read(false);
  // `gone` marks the readings with the name gone, for a guard that must tell a word from what the line wrote (#524)
  return typed.some((r) => r.open.size) ? [...typed, ...read(true).map((r) => ({ ...r, gone: true }))] : typed;
}

/**
 * Commands that only print, search or document their arguments, never run
 * one (#311): the words after one are data, so a guard never re-reads them
 * as a command. A command that can execute an argument (sh, eval, xargs,
 * find, tee, dd ...) must stay off this list -- unless it's one option
 * that runs a program (man -P, gh alias set --shell, rg --pre, #315), which
 * argCommands names, reading its value as a command line.
 */
export const ARG_SAFE = new Set(["echo", "printf", "print", "cat", "head", "tail", "wc", "ls",
  "stat", "file", "du", "df", "basename", "dirname", "realpath", "readlink", "pwd", "date",
  "sort", "uniq", "cut", "tr", "cmp", "diff", "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "ack-grep", "man", "which", "type", "whatis", "apropos", "whereis", "gh", "jq", "true",
  "false", ":"]);

// The variables naming the pager a program hands its output to (#315): man,
// git, gh and ack run the value as a command line.
const PAGER_VARS = new Set(["PAGER", "MANPAGER", "GIT_PAGER", "GH_PAGER", "ACK_PAGER", "ACK_PAGER_COLOR"]);

// man's short options that take a value (man-db's and BSD man's), so a P
// inside one's value is never read as -P.
const MAN_VALUE = "CELMPRSemprs";

// gh's own commands and their aliases (gh 2.10x). Any other first word runs
// an extension (gh-NAME) or an alias, a program the guards can't see (#315).
const GH_COMMANDS = new Set(["a11y", "accessibility", "actions", "agent", "agent-task", "agent-tasks", "agents",
  "alias", "api", "at", "attestation", "auth", "browse", "cache", "co", "codespace", "completion", "config",
  "copilot", "credits", "cs", "discussion", "environment", "exit-codes", "ext", "extension", "extensions",
  "formatting", "gist", "gpg-key", "help", "issue", "label", "licenses", "mintty", "org", "pr", "preview",
  "project", "reference", "release", "repo", "rs", "ruleset", "run", "search", "secret", "skill", "skills",
  "ssh-key", "status", "telemetry", "variable", "version", "workflow"]);

// The gh config keys naming a program gh runs (#315).
const GH_PROGRAMS = new Set(["pager", "editor", "browser"]);

/**
 * Every value `args` give one option (#315): `--long=V` or `--long V`, the
 * long name shortened as getopt allows down to `min` characters, and its
 * short letter -- `-P V`, `-PV`, or ending a cluster (`-aP V`). `short`
 * holds each of the program's letters that take a value, so a letter in
 * another option's value is never read as this one. An `optional` value is
 * only ever joined to its option (`-Hfirefox`, `--html=firefox`).
 */
function optionValues(args, { long, min = long.length, letter = "", short = "", optional = false }) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      if (name.length < min || !long.startsWith(name)) continue;
      if (eq >= 0) out.push(a.slice(eq + 1));
      else if (!optional && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const mine = a[k] === letter;
      if (!mine && !short.includes(a[k])) continue; // a plain switch
      const joined = a.slice(k + 1);
      const v = joined || (mine && optional) ? joined : (args[++i] ?? "");
      if (mine && v) out.push(v);
      break;
    }
  }
  return out;
}

// The `gh repo` options that take a value (#317), per action, so a
// destination is never mistaken for one.
const GH_REPO_VALUED = {
  clone: ["-u", "--upstream-remote-name"],
  fork: ["--fork-name", "--org", "--remote-name"],
  create: ["-d", "--description", "-g", "--gitignore", "-h", "--homepage", "-l", "--license", "-p", "--template",
    "-r", "--remote", "-s", "--source", "-t", "--team"],
};

/**
 * The git clone a `gh repo clone REPO [DIR] [-- gitflags]`, `gh repo fork
 * REPO --clone [--fork-name NAME]` or `gh repo create NAME --clone` runs
 * (#317), as the command line `git clone [gitflags] REPO [DIR]`, so a
 * guard reading it sees where the tree lands -- the repo's own name,
 * here, when no folder is given. Nothing for a fork or create that
 * doesn't clone, or any other repo action.
 */
function ghClone(action, after) {
  const valued = GH_REPO_VALUED[action];
  if (!valued) return [];
  const dd = after.indexOf("--");
  const own = dd < 0 ? after : after.slice(0, dd);
  const gitflags = dd < 0 ? [] : after.slice(dd + 1);
  const bare = [];
  let clone = action === "clone";
  let name = null;
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    const eq = a.startsWith("-") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(flag)) {
      const v = eq > 0 ? a.slice(eq + 1) : own[++i];
      if (flag === "--fork-name" && typeof v === "string") name = v;
    } else if (flag === "--clone") clone = eq < 0 || a.slice(eq + 1) !== "false";
    else if (!a.startsWith("-")) bare.push(a);
  }
  const [repo, dir] = bare;
  if (!clone || repo === undefined) return [];
  const dest = action === "clone" ? dir : name;
  return [["git", "clone", ...gitflags, repo, ...(dest === undefined || dest === null ? [] : [dest])].map(quoteWord).join(" ")];
}

/** What gh runs from its arguments (#315, #317) -- see argCommands. */
function ghCommands(rest) {
  const [sub, ...more] = rest;
  if (!sub || sub.startsWith("-")) return [];
  // an extension or an alias: an unknown program, its later words judged like any runner's
  if (!GH_COMMANDS.has(sub)) return runnerCommands([`gh-${sub}`, ...more]);
  const at = more.findIndex((a) => !a.startsWith("-"));
  if (at < 0) return [];
  const action = more[at];
  const after = more.slice(at + 1);
  if (/^ext(?:ensions?)?$/.test(sub) && action === "exec" && after.length) {
    return runnerCommands([`gh-${after[0]}`, ...after.slice(1)]);
  }
  if (sub === "repo") return ghClone(action, after);
  if (action !== "set" || (sub !== "alias" && sub !== "config")) return [];
  const bare = [];
  let shell = false;
  for (let i = 0; i < after.length; i++) {
    const a = after[i];
    if (a === "--") { bare.push(...after.slice(i + 1)); break; }
    if (sub === "config" && (a === "-h" || a === "--host")) { i++; continue; }
    if (a === "-s" || /^--shell(?:=true)?$/.test(a)) shell = true;
    else if (!a.startsWith("-")) bare.push(a);
  }
  const [key, value] = bare;
  if (typeof value !== "string") return [];
  if (sub === "alias") return shell || value.startsWith("!") ? [value.replace(/^!/, "")] : [];
  return GH_PROGRAMS.has(key) ? [value] : [];
}

/**
 * The command lines a program on ARG_SAFE still runs from its arguments
 * (#315), one option at a time; every other word it's given stays data:
 *   man       -P / --pager, and -H / --html=BROWSER
 *   gh        `alias set` with --shell, or an expansion starting with !;
 *             `config set pager|editor|browser`; an extension --
 *             `extension exec NAME`, or a first word that isn't one of gh's
 *             commands -- an unknown program, its later words read through
 *             runnerCommands; and the `git clone` a `repo clone`, `repo
 *             fork --clone` or `repo create --clone` runs (#317), so the
 *             folder it plants is judged like git's own
 *   rg        --pre, alone and as rg runs it: on each path operand, or here
 *   ag, ack   --pager
 *   sort      --compress-program
 * Empty for every other program, and for these without such an option.
 */
export function argCommands(words) {
  if (!Array.isArray(words) || words.length < 2) return [];
  const name = commandName(words[0]);
  const rest = words.slice(1);
  const held = new Set(); // a Set here and below: a search of `out` per word is quadratic on a long line (#522)
  const out = [];
  const push = (line) => {
    if (typeof line === "string" && line.trim() && !held.has(line)) { held.add(line); out.push(line); }
  };
  if (name === "man") {
    for (const v of optionValues(rest, { long: "--pager", min: 5, letter: "P", short: MAN_VALUE })) push(v);
    for (const v of optionValues(rest, { long: "--html", min: 4, letter: "H", short: MAN_VALUE, optional: true })) push(v);
  } else if (name === "gh") {
    for (const line of ghCommands(rest)) push(line);
  } else if (name === "rg") {
    const operands = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "--pre");
    for (const v of optionValues(rest, { long: "--pre" })) {
      push(v);
      push([v, ...operands.map(quoteWord), "."].join(" "));
    }
  } else if (name === "ag" || name === "ack" || name === "ack-grep") {
    for (const v of optionValues(rest, { long: "--pager", min: 5 })) push(v);
  } else if (name === "sort") {
    for (const v of optionValues(rest, { long: "--compress-program", min: 4, short: "kSoTt" })) push(v);
  }
  return out;
}

/**
 * The command lines the pager variables set on one command hold (#315):
 * `MANPAGER=CMD man ls`, `GIT_PAGER=CMD git log`, PAGER, GH_PAGER and
 * ack's -- in front of any command, alone on the line, or by export,
 * declare, typeset, readonly or local, since a later man, git or gh runs
 * it. `assigns` and `words` are unwrap's.
 */
export function pagerCommands(assigns, words) {
  const declared = /^(export|declare|typeset|readonly|local)$/.test(words?.[0] ?? "") ? words.slice(1) : [];
  const out = new Set();
  for (const list of [assigns ?? [], declared]) {
    for (const a of list) {
      const eq = a.indexOf("=");
      const v = a.slice(eq + 1);
      if (eq > 0 && PAGER_VARS.has(a.slice(0, eq)) && v.trim()) out.add(v);
    }
  }
  return [...out];
}

// An option whose value is a command line a runner hands a shell (strace has
// none; op/sg/runuser and the npm family use these), and the separators past
// which the rest of a runner's words are the command it runs.
const RUNNER_CMD_OPTS = new Set(["-c", "--call", "--command", "--shell-mode", "-e"]);
const RUNNER_SEPS = new Set(["--", "--args", ":::"]);

/**
 * The command lines an unknown program may run among its later words (#311),
 * so neither guard has to learn every runner one table entry at a time: when
 * a segment's first word (after unwrap's peeling) is a program the guards
 * don't otherwise handle, its later words can still be the real command --
 * `op run -- git push`, `bundle exec rm -rf hooks`, `tmux new-session -d
 * 'git reset --hard'`, `uv run pytest`. Returns the inner lines to re-judge:
 * a -c / --call string, whatever follows a `--` / `:::` / `--args`
 * separator, the run of words from the first bare one, each quoted string
 * argument that is itself a command, and osascript's `do shell script
 * "..."`. For a program that only reads its arguments (ARG_SAFE), only the
 * option that runs one (argCommands, #315); empty with nothing
 * command-shaped after it. The caller decides which inner line is
 * dangerous; this only finds the candidates. Words are requoted so a
 * re-read splits them the same way.
 */
export function runnerCommands(words) {
  if (!Array.isArray(words) || words.length < 2) return [];
  const name = commandName(words[0]);
  if (ARG_SAFE.has(name)) return argCommands(words);
  const rest = words.slice(1);
  const held = new Set();
  const out = [];
  const push = (line) => {
    if (typeof line === "string" && line && !held.has(line)) { held.add(line); out.push(line); }
  };

  // osascript's AppleScript runs a shell command inside `do shell script "X"`
  if (name === "osascript") {
    for (const w of rest) {
      for (const m of w.matchAll(/do\s+shell\s+script\s+(?:"([^"]*)"|'([^']*)')/gi)) push(m[1] ?? m[2]);
    }
    return out;
  }

  // a -c / --call / -e string, or its --opt=value form, is a command line
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (RUNNER_CMD_OPTS.has(a)) { push(rest[i + 1]); continue; }
    const eq = a.indexOf("=");
    if (eq > 0 && RUNNER_CMD_OPTS.has(a.slice(0, eq))) push(a.slice(eq + 1));
  }
  // whatever follows a `--`, `--args` or `:::` separator is the command
  const sep = rest.findIndex((a) => RUNNER_SEPS.has(a));
  if (sep >= 0 && sep + 1 < rest.length) push(rest.slice(sep + 1).map(quoteWord).join(" "));
  // the inline run of words from each bare one -- the first is usually the
  // command, but a runner can put operands ahead of it (`bwrap --bind / /
  // git ...`), so every bare start is a candidate (capped, as a runner's own
  // bare word only re-reads as a harmless unknown anyway)
  let starts = 0;
  for (let i = 0; i < rest.length && starts < 8; i++) {
    const a = rest[i];
    if (a.startsWith("-") || RUNNER_SEPS.has(a) || a === "::") continue;
    push(rest.slice(i).map(quoteWord).join(" "));
    starts++;
  }
  // a quoted multi-word argument that is a command line of its own
  for (const a of rest) if (/\s/.test(a)) push(a);
  return out;
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
 * The command line `eval` runs (#283): its words joined by one space, the
 * way the shell joins them before it reads the result as a line -- so
 * `eval 'git reset' '--hard'` is the reset and `eval echo git reset
 * --hard` is an echo. Null with no words, or only blank ones. Both guards
 * read eval through this one function, as they share shellCommandString,
 * so neither drifts back to reading its words one at a time.
 */
export function evalCommandString(args) {
  const line = args.join(" ").trim();
  return line || null;
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

// The fields a tool's input names a shell command in (#310), the ones that
// name its language, and the ones that name the folder it runs in (#311). The
// code languages that are a shell include a /bin/bash path, read by basename.
const COMMAND_FIELDS = ["command", "cmd", "shell_command"];
const LANGUAGE_FIELDS = ["language", "lang", "shell", "interpreter", "runtime"];
const FOLDER_FIELDS = ["cwd", "workdir", "working_directory", "workingDirectory"];
const SHELL_LANGS = new Set(["sh", "bash", "zsh", "dash", "ksh", "shell", "posix"]);

/** A word quoted so shellSegments reads it back as that one word. */
export function quoteWord(s) {
  const str = String(s);
  return /^[\w@%+=:,./-]+$/.test(str) ? str : `'${str.replace(/'/g, "'\\''")}'`;
}

/** True for a non-empty array of only strings. */
const allStrings = (v) => Array.isArray(v) && v.length > 0 && v.every((w) => typeof w === "string");

/**
 * The command line one command field stands for (#310): a string as it is,
 * with an `args` / `arguments` string array beside it appended word for
 * word; an exec-style array of strings, each one word; else null.
 */
function fieldLine(value, args) {
  if (typeof value === "string") return allStrings(args) ? [value, ...args.map(quoteWord)].join(" ") : value;
  return allStrings(value) ? value.map(quoteWord).join(" ") : null;
}

/**
 * The command lines a tool call's input hands a shell (#310, #311), as
 * { lines, dir, concurrent } -- the one reader both guards share, at the
 * breadth the run guard read on its own: a `command` / `cmd` /
 * `shell_command` string (an exec-style array of strings, or a string with
 * an `args` / `arguments` array, counts too), each entry of a `commands`
 * list (strings, or objects carrying one of those fields), a `script`
 * (unless a language field names a non-shell), and `code` whose language is
 * a shell (incl. a `/bin/bash` path). `dir` is the folder the input names
 * (cwd / workdir / working_directory / workingDirectory), or null;
 * `concurrent`, a batch run at once. Out of scope, as both guard headers
 * say: code in another language, and keystrokes to a running process.
 */
export function toolCommandLines(input) {
  if (!input || typeof input !== "object") return { lines: [], dir: null, concurrent: false };
  const language = LANGUAGE_FIELDS.map((f) => input[f]).find((v) => typeof v === "string");
  const shell = language === undefined ? null : SHELL_LANGS.has(commandName(language.trim()));
  const lines = [];
  const take = (obj) => {
    for (const f of COMMAND_FIELDS) {
      const line = fieldLine(obj[f], obj.args ?? obj.arguments);
      if (line !== null) lines.push(line);
    }
  };
  take(input);
  if (typeof input.script === "string" && shell !== false) lines.push(input.script);
  if (typeof input.code === "string" && shell === true) lines.push(input.code);
  for (const c of Array.isArray(input.commands) ? input.commands : []) {
    if (typeof c === "string") lines.push(c);
    else if (c && typeof c === "object") take(c);
  }
  const dir = FOLDER_FIELDS.map((f) => input[f]).find((v) => typeof v === "string" && v !== "") ?? null;
  return { lines, dir, concurrent: Number(input.concurrency) > 1 };
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
