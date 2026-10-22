#!/usr/bin/env node

/**
 * Purpose: PreToolUse harness guard (#208) -- refuses agent writes to the
 *   files that define the agent's own harness: the hook directory, the MCP
 *   server configs (.mcp.json, ~/.claude.json, Cursor's project and home
 *   mcp.json, #298), the settings cascade, the plugin manifest, .claude/hooks
 *   and agents (and Cursor's hooks, #269), the skill, agent and command
 *   folders in .claude and ~/.claude (#309), ~/.claude/hooks and every
 *   script those settings run as a hook or the status line, wherever it
 *   lives (#312: read fresh from the settings and hooks.json files each
 *   run, so replacing ~/.config/x/statusline is refused like adding a
 *   hook is), every script a protected MCP config launches from outside
 *   the project (#314: the stdio servers in ~/.claude.json, its projects,
 *   .mcp.json and Cursor's mcp.json, read the same way; one inside the
 *   project -- cairn's own server/dist build -- stays writable, so a build
 *   still can), every folder such a config runs a server from (#316: uv's
 *   --directory, a server's cwd, the folder `node DIR` runs by its
 *   index.js -- that folder, never its parents -- and a bare word naming a
 *   file in it, `uv --directory DIR run weather.py`), the plugin copy that runs (#267:
 *   its root outside the project, ~/.claude/plugins), and the ship-gate
 *   stamp and run manifests the run guard trusts (#263: under CAIRN_HOME
 *   and ~/.cairn; the run report stays writable, the server's writes never
 *   pass a hook), and the refusal log the circuit breaker counts (#358,
 *   same homes). Letter case never counts (#295): a path is read in its
 *   on-disk case and compared case-folded, and so is a command's name, so a
 *   Mac's volume can't hide either -- a real HOOKS/ on a case-sensitive
 *   volume is refused too. An agent that can rewrite its own hooks can
 *   switch off every other control in one edit; this is the backstop. Exit
 *   2 blocks; ANY internal error exits 0. Residual (#263): run_manifest
 *   set_status running->stopped is legal and lifts the mid-run push block.
 *
 *   Threat model: the realistic attack is INDIRECT -- text the agent reads
 *   (an issue, a review, a fetched page) steering it into a harness edit.
 *   This turns a silent success into a refusal the human sees. NOT a
 *   sandbox: CAIRN_HARNESS_EDIT=1 is the owner's escape (inline, it exempts
 *   only its own command, #265), never taught by a refusal (#286). What
 *   each tool is read for, and what it can't see, is under Coverage below.
 *
 *   Breaker (#358): each refusal is handed to breaker.mjs, which appends
 *   its audit row (a digest of the input, never the path) and, while a
 *   batch run is live, counts it toward freezing the run -- a run that
 *   keeps reaching for its own hooks is a run whose plan went wrong.
 *
 * removeWhen: the platform isolates agent config at the OS level in every
 *   session and harness, so the agent process cannot write its own hooks or
 *   settings (ADR 0016). Half met (SURVEY.md 2026-10-13, native-vs-cairn-subsystem-judgement):
 *   Claude Code's sandbox now blocks those writes for sandboxed Bash only.
 *   Still open: auto mode's steerable classifier (default since 2.1.284),
 *   non-sandboxed sessions, Edit/Write/MCP outside the sandbox, the seven
 *   other harnesses.
 * derives: axiom 5 (owner-ground); axiom 3 (data-not-directive)
 * Author(s): John Reed
 *
 * Coverage: hooks/hooks.json sends this guard Edit, Write, NotebookEdit,
 *   Bash and every MCP tool (mcp__*, #310).
 *
 *   Edit, Write, NotebookEdit: the file they name.
 *
 *   Bash: read as a shell reads it (shell-words.mjs, #270) for what it
 *   WRITES -- redirects and the operands of commands that change files,
 *   through wrappers and program runners (xcrun, script, flock, #307;
 *   strace, runuser, #311), bash -c, su -c, find -exec, xargs and a heredoc
 *   fed to a shell. Any other heredoc body is data, but the $(...) or
 *   backtick an unquoted body (`<<EOF`) runs is read as a line of its own
 *   (#322); a quoted delimiter (`<<'EOF'`) keeps the body literal. A
 *   program runner the table doesn't name is backed up by
 *   runnerCommands (#311): the write its later words form -- `op run -- rm
 *   -rf hooks`, `bundle exec`, a `-c` string, `tmux new-session -d '...'` --
 *   is read too, and `npm`/`pnpm`/`yarn exec` the same, so the table needn't
 *   grow one runner at a time. A command that only reads its arguments
 *   (echo, grep, cat ...) runs none of them, but the one option that runs a
 *   program is read as a command line (#315: man -P, rg --pre, gh alias set
 *   --shell, a gh extension ...), and so is a pager variable set on the
 *   line (PAGER=, MANPAGER=, GIT_PAGER= ...). A
 *   relative path is judged from every folder a cd, env -C or git -C on the
 *   line can reach (#258); after a cd it can't follow, refused. A git -C or
 *   tar -C value is read like a cd target (#318): ~, $HOME and $PWD spelled
 *   out, a variable it can't read refused the same way. A write target a
 *   substitution computes the folder of is judged there when the guard
 *   knows the folder -- `$(pwd)/x` is the shell's, from every folder a cd
 *   before it can reach, `$(git rev-parse --show-toplevel)/x` the repo
 *   root above each of those (#321) -- and refused otherwise.
 *   Substitutions nest SUBSTITUTION_DEPTH levels deep; a line nested
 *   deeper is refused unread (#321). A command
 *   that plants a whole tree is judged by where it lands, like a mkdir of
 *   it (#317): git clone, worktree add, submodule add and init, gh repo
 *   clone and fork --clone, npx degit, and the create-* initializers npm,
 *   pnpm, yarn, bun and npx run -- the repo's own name, here, when no
 *   folder is given, so a clone into .claude/skills plants a skill, or a
 *   plugin with hooks of its own, and is refused. Removing a
 *   protected folder or one holding it counts, and so does changing its
 *   mode, owner, flags or ACL (chmod, chown, chflags, setfacl, xattr -w,
 *   #299), or claude writing its config itself: `claude mcp add` (#303),
 *   `claude plugin install|enable|disable|init`, `claude import`, and the
 *   same run by npx or node (#308). A path only READ passes (#240).
 *
 *   MCP tools (#310), known shapes only: a tool whose own name says it
 *   writes, edits, creates, deletes, moves, copies, saves or changes a mode
 *   (write_file, edit_block, move_file, create_directory, delete_file,
 *   take_screenshot ...) has its path fields judged -- path, paths,
 *   file_path, filePath, target, destination, dest, new_path, and source
 *   for a move -- as written, never globbed. A command line in any MCP
 *   tool's input is read like Bash, through the one field reader both guards
 *   share (toolCommandLines, #310, #311): command, cmd or shell_command (a
 *   string, an exec-style array, or a string with an args / arguments list),
 *   each entry of a commands list, a script unless a non-shell language is
 *   named, and code whose language is a shell (incl. a /bin/bash path), from
 *   the folder cwd / workdir / working_directory / workingDirectory names.
 *   Anything else passes: a read
 *   tool, a writing tool under another name or field, keystrokes into a
 *   running process, settings a server keeps.
 *
 *   Not seen: a write in an interpreter (python -c, an MCP tool running
 *   python or javascript), a write that only exists in a substitution's
 *   output (`$(cat script)` run as a command -- the body of a $(...), a
 *   <(...), >(...) or $((...)), and the literal target after any of them
 *   are read, #319, #320), an archive's members,
 *   paths an upstream command finds, modes cp -p, rsync or tar copy, the
 *   program a hook or an MCP server starts by name off PATH. An MCP server
 *   that runs arbitrary code is that same class: gate it with the
 *   harness's own permission rules (ask or deny on its tools), not this.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHELLS, SUBSTITUTION_DEPTH, braceExpand, pagerCommands, quoteWord, runnerCommands, shellCommandString,
  shellReadsStdin, shellSegments, suCommandString, toolCommandLines, tooDeep, unwrap,
} from "./shell-words.mjs";

// #358 -- the breaker loads on its own: a breaker.mjs that is missing or
// broken leaves this guard refusing exactly as before, never crashed
const BREAKER = await import("./breaker.mjs").catch(() => null);

// Constants

/**
 * Protected shapes, matched against a path relative to the project root
 * (POSIX separators), case-folded first (#295). Kept as one list so the
 * refusal line can name which rule fired and `audit security --surface`
 * has one place to read.
 */
