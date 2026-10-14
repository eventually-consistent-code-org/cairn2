#!/usr/bin/env node

/**
 * Purpose: PreToolUse run guard (#216, #249-#252, #257, #262, #264, #270, #296, #297, #299-#302,
 *   #305, #306, #310, #311, #315) -- refuses git commands that rewrite a working tree or its history
 *   out from under whoever is in it, or push past the ship gate. Exit 2
 *   blocks; ANY internal error exits 0 -- a broken guard never blocks work.
 *   The rules are spelled out in the block below.
 *
 * removeWhen: headless runs execute in platform-provided isolated
 *   checkouts that cannot reach the human's working directory, and a
 *   default-branch push needs the human's hand. Half met
 *   (SURVEY.md 2026-10-13, native-vs-cairn-subsystem-judgement): EnterWorktree
 *   (2.1.222) confines edits and Bash to the native worktree. Still open:
 *   the fallback worktree path, default-branch pushes in auto mode
 *   (allowed by default), the other harnesses.
 * Author(s): John Reed
 */

/*
 * The rules
 *
 *   Always, in every session: the git commands that throw work away with
 *   no undo (the table in destructive(): hard reset; force, mirror and
 *   prune pushes, or one deleting the default branch; forced or whole-tree
 *   checkout/restore; a discarding switch; clean; stash clear; reflog
 *   expire), options shortened as git allows (--har is --hard, #296). Their
 *   everyday neighbours stay allowed. Escape: CAIRN_ALLOW_DESTRUCTIVE_GIT=1
 *   -- for the session, or as the leading assignment of the one command
 *   (honoured, never taught: refusals name only the owner's ways, #262).
 *
 *   Always: an agent push landing on the default branch (main, master, the
 *   remote's HEAD branch; a glob, `:` or push-everything push may, #297, as
 *   may a short name or the push settings git follows, #302) is refused
 *   unless the last plan_drift left a clean ship-gate stamp for the exact
 *   commit pushed (#251; open issues stay prose). Other branches are
 *   untouched; a missing or unreadable stamp refuses (#299). Escape:
 *   CAIRN_ALLOW_UNSHIPPED_PUSH=1, same two shapes.
 *
 *   While a batch run is live, or the run list can't be read (#299): `git checkout`,
 *   `git switch` and the hard reset (even overridden) aimed at the owner's
 *   own checkout (see ownerCheckout) are refused -- they change the
 *   human's files underneath them, mid-edit. CAIRN_RUN_OK=1 as the leading
 *   assignment overrides that once. And `git push`, from any worktree, is
 *   refused unless the run manifest grants pushAuth and marks one of its
 *   phases in flight (#260). No override: push authority is the owner's
 *   staging decision (ADR 0007).
 *
 *   A push either of those gates checks is its own step (#305). The guard
 *   works out what a push sends before the line runs, so anything earlier
 *   on the line that could make a commit or move a ref refuses it: a git
 *   command that isn't read-only (commit, merge, reset, checkout, branch
 *   -f, fetch, another push, an alias git may expand -- see movesRefs),
 *   any program off a short read-only list (npm version commits), or a
 *   redirect into a file. In a loop, a function, a pipe, the background or
 *   a $(...) the order can't be trusted, so such a command anywhere counts.
 *   A push on its own, and whatever runs after it, are judged as before.
 *
 *   Each git command is judged where git would run it (#306): from every
 *   folder a cd or pushd on the line may have left the shell in (a cd can
 *   fail, so all of them, as the harness guard counts them), then its env
 *   -C and -C, under every GIT_DIR, GIT_WORK_TREE and GIT_COMMON_DIR the
 *   session, the line or its own --git-dir / --work-tree give it. A push
 *   from another repository needs that repository's own stamp, and a
 *   checkout writing the owner's work tree, or moving their HEAD, is the
 *   owner's checkout. A folder or path only the shell can work out (cd
 *   "$X", cd -, GIT_DIR=$(...)) refuses any push -- what it lands can't be
 *   told -- unless the ship gate's escape is set, and mid-run, a checkout,
 *   switch or hard reset.
 *
 *   Commands are read by shell-words.mjs, shared with the harness guard
 *   (#270), so rules see through wrappers and their flag values (sudo -u
 *   root, timeout 5) and the program runners in its table (xcrun, script -c,
 *   strace, runuser, #307, #311). A runner the table doesn't name is backed
 *   up by runnerCommands (#311): when an unknown program's later words form
 *   a command -- `op run -- git push`, `bundle exec git reset --hard`, a
 *   `-c` string, `tmux new-session -d '...'` -- that inner line is judged
 *   too, so the table needn't grow one runner at a time. A program that only
 *   prints or searches its arguments (echo, grep, gh, ...) runs none of
 *   them, so a line that merely mentions git stays clear -- except the one
 *   option that runs a program (#315): man -P / --pager, gh alias set
 *   --shell (or a !expansion), gh config set pager|editor|browser, rg --pre,
 *   ag / ack --pager, sort --compress-program, whose value is read as a
 *   command line; and a gh extension or alias (`gh extension exec X`, a word
 *   that isn't a gh command) is an unknown program, read like any runner.
 *   A pager variable set on the line -- PAGER, MANPAGER, GIT_PAGER,
 *   GH_PAGER, ack's -- holds a command line too, judged right after the
 *   command it rides on (`GIT_PAGER=... git log`). Quoted text never
 *   refuses, but a double-quoted $(...) still runs, so its body is checked
 *   as a command of its own (#257). An unquoted $(...) or backtick is one
 *   word of the command around it (#319): `git reset $(git rev-parse X)
 *   --hard` is a hard reset, its --hard never cut off into a line of its
 *   own. A process substitution's body runs too, and so does a $(...)
 *   inside arithmetic -- or the whole `$((...))`, when a shell can't parse
 *   it as arithmetic and runs it as a subshell -- so `diff <(git reset
 *   --hard) x`, `$(( $(git reset --hard) ))` and `$((git reset --hard))`
 *   are read as the reset they are (#320). A heredoc body is data (#322):
 *   its lines are never commands, so a README written through `cat
 *   <<'EOF'` may say never to hard reset -- but the $(...) or backtick an
 *   unquoted body runs is read as a line of its own, and a heredoc fed to
 *   a shell reading stdin (`sh <<EOF`, `cat <<EOF | sh`) is that shell's
 *   script. A command
 *   that only exists in a substitution's output (`$(cat script)` run as a
 *   command) is still not seen.
 *
 *   Which tools (#310): the Bash tool's command, and the same line from any
 *   other tool -- an MCP server's shell tool -- found by its input's fields:
 *     command, cmd, shell_command  a command line; an exec-style array of
 *                                  strings, or a string with an args /
 *                                  arguments string array, is one too
 *     script                       a command line, unless a language field
 *                                  names something other than a shell
 *     code                         a command line only when a language
 *                                  field names a shell (ctx_execute's shell)
 *     commands                     a list of command lines, or of objects
 *                                  with a command field (ctx_batch_execute);
 *                                  in order, or at once past concurrency 1,
 *                                  each one's cd and GIT_DIR counting for all
 *     cwd, workdir, working_directory, workingDirectory
 *                                  the folder they start in
 *   Language fields: language, lang, shell, interpreter, runtime. Out of
 *   scope, and left to the harness's permission rules: tools that run code
 *   in another language (a code / language pair such as ctx_execute in
 *   python or javascript can call git any way it likes), and text sent to
 *   a process already running (interact_with_process) -- nothing in the
 *   call says a shell reads it. Which tools reach the guard at all is
 *   hooks/hooks.json's matcher.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  SHELLS, SUBSTITUTION_DEPTH, argCommands, commandName, pagerCommands, runnerCommands, shellCommandString,
  shellReadsStdin, shellSegments, toolCommandLines, unwrap,
} from "./shell-words.mjs";

// Same per-machine hashing scheme as lib.mjs / server continuity. lib.mjs
// keeps its copy private and pins every path under the real home, while
// this guard honours CAIRN_HOME, so the few lines live here too.
function pathHash(projectDir) {
  const abs = resolve(projectDir);
  return { base: basename(abs), hash: createHash("sha256").update(abs).digest("hex").slice(0, 16) };
}

// Constants

/**
 * git's top-level options that eat the following word as their value, from
 * git(1) and git.c (#301): `git --attr-source HEAD reset --hard` resets.
 * Their `--opt=value` forms are one word, skipped like any switch, and so is
 * --exec-path, which only ever takes its value after `=`. git spells these
 * in full -- it shortens no top-level option. --super-prefix is gone from
 * newer git and --list-cmds only takes `=`; both stay, since git refuses a
 * line that misuses them, and an older git reads them this way.
 */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
  "--attr-source", "--shallow-file", "--super-prefix", "--list-cmds"]);

/**
 * How this guard reads a command line (shell-words.mjs): ( ) and #
 * comments end a command, a $(...) or backtick is one word whose body is
 * a command of its own (#257, #319) -- a <(...), >(...) or $((...)) too
 * (#320) -- and backslash-newline joins lines. Bodies nest
 * SUBSTITUTION_DEPTH levels; a line nested deeper is refused unread (#321).
 * A heredoc body is data, never command lines (#322): only the
 * substitutions an unquoted body runs are read, each as a line of its
 * own, so a README written through `cat <<'EOF'` can mention a hard
 * reset. Redirects are not modelled: `>` and `< file` are word text.
 */
const READ = {
  subshells: true, comments: true, substitutions: true, heredocs: true,
  continuation: true, posixEscapes: true, anyWhitespace: true,
};

// The session-wide escape for the always-on destructive refusals. Same shape
// as CAIRN_HARNESS_EDIT: set in the environment, or as the leading
// assignment of the very command it unlocks.
const DESTRUCTIVE_ENV = "CAIRN_ALLOW_DESTRUCTIVE_GIT";

// The escape for the default-branch ship gate (#251), same shape.
const UNSHIPPED_ENV = "CAIRN_ALLOW_UNSHIPPED_PUSH";

// Branch names that are always treated as the default branch.
const DEFAULT_BRANCHES = ["main", "master"];

// A folder or repository the guard can't work out (#306) -- `cd "$X"`,
// `GIT_DIR=$(...)`. A gate that has to know where a command acts refuses.
const LOST = Symbol("lost");

// The variables that move which repository and work tree git acts on (#306).
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

// The most folders, or targets for one git command, the guard follows before it calls the line lost.
const MAX_TARGETS = 16;

/**
 * git subcommands that never make a commit or move a ref (#305) -- they
 * read, or touch only the index, the work tree or the config (whose push
 * settings linePushConfig watches). Any other subcommand can: an alias,
 * a third-party git-foo, or a typo help.autocorrect runs as the real thing.
 */
const GIT_READS = new Set(["", "status", "log", "diff", "show", "add", "rm", "mv", "restore", "grep",
  "blame", "annotate", "shortlog", "describe", "rev-parse", "rev-list", "ls-files", "ls-tree",
  "ls-remote", "cat-file", "show-ref", "for-each-ref", "show-branch", "name-rev", "merge-base",
  "diff-tree", "diff-index", "diff-files", "range-diff", "cherry", "whatchanged", "format-patch",
  "archive", "bundle", "count-objects", "fsck", "verify-commit", "verify-tag", "check-ignore",
  "check-attr", "check-mailmap", "check-ref-format", "var", "version", "help", "config", "clean",
  "apply", "gc", "prune", "repack", "pack-refs", "hash-object", "write-tree", "interpret-trailers",
  "stripspace", "sparse-checkout", "update-index", "read-tree", "checkout-index"]);

// Subcommands whose first word decides (#305): these actions leave every ref alone.
const GIT_READ_ACTIONS = new Map([
  ["stash", ["list", "show"]],
  ["remote", [undefined, "-v", "--verbose", "show", "get-url"]],
  ["worktree", ["list", "lock", "unlock", "prune", "repair", "move", "remove"]],
  ["notes", [undefined, "list", "show"]],
  ["submodule", [undefined, "status", "summary"]],
]);

/**
 * Programs that read and never make a commit or move a ref (#305), plus
 * the shell's own folder and variable builtins. Anything else earlier on
 * a line can -- `npm version` commits, and a script can do anything.
 */
const HARMLESS = new Set(["", "cd", "pushd", "popd", "dirs", "echo", "printf", "true", "false", ":",
  "test", "[", "[[", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "which",
  "type", "date", "sleep", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "readlink",
  "stat", "file", "du", "df", "diff", "cmp", "jq", "whoami", "id", "uname", "hostname", "export",
  "unset", "set", "local", "declare", "typeset", "readonly", "read", "wait", "exit", "return", "shift"]);

// Reserved words whose body runs again, later or alongside (#305): order on the line can't be trusted.
const REPEATS = new Set(["while", "until", "for", "select", "repeat", "function", "coproc"]);

// A lone word before `(`: `name () { ...; }` defines a function.
const FUNC_NAME = /^[A-Za-z_][\w.:-]*$/;

/**
 * Every git invocation in a command line, parsed, and every command's
 * place in it (#305). Each invocation carries the leading VAR=value
 * assignments, the -C directories in order, the -c and --config-env
 * values, the subcommand, its args (cut at a bare `--`), the paths past
 * that `--`, which are paths, not flags -- `git checkout -- .` (#264) --
 * and `step`, its index in `steps` -- plus where it acts (#306): `opts`,
 * its --git-dir / --work-tree, `wrapDirs`, the env -C or sudo -D folder
 * it starts in, `envAssigns`, the GIT_ENV assignments it runs under (its
 * own, or a `bash -c` around it), and `envCleared`, true when a wrapper may
 * clear the environment first. `steps` holds, for every command in line
 * order, whether it can make a commit or move a ref; `unordered` says that
 * order can't be trusted -- a loop or function body, a pipe, the
 * background, or a substitution, whose body is read after the line. For
 * linePlaces: `moves`, every cd, pushd, env -C and sudo -D; `repeats`, a
 * loop or function body that may run one again; `cdpaths` and `envSets`,
 * the CDPATH and GIT_ENV values the line sets (undefined: unset).
 * Recurses into `sh -c '<script>'` style wrappers.
 */