const PROTECTED = [
  { re: /^hooks\//i, what: "the hook directory" },
  { re: /^\.mcp\.json$/i, what: "the MCP server config" },
  { re: /^(?:.*\/)?\.claude\/settings(?:\.[\w-]+)?\.json$/i, what: "a settings file" },
  { re: /^(?:.*\/)?\.claude-plugin\/[^/]+\.json$/i, what: "the plugin manifest" },
  { re: /^(?:.*\/)?\.claude\/hooks\//i, what: "the project's Claude hooks" },
  { re: /^(?:.*\/)?\.claude\/agents\//i, what: "the project's agent definitions" },
  { re: /^(?:.*\/)?\.claude\/skills\//i, what: "the project's skills" },
  { re: /^(?:.*\/)?\.claude\/commands\//i, what: "the project's slash commands" },
  { re: /^(?:.*\/)?\.cursor\/hooks(?:\.json$|\/)/i, what: "Cursor's hooks" },
  { re: /^(?:.*\/)?\.cursor\/mcp\.json$/i, what: "Cursor's MCP server config" },
];

// Folders whose whole contents are protected, as [parent, folder, what]
// (#267; Cursor's, #269; skills and slash commands, #309).
const SUB_TREES = [
  [".claude", "hooks", "the project's Claude hooks"],
  [".claude", "agents", "the project's agent definitions"],
  [".claude", "skills", "the project's skills"],
  [".claude", "commands", "the project's slash commands"],
  [".cursor", "hooks", "Cursor's hooks"],
];

// Folders whose whole contents are protected: a find started in one is a hit whatever it tests.
const TREES = new Set(["the hook directory", ...SUB_TREES.map(([, , what]) => what)]);

// Names a wildcard is tested against inside .claude/, .claude-plugin/ and .cursor/.
const SETTINGS_NAMES = ["settings.json", "settings.local.json"];
const MANIFEST_NAMES = ["plugin.json", "marketplace.json"];
const CURSOR_NAMES = ["hooks.json"];
const CURSOR_MCP = ["mcp.json"];

// Files in the home folder that set up every session, as [folder, names,
// what]: the machine-wide settings, and the MCP server configs Claude Code
// (~/.claude.json, "" being the home folder itself) and Cursor read (#298).
const HOME_FILES = [
  [".claude", SETTINGS_NAMES, "your machine-wide Claude settings"],
  ["", [".claude.json"], "your machine-wide MCP server config"],
  [".cursor", CURSOR_MCP, "your machine-wide Cursor MCP server config"],
];

// What a refusal calls a script the settings run (#312), one a protected
// MCP config launches (#314), and a folder such a config runs its server
// from (#316).
const SCRIPT_WHAT = "a script your settings run as a hook or status line";
const MCP_WHAT = "a script your MCP server config launches";
const MCP_DIR_WHAT = "a folder your MCP server config runs its server from";

// Options whose value is the folder a runner works in (#316): uv's
// --directory, npm's and pnpm's -C, bun's --cwd, as the next word or with
// `=`. The words after one resolve from it, and the server runs inside
// it. node's -C is --conditions, never a folder.
const FOLDER_OPTS = ["--directory", "--cwd", "-C"];

// The runtimes that run a folder by its entry file (#316): `node DIR` runs
// DIR/index.js or the main its package.json names, `python DIR` runs
// DIR/__main__.py. Their options whose value is the next word, so the
// first bare word after them is the one they run; and the ones that run
// their own value instead (-e, -p, -c, -m), after which a bare word is an
// argument.
const FOLDER_RUNNERS = /^(?:node|nodejs|python[\d.]*|pypy[\d.]*)$/;
const RUNNER_VALUE_OPTS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "--input-type", "--title", "--conditions", "-C", "--inspect-port", "--max-old-space-size",
  "--stack-size", "-W", "-X"]);
const RUNNER_INLINE_OPTS = new Set(["-e", "--eval", "-p", "--print", "-c", "-m"]);
const ENTRY_FILES = ["index.js", "index.mjs", "index.cjs", "package.json", "__main__.py"];

// A word that is a URL, never a file a hook runs.
const URL_WORD = /^[a-z][\w+.-]*:\/\//i;

// A package a runner fetches by name (`npx -y @scope/pkg`), never a file (#314).
const PACKAGE_WORD = /^@[\w.-]+\/[^/]+$/;

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
 * and heredocs are modelled, and ( ) end a command, so `(cd hooks && rm
 * x)` is a cd and an rm (#258). A $(...) or backtick is one word, quoted
 * or not, so the literal target after one is still seen (#319), and its
 * body is read as a command line of its own -- inside an unquoted
 * heredoc body too, whose text is otherwise data (#322). # comments are
 * word text.
 */
const READ = { redirects: true, subshells: true, substitutions: true };

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
const CHANGES = new Set(["tee", "truncate"]);
// Commands that change a path's mode, owner, flags or ACL: a folder
// holding a protected place counts, as it does for removal (#299). chmod
// 000 on the cairn home leaves the run guard reading nothing.
const PERMS = new Set(["chmod", "chown", "chgrp", "chflags", "chattr", "setfacl", "setfattr"]);

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

// The options of git's tree-creating subcommands that take a value (#317),
// so a destination is never mistaken for one: clone, worktree add,
// submodule add and init.
const GIT_CLONE = { short: "obujc", long: ["--template", "--origin", "--branch", "--upload-pack",
  "--reference", "--reference-if-able", "--separate-git-dir", "--depth", "--shallow-since",
  "--shallow-exclude", "--config", "--filter", "--jobs", "--server-option", "--bundle-uri"] };
const GIT_WORKTREE_ADD = { short: "bB", long: ["--reason"] };
const GIT_SUBMODULE_ADD = { short: "b", long: ["--branch", "--name", "--reference", "--depth"] };
const GIT_INIT = { short: "b", long: ["--template", "--separate-git-dir", "--object-format", "--ref-format",
  "--initial-branch"] };

// An initializer package a runner scaffolds a tree with (#317): create-x,
// @scope/create-x (its scope dropped by cmdName), create-x@latest.
const CREATE_PKG = /^create-[\w.-]*(?:@[^@]*)?$/;

// The runners whose `create <x>` / `init <x>` run an initializer, and
// whose bare `init` writes a package.json here (#317).
const INIT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

// The `claude mcp` subcommands that write a server config (#303); list,
// get, serve, login and logout leave every config as it is.
const CLAUDE_MCP_WRITES = ["add", "add-json", "add-from-claude-desktop", "remove", "reset-project-choices"];

// The `claude plugin` subcommands that change which plugins load (#308),
// aliases too: what each writes is in claudeTargets. list, details,
// validate, eval, tag, test and help change nothing.
const CLAUDE_PLUGIN_INSTALLS = ["install", "i", "uninstall", "remove", "update", "prune", "autoremove"];
const CLAUDE_PLUGIN_TOGGLES = ["enable", "disable"];
const CLAUDE_PLUGIN_INITS = ["init", "new"];
const CLAUDE_MARKET_WRITES = ["add", "remove", "rm", "update"];

// The words that name a claude subcommand; a help flag right after a run
// of only these is help, never a value some option swallowed (#308).
const CLAUDE_COMMAND_WORDS = ["mcp", "plugin", "plugins", "marketplace", "import", "configure",
  ...CLAUDE_MCP_WRITES, ...CLAUDE_PLUGIN_INSTALLS, ...CLAUDE_PLUGIN_TOGGLES, ...CLAUDE_PLUGIN_INITS,
  ...CLAUDE_MARKET_WRITES];

// The settings file each `--scope` writes.
const SCOPE_SETTINGS = { user: "~/.claude/settings.json", project: ".claude/settings.json",
  local: ".claude/settings.local.json" };

// Programs that launch another package's program, or node running a
// script: how Claude Code runs without its `claude` name (#308).
const RUNNERS = new Set(["npx", "pnpx", "bunx", "npm", "pnpm", "yarn", "bun", "node", "deno"]);

// A word naming Claude Code's package -- any version, or a path into it.
const CLAUDE_PKG = /@anthropic-ai\/claude-code(?![\w-])/i;

// The harness's own tools; every other tool name is an MCP tool (#310).
const CORE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);

// What an MCP tool does to the paths it names, read off the words of its
// name (`write_file`, `editBlock`, `move_file`, `create_directory`, #310).
const TOOL_REMOVES = new Set(["delete", "remove", "rm", "rmdir", "unlink", "trash", "erase"]);
const TOOL_MOVES = new Set(["move", "rename", "mv"]);
const TOOL_COPIES = new Set(["copy", "cp", "duplicate"]);
const TOOL_PERMS = new Set(["chmod", "chown", "chgrp"]);
const TOOL_FOLDERS = new Set(["directory", "directories", "dir", "dirs", "folder", "folders"]);
// Browser tools' screenshots and snapshots land on the file path they're given.
const TOOL_WRITES = new Set(["write", "edit", "create", "make", "mkdir", "append", "save", "put", "patch",
  "replace", "insert", "overwrite", "truncate", "touch", "update", "modify", "apply", "export",
  "download", "extract", "unzip", "untar", "link", "symlink", "screenshot", "snapshot", "heapsnapshot"]);

// The input fields an MCP tool names a path in; a move or copy reads its
// source from SOURCE_FIELDS, and from the plain path fields when it also
// names a destination.
const PATH_FIELDS = ["path", "paths", "file_path", "filePath"];
const DEST_FIELDS = ["target", "destination", "dest", "new_path"];
const SOURCE_FIELDS = ["source"];

// The most entries listed under one protected folder outside the project
// before the rest counts as unlisted -- and so as reachable (see walkHit).
const LIST_CAP = 500;

// Variables -- the folders every rule is measured against, set per payload.
// Each holds the path as given and its real path, when a symlink differs.
let ROOTS = [];
let HOMES = [];
// Protected places outside the project (#263, #267), each { dir, what,
// tree, carve }: `tree` protects everything under dir, else only the
// *.json files directly in it (the way the run guard reads runs/); `carve`
// lists project folders inside dir that stay ordinary work.
let ZONES = [];
// The scripts the protected settings run (#312) and the protected MCP
// configs launch (#314), each { path, what }, in every spelling.
let SCRIPTS = [];
// The protected paths find could walk to, listed once per run, and the
// zones too big to list in full.
let ENTRIES = null;
let UNLISTED = [];

// Paths

/**
 * A name with its letter case folded the way a case-insensitive volume
 * compares names (#295). Upper then lower also folds the two non-ASCII
 * letters macOS's APFS treats as ASCII ones: the long s and the Kelvin sign.
 */
function fold(s) {
  return s.toUpperCase().toLowerCase();
}

/** True when two paths or names are the same, letter case aside (#295). */
function same(a, b) {
  return fold(a) === fold(b);
}

/** A command word's name, path and letter case dropped: macOS runs `/BIN/RM` as rm (#295). */
function cmdName(word) {
  return fold(basename(word ?? ""));
}

/**
 * The real path of the deepest folder that exists, with the rest put back.
 * The native realpath returns each name in its on-disk case, so `.CLAUDE`
 * on a Mac comes back `.claude` (#295); the JS one keeps the case typed.
 */
function canonical(abs) {
  const rest = [];
  let head = abs;
  for (;;) {
    try { return join(realpathSync.native(head), ...rest); } catch { /* not there yet */ }
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

/**
 * The names of `abs` below `dir`, or null when `abs` isn't `dir` or under
 * it -- letter case aside (#295). Both are resolved absolute paths.
 */
function below(dir, abs) {
  const d = dir.split(sep).filter(Boolean);
  const a = abs.split(sep).filter(Boolean);
  return a.length >= d.length && d.every((x, j) => same(x, a[j])) ? a.slice(d.length) : null;
}

/** Project-relative POSIX path, or null when the path escapes the project. */
function projectRelative(abs) {
  for (const root of ROOTS) {
    const rest = below(root, abs);
    if (rest) return rest.join("/");
  }
  return null;
}

/** True when `abs` is `dir` or any folder above it, letter case aside (#295). */
function holds(abs, dir) {
  return below(abs, dir) !== null;
}

/** ~, $HOME and ${HOME} at the front of a path, spelled out the way the shell does (#258, #263). */
function expandHome(raw) {
  return raw.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, () => resolve(homedir()));
}

/** expandHome, and $CAIRN_HOME too -- the run guard's own cairn home (#263, #299). */
function expandVars(raw) {
  return expandHome(raw).replace(/^(?:\$CAIRN_HOME|\$\{CAIRN_HOME\})(?=\/|$)/, () => process.env.CAIRN_HOME ?? "");
}

/**
 * The protected places outside the project (#263): the ship-gate stamp
 * and the run manifests the run guard trusts, and the refusal log the
 * circuit breaker counts (#358), in every cairn home they can live in --
 * CAIRN_HOME (the run guard reads it) and ~/.cairn (the server writes
 * it). The run report beside the manifests stays writable.
 *
 * And the plugin copy that actually runs (#267): everything under
 * ~/.claude/plugins (the registry files, the cache each install runs
 * from, the marketplaces), and the live plugin root -- CLAUDE_PLUGIN_ROOT,
 * which Claude Code hands its hooks, else the folder two up from this
 * script -- when it lies outside the project. A dev install whose root IS
 * the project is covered by PROTECTED; a project inside the plugin root
 * (a worktree) is carved out of it.
 *
 * And the folders Claude Code loads every session from the home folder
 * (#309): ~/.claude/skills, where a folder carrying a plugin manifest
 * loads next session as a plugin with its own hooks and MCP servers
 * (`claude plugin init` scaffolds exactly that), ~/.claude/agents and
 * ~/.claude/commands. No carve-out: a project inside one is a plugin that
 * loads, so its files are the harness too.
 *
 * And ~/.claude/hooks (#312), where your settings keep the scripts their
 * hooks run: a script swapped there runs at the next hook event, outside
 * any tool call, where no guard sees what it does.
 */
function outsideZones() {
  const zones = [];
  const add = (dir, what, tree, carve = []) => {
    for (const d of spellings(dir)) zones.push({ dir: d, what, tree, carve });
  };
  for (const base of [process.env.CAIRN_HOME, ...HOMES.map((h) => join(h, ".cairn"))]) {
    if (!base) continue;
    add(join(base, "ship-gate"), "the ship-gate stamp", true);
    add(join(base, "runs"), "the run manifests", false);
    // #358 -- the breaker counts these rows; a log the agent can empty is a breaker it can reset
    add(join(base, "refusals"), "the guard refusal log", true);
  }
  for (const home of HOMES) {
    add(join(home, ".claude", "plugins"), "the installed plugins and their registry", true);
    add(join(home, ".claude", "skills"), "your machine-wide skills", true);
    add(join(home, ".claude", "agents"), "your machine-wide agent definitions", true);
    add(join(home, ".claude", "commands"), "your machine-wide slash commands", true);
    add(join(home, ".claude", "hooks"), "your machine-wide Claude hooks", true);
  }
  const pluginRoot = livePluginRoot();
  const plugin = spellings(pluginRoot);
  if (!plugin.some((r) => ROOTS.some((root) => holds(root, r)))) {
    const carve = ROOTS.filter((root) => plugin.some((r) => holds(r, root)));
    add(pluginRoot, "the installed plugin these hooks run from", true, carve);
  }
  return zones;
}

/** The plugin root these hooks run from: CLAUDE_PLUGIN_ROOT, which Claude Code hands its hooks, else two up from here. */
function livePluginRoot() {
  return resolve(process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL("../..", import.meta.url)));
}

/** The protected place outside the project a path lies inside, or null -- letter case aside (#295). */
function zoneOf(abs) {
  for (const z of ZONES) {
    if (same(abs, z.dir) || !holds(z.dir, abs) || z.carve.some((c) => holds(c, abs))) continue;
    if (z.tree || (same(dirname(abs), z.dir) && fold(abs).endsWith(".json"))) return z.what;
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

// Scripts the settings run (#312)

/** Every command line a settings or hooks.json file runs: each hook's `command`, and the status line's. */
function settingsCommands(json) {
  const out = [];
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (typeof v.command === "string") out.push(v.command);
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(json?.hooks, 0);
  if (typeof json?.statusLine?.command === "string") out.push(json.statusLine.command);
  return out;
}

/**
 * One word of a hook or server command, spelled out the way its shell
 * would: ~, $HOME, $CLAUDE_PROJECT_DIR and $CLAUDE_PLUGIN_ROOT (braced or
 * not). Null for a flag, an assignment, a URL, a package spec
 * (@scope/pkg), and a word with any other variable, a substitution or a
 * wildcard.
 */
function spellWord(word, vars) {
  if (word.startsWith("-") || ASSIGNMENT.test(word) || URL_WORD.test(word) || PACKAGE_WORD.test(word)) return null;
  let w = word.replace(/^~(?=\/|$)/, () => vars.HOME);
  const m = /^\$(?:(\w+)|\{(\w+)\})(?=\/|$)/.exec(w);
  if (m) {
    const v = vars[m[1] ?? m[2]];
    if (!v) return null;
    w = v + w.slice(m[0].length);
  }
  return /[$`*?[]/.test(w) ? null : w;
}

/**
 * The file one word of a hook or server command names, from `at.dir` --
 * the project root, where hooks run, unless the server's cwd or an option
 * on the line named a folder (#316, `at.named`). Null for a program found
 * on PATH (node, bash, npx), a word spellWord drops, a device, a folder
 * that's there -- `cd "$CLAUDE_PROJECT_DIR"` runs nothing -- and a word
 * with no slash, unless a named folder holds a file by that name: `uv
 * --directory DIR run weather.py` runs DIR/weather.py (#316).
 */
function scriptFile(word, vars, at) {
  const w = spellWord(word, vars);
  if (w === null || (!w.includes("/") && !at.named)) return null;
  const abs = resolve(at.dir, w);
  if (abs === "/dev" || abs.startsWith("/dev/")) return null;
  try {
    if (statSync(abs).isDirectory()) return null;
  } catch {
    // not there yet: one planted there runs too -- but a bare name that
    // isn't there is a program on PATH (`run`, `start`)
    if (!w.includes("/")) return null;
  }
  return abs;
}

/**
 * The folder node or python runs by its entry file (#316): the first bare
 * word after their options -- `node DIR` runs DIR/index.js or the main in
 * its package.json, `python DIR` runs DIR/__main__.py -- when it is a
 * folder that's there holding one. Null after -e, -p, -c or -m, which run
 * their own value, and for any later folder: `node server.js ~/Desktop`
 * serves the Desktop, it doesn't run it. `args` follow the runtime's name.
 */
function runFolder(args, vars, at) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (RUNNER_INLINE_OPTS.has(a)) return null;
    if (a.startsWith("-") && a !== "-") {
      if (RUNNER_VALUE_OPTS.has(a)) i++;
      continue;
    }
    const w = spellWord(a, vars);
    if (w === null) return null;
    const abs = resolve(at.dir, w);
    try {
      if (statSync(abs).isDirectory() && ENTRY_FILES.some((n) => existsSync(join(abs, n)))) return abs;
    } catch { /* not there: scriptFile keeps it as the file one planted there would be */ }
    return null;
  }
  return null;
}

/**
 * What one hook or server command names, as { path, folder }: every word
 * that is a file, its `< file` inputs, and the same inside `bash -c`. A
 * folder option (#316: uv's --directory, -C, --cwd, as the next word or
 * with `=`) moves where the words after it resolve from, and a bare word
 * naming a file there counts (`uv --directory DIR run weather.py`), as it
 * does from a server's cwd in `base`. With `base.folders`, each folder so
 * named, and the one node or python runs by its entry file (`node DIR`),
 * comes back as a folder: the server runs inside it.
 */
function commandScripts(command, vars, base = null, depth = 0) {
  const out = [];
  const folder = (dir) => { if (base?.folders) out.push({ path: dir, folder: true }); };
  for (const seg of shellSegments(command, READ)) {
    if (seg.deep) continue; // past what the reader reads (#321): no path to find there
    const { words } = unwrap(seg.words, READ);
    const cmd = cmdName(words[0]);
    const str = SHELLS.has(cmd) ? shellCommandString(words.slice(1)) : null;
    // where a relative word resolves from: the project, the server's cwd,
    // or the folder an option named before it on this line
    let at = { dir: base?.dir ?? vars.CLAUDE_PROJECT_DIR, named: Boolean(base?.named) };
    const all = [...seg.words, ...(seg.inputs ?? [])];
    for (let i = 0; i < all.length; i++) {
      const w = all[i];
      if (w === str) continue; // the -c string is a command line, read as one below, not a path
      const eq = w.startsWith("--") ? w.indexOf("=") : -1;
      const name = eq > 0 ? w.slice(0, eq) : w;
      if (FOLDER_OPTS.includes(name) && !(name === "-C" && FOLDER_RUNNERS.test(cmd))) {
        const raw = eq > 0 ? w.slice(eq + 1) : all[++i];
        const d = raw === undefined ? null : spellWord(raw, vars);
        if (d === null) continue;
        at = { dir: resolve(at.dir, d), named: true };
        folder(at.dir);
        continue;
      }
      const f = scriptFile(w, vars, at);
      if (f) out.push({ path: f, folder: false });
    }
    if (base?.folders && FOLDER_RUNNERS.test(cmd)) {
      const d = runFolder(words.slice(1), vars, at);
      if (d) folder(d);
    }
    if (str && depth < 3) out.push(...commandScripts(str, vars, base && { ...base, dir: at.dir, named: at.named }, depth + 1));
  }
  return out;
}

/**
 * Every script the protected settings run (#312), in each spelling: the
 * paths that hook commands and the status line name in your machine-wide
 * settings, the project's settings, and the project's and the live
 * plugin's hooks/hooks.json. A file that can't be read or parsed is
 * skipped quietly -- the folder rules still stand, and a comment in
 * settings never blocks every write -- and nothing is kept between runs.
 */
function settingsScripts() {
  const home = resolve(homedir());
  const project = ROOTS[0];
  const plugin = livePluginRoot();
  // each file, with the folder its ${CLAUDE_PLUGIN_ROOT} means
  const sources = [
    ...SETTINGS_NAMES.map((n) => [join(home, ".claude", n), plugin]),
    ...SETTINGS_NAMES.map((n) => [join(project, ".claude", n), plugin]),
    [join(project, "hooks", "hooks.json"), project],
    [join(plugin, "hooks", "hooks.json"), plugin],
  ];
  const seen = new Set();
  const out = new Set();
  for (const [file, pluginRoot] of sources) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const vars = { HOME: home, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: pluginRoot };
      for (const c of settingsCommands(JSON.parse(readText(file) ?? ""))) {
        for (const { path } of commandScripts(c, vars)) for (const s of spellings(path)) out.add(s);
      }
    } catch { /* missing, unreadable or malformed: skip this file */ }
  }
  return [...out];
}

// Scripts the MCP configs launch (#314)

/**
 * The command lines one MCP server entry launches: its `command` and
 * `args`, each word quoted as the one word it is -- no shell splits them
 * -- and a `command` holding a space read as a line too, as some clients
 * split it. None for a server with no command: a URL server runs nothing.
 */
function serverLines(server) {
  if (!server || typeof server !== "object" || typeof server.command !== "string") return [];
  const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === "string") : [];
  const tail = args.map(quoteWord).join(" ");
  const lines = [`${quoteWord(server.command)} ${tail}`];
  if (/\s/.test(server.command.trim())) lines.push(`${server.command} ${tail}`);
  return lines;
}

/**
 * Every script the protected MCP configs launch from outside the project
 * (#314), and every folder they run a server from (#316), as { scripts,
 * folders }, each spelling that lies outside it: the paths a stdio
 * server's `command` and `args` name, resolved the way a hook command's
 * words are (a project's own servers from that project, a server with a
 * `cwd` from there), in ~/.claude.json -- its own servers and each
 * project's -- the project's .mcp.json, and Cursor's project and home
 * mcp.json (`${userHome}`, `${workspaceFolder}`). The server starts next
 * session with the tokens its config hands it, outside any tool call. A
 * script inside the project stays ordinary work: cairn's own .mcp.json
 * launches its server/dist build, and a build has to write it. The
 * folders are the ones the config names -- a `cwd`, uv's --directory,
 * the one `node DIR` runs -- never their parents, and never one holding
 * the project or the home folder. A file that can't be read or parsed is
 * skipped quietly; ~/.claude.json, which can run to megabytes, is read
 * and parsed once a run.
 */
function mcpScripts() {
  const home = resolve(homedir());
  const project = ROOTS[0];
  const parse = (file) => {
    try { return JSON.parse(readText(file) ?? ""); } catch { return null; }
  };
  // each server, with the folder its relative paths and $CLAUDE_PROJECT_DIR mean
  const servers = [];
  const take = (json, dir) => {
    const list = json?.mcpServers;
    if (list && typeof list === "object") for (const s of Object.values(list)) servers.push([s, dir]);
  };
  const claude = parse(join(home, ".claude.json"));
  take(claude, project);
  const projects = claude?.projects;
  if (projects && typeof projects === "object") {
    for (const [dir, entry] of Object.entries(projects)) if (isAbsolute(dir)) take(entry, dir);
  }
  take(parse(join(project, ".mcp.json")), project);
  take(parse(join(project, ".cursor", "mcp.json")), project);
  take(parse(join(home, ".cursor", "mcp.json")), project);
  const seen = new Set();
  const scripts = new Set();
  const folders = new Set();
  const anchors = [...ROOTS, ...HOMES];
  for (const [server, dir] of servers) {
    const vars = { HOME: home, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: dir, userHome: home, workspaceFolder: dir };
    const keep = ({ path, folder }) => {
      for (const s of spellings(path)) {
        if (projectRelative(s) !== null) continue;
        if (!folder) scripts.add(s);
        else if (!anchors.some((a) => holds(s, a))) folders.add(s);
      }
    };
    // the folder the client starts the server in (#316): its cwd, else the project
    const cwd = typeof server?.cwd === "string" ? spellWord(server.cwd, vars) : null;
    const base = { dir: cwd === null ? dir : resolve(dir, cwd), named: cwd !== null, folders: true };
    const lines = serverLines(server);
    if (cwd !== null && lines.length) keep({ path: base.dir, folder: true });
    for (const line of lines) {
      if (seen.has(`${base.dir}\0${line}`)) continue;
      seen.add(`${base.dir}\0${line}`);
      try {
        for (const found of commandScripts(line, vars, base)) keep(found);
      } catch { /* an entry the reader can't take: skip it */ }
    }
  }
  return { scripts: [...scripts], folders: [...folders] };
}

/**
 * Every protected script, as { path, what } -- what the settings run
 * (#312), then what the MCP configs launch (#314) -- and every folder an
 * MCP config runs a server from (#316), as { scripts, folders }, read
 * fresh on every call.
 */
function protectedScripts() {
  const out = new Map();
  for (const p of settingsScripts()) out.set(p, SCRIPT_WHAT);
  const { scripts, folders } = mcpScripts();
  for (const p of scripts) if (!out.has(p)) out.set(p, MCP_WHAT);
  return { scripts: [...out].map(([path, what]) => ({ path, what })), folders };
}

/** The script `abs` is a folder on the way to (#312, #314), or null. */
function holdsScript(abs) {
  return SCRIPTS.find((s) => holds(abs, s.path) && !same(abs, s.path)) ?? null;
}

// Rules

/** The file itself is protected (the check every version of this guard made), letter case aside (#295). */
function fileRule(abs) {
  for (const home of HOMES) {
    for (const [dir, names, what] of HOME_FILES) if (names.some((n) => same(abs, join(home, dir, n)))) return what;
  }
  const zone = zoneOf(abs);
  if (zone) return zone;
  const rel = projectRelative(abs);
  if (rel !== null) for (const p of PROTECTED) if (p.re.test(fold(rel))) return p.what;
  // a script the settings run, wherever it lives (#312), or one an MCP
  // config launches (#314); anything else outside the project is not this
  // guard's business
  return SCRIPTS.find((s) => same(abs, s.path))?.what ?? null;
}

/** The path names a protected FOLDER: writing into it, replacing it or removing it (#265), letter case aside (#295). */
function dirRule(abs) {
  for (const home of HOMES) {
    for (const [dir, , what] of HOME_FILES) if (dir && same(abs, join(home, dir))) return what;
  }
  const zone = ZONES.find((z) => same(z.dir, abs));
  if (zone) return zone.what;
  const rel = projectRelative(abs);
  if (rel) {
    const r = fold(rel);
    if (r === "hooks") return "the hook directory";
    for (const [up, sub, what] of SUB_TREES) if (r === `${up}/${sub}` || r.endsWith(`/${up}/${sub}`)) return what;
    const name = r.split("/").pop();
    if (name === ".claude") return "a Claude settings directory";
    if (name === ".claude-plugin") return "the plugin manifest";
    if (name === ".cursor") return "Cursor's settings directory";
  }
  // A folder on the way to a protected script, while it isn't there as a
  // folder (#312, #314): a write here -- `mv /tmp/x ~/.config/iterm2` --
  // puts a new script in the old one's place. Into one that's there, a
  // write lands beside the script and is judged by its own name.
  const script = holdsScript(abs);
  if (!script) return null;
  try { return statSync(abs).isDirectory() ? null : script.what; } catch { return script.what; }
}

/**
 * Removing the project, or any folder above it, removes everything in it
 * (#265); locking one with chmod, chown or an ACL locks everything in it
 * too (#299). The same goes for the home folder, each cairn home, and a
 * folder on the way to a protected script (#312, #314).
 */
function holderRule(abs) {
  if (ROOTS.some((root) => holds(abs, root))) {
    return "the folder holding the hook directory and settings";
  }
  if (HOMES.some((home) => holds(abs, home))) {
    return "the folder holding your machine-wide Claude settings";
  }
  const zone = ZONES.find((z) => holds(abs, z.dir));
  if (zone) return `the folder holding ${zone.what}`;
  const script = holdsScript(abs);
  return script ? `the folder holding ${script.what}` : null;
}

/** Could this name, once the shell expands it in `dir`, be a *.json file there? */
function couldManifest(comp, dir) {
  if (STANDINS.includes(comp) || fold(comp).endsWith(".json")) return true;
  let names = [];
  try { names = readdirSync(dir); } catch { /* nothing there to expand to */ }
  return names.some((n) => fold(n).endsWith(".json") && could(comp, n));
}

/** The protected place outside the project a wildcard path could reach (#263). */
function zoneGlob(p, remove) {
  for (const z of ZONES) {
    const d = z.dir.split(sep).filter(Boolean);
    const n = d.length;
    if (!n || p.length < n || !d.slice(0, -1).every((x, j) => could(p[j], x))) continue;
    // a path spelled plainly into a carved-out project folder is that project's business
    const carved = z.carve.some((c) => {
      const cc = c.split(sep).filter(Boolean);
      return p.length >= cc.length && cc.every((x, j) => same(p[j], x));
    });
    if (carved) continue;
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

/**
 * Could this glob component expand to `name`, in any letter case (#295)?
 * Tried as typed and case-folded, so `[!A-Z]ooks` and `HOO*` both count
 * for hooks. A bare stand-in counts only when `anyOk`.
 */
function could(comp, name, anyOk = true) {
  if (STANDINS.includes(comp)) return anyOk;
  try { return compRe(comp).test(name) || compRe(fold(comp)).test(fold(name)); } catch { return true; }
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
        [".claude-plugin", MANIFEST_NAMES, "the plugin manifest"], [".cursor", CURSOR_NAMES, "Cursor's hooks"],
        [".cursor", CURSOR_MCP, "Cursor's MCP server config"]]) {
        // the folder itself, or a settings / manifest file directly inside it
        if (i === c.length - 1 && could(c[i], dir, remove)) return dirRule(join(ROOTS[0], dir));
        const named = i === c.length - 2 && names.some((n) => could(c[i + 1], n));
        if (named && could(c[i], dir)) return what;
      }
      // .claude/hooks/, .claude/agents/ and .cursor/hooks/, the folder or anything in it (#267, #269)
      for (const [up, sub, what] of SUB_TREES) {
        if (i + 1 < c.length && could(c[i], up) && could(c[i + 1], sub, i + 2 < c.length || remove)) {
          return what;
        }
      }
    }
  }
  const p = abs.split(sep).filter(Boolean);
  const under = (dir) => {
    const d = dir.split(sep).filter(Boolean);
    return p.length >= d.length && d.every((x, j) => could(p[j], x));
  };
  // the home folder's files (#298): `~/.c*.json`, `cp -r src/. ~`, `~/.claude/*.json`
  for (const home of HOMES) {
    const n = home.split(sep).filter(Boolean).length;
    if (!under(home) || p.length <= n || p.length > n + 2) continue;
    for (const [dir, names, what] of HOME_FILES) {
      if (dir && !could(p[n], dir)) continue;
      if (dir && p.length === n + 1 && could(p[n], dir, remove)) return what; // the folder itself
      const rest = p.slice(dir ? n + 1 : n);
      if (rest.length === 1 && names.some((s) => could(rest[0], s))) return what;
    }
  }
  const zone = zoneGlob(p, remove);
  if (zone) return zone;
  // a protected script (#312, #314): its own name, or a folder on the way
  // to it that a removal takes or a copied folder's unknown contents fill
  for (const { path: s, what } of SCRIPTS) {
    const d = s.split(sep).filter(Boolean);
    if (p.length > d.length || !p.every((x, j) => could(x, d[j]))) continue;
    if (p.length === d.length || STANDINS.includes(p[p.length - 1])) return what;
    if (remove || mode === "perm") return `the folder holding ${what}`;
  }
  if (remove || mode === "perm") {
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
 * create (mkdir/touch -- an empty folder changes nothing), remove, or perm
 * (chmod and kin, #299: like remove, a folder holding a protected place
 * counts). Both the path as written and its real path are checked, so a
 * symlinked project folder can't hide either spelling.
 */
function judge(abs, mode, literal = false) {
  const holder = mode === "remove" || mode === "perm";
  for (const p of spellings(abs)) {
    const what = fileRule(p) ??
      (mode !== "create" ? dirRule(p) : null) ??
      (holder ? holderRule(p) : null) ??
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
 * The folder git clone makes when none is given (#317): the repo's last
 * name, from a URL, an scp-like host:path or a local path, minus .git --
 * kept, or added, for a bare or mirror clone.
 */
function repoName(url, bare = false) {
  const path = String(url).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1);
  if (!name) return null;
  return bare ? name.replace(/(?<!\.git)$/i, ".git") : name.replace(/\.git$/i, "") || null;
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
  if (!parts.length && !files.length && cmdName(feeder[0]) === "cat") {
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

/**
 * Does this find test select `entry` (printed by find as `shown`)? A name
 * on disk may differ from the protected spelling only in case, so a test
 * is tried as typed and case-folded (#295). Unreadable tests select.
 */
function testSelects(t, entry, shown) {
  if (t.kind === "lname") return false; // symlink targets; the protected files are not links
  try {
    if (t.kind === "regex") return new RegExp(`^(?:${t.pat})$`, "i").test(shown);
    const x = t.kind === "name" ? basename(entry) : shown;
    return fnmatchRe(t.pat, t.ci).test(x) || fnmatchRe(fold(t.pat), false).test(fold(x));
  } catch {
    return true;
  }
}

/** Everything under `dir` but `skip`, nearest first, up to LIST_CAP entries; true when some was left unlisted. */
function listTree(dir, out, skip = []) {
  const queue = [dir];
  let n = 0;
  while (queue.length) {
    const d = queue.shift();
    let found = [];
    try { found = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of found) {
      const p = join(d, e.name);
      if (skip.some((s) => holds(s, p))) continue;
      if (++n > LIST_CAP) return true;
      out.push(p);
      if (e.isDirectory()) queue.push(p);
    }
  }
  return false;
}

/** The folder a find start names whose whole contents are protected, or null. */
function treeRule(abs) {
  const zone = ZONES.find((z) => z.tree && same(z.dir, abs));
  if (zone) return zone.what;
  const what = dirRule(abs);
  return TREES.has(what) ? what : null;
}

/**
 * Every protected path find could reach: the fixed surfaces, what hooks/
 * holds on disk, the protected scripts (#312, #314), and the protected
 * places outside the project (#263) -- a zone too big to list goes in
 * UNLISTED.
 */
function protectedEntries() {
  if (ENTRIES) return ENTRIES;
  ENTRIES = SCRIPTS.map((s) => s.path);
  for (const root of ROOTS) {
    const trees = SUB_TREES.map(([up, sub]) => join(root, up, sub));
    ENTRIES.push(join(root, "hooks"), join(root, "hooks", "hooks.json"), join(root, ".mcp.json"),
      join(root, ".claude"), ...SETTINGS_NAMES.map((n) => join(root, ".claude", n)), ...trees,
      join(root, ".claude-plugin"), ...MANIFEST_NAMES.map((n) => join(root, ".claude-plugin", n)),
      join(root, ".cursor"), ...[...CURSOR_NAMES, ...CURSOR_MCP].map((n) => join(root, ".cursor", n)));
    const stack = [join(root, "hooks"), ...trees];
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
    for (const [dir, names] of HOME_FILES) {
      if (dir) ENTRIES.push(join(home, dir));
      ENTRIES.push(...names.map((n) => join(home, dir, n)));
    }
  }
  for (const z of ZONES) {
    if (!existsSync(z.dir)) continue;
    ENTRIES.push(z.dir);
    if (z.tree) {
      if (listTree(z.dir, ENTRIES, z.carve)) UNLISTED.push(z);
      continue;
    }
    let names = [];
    try { names = readdirSync(z.dir); } catch { /* not a folder */ }
    for (const n of names) if (fold(n).endsWith(".json")) ENTRIES.push(join(z.dir, n));
  }
  return ENTRIES;
}

/**
 * The folders from `start` down to each protected place under it -- the
 * project, the home folder, each zone, each protected script -- every one
 * a folder holding it.
 */
function holdersUnder(start) {
  const out = [];
  for (const anchor of [...ROOTS, ...HOMES, ...ZONES.map((z) => z.dir), ...SCRIPTS.map((s) => s.path)]) {
    const rest = below(start, anchor);
    if (rest) for (let k = 0; k <= rest.length; k++) out.push(join(start, ...rest.slice(0, k)));
  }
  return out;
}

/**
 * Would find, walking from `dir`, reach a protected path its tests select?
 * A start inside hooks/ (or a protected file or folder tree) is hit
 * whatever the tests say; a start holding one is hit when a test can
 * select it, when nothing narrows the walk (no name test, or a negated
 * one), or when it holds a zone too big to list. Removing or chmod-ing
 * what it walks also counts the folders holding one (#299): `find ~
 * -name .cairn -exec chmod 000 {} +`.
 */
function walkHit(spec, dir, mode = "write") {
  for (const s of spec.starts) {
    const start = resolveIn(dir, expandVars(s)); // `find ~/.cairn` walks the home folder (#263)
    const inside = fileRule(start) ?? treeRule(start);
    if (inside) return { path: s, what: inside };
    const entries = protectedEntries();
    const unlisted = UNLISTED.find((z) => holds(start, z.dir));
    if (unlisted) return { path: s, what: unlisted.what };
    const holders = mode === "remove" || mode === "perm" ? holdersUnder(start) : [];
    for (const entry of [...entries, ...holders]) {
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
    if (cmdName(w[0]) === "find") {
      const hit = walkHit(parseFind(w.slice(1)), feed.dir, mode);
      if (hit) return hit;
      continue;
    }
    words.push(...w.slice(1));
    texts.push(...u.heredocs.map((h) => h.body), ...(u.herestrings ?? []));
  }
  for (const t of texts) words.push(...t.split(/\s+/));
  for (const x of words) {
    if (!x || x.startsWith("-")) continue;
    // `echo ~/.cairn | xargs chmod 000`: the shell spelled out ~ before echo saw it (#299)
    const what = judge(resolveIn(feed.dir, expandVars(x)), mode);
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
    // -m, -o and -g also reset a folder that already exists (#299)
    const mode = hasOpt(opts, "-m", "--mode", "-o", "--owner", "-g", "--group") ? "perm" : "create";
    for (const o of operands) add(o, mode);
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

/**
 * chmod, chown, chgrp, chflags, chattr, setfacl, setfattr (#299): every
 * operand, the mode or owner word too (harmless as a path), and each path
 * a setfacl / setfattr --restore dump names on its `# file:` lines.
 */
function permTargets(args, ctx, add) {
  for (const o of plain(args)) add(o, "perm");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const dump = a === "--restore" ? args[i + 1] : a.startsWith("--restore=") ? a.slice(10) : null;
    const text = dump ? readText(resolveIn(ctx.dir, expandVars(dump))) : null;
    for (const m of text?.matchAll(/^# file: (.+)$/gm) ?? []) add(m[1], "perm");
  }
}

/** xattr (macOS): -w NAME VALUE, -d NAME and -c change the files after them; a listing or -p only reads (#299). */
function xattrTargets(args, add) {
  const { opts, operands } = parseOpts(args);
  const skip = hasOpt(opts, "-w") ? 2 : hasOpt(opts, "-d") ? 1 : hasOpt(opts, "-c") ? 0 : -1;
  if (skip >= 0) for (const o of operands.slice(skip)) add(o, "perm");
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
      [dir] = dirTarget(o.value, dir, ctx.shellDir ?? ctx.dir); // a later -C is relative to the one before, read like a cd (#318)
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

/**
 * The folder a tree-creating git command plants (#317), judged like a
 * mkdir of it: `clone [opts] URL [DIR]` (DIR defaults to the repo's name,
 * here), `worktree add [opts] DIR [branch]`, `submodule add [opts] URL
 * [DIR]`, `init [DIR]` (here, by default). A clone into a protected
 * folder plants a skill, or a plugin with hooks and MCP servers of its
 * own -- the install line a README would carry.
 */
function gitTreeTargets(sub, rest, dir, add) {
  if (sub === "clone") {
    const { opts, operands } = parseOpts(rest, GIT_CLONE);
    const [url, dest] = operands;
    const name = url === undefined ? null : dest ?? repoName(url, hasOpt(opts, "--bare", "--mirror"));
    if (name) add(name, "write", dir);
  } else if (sub === "init") {
    add(parseOpts(rest, GIT_INIT).operands[0] ?? ".", "write", dir);
  } else {
    // worktree and submodule: their own options may sit before `add`
    const at = rest.findIndex((a) => !a.startsWith("-"));
    if (at < 0 || rest[at] !== "add") return;
    const { operands } = parseOpts(rest.slice(at + 1), sub === "worktree" ? GIT_WORKTREE_ADD : GIT_SUBMODULE_ADD);
    const [first, second] = operands;
    if (first === undefined) return;
    const dest = sub === "worktree" ? first : second ?? repoName(first);
    if (dest) add(dest, "write", dir);
  }
}

/**
 * The folder an initializer scaffolds (#317): every bare word it's given
 * may be it -- `create-vite my-app --template react` names my-app, and
 * `react` judged as a folder here is harmless -- and none means here.
 */
function scaffoldTargets(words, add) {
  const bare = words.filter((a) => a !== "--" && !a.startsWith("-"));
  for (const d of bare.length ? bare : ["."]) add(d, "write");
}

/** The folder degit fills (#317): `degit SRC [DIR]`, here when none. */
function degitTargets(words, add) {
  const bare = words.filter((a) => a !== "--" && !a.startsWith("-"));
  if (bare.length) add(bare[1] ?? ".", "write");
}

/**
 * git: checkout/restore pathspecs, rm/mv operands, apply's patch, the tree
 * clone and kin plant (#317) -- from its -C folder (#258), read the way a
 * cd target is (#318): `~/proj`, `$HOME/proj` and `"$PWD"` spelled out,
 * and a folder the guard can't read (`-C "$X"`) LOST, so a relative
 * operand from it is refused rather than judged under a folder literally
 * named `~`.
 */
function gitTargets(args, seg, ctx, add) {
  let k = 0;
  let dir = ctx.dir;
  while (k < args.length && args[k].startsWith("-")) {
    if (args[k] === "-C" && args[k + 1]) [dir] = dirTarget(args[k + 1], dir, ctx.shellDir ?? ctx.dir);
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
  else if (["clone", "init", "worktree", "submodule"].includes(sub)) gitTreeTargets(sub, args.slice(k + 1), dir, add);
}

/**
 * claude mcp (#303): add, add-json, add-from-claude-desktop and remove
 * write ~/.claude.json in user and local scope -- local is the default --
 * and the .mcp.json where claude runs in project scope; reset-project-choices
 * rewrites the approvals in ~/.claude.json and the local settings. A server
 * added there starts next session, outside every hook. The subcommand is
 * any word after `mcp`, since a top-level option's value can sit between
 * them, and a word from a stream (xargs, find -exec) may be the whole `mcp
 * add ...`. ~/.claude.json is named whatever the scope says, so no
 * misreading of the options lets a write by.
 *
 * claude plugin and claude import (#308), found the same way: install,
 * uninstall, update and prune change the installed plugins and the
 * settings that enable them; enable and disable flip those settings --
 * `claude plugin disable cairn` turns off every cairn guard next session;
 * init scaffolds a plugin in ~/.claude/skills; configure --values-stdin
 * saves a plugin's options; marketplace add, remove and update change the
 * marketplaces plugins install from; import brings another agent's config
 * in. A dry run (prune, import) and help pass -- help only as the last
 * word, right after the subcommand words, where no option can have
 * swallowed it as a value.
 */
function claudeTargets(args, ctx, add) {
  // a nested shell's "$1" is whatever its caller's xargs or find handed it
  const words = ctx.positional ? args.map((a) => a.replace(POSITIONAL, ctx.positional)) : args;
  const streamed = words.some((a) => STANDINS.some((m) => a.includes(m)));
  // the scope options sit before `--`; what follows it is a server's own command line
  const end = words.includes("--") ? words.indexOf("--") : words.length;
  const head = words.slice(0, end);
  // -h or --help ending the options, or the help subcommand of a command
  // group (`claude plugin help install`), which only ever prints
  const help = head.findIndex((a, i) => ((a === "-h" || a === "--help") && i === head.length - 1) ||
    (a === "help" && ["plugin", "plugins", "marketplace", "mcp"].some((c) => same(head[i - 1] ?? "", c))));
  if (!streamed && help >= 0 && head.slice(0, help).every((a) => CLAUDE_COMMAND_WORDS.some((c) => same(a, c)))) return;
  // the words after the first one naming a subcommand, or null
  const after = (list, ...names) => {
    const at = list.findIndex((a) => names.some((n) => could(a, n)));
    return at < 0 ? null : list.slice(at + 1);
  };
  const has = (list, names) => list !== null && names.some((n) => list.some((a) => could(a, n)));
  // a flag that keeps it a dry run, unless an option before it took it as a value
  const dry = (list) => list.some((a, i) => a === "--dry-run" && !(list[i - 1] ?? "").startsWith("-"));
  let scope = null;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    const s = a === "-s" || a === "--scope" ? head[++i]
      : a.startsWith("--scope=") ? a.slice(8) : /^-s./.test(a) ? a.slice(2) : null;
    if (s !== null && s !== undefined) scope = s;
  }
  // the settings file the scope names, else each the default can mean
  const settings = (...dflt) => {
    for (const s of SCOPE_SETTINGS[scope] ? [scope] : dflt) add(SCOPE_SETTINGS[s]);
  };
  const registry = (name) => add(`~/.claude/plugins/${name}`);

  if (streamed || has(after(words, "mcp"), CLAUDE_MCP_WRITES)) {
    if (scope === "project") add(".mcp.json");
    add("~/.claude.json");
  }
  const plugin = after(words, "plugin", "plugins");
  // both readings, so a plugin named `marketplace` can't hide `disable cairn`
  const market = plugin && after(plugin, "marketplace");
  if (has(market, CLAUDE_MARKET_WRITES)) {
    registry("known_marketplaces.json");
    if (has(market, ["add"])) settings("user");
    if (has(market, ["remove", "rm"])) settings("user", "project", "local");
  }
  if (plugin) {
    const installs = after(plugin, ...CLAUDE_PLUGIN_INSTALLS);
    if (installs && !(has(plugin, ["prune", "autoremove"]) && dry(installs))) {
      registry("installed_plugins.json");
      if (has(plugin, ["update"])) settings("user", "project", "local");
      else settings("user");
    }
    if (has(plugin, CLAUDE_PLUGIN_TOGGLES)) settings("user", "project", "local");
    if (has(plugin, CLAUDE_PLUGIN_INITS)) add(`~/.claude/skills/${ANY}`);
    if (has(after(plugin, "configure"), ["--values-stdin"])) settings("user");
  }
  const imported = after(words, "import");
  if (imported && !dry(imported)) {
    settings("user");
    add("~/.claude.json");
  }
}

/**
 * npx, bunx, pnpm dlx, yarn dlx, node <cli> and kin (#308): Claude Code
 * launched without its `claude` name -- its package (`npx -y
 * @anthropic-ai/claude-code mcp add ...`, `npx -p @anthropic-ai/claude-code
 * claude ...`), a program named claude, or a path into the package. The
 * words after it are claude's. A `-c` / `--call` / `--shell-mode` string is
 * a command line the runner hands a shell, read like `bash -c`.
 *
 * The tree an initializer plants (#317), judged like a mkdir of it: `npx
 * degit SRC [DIR]`, `npx create-x [DIR]` and `bunx create-x [DIR]`; `npm
 * create x [DIR]`, `npm init x [DIR]`, `pnpm create`, `yarn create` and
 * `bun create` the same; none lands here. A bare `npm init` (pnpm's,
 * yarn's, bun's too) writes a package.json here.
 */
function runnerTargets(cmd, args, ctx, add, out) {
  // the bare words, past the values of a runner's own -p / -c
  const bare = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { bare.push(...args.slice(i + 1)); break; }
    if (["-p", "--package", "-c", "--call"].includes(a)) { i++; continue; }
    if (!a.startsWith("-")) bare.push(a);
  }
  const [head, ...tail] = bare;
  if (head !== undefined && INIT_RUNNERS.has(cmd) && (head === "create" || head === "init")) {
    if (tail.length) scaffoldTargets(tail.slice(1), add);
    else if (head === "init") add("package.json");
  } else if (head !== undefined && (cmd === "npx" || cmd === "pnpx" || cmd === "bunx")) {
    if (cmdName(head) === "degit") degitTargets(tail, add);
    else if (CREATE_PKG.test(cmdName(head))) scaffoldTargets(tail, add);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const line = ["-c", "--call", "--shell-mode"].includes(a) ? args[i + 1]
      : a.startsWith("--call=") ? a.slice(7) : undefined;
    if (line !== undefined && ctx.depth < 3) out.push(...lineTargets(line, ctx.dir, ctx.depth + 1, { walk: ctx.walk }));
  }
  const at = args.findIndex((a) => CLAUDE_PKG.test(a) || /^claude(?:\.[cm]?js)?$/.test(cmdName(a)));
  if (at >= 0) claudeTargets(args.slice(at + 1), ctx, add);
  // #311 -- `npm exec`, `pnpm exec`, `yarn exec`, `npm x`, `pnpm dlx` run the
  // words after the subcommand (past any `--`) as a command line, read like
  // bash. `run` scripts a package.json entry the guard can't see, so it stays out.
  const sub = args.findIndex((a) => ["exec", "x", "dlx"].includes(cmdName(a)));
  if (sub >= 0 && ctx.depth < 3) {
    let rest = args.slice(sub + 1);
    const dd = rest.indexOf("--");
    if (dd >= 0) rest = rest.slice(dd + 1);
    if (rest.length) out.push(...lineTargets(rest.join(" "), ctx.dir, ctx.depth + 1, { walk: ctx.walk }));
  }
}

/**
 * Every path one segment would change, as { raw, abs, mode }. Generous
 * inside a write command; silent for a command that only reads.
 */
function writeTargets(seg, ctx) {
  const out = [];
  const { words: w0, writes, wrappers, dirs, assigns } = unwrap(seg.words, READ);
  // xargs runs its command with paths read from stdin (#258). Its name is
  // folded like any command's: macOS runs `XARGS` as xargs (#300).
  const xargs = wrappers.find((x) => cmdName(x.name) === "xargs");
  // What this command reads on stdin, should a path come from there. A
  // stdin path in a nested line came from its caller's xargs, unless this
  // command has an xargs of its own or reads a pipe itself (`pipe`).
  const own = {
    seg, up: ctx.up, dir: ctx.dir, shellDir: ctx.shellDir, argFiles: xargs ? argFiles(xargs.args) : [],
  };
  const add = (raw, mode = "write", dir = ctx.dir, pipe = false) => {
    // a nested shell's "$1" / "$@" is whatever path its caller handed it
    const mapped = ctx.positional && raw.search(POSITIONAL) >= 0;
    // the shell spells out $PWD, $HOME, ~ and $CAIRN_HOME before the command
    // sees them (#258, #263), and a folder it computes in front of the path
    // when the guard knows which: $(pwd) and the repo root (#321)
    const r = expandVars(computedDir((mapped ? raw.replace(POSITIONAL, ctx.positional) : raw)
      .replace(/^(?:\$PWD|\$\{PWD\})(?=\/|$)/, () => ctx.shellDir ?? ctx.dir), ctx.shellDir ?? ctx.dir));
    const feed = pipe || xargs ? own : (ctx.argvFeed ?? own);
    // a path with nothing in front of any other substitution to anchor it
    // (`$(somecmd)/notes.txt`, `\`dirname x\`/y`) lands where the guard can't
    // follow, like a cd it can't (#319): there is no tail it could clear
    // from there, since the folder may be a protected one itself; a
    // computed name under a folder it knows (`/tmp/$(date +%s).bak`) is
    // judged there, as a $NAME is
    const abs = /^(?:\.\/)*(?:\$\(|`)[^]*\//.test(r) ? LOST : resolveIn(dir, r);
    out.push({ raw: r, abs, mode, feed, walk: ctx.walk });
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
  // #315 -- a pager variable set here (PAGER=, MANPAGER=, GIT_PAGER= ...)
  // names a program man, git or gh runs: its value is a command line too
  if (ctx.depth < 3) {
    for (const inner of pagerCommands(assigns, w0)) {
      out.push(...lineTargets(inner, ctx.dir, ctx.depth + 1, { walk: ctx.walk }));
    }
  }
  const w = xargs && w0.length ? withStdin(w0, xargs.args) : w0;
  if (!w.length) return out;
  const cmd = cmdName(w[0]); // `TEE` and `/BIN/RM` run tee and rm on a Mac (#295)
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
  else if (PERMS.has(cmd)) permTargets(args, ctx, add);
  else if (cmd === "xattr") xattrTargets(args, add);
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
  else if (cmd === "claude") claudeTargets(args, ctx, add);
  else if (RUNNERS.has(cmd)) runnerTargets(cmd, args, ctx, add, out);
  // #317 -- an initializer run by name, or through `pnpm dlx` / `npm exec`
  else if (cmd === "degit") degitTargets(args, add);
  else if (CREATE_PKG.test(cmd)) scaffoldTargets(args, add);
  // #311 -- a program runner off the shared table (op run, bundle exec, tmux
  // new-session, uv run ...) may run a later word as the real command; read
  // those inner lines too. A program that only prints or searches its
  // arguments (ARG_SAFE, inside runnerCommands) runs none of them, so an
  // ordinary line that merely names a protected path passes -- all but the
  // one option that runs a program (man -P, rg --pre, gh alias set --shell,
  // #315), which runnerCommands hands back as a line of its own.
  else if (ctx.depth < 3) {
    for (const inner of runnerCommands(w)) {
      out.push(...lineTargets(inner, ctx.dir, ctx.depth + 1, { walk: ctx.walk }));
    }
  }
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

// A substitution in front of a path that names a folder the guard knows
// (#321): the shell's own folder, as $PWD is, or the repo root above it.
const COMPUTED_DIR = /^(?:\$\((pwd(?: -[LP])?|git rev-parse --show-toplevel)\)|`(pwd(?: -[LP])?|git rev-parse --show-toplevel)`)(?=\/|$)/;

/**
 * `raw` with a leading `$(pwd)` or `$(git rev-parse --show-toplevel)`
 * spelled out from `shell`, the folder the shell is in -- one candidate at
 * a time, so after `cd hooks` the pwd is hooks, and after a cd the guard
 * lost it stays LOST. The repo root is the one above that candidate, and
 * LOST where no .git is above it: git would fail, and the path is then
 * whatever the shell makes of an empty expansion.
 */
function computedDir(raw, shell) {
  return raw.replace(COMPUTED_DIR, (m, a, b) => {
    if ((a ?? b).startsWith("pwd")) return shell;
    const root = gitRoot(shell);
    return existsSync(join(root, ".git")) ? root : LOST;
  });
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
 * env -C, sudo -D and git -C folder. `cd -` and `pushd +N` are lost, and
 * so is a target a substitution computes (`cd $(...)`, cd `...`), once
 * dirTarget reads it. popd and a bare pushd only revisit folders already
 * counted.
 */
function segMoves(seg, again) {
  const { words: w, dirs } = unwrap(seg.words, READ);
  const cmd = basename(w[0] ?? "");
  const moves = dirs.map((raw) => ({ raw, again }));
  if (cmd === "cd" || cmd === "pushd") {
    const ops = w.slice(1).filter((a) => a !== "--" && !/^-[LPe@]+$/.test(a));
    if (seg.op === "(" || ops[0] === "-" || /^[+-]\d+$/.test(ops[0] ?? "")) {
      moves.push({ lost: true, again });
    } else if (ops.length) moves.push({ raw: ops[0], cd: true, again });
    else if (cmd === "cd") moves.push({ raw: "~", again });
  } else if (cmdName(cmd) === "git") { // cd and pushd are builtins, matched as spelled; git is a program (#295)
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
  // a line nested past what the reader reads holds commands the guard never
  // saw (#321): refused unread, unless the human's override prefixes it
  if (tooDeep(segs)) return depth > 0 || !exempt(segs[0]?.words ?? []) ? [{ deep: true }] : [];
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
  if (t.deep) return { deep: true };
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
    if (t.walk.spec.starts.some((s) => isLost(resolveIn(t.walk.dir, expandVars(s))))) return lost;
    return walkHit(t.walk.spec, t.walk.dir, t.mode);
  }
  if (isLost(t.abs)) return lost;
  const what = judge(t.abs, t.mode);
  return what ? { path: t.raw, what } : null;
}

// MCP tools (#310)

/** The words of an MCP tool's own name, past its `mcp__server__` prefix, lowercased. */
function toolWords(tool) {
  const name = tool.startsWith("mcp__") ? tool.split("__").pop() : tool;
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Every path a set of input fields holds: a string, or the strings in a list. */
function fieldValues(input, fields) {
  const out = [];
  for (const f of fields) {
    const v = input?.[f];
    if (typeof v === "string" && v) out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === "string" && x));
  }
  return out;
}

/**
 * The paths an MCP tool would change, as { raw, mode }, read off its name
 * (#310): a removing tool removes every path it names; a move removes its
 * source and writes its destination, and the source's name inside it; a
 * copy writes only the destination side; chmod and kin change a mode;
 * making a folder creates it; any other writing name writes. A name that
 * says none of these -- read_file, list_directory -- changes nothing here.
 */
function toolPaths(tool, input) {
  const words = new Set(toolWords(tool));
  const any = (set) => [...words].some((w) => set.has(w));
  const plainPaths = fieldValues(input, PATH_FIELDS);
  const dests = fieldValues(input, DEST_FIELDS);
  const named = [...plainPaths, ...dests];
  const out = [];
  if (any(TOOL_REMOVES)) {
    for (const raw of [...named, ...fieldValues(input, SOURCE_FIELDS)]) out.push({ raw, mode: "remove" });
  } else if (any(TOOL_MOVES) || any(TOOL_COPIES)) {
    const srcs = [...fieldValues(input, SOURCE_FIELDS), ...(dests.length ? plainPaths : [])];
    for (const raw of dests.length ? dests : plainPaths) {
      out.push({ raw, mode: "write" });
      for (const s of srcs) if (basename(s)) out.push({ raw: join(raw, basename(s)), mode: "write" });
    }
    if (any(TOOL_MOVES)) for (const raw of srcs) out.push({ raw, mode: "remove" });
  } else if (any(TOOL_PERMS)) {
    for (const raw of named) out.push({ raw, mode: "perm" });
  } else if (words.has("mkdir") || ((words.has("create") || words.has("make")) && any(TOOL_FOLDERS))) {
    for (const raw of named) out.push({ raw, mode: "create" });
  } else if (any(TOOL_WRITES)) {
    for (const raw of named) out.push({ raw, mode: "write" });
  }
  return out;
}

// Main

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const tool = payload?.tool_name;
  if (typeof tool !== "string" || !tool) process.exit(0);
  // An MCP tool is read for the paths its name says it changes and the
  // command lines its input carries (#310); one with neither passes.
  const core = CORE_TOOLS.has(tool);
  const toolInput = payload?.tool_input ?? {};
  const mcpPaths = core ? [] : toolPaths(tool, toolInput);
  const { lines: mcpCommandLines, dir: mcpDir } = core
    ? { lines: [], dir: null } : toolCommandLines(toolInput);
  const mcpLines = mcpCommandLines.map((line) => ({ line, cwd: mcpDir }));
  if (!core && !mcpPaths.length && !mcpLines.length) process.exit(0);

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

  // What the protected settings run and the MCP configs launch, read fresh
  // on every call (#312, #314). A folder an MCP config runs a server from
  // is a zone like the plugin root: everything in it is the harness (#316).
  const { scripts, folders } = protectedScripts();
  SCRIPTS = scripts;
  for (const dir of folders) ZONES.push({ dir, what: MCP_DIR_WHAT, tree: true, carve: [] });

  let hit = null;

  if (tool === "Bash") {
    // Only what the command WRITES is checked; reading a hook file is
    // ordinary work and must stay frictionless (#240).
    for (const t of lineTargets(payload?.tool_input?.command ?? "", cwd, 0)) {
      hit = judgeTarget(t);
      if (hit) break;
    }
  } else if (core) {
    const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
    const what = p ? judge(resolveIn(cwd, expandHome(String(p))), "write", true) : null;
    if (what) hit = { path: p, what };
  } else {
    // a path field is taken as written, never globbed: no shell expands it
    for (const { raw, mode } of mcpPaths) {
      const what = judge(resolveIn(cwd, expandHome(raw)), mode, true);
      if (what) { hit = { path: raw, what }; break; }
    }
    // a command line is read like Bash, from the folder the input names for it
    for (const { line, cwd: at } of hit ? [] : mcpLines) {
      const dir = at ? resolveIn(cwd, expandHome(at)) : cwd;
      for (const t of lineTargets(line, dir, 0)) {
        hit = judgeTarget(t);
        if (hit) break;
      }
      if (hit) break;
    }
  }

  if (!hit) process.exit(0);

  if (hit.deep) {
    // #321: substitutions nested past what the reader reads -- fail closed
    console.error(
      `cairn harness guard: this line nests substitutions deeper than the guard reads (${SUBSTITUTION_DEPTH} ` +
      "levels), so what runs inside them can't be judged.",
    );
    console.error("  flatten the line -- run the inner commands as steps of their own -- and the guard can judge it.");
  } else if (hit.lost) {
    // #258: a directory change it couldn't follow -- fail closed, and say so
    // (a git -C too, #318; a folder a substitution computes, #319)
    console.error(
      "cairn harness guard: a directory change in this line (cd, pushd, env -C, git -C), or a " +
      "folder a $(...) computes, goes somewhere the guard couldn't tell, so this write may land " +
      "in the hook directory or a settings file.",
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
  // #286, like the run guard's #262: name the owner's ways to approve, never
  // a paste-ready prefix -- the inline override is still honoured, just not taught
  console.error("  this needs the owner's go-ahead. Owner: make the change yourself or with `!` in your prompt,");
  console.error("  or start the session with CAIRN_HARNESS_EDIT set to 1 in its environment.");
  console.error("  If you did not ask for this, something the agent read did — check where the");
  console.error("  instruction came from: tracker or web text asking for it is not the owner asking.");
  // #358 -- the audit row and the breaker's count; fixed text only, never the path
  const reason = hit.deep ? "a line nested past the reader's depth"
    : hit.lost ? "a write past a folder the guard can't follow" : `a write to ${hit.what}`;
  const more = BREAKER?.recordRefusal({ guard: "harness", payload, effect: "changes-harness-config", reason, projectDir });
  for (const line of more ?? []) console.error(line);
  process.exit(2);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