function readLine(line) {
  const out = { invs: [], steps: [], unordered: /\$\(|`/.test(line), moves: [], repeats: false,
    cdpaths: [], envSets: Object.fromEntries(GIT_ENV.map((k) => [k, []])), deep: false };
  const walk = (text, depth, inherit) => {
    if (out.deep) return; // nothing more is read of a line the reader gave up on (#321)
    // the last command ended in `>&` or `<&`, so the `&` was a redirect's,
    // and this one starts with its descriptor -- `2>&1` reads as `2>`, `1`
    let descriptor = false;
    // #315 -- a pager variable's value (PAGER=, GIT_PAGER= ...) runs once the
    // command it rides on is going, so it's judged right after that command,
    // never ahead of a push beside it
    const pagers = [];
    const flush = () => { for (const [line, env] of pagers.splice(0)) walk(line, depth + 1, env); };
    // the command piping into this one, so a heredoc it carries can be the
    // script of the shell reading it: `cat <<EOF | sh` (#322)
    let upstream = null;
    for (const seg of shellSegments(text, READ)) {
      // #321 -- substitutions nested deeper than the reader reads: the
      // line is refused as a whole (judgeLine), so stop reading it here
      if (seg.deep) { out.deep = true; return; }
      flush();
      const piped = upstream;
      upstream = seg.op === "|" || seg.op === "|&" ? seg : null;
      const segWords = descriptor && /^(\d+|-)$/.test(seg.words[0] ?? "") ? seg.words.slice(1) : seg.words;
      descriptor = seg.op === "&" && /[<>]$/.test(seg.words[seg.words.length - 1] ?? "");
      if ((seg.op === "&" && !descriptor) || seg.op === "|" || seg.op === "|&") out.unordered = true;
      if (seg.reserved.some((w) => REPEATS.has(w))
        || (seg.op === "(" && seg.words.length === 1 && FUNC_NAME.test(seg.words[0]))) {
        out.unordered = true;
        out.repeats = true;
      }

      // Assignments and wrappers come off the front, flag values and all, so
      // `/usr/bin/sudo -u root git reset --hard` is still git (#270) -- and
      // in any letter case: a Mac runs `GIT` and `/usr/bin/Git` as git (#300)
      const { words, assigns, wrappers, dirs: wrapDirs } = unwrap(segWords, READ);
      const cmd = commandName(words[0]);
      // git's own env -C applies to it alone (see invTargets); anything
      // else's -- a `bash -c` -- is where its commands run
      noteFolders(out, seg, words, assigns, cmd === "git" ? [] : wrapDirs);
      const env = {
        assigns: [...inherit.assigns, ...assigns.filter((a) => GIT_ENV.some((k) => a.startsWith(`${k}=`)))],
        cleared: inherit.cleared || wrappers.some(clearsEnv),
      };
      if (depth < 3) for (const line of pagerCommands(assigns, words)) pagers.push([line, env]);

      // sh -c / bash -lc: the script is one quoted word -- parse it too,
      // found the same way the harness guard finds it (#270)
      if (SHELLS.has(cmd) && depth < 2) {
        const script = shellCommandString(words.slice(1));
        // #322 -- a shell reading stdin runs the heredoc fed to it, its own
        // or the one piped in (`cat <<EOF | sh`), as the harness guard reads it
        const docs = !script && shellReadsStdin(words.slice(1))
          ? [seg, ...(piped ? [piped] : [])].flatMap((s) => s.heredocs) : [];
        if (script) walk(script, depth + 1, env);
        else if (docs.length) for (const h of docs) walk(h.body, depth + 1, env);
        else out.steps.push(true); // a script file, or stdin the guard can't see: anything at all
        continue;
      }
      if (cmd !== "git") {
        // #311 -- a program runner off the table (op run, bundle exec, tmux
        // new-session, uv run ...) may run a later word as the real command;
        // judge those inner lines too, so the wrapper table stops growing.
        // HARMLESS commands (and ARG_SAFE ones, via runnerCommands) read, not
        // run, their arguments, so a line that only mentions git stays clear
        // -- all but the one option that runs a program (rg --pre, man -P,
        // gh alias set --shell, #315), whose value is read either way.
        if (depth < 3) {
          const inner = HARMLESS.has(cmd) ? argCommands(words) : runnerCommands(words);
          for (const line of inner) walk(line, depth + 1, env);
        }
        out.steps.push(!HARMLESS.has(cmd) || writesFile(words));
        continue;
      }

      let i = 1;
      const dirs = [];
      const configs = [];
      const configEnvs = [];
      const opts = {};
      while (i < words.length && words[i].startsWith("-")) {
        const w = words[i];
        if (w === "-C") dirs.push(words[i + 1] ?? "");
        if (w === "-c") configs.push(words[i + 1] ?? "");
        if (w === "--config-env") configEnvs.push(words[i + 1] ?? "");
        if (w.startsWith("--config-env=")) configEnvs.push(w.slice(13));
        // --git-dir and --work-tree, either form; the last one wins, as in git
        const where = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(w);
        if (where) opts[where[1] === "git-dir" ? "GIT_DIR" : "GIT_WORK_TREE"] = where[2] ?? words[i + 1] ?? "";
        if (w === "--bare") opts.bare = true;
        i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
      }
      const rest = words.slice(i + 1);
      const dashes = rest.indexOf("--");
      const inv = {
        assigns,
        dirs,
        configs,
        configEnvs,
        sub: words[i] ?? "",
        args: dashes < 0 ? rest : rest.slice(0, dashes),
        paths: dashes < 0 ? [] : rest.slice(dashes + 1),
        step: out.steps.length,
        opts,
        wrapDirs,
        envAssigns: env.assigns,
        envCleared: env.cleared,
      };
      out.steps.push(movesRefs(inv) || writesFile(words));
      out.invs.push(inv);
    }
    flush();
  };
  walk(line, 0, { assigns: [], cleared: false });
  return out;
}

/**
 * Records what one command does to the folder and the git environment the
 * rest of the line runs in (#306): a cd or pushd (lost when a subshell
 * break leaves it no target; a `cd $(...)` is lost once pathWord reads
 * the target), an env -C or sudo -D folder, a GIT_ENV value set by a
 * bare assignment, export or declare, or
 * taken away by unset (or a bare export/declare of the name), and any
 * CDPATH the line sets, even as one cd's own prefix.
 */
function noteFolders(out, seg, words, assigns, wrapDirs) {
  for (const raw of wrapDirs) out.moves.push({ raw });
  if (words[0] === "cd" || words[0] === "pushd") {
    out.moves.push({ cmd: words[0], args: words.slice(1), lost: seg.op === "(" });
  }
  const declares = /^(export|declare|typeset|readonly|local|unset)$/.test(words[0] ?? "");
  const shared = [...(words.length ? [] : assigns), ...(declares ? words.slice(1) : [])];
  for (const a of [...assigns, ...shared]) if (a.startsWith("CDPATH=")) out.cdpaths.push(a.slice(7));
  for (const a of shared) {
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (GIT_ENV.includes(name)) out.envSets[name].push(eq < 0 || words[0] === "unset" ? undefined : a.slice(eq + 1));
  }
}

/** True for a wrapper that may run its command without the session's environment: env -i or -u, sudo, doas. */
function clearsEnv({ name, args }) {
  if (name === "sudo" || name === "doas") return true;
  return name === "env" && args.some((a) => a === "-" || /^-[^-]*[iu]|^--(?:ignore-environment|unset)/.test(a));
}

/**
 * True when a command's words send its output into a file (#305) -- `> f`,
 * `2>>f` -- rather than a descriptor or /dev/null. A file could be a ref.
 * A `>` ending the words had its `&` read as an operator: `2>&1`.
 */
function writesFile(words) {
  for (let k = 0; k < words.length; k++) {
    const at = words[k].indexOf(">");
    if (at < 0) continue;
    const target = words[k].slice(at + 1).replace(/^>/, "") || (words[k + 1] ?? "");
    if (target && !target.startsWith("&") && target !== "/dev/null") return true;
  }
  return false;
}

// The options of `git branch` and `git tag` that take a value, and the ones that list.
const REF_VALUED = ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort",
  "--format", "--set-upstream-to", "--message", "--file", "--local-user", "--cleanup"];
const REF_READ = { longs: ["--list", "--show-current", "--verify", ...REF_VALUED], valued: REF_VALUED };

/**
 * True when `git branch` or `git tag` only lists (#305): no ref named, or
 * --list, --show-current, a tag's --verify. Naming one creates, moves,
 * copies or deletes it -- a deleted tag can unshadow the branch it hid.
 */
function listsRefs(inv) {
  const tag = inv.sub === "tag";
  const { flags, words } = readArgs(inv.args, { ...REF_READ, short: tag ? "muF" : "u" });
  return !words.length || flags.has("--list") || flags.has("-l") || flags.has("--show-current")
    || (tag && (flags.has("--verify") || flags.has("-v")));
}

/**
 * True when this git invocation can make a commit or move a ref (#305):
 * every subcommand but the read-only ones in GIT_READS, the listing forms
 * of branch and tag, the reading actions of stash, remote, worktree, notes
 * and submodule, and a reflog that neither expires nor deletes entries
 * (`main@{1}` is read from it). A push counts: it moves the remote-tracking
 * refs a later push can name, and -u changes the upstream it follows.
 */
function movesRefs(inv) {
  const { sub, args } = inv;
  if (sub === "branch" || sub === "tag") return !listsRefs(inv);
  if (sub === "reflog") return args[0] === "expire" || args[0] === "delete";
  if (GIT_READ_ACTIONS.has(sub)) return !GIT_READ_ACTIONS.get(sub).includes(args[0]);
  return !GIT_READS.has(sub);
}

/**
 * A path word resolved from `from` the way the shell hands it to its
 * command (#306): ~, ~/ and $HOME are the home folder, $PWD the folder
 * itself. LOST for any other variable, a substitution, ~user, a brace
 * list or a wildcard, and for a relative path from a LOST folder -- the
 * guard won't guess where they lead.
 */
function pathWord(raw, from) {
  let base = from;
  let rest = String(raw);
  const m = /^(?:\$(HOME|PWD)|\$\{(HOME|PWD)\}|~)(?=\/|$)/.exec(rest);
  if (m) {
    base = (m[1] ?? m[2]) === "PWD" ? from : homedir();
    rest = rest.slice(m[0].length).replace(/^\/+/, "");
  }
  if (/[$`*?[]|^~|\{[^}]*(?:,|\.\.)[^}]*\}/.test(rest)) return LOST;
  if (isAbsolute(rest)) return resolve(rest);
  return base === LOST ? LOST : resolve(base, rest || ".");
}

/**
 * The folders one cd or pushd can move to from `from` (#306): its target,
 * the home folder for a bare cd, and for a bare name the same name under
 * each CDPATH entry. `cd -`, `pushd +N` and a target only the shell can
 * work out are LOST. A bare pushd and popd only revisit folders already
 * counted.
 */
function cdTargets(move, from, cdpaths) {
  if (move.lost) return [LOST];
  const ops = move.args.filter((a) => a !== "--" && !/^-[LPe@]+$/.test(a));
  if (!ops.length) return move.cmd === "cd" ? [pathWord("~", from)] : [];
  if (ops[0] === "-" || /^[+-]\d+$/.test(ops[0])) return [LOST];
  const out = [pathWord(ops[0], from)];
  if (!/^(?:\/|\.\.?(?:\/|$)|~|\$)/.test(ops[0])) {
    for (const entry of cdpaths.flatMap((v) => v.split(":"))) out.push(pathWord(join(entry || ".", ops[0]), from));
  }
  return out;
}

/**
 * Every folder the shell may be in when a command on the line runs (#306),
 * counted the way the harness guard counts them (#258): the starting
 * folder, and every cd, pushd, env -C and sudo -D target resolved from
 * every folder found before it. A cd can fail, be skipped or run later,
 * so none ever takes a folder away, and every git command is judged from
 * all of them. In a loop or function body a cd can run again, so the
 * moves apply until nothing new turns up; a line still growing then, or
 * past MAX_TARGETS, has gone somewhere the guard can't follow -- LOST.
 */
function linePlaces(line, start) {
  const cdpaths = [...(process.env.CDPATH ? [process.env.CDPATH] : []), ...line.cdpaths];
  const places = [start];
  const add = (more) => { for (const p of more) if (!places.includes(p)) places.push(p); };
  for (let round = 0; ; round++) {
    const before = places.length;
    for (const m of line.moves) {
      add(places.flatMap((p) => (m.cmd ? cdTargets(m, p, cdpaths) : [pathWord(m.raw, p)])));
    }
    if (places.length > MAX_TARGETS) return [...places.slice(0, MAX_TARGETS), LOST];
    if (!line.repeats || places.length === before) return places;
    if (round === 3) return [...places, LOST];
  }
}

/**
 * The values each GIT_ENV variable may hold for this invocation (#306), in
 * GIT_ENV order, undefined for unset: its --git-dir or --work-tree, else
 * its own leading assignment (`GIT_DIR=x git ...`, or one a `bash -c` it
 * sits in inherits), else any value the session or the line gives it --
 * plus unset, when a wrapper may clear the environment (env -i or -u,
 * sudo, doas). `--bare` may make the folder itself the git dir, and a
 * `-c core.worktree` is one more work tree it may write.
 */
function envChoices(inv, lineEnv) {
  return GIT_ENV.map((k) => {
    let vals;
    if (inv.opts[k] !== undefined) vals = [inv.opts[k]];
    else {
      const own = inv.envAssigns.filter((a) => a.startsWith(`${k}=`)).pop();
      vals = own !== undefined ? [own.slice(k.length + 1)]
        : inv.envCleared ? [...lineEnv[k], undefined] : lineEnv[k];
      if (k === "GIT_DIR" && inv.opts.bare) vals = [...vals, "."];
    }
    if (k === "GIT_WORK_TREE") {
      // a --config-env value sits where the guard can't see it: a `$` word, which reads as LOST
      for (const [key, v] of ownConfig(inv)) if (key === "core.worktree") vals = [...vals, v ?? "$?"];
    }
    return [...new Set(vals)];
  });
}

/**
 * Every place this git invocation may act (#306), each a target { dir, env }
 * -- the folder git starts in after env -C and its own -C, and the
 * environment it runs under, with GIT_DIR, GIT_WORK_TREE and
 * GIT_COMMON_DIR resolved from that folder the way git resolves them --
 * or LOST where the guard can't tell. One per folder the shell may be in
 * and per value each variable may hold.
 */
function invTargets(inv, places, lineEnv) {
  const choices = envChoices(inv, lineEnv);
  const found = new Map();
  for (const place of places) {
    let dir = place;
    for (const d of [...inv.wrapDirs, ...inv.dirs]) dir = pathWord(d, dir);
    if (dir === LOST) { found.set("lost", LOST); continue; }
    for (const gitDir of choices[0]) {
      for (const workTree of choices[1]) {
        for (const common of choices[2]) {
          const env = { ...process.env };
          let lost = false;
          [gitDir, workTree, common].forEach((v, k) => {
            delete env[GIT_ENV[k]];
            if (v === undefined) return;
            const abs = pathWord(v, dir);
            if (abs === LOST) lost = true;
            else env[GIT_ENV[k]] = abs;
          });
          const key = lost ? "lost" : [dir, ...GIT_ENV.map((g) => env[g] ?? "")].join("\0");
          found.set(key, lost ? LOST : { dir, env });
        }
      }
    }
  }
  const targets = [...found.values()];
  return targets.length > MAX_TARGETS ? [...targets.slice(0, MAX_TARGETS), LOST] : targets;
}

/** A path with its links resolved, or as given when it doesn't exist. */
function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Where a target's refs live -- its common git dir, links resolved -- or
 * null when git finds no repository there (#306). A linked worktree shares
 * its main checkout's, so the two are one repository. Read once per target.
 */
function repoOf(at) {
  if (at.repo === undefined) {
    const raw = gitOut(at, ["rev-parse", "--git-common-dir"]);
    at.repo = raw === null ? null : realPath(resolve(at.dir, raw));
  }
  return at.repo;
}

/**
 * The folder whose ship-gate stamp covers a push from `at` (#306): the
 * project's, for the project's repository -- from any of its worktrees,
 * where the commit check still reads that worktree's own HEAD -- or that
 * other repository's own folder (the one holding its .git, or a bare
 * one's git dir), which has no stamp unless plan_drift ran there. Never
 * the folder git happens to start in: under GIT_DIR that can be the
 * project's. A project outside any repository keeps its own stamp for
 * every push, as before.
 */
function stampDir(at, ctx) {
  const mine = repoOf(ctx.project);
  const repo = repoOf(at);
  if (mine === null || repo === mine) return ctx.projectDir;
  return basename(repo) === ".git" ? dirname(repo) : repo;
}

/** True for a git dir that is a repository's own, not a linked worktree's (.git/worktrees/<name>). */
const mainGitDir = (gitDir) => !/[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir);

/**
 * True when a command at `at` changes the owner's checkout (#216, #306):
 * the HEAD it moves is a main working tree's, not a linked worktree's, or
 * the work tree it writes is one -- a --work-tree or GIT_WORK_TREE aimed at
 * the owner's folder from the run's own git dir. A target git can't read
 * is not the owner's checkout -- false, so one odd -C target never aborts
 * the checks on the rest of the line.
 */
function ownerCheckout(at) {
  const gitDir = gitOut(at, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir === null) return false;
  if (mainGitDir(gitDir)) return true;
  const top = gitOut(at, ["rev-parse", "--show-toplevel"]);
  if (top === null) return false;
  const env = { ...process.env };
  for (const k of GIT_ENV) delete env[k];
  const own = gitOut({ dir: top, env }, ["rev-parse", "--absolute-git-dir"]);
  return own !== null && mainGitDir(own);
}

/**
 * Every manifest for this project whose status is `running`, as
 * { live: [{ runId, state }], unreadable }. "A run is live" is file state
 * in the per-machine cairn home, not an env var, so it survives the agent
 * boundaries an env var would not cross. `unreadable` names a runs folder
 * or manifest that exists but can't be read (#299) -- the guard can't say
 * no run is live, so the gates that ask refuse instead of skipping.
 */
function liveRuns(projectDir, baseDir) {
  const { base, hash } = pathHash(projectDir);
  const prefix = `${base}-${hash}-`;
  const dir = join(baseDir, "runs");
  const live = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // no runs dir -- this machine has never staged a batch run
    return { live, unreadable: e?.code === "ENOENT" ? null : `${dir} (${e?.code ?? e})` };
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const state = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (state?.status === "running") {
        live.push({ runId: state.runId ?? name.slice(prefix.length, -5), state });
      }
    } catch (e) {
      // a corrupt manifest is not evidence of a live run, nor is one
      // deleted since the listing -- but one that can't be read may be
      if (e instanceof SyntaxError || e?.code === "ENOENT") continue;
      return { live, unreadable: `${join(dir, name)} (${e?.code ?? e})` };
    }
  }
  return { live, unreadable: null };
}

/**
 * Why a running manifest doesn't authorize a push now, or null when it
 * does. Push authority is granted + scoped to "manifest-phases" at staging;
 * #260 adds the phase: run_manifest set_phase records `currentPhase` at
 * each phase start, and only a currentPhase that is one of the manifest's
 * phases carries the grant. No currentPhase (an older manifest, or a run
 * between phases) refuses. It can't prove the pushed commits belong to
 * that phase -- only that a phase the owner authorized is in flight.
 */
function pushRefusal(state) {
  const auth = state?.pushAuth;
  const phases = Array.isArray(state?.phases) ? state.phases : [];
  if (auth?.granted !== true || auth.scope !== "manifest-phases" || !phases.length) {
    return "without push authority for its phases — nothing pushes until the owner grants it at staging";
  }
  const current = state.currentPhase;
  if (typeof current !== "number") {
    return "without a phase marked in flight (run_manifest set_phase) — a push can't be tied to " +
      "a phase the owner authorized";
  }
  if (!phases.some((p) => p?.number === current)) {
    return `marking phase ${current} in flight, which is not one of its phases`;
  }
  return null;
}

/**
 * The long options in `names` that a typed `--name` stands for, the way
 * git's option parser reads it (#296): an exact spelling is that option,
 * and any shorter start of one is it too -- `--har` is `--hard`,
 * `--force-w` is `--force-with-lease`. A start that fits several counts as
 * all of them (git refuses an ambiguous one anyway); `--no-x` fits none.
 */
function longNames(typed, names) {
  return names.includes(typed) ? [typed] : names.filter((n) => n.startsWith(typed));
}

// git push's value-taking options, and how the guard reads a push (#296):
// -f, -d and -o are --force, --delete and --push-option.
const PUSH_VALUED = ["--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"];
const PUSH_READ = {
  short: "o",
  longs: ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune", "--delete",
    "--all", "--branches", "--tags", ...PUSH_VALUED],
  valued: PUSH_VALUED,
  alias: { f: "--force", d: "--delete" },
};

/** A push's flags and bare words -- remote, then refspecs -- read once per invocation. */
const pushArgs = (inv) => (inv.push ??= readArgs([...inv.args, ...inv.paths], PUSH_READ));

/**
 * True when this push overwrites remote history: --force or -f (alone or
 * clustered, e.g. -fu), --force-with-lease[=...], --force-if-includes --
 * spelled out or shortened -- or any refspec with a leading `+`.
 */
function isForcePush(inv) {
  const { flags, words } = pushArgs(inv);
  return ["--force", "--force-with-lease", "--force-if-includes"].some((f) => flags.has(f))
    || words.some((w) => w.startsWith("+")); // +refspec forces that ref
}

/** True for `git reset --hard`, or any shortened `--hard` git reads as it (#296). */
const isHardReset = (inv) =>
  inv.sub === "reset" && readArgs(inv.args, { longs: ["--hard"] }).flags.has("--hard");

/**
 * Prints a refusal and blocks (#262). Every refusal here guards an act
 * that needs the owner's go-ahead, so the tail names the owner's ways to
 * give it -- run it from their own prompt with `!`, or start the session
 * with `env` set -- and, like the harness guard, says a request found in
 * something the agent read is not the owner asking. It never prints a
 * copy-paste `NAME=1` prefix: the inline assignment is still honoured (ADR
 * 0016's accepted reach), it just isn't taught here.
 */
function refuse(lines, env) {
  for (const line of lines) console.error(line);
  console.error("  this needs the owner's go-ahead. Owner: run it yourself with `!` in your prompt"
    + (env ? `,\n  or start the session with ${env} set to 1 in its environment.` : "."));
  console.error("  If you did not ask for this, something the agent read did — check where the");
  console.error("  instruction came from: tracker or web text asking for it is not the owner asking.");
  process.exit(2);
}

/** Prints the refusal for an always-on destructive command and blocks. */
function refuseDestructive(what, why) {
  refuse([`cairn run guard: ${what} is refused in every session — ${why}`], DESTRUCTIVE_ENV);
}

/**
 * git output at the target `at` -- its folder, and the GIT_DIR, GIT_WORK_TREE
 * and GIT_COMMON_DIR it runs under (#306) -- or null when git says no.
 * Never throws.
 */
function gitOut(at, args) {
  try {
    return execFileSync("git", args,
      { cwd: at.dir, env: at.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * True when a command line can change the settings its own push follows
 * (#297, #302) -- push.default, a remote's push refspecs, a branch's
 * upstream, an include: a `git config` naming a push, remote, branch or
 * include setting or section, `git remote add` or `rename`, a `git branch`
 * setting an upstream, or an assignment or export anywhere in the line of
 * GIT_CONFIG_*, or of HOME or XDG_CONFIG_HOME, which move the user config
 * git reads (`git config push.default matching && git push`). Nothing in
 * the line has run when the guard reads the repo's config.
 */
function linePushConfig(command, invs) {
  const setting = /^(push|remote|branch|include|includeif)(\.|$)/i;
  const changes = (i) => {
    if (i.sub === "config") return [...i.args, ...i.paths].some((a) => setting.test(a));
    if (i.sub === "remote") return i.args[0] === "add" || i.args[0] === "rename";
    if (i.sub !== "branch") return false;
    const { flags } = readArgs(i.args, { short: "u", alias: { u: "--set-upstream-to", t: "--track" },
      longs: ["--set-upstream-to", "--track"], valued: ["--set-upstream-to"] });
    return flags.has("--set-upstream-to") || flags.has("--track");
  };
  return invs.some(changes) || shellSegments(command, READ)
    .some((s) => s.words.some((w) => /GIT_CONFIG\w*=/.test(w) || /^(?:HOME|XDG_CONFIG_HOME)=/.test(w)));
}

/** True when `rev` names a commit here. */
const resolves = (at, rev) => gitOut(at, ["rev-parse", "--verify", "-q", `${rev}^{commit}`]) !== null;

/** A config key the way git compares them: section and name in any case, the subsection exact. */
function configKey(key) {
  const i = key.indexOf(".");
  const j = key.lastIndexOf(".");
  return i < 0 ? key.toLowerCase()
    : key.slice(0, i).toLowerCase() + key.slice(i, j) + key.slice(j).toLowerCase();
}

/**
 * This command's own config as [key, value] pairs (#302): each `-c` (a bare
 * `-c x.y` is true), then each --config-env, whose value sits in an
 * environment variable the guard can't see -- undefined.
 */
function ownConfig(inv) {
  const pairs = inv.configs.map((c) => {
    const eq = c.indexOf("=");
    return eq < 0 ? [configKey(c), "true"] : [configKey(c.slice(0, eq)), c.slice(eq + 1)];
  });
  for (const c of inv.configEnvs) {
    const eq = c.lastIndexOf("=");
    pairs.push([configKey(eq < 0 ? c : c.slice(0, eq)), undefined]);
  }
  return pairs;
}

// The settings that decide where a push lands, and to which remote (#297, #302).
const PUSH_SETTING = /^(push\.default|remote\.pushdefault|remote\..+\.push|branch\..+\.(merge|remote|pushremote))$/;

/**
 * True when the guard can't read the settings a push follows (#297, #302):
 * the line changes them before it pushes (see linePushConfig), the command
 * pulls in an include (`-c include.path=F` can set anything), or a
 * --config-env sets one from an environment variable the guard can't see.
 * The guard never hands a command's own `-c` values to git -- they are
 * read here, so nothing the agent typed runs before the guard says yes.
 */
function configUnknown(inv) {
  return inv.lineConfig || ownConfig(inv).some(([k, v]) =>
    /^include(if)?\./.test(k) || (v === undefined && PUSH_SETTING.test(k)));
}

/**
 * Every value a push's git sees for `key` (#302): the repo's config, its
 * includes followed, then this command's own `-c` ones after them -- the
 * last wins for a single-valued key. Ask configUnknown first.
 */
function configValues(inv, at, key) {
  const want = configKey(key);
  const repo = gitOut(at, ["config", "--get-all", key]);
  return [...(repo ? repo.split("\n") : []),
    ...ownConfig(inv).filter(([k]) => k === want).map(([, v]) => v)];
}

/**
 * The push refspecs configured for `remote` (#302): git pushes these
 * instead when a push names no refspec, and sends a branch typed on its own
 * where they map it. Ask configUnknown first.
 */
function remotePushSpecs(inv, at, remote) {
  const out = [];
  const keep = (key, value) => {
    const m = /^remote\.(.+)\.push$/.exec(key);
    if (m && value !== undefined && m[1] === remote) out.push(value);
  };
  for (const line of (gitOut(at, ["config", "--get-regexp", "^remote\\..*\\.push$"]) ?? "").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) keep(line.slice(0, sp), line.slice(sp + 1));
  }
  for (const [k, v] of ownConfig(inv)) keep(k, v);
  return out;
}

/** The last value a push's git sees for `key`, or null when it is unset (#302). */
function configValue(inv, at, key) {
  const set = configValues(inv, at, key);
  return set.length ? set[set.length - 1] : null;
}

/** push.default as this push's git reads it, lowercased -- `simple` when unset (#302). */
function pushMode(inv, at) {
  return (configValue(inv, at, "push.default") ?? "simple").trim().toLowerCase();
}

/** The value of the last `--repo` a push gives, shortened as git allows, or undefined (#302). */
function repoOption(inv) {
  let repo;
  for (let k = 0; k < inv.args.length; k++) {
    const a = inv.args[k];
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!name.startsWith("--") || !longNames(name, PUSH_READ.longs).includes("--repo")) continue;
    repo = eq < 0 ? inv.args[++k] : a.slice(eq + 1);
  }
  return repo;
}

/**
 * The remote a push goes to (#302): the one it names, else its --repo, else
 * the one git picks for a bare push from `current` -- the branch's
 * pushRemote, remote.pushDefault, the branch's remote, then origin. Settings
 * the guard can't read leave origin, the same guess the default-branch
 * names start from; the callers that need more ask configUnknown first.
 */
function pushRemote(inv, at, positional, current) {
  const named = positional[0] ?? repoOption(inv);
  if (named !== undefined) return named;
  if (configUnknown(inv)) return "origin";
  const keys = current ? [`branch.${current}.pushRemote`, "remote.pushDefault", `branch.${current}.remote`]
    : ["remote.pushDefault"];
  for (const key of keys) {
    const v = configValue(inv, at, key);
    if (v) return v;
  }
  return "origin";
}

/**
 * The branch a push destination lands on, the way git reads one (#302):
 * `refs/heads/x` and the short `heads/x` are branch x -- git matches a short
 * name against the remote's refs/heads/... -- and a bare name is the branch
 * of that name. `HEAD` counts as the current branch, generously: git lands
 * `x:HEAD` on a branch named HEAD.
 */
function branchNames(dst, current) {
  if (dst === "HEAD") return current ? [current] : [];
  const m = /^(?:refs\/)?heads\/(.+)$/.exec(dst);
  return [m ? m[1] : dst];
}

/**
 * The full local ref names a refspec's source can be (#302), the way git
 * finds the ref a push of it names: `main`, `heads/main` and
 * `refs/heads/main` alike, HEAD and `@` the current branch, and a symbolic
 * branch the one it points at -- git lands `git push origin alias` on main
 * when alias points there.
 */
function localRefs(src, at, current) {
  const refs = new Set();
  if (src === "HEAD" || src === "@") {
    if (current) refs.add(`refs/heads/${current}`);
  } else {
    refs.add(src.startsWith("refs/") ? src : `refs/heads/${src.replace(/^heads\//, "")}`);
  }
  // a configured refspec could start with `-`: never hand git one as an option
  const full = src.startsWith("-") ? null
    : gitOut(at, ["rev-parse", "--symbolic-full-name", src])?.split("\n")[0];
  if (full?.startsWith("refs/")) refs.add(full);
  return [...refs];
}

/**
 * Where a remote push refspec sends the local ref `full`, as branch names
 * (#302) -- an exact source or a glob, the way git maps a branch typed on
 * its own through `remote.<name>.push`. A spec with no destination keeps
 * the name, and so maps nowhere new.
 */
function mapThrough(full, spec) {
  const plain = spec.replace(/^\+/, "");
  const colon = plain.indexOf(":");
  if (colon < 0) return [];
  const [src, dst] = [plain.slice(0, colon), plain.slice(colon + 1)];
  const star = src.indexOf("*");
  if (star < 0) return src === full ? branchNames(dst, null) : [];
  const [pre, suf] = [src.slice(0, star), src.slice(star + 1)];
  if (full.length < pre.length + suf.length || !full.startsWith(pre) || !full.endsWith(suf)) return [];
  return branchNames(dst.replace("*", () => full.slice(pre.length, full.length - suf.length)), null);
}

/**
 * The local branches a glob refspec lands on the default ones (#297). git
 * maps the src pattern onto the dst pattern through their one `*`, so the
 * branch landing on refs/heads/<name> is the src with the dst's match put
 * back in -- `refs/heads/x*:refs/heads/mai*` lands branch `xn` on main.
 * The dst is tried against the full ref, the short heads/ name (#302) and
 * the bare name, and only a source that exists is one. git refuses a glob
 * on one side only.
 */
function globSources(src, dst, defaults, at) {
  if (!src.includes("*")) return [];
  const star = dst.indexOf("*");
  const [pre, suf] = [dst.slice(0, star), dst.slice(star + 1)];
  const found = [];
  for (const b of defaults) {
    for (const name of [`refs/heads/${b}`, `heads/${b}`, b]) {
      if (name.length < pre.length + suf.length || !name.startsWith(pre) || !name.endsWith(suf)) continue;
      const from = src.replace("*", () => name.slice(pre.length, name.length - suf.length));
      if (resolves(at, from)) found.push(from);
    }
  }
  return found;
}

// A source standing for "can't tell": the push follows settings the guard
// can't read, so what it lands is unknown (#302) -- see configUnknown.
const UNKNOWN = Symbol("unknown source");

// Why a gate can't see where a command acts (#306).
const WHERE_LOST = "a directory change or git setting on this line (cd, pushd, GIT_DIR, --git-dir, " +
  "--work-tree) goes somewhere the guard can't tell";

// Why a push with a commit or ref move ahead of it on its line can't be vouched for (#305).
const MOVED_BEFORE = "an earlier command on this line can make a commit or move a ref first, and the " +
  "guard checks what a push sends before the line runs";

/**
 * What `git push <args>` would land on the default branch, as the source
 * revs being pushed there (null for a deletion, UNKNOWN when the settings
 * that decide it can't be read). Empty when the push never touches the
 * default branch -- feature branches, tags, other refs. Read once per
 * target -- each invocation has its own (#306).
 */
const defaultBranchSources = (inv, at) => (at.sources ??= branchSources(inv, at));

/**
 * defaultBranchSources, worked out the way git resolves a push. A push of
 * every branch counts (#297): --all, --branches and --mirror, the `:`
 * matching refspec, a bare push under push.default=matching, and a glob
 * whose destination can name the default branch. So does every spelling
 * git lands there (#302): `heads/main` and `refs/heads/main` on either
 * side of the `:`, a symbolic branch pointing at main, a bare push or a
 * branch typed on its own that push.default=upstream (or tracking) sends to
 * its upstream, and a remote's own push refspecs (`remote.<name>.push`),
 * which a bare push pushes and a typed branch is mapped through.
 */
function branchSources(inv, at) {
  const { flags, words: positional } = pushArgs(inv);
  const all = flags.has("--all") || flags.has("--mirror") || flags.has("--branches");
  const del = flags.has("--delete");
  const tags = flags.has("--tags");

  // Default branch names: main, master, and the remote's HEAD when known
  const current = gitOut(at, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const remote = pushRemote(inv, at, positional, current);
  const defaults = new Set(DEFAULT_BRANCHES);
  if (/^[\w.-]+$/.test(remote)) {
    const head = gitOut(at, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]);
    if (head?.startsWith(`${remote}/`)) defaults.add(head.slice(remote.length + 1));
  }
  const lands = (names) => names.some((n) => defaults.has(n));

  // Every local default branch, as the full ref -- a tag spelled the same
  // can't stand in for the branch that actually lands
  const everyBranch = () => [...defaults].map((b) => `refs/heads/${b}`).filter((r) => resolves(at, r));

  // --all / --mirror push every local branch, the default one included
  if (all) return everyBranch();

  // What one refspec lands there. `typed`: it came from the command line,
  // so git may send a branch named on its own on through the settings
  const landing = (spec, typed) => {
    const plain = spec.replace(/^\+/, "");
    // `:` pushes every branch both sides have, the default one included
    if (plain === ":") return everyBranch();
    const colon = plain.indexOf(":");
    const src = colon < 0 ? plain : plain.slice(0, colon);
    const dst = colon < 0 ? plain : plain.slice(colon + 1);
    if (dst.includes("*")) return globSources(src, dst, defaults, at);
    let names;
    if (colon >= 0 || del) {
      names = branchNames(dst, current);
    } else {
      // a branch on its own lands under git's full name for it
      const refs = localRefs(src, at, current);
      names = refs.filter((r) => r.startsWith("refs/heads/")).map((r) => r.slice(11));
      // ...unless the settings send it elsewhere -- git maps a ref it finds
      // by name, never HEAD
      if (typed && src !== "HEAD" && src !== "@") {
        if (configUnknown(inv)) return [UNKNOWN];
        const specs = remotePushSpecs(inv, at, remote);
        const upstream = /^(upstream|tracking)$/.test(pushMode(inv, at));
        for (const r of refs) {
          for (const s of specs) names.push(...mapThrough(r, s));
          if (!upstream || !r.startsWith("refs/heads/")) continue;
          for (const m of configValues(inv, at, `branch.${r.slice(11)}.merge`)) {
            names.push(...branchNames(m, null));
          }
        }
      }
    }
    if (!lands(names)) return [];
    return [del || src === "" ? null : src];
  };

  const refspecs = positional.slice(1);
  if (refspecs.length) return refspecs.flatMap((s) => landing(s, true));

  // bare `git push` / `git push origin`: nothing but tags under --tags
  if (tags) return [];
  if (configUnknown(inv)) return [UNKNOWN];
  // a remote's own push refspecs are what git pushes, when it has any
  const configured = remotePushSpecs(inv, at, remote);
  if (configured.length) return configured.flatMap((s) => landing(s, false));
  // otherwise push.default: every matching branch; the current branch to
  // its upstream (tracking is upstream's old name); or to itself
  const mode = pushMode(inv, at);
  if (mode === "matching") return everyBranch();
  if (mode === "nothing" || !current) return [];
  const to = mode === "upstream" || mode === "tracking"
    ? configValues(inv, at, `branch.${current}.merge`).flatMap((m) => branchNames(m, null)) : [current];
  return lands(to) ? ["HEAD"] : [];
}

/**
 * A git subcommand's args split into the flags it sets and its bare words,
 * skipping the values valued flags swallow: `-b name`, `--source x`, and a
 * short cluster's tail after a valued letter (`-sHEAD`). `--x=v` keeps `--x`.
 * A typed long option counts as each of `longs` it spells or shortens
 * (#296), and takes the next word when one of them is `valued`; `alias`
 * files a short letter under its long name (`f` is `--force`). `flags` is
 * every flag ever set, for the ones that refuse; `on` is each one's state
 * after any `--no-` negation, for the ones that make a command safe --
 * `git clean -n --no-dry-run` deletes.
 */
function readArgs(args, { short = "", longs = [], valued = [], alias = {} } = {}) {
  const flags = new Set();
  const on = new Map();
  const words = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const hit = longNames(name, longs);
      for (const n of hit) { flags.add(n); on.set(n, true); }
      if (eq < 0 && hit.some((n) => valued.includes(n))) k++;
      if (!hit.length && name.startsWith("--no-")) {
        for (const n of longNames(`--${name.slice(5)}`, longs)) on.set(n, false);
      }
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let c = 1; c < a.length; c++) {
        const f = alias[a[c]] ?? `-${a[c]}`;
        flags.add(f);
        on.set(f, true);
        if (short.includes(a[c])) {
          if (c === a.length - 1) k++; // value is the next word
          break; // ...or the rest of this one
        }
      }
      continue;
    }
    words.push(a);
  }
  return { flags, on, words };
}

/**
 * True for a pathspec that names the whole tree rather than a file in it:
 * `.`, `./`, `..`, `../..`, `:/`, `:/.`, `:(top)`, and a bare glob (`*`,
 * `**`, `./*` -- a pathspec `*` crosses `/`). A single path -- `src/a.ts`,
 * `.gitignore`, `:/src`, `*.ts` -- is not.
 */
function wholeTree(p) {
  return p !== "" && /^(?::\/|:\(top\))?(?:\.{1,2}(?:\/\.{1,2})*)?\/?\**$/.test(p);
}

/**
 * True when a checkout/restore's pathspec names the whole tree -- or comes
 * from --pathspec-from-file, which the guard can't see into.
 */
function wholeTreeSpec(flags, words, paths) {
  return flags.has("--pathspec-from-file") || [...words, ...paths].some(wholeTree);
}

/** True for a git config value that reads as true (`true`, `yes`, `on`, `1`, bare). */
const truthy = (v) => !/^(false|no|off|0)$/i.test(String(v).trim());

/**
 * True when this push mirrors -- `--mirror`, `-c remote.<r>.mirror=true`,
 * or a remote configured to mirror already (`git remote add --mirror=push`,
 * `git config remote.<r>.mirror true`), which turns a plain `git push <r>`
 * into one that force-updates and deletes every remote ref.
 */
function isMirrorPush(inv, flags, words, at) {
  if (flags.has("--mirror")) return true;
  const key = /^remote\.(.+)\.mirror(?:=(.*))?$/i;
  if (inv.configs.some((c) => { const m = key.exec(c); return m && truthy(m[2] ?? "true"); })) {
    return true;
  }
  const set = gitOut(at, ["config", "--get-regexp", "^remote\\..*\\.mirror$"]);
  if (!set) return false;
  const remote = words[0];
  return set.split("\n").some((line) => {
    const m = /^remote\.(.+)\.mirror\s*(.*)$/i.exec(line.trim());
    return m && truthy(m[2] || "true") && (remote === undefined || remote === m[1]);
  });
}

/**
 * The always-on table (#249, #250, #264): why `inv` throws work away with
 * no undo, as [what, why] -- or null. Every row is refused in every session
 * behind the one CAIRN_ALLOW_DESTRUCTIVE_GIT escape. The everyday
 * neighbours stay allowed because they are routine or recoverable: a
 * single-path checkout/restore, `stash drop`, `branch -D`, `restore
 * --staged .` (the index only, like a plain `git reset`), deleting a
 * feature branch, and `clean -n`.
 */
function destructive(inv, at) {
  const { sub, args, paths } = inv;
  const discards = "it discards uncommitted work with no undo.";
  switch (sub) {
    case "reset":
      return isHardReset(inv) ? ["`git reset --hard`", discards] : null;

    case "checkout": {
      const { flags, words } = readArgs(args, { short: "bB", alias: { f: "--force" },
        longs: ["--force", "--orphan", "--conflict", "--pathspec-from-file"],
        valued: ["--orphan", "--conflict", "--pathspec-from-file"] });
      if (flags.has("--force")) return ["`git checkout --force`", discards];
      return wholeTreeSpec(flags, words, paths) ? ["a whole-tree `git checkout`", discards] : null;
    }

    case "switch": {
      const { flags } = readArgs(args, { short: "cC", alias: { f: "--force" },
        longs: ["--discard-changes", "--force", "--create", "--force-create", "--orphan", "--conflict"],
        valued: ["--create", "--force-create", "--orphan", "--conflict"] });
      return flags.has("--discard-changes") || flags.has("--force")
        ? ["`git switch --discard-changes`", discards] : null;
    }

    case "restore": {
      const { flags, on, words } = readArgs(args, { short: "s",
        alias: { s: "--source", S: "--staged", W: "--worktree" },
        longs: ["--source", "--staged", "--worktree", "--pathspec-from-file", "--conflict"],
        valued: ["--source", "--pathspec-from-file", "--conflict"] });
      // the work tree is restored unless only --staged is asked for, and
      // --no-staged takes that back
      const worktree = flags.has("--worktree") || on.get("--staged") !== true;
      return worktree && wholeTreeSpec(flags, words, paths)
        ? ["a whole-tree `git restore`", discards] : null;
    }

    case "clean": {
      // Every clean but a dry run: plain `git clean` only refuses on its own
      // while clean.requireForce holds, and `-c clean.requireForce=false`
      // or a repo config turns that off -- so the -f isn't what to look for.
      // A dry run counts once it's the last word on it: -n --no-dry-run deletes
      const { on } = readArgs(args, { short: "e", alias: { n: "--dry-run" },
        longs: ["--dry-run", "--exclude"], valued: ["--exclude"] });
      return on.get("--dry-run") === true ? null
        : ["`git clean`", "it deletes untracked files, which git never had a copy of."];
    }

    case "stash":
      return args[0] === "clear" ? ["`git stash clear`", "it drops every stash at once."] : null;

    case "reflog":
      return args[0] === "expire"
        ? ["`git reflog expire`", "it erases the record git recovers lost commits from."] : null;

    case "push": {
      // Past a bare `--` a push's words are still refspecs, not paths (pushArgs)
      if (isForcePush(inv)) {
        return ["`git push --force`",
          "it overwrites remote history other people may already have pulled."];
      }
      const { flags, words } = pushArgs(inv);
      if (isMirrorPush(inv, flags, words, at)) {
        return ["`git push --mirror`", "it force-updates and deletes remote refs to match this clone."];
      }
      if (flags.has("--prune")) {
        return ["`git push --prune`", "it deletes every remote branch this clone doesn't have."];
      }
      return defaultBranchSources(inv, at).includes(null)
        ? ["a push deleting the default branch", "everyone's shared history hangs off it."] : null;
    }
  }
  return null;
}

/**
 * Why this push may not land on the default branch yet, as [why, what to
 * do instead?, how sure the guard is?] -- or null when the ship gate is
 * satisfied or doesn't apply (#251). The stamp is plan_drift's record of
 * its last run: { head, clean, at }. A missing stamp is a refusal, and so
 * is one that exists but can't be read (#299): a gate that can't see its
 * stamp refuses, never skips. So is a push whose settings can't be read
 * (#302) -- the guard can't say what it lands, so no stamp covers it --
 * and one with a commit or a ref move ahead of it on the line (#305): the
 * commit the guard checks now is not the one the push will send. Everything
 * is read at the target the push leaves from (#306), and the stamp is the
 * one stampDir names for that repository.
 */
function shipGateRefusal(inv, at, ctx) {
  try {
    if (repoOf(at) === null) return null; // no repository there -- git refuses the push itself
    const sources = defaultBranchSources(inv, at);
    if (!sources.length) return null;
    if (sources.includes(UNKNOWN)) {
      return ["git's push settings decide where, and the guard can't read them first -- the line " +
        "changes them before it pushes, or takes them from --config-env or an include",
      "  run the config change as a command of its own, then push -- or run /cairn:ship.",
      "this push may land on the default branch"];
    }
    if (inv.movedBefore) return [MOVED_BEFORE, "  push as its own step, once the drift check has seen " +
      "the commit -- or run /cairn:ship."];

    const from = stampDir(at, ctx);
    const { base, hash } = pathHash(from);
    const path = join(ctx.baseDir, "ship-gate", `${base}-${hash}.json`);
    let stamp;
    try {
      stamp = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") {
        return [from === ctx.projectDir ? "no drift check has been recorded for this project"
          : `it leaves from ${from}, another repository, and no drift check has been recorded there`];
      }
      if (e instanceof SyntaxError) return ["the last drift check's record is unreadable"];
      return [`the last drift check's record can't be read (${e?.code ?? e})`,
        `  the owner should restore read access to ${path} -- the gate won't skip a check it can't see.`];
    }
    if (stamp?.clean !== true) return ["the last drift check flagged drift that ship stops on"];

    for (const src of sources) {
      if (src === null) return ["it deletes the default branch"];
      const sha = gitOut(at, ["rev-parse", "--verify", "-q", `${src}^{commit}`]);
      if (sha === null) return null; // git can't resolve it -- the push will fail on its own
      if (sha !== stamp.head) {
        return [`the last drift check was for ${String(stamp.head).slice(0, 7)}, ` +
          `not the commit being pushed (${sha.slice(0, 7)})`];
      }
    }
    return null;
  } catch {
    return null; // fail open for this check only -- the rest of the line still gets checked
  }
}

/**
 * The command lines a tool call runs, as { lines, dir, concurrent } (#310):
 * the Bash tool's command, or -- for any other tool, an MCP server's shell
 * tool -- what toolCommandLines reads from its input, the one MCP-field
 * reader both guards share (#311). `dir` is the folder the tool names for
 * them, if it names one; `concurrent`, a batch that runs them at once.
 */
function toolLines(payload) {
  const input = payload?.tool_input;
  if (payload?.tool_name === "Bash") return { lines: [String(input?.command ?? "")], concurrent: false };
  return toolCommandLines(input);
}

/**
 * Judges one command line (a readLine result) that starts in the folder
 * `start`, and exits 2 on the first refusal: every git invocation in it,
 * at every place it may act (#306), against each rule in turn. `ctx`
 * carries the project, the cairn home, the run list, whether any line of
 * the tool call changes the push settings, `priorMoves` -- another line
 * of the same tool call, run before this one or alongside it, can make a
 * commit or move a ref (#305, #310) -- and `where`, the folder moves and
 * GIT_ENV settings of every line in the call, since a tool may run them
 * all in one shell.
 */
function judgeLine(line, start, ctx) {
  const { currentRuns, where } = ctx;
  // #321 -- a line nested past what the reader reads holds commands the
  // guard never saw; fail closed rather than let the unread part run
  if (line.deep) {
    refuse([
      `cairn run guard: this line nests substitutions deeper than the guard reads (${SUBSTITUTION_DEPTH} ` +
      "levels), so what runs inside them can't be judged.",
      "  flatten the line -- run the inner commands as steps of their own -- and the guard can judge it.",
    ]);
  }
  // #306 -- where each git command may run: every folder the line can cd
  // to, and every GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR it can set
  const places = line.invs.length ? linePlaces(where, start) : [];
  const lineEnv = Object.fromEntries(GIT_ENV.map((k) => [k, [process.env[k], ...where.envSets[k]]]));
  for (const inv of line.invs) {
    inv.lineConfig = ctx.lineConfig;
    // #305 -- something before it on the line can make a commit or move a
    // ref; in a line whose order can't be trusted, anywhere but itself
    inv.movedBefore = ctx.priorMoves
      || line.steps.some((moves, k) => moves && (k < inv.step || (line.unordered && k !== inv.step)));
    // Overrides only count as the leading assignment of THIS command, so a
    // quoted mention elsewhere can't bypass the guard
    const prefixed = (name) => inv.assigns.includes(`${name}=1`);
    const hardReset = isHardReset(inv);
    const targets = invTargets(inv, places, lineEnv);
    const known = targets.filter((t) => t !== LOST);
    const lost = known.length < targets.length;

    // #249, #250, #264 -- the work-destroying table, every session. Most
    // rows don't depend on where; a push's mirror and deletion rows are
    // read at every target the guard can see.
    if (!ctx.allowDestructive && !prefixed(DESTRUCTIVE_ENV)) {
      for (const at of known.length ? known : [{ dir: ctx.cwd }]) {
        const hit = destructive(inv, at);
        if (hit) refuseDestructive(...hit);
      }
    }

    // #251 -- the default branch only takes what a clean drift check saw,
    // judged at every repository the push may leave from (#306)
    if (inv.sub === "push" && process.env[UNSHIPPED_ENV] !== "1" && !prefixed(UNSHIPPED_ENV)) {
      if (lost) {
        refuse([
          `cairn run guard: ${WHERE_LOST}, so it can't tell which repository this push leaves from ` +
          "or what it lands.",
          "  name the folder plainly (cd <path>, git -C <path>) and the guard can judge it -- or run /cairn:ship.",
        ], UNSHIPPED_ENV);
      }
      for (const at of known) {
        const why = shipGateRefusal(inv, at, ctx);
        if (why) {
          refuse([
            `cairn run guard: ${why[2] ?? "this push lands on the default branch"}, but ${why[0]}.`,
            why[1] ?? "  run /cairn:ship instead -- it runs the drift check first, then pushes.",
          ], UNSHIPPED_ENV);
        }
      }
    }

    // #252, #260 -- mid-run, a push needs the authority granted at the
    // staging gate and a manifest phase in flight. From ANY worktree --
    // the run's own is exactly where it pushes.
    if (inv.sub === "push") {
      const { live, unreadable } = currentRuns();
      // #299 -- a run list that can't be read can't vouch that no run is live
      if (unreadable) {
        refuse([
          `cairn run guard: can't read the batch-run list at ${unreadable}, so this push ` +
          "can't be checked against a live run's push authority.",
          "  the owner should restore read access to it; nothing pushes until the guard can read it.",
        ]);
      }
      for (const run of live) {
        const why = pushRefusal(run.state);
        if (!why) continue;
        console.error(`cairn run guard: a batch run (${run.runId}) is in flight ${why}.`);
        console.error("  the phase ends verified-not-pushed; push it yourself from your own");
        console.error("  terminal once the run is done.");
        process.exit(2);
      }
      // #305 -- authority covers a push the guard can see, not one a
      // commit earlier on the line changes after the guard has looked
      if (live.length && inv.movedBefore) {
        refuse([
          `cairn run guard: a batch run (${live[0].runId}) is in flight, and ${MOVED_BEFORE}.`,
          "  push as its own step, so what it sends is what was checked.",
        ]);
      }
      continue;
    }

    // #216 -- tree-rewriting commands aimed at the owner's checkout mid-run
    if (!hardReset && inv.sub !== "checkout" && inv.sub !== "switch") continue;
    if (prefixed("CAIRN_RUN_OK")) continue;
    const { live, unreadable } = currentRuns();
    if (!live.length && !unreadable) continue; // no unattended run in flight -- ordinary work
    // #306 -- every place it may act; only the run's own worktree is left alone
    const owner = known.some(ownerCheckout);
    if (!lost && !owner) continue;

    const name = hardReset ? "git reset --hard" : `git ${inv.sub}`;
    if (unreadable) {
      refuse([
        `cairn run guard: can't read the batch-run list at ${unreadable}, so this \`${name}\` of ` +
        "the checkout you work in can't be checked against a live run.",
        "  the owner should restore read access to it, or run the command inside a run's own worktree.",
      ]);
    }
    if (!owner) {
      refuse([
        `cairn run guard: a batch run (${live[0].runId}) is in flight, and ${WHERE_LOST}, so this ` +
        `\`${name}\` may target the checkout you work in.`,
        "  name the folder plainly (cd <path>, git -C <path>), or run the command inside the run's own worktree.",
      ]);
    }
    refuse([
      `cairn run guard: a batch run (${live[0].runId}) is in flight, and this \`${name}\` targets ` +
      "the checkout you work in — it would change your files underneath you.",
      "  run the command inside the run's own worktree, or wait for the run to finish.",
    ]);
  }
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = toolLines(payload);
  if (!tool.lines.length) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const baseDir = process.env.CAIRN_HOME || join(homedir(), ".cairn");
  const cwd = resolve(payload?.cwd || projectDir);
  const allowDestructive = process.env[DESTRUCTIVE_ENV] === "1";

  // Read the run manifests at most once, and only if a command needs them
  let runs;
  const currentRuns = () => (runs ??= liveRuns(projectDir, baseDir));

  // #310 -- a tool call can carry several lines, run in order or at once:
  // a commit in one moves what a later push sends, and so do the push
  // settings any of them changes
  const lines = tool.lines.map((command) => ({ command, ...readLine(command) }));
  const moves = lines.map((l) => l.steps.some(Boolean));
  const start = tool.dir == null ? cwd : pathWord(tool.dir, cwd);
  const where = lines.length === 1 ? lines[0] : {
    moves: lines.flatMap((l) => l.moves),
    repeats: lines.some((l) => l.repeats),
    cdpaths: lines.flatMap((l) => l.cdpaths),
    envSets: Object.fromEntries(GIT_ENV.map((k) => [k, lines.flatMap((l) => l.envSets[k])])),
  };
  const ctx = {
    projectDir, baseDir, cwd, project: { dir: projectDir }, allowDestructive, currentRuns, where,
    lineConfig: lines.some((l) => linePushConfig(l.command, l.invs)),
  };
  lines.forEach((line, n) => {
    ctx.priorMoves = moves.some((m, k) => m && (tool.concurrent ? k !== n : k < n));
    judgeLine(line, start, ctx);
  });
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
