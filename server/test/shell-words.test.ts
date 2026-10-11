/**
 * Purpose: #270 -- the shell reader both PreToolUse guards share. Pins what
 *   each `read` option turns on, that heredoc bodies stay data on their
 *   segment, and how unwrap / shellCommandString find the real command.
 *   The guards' own suites pin the allow/refuse results end to end; this
 *   pins the module they both stand on, so a fix is tested once.
 * Author(s): John Reed
 */

import { describe, it, expect } from "vitest";
import {
  WRAPPERS, SHELLS, ARG_SAFE, braceExpand, commandName, shellSegments, unwrap, shellCommandString,
  shellReadsStdin, suCommandString, runnerCommands, argCommands, pagerCommands, toolCommandLines,
// @ts-expect-error untyped hook module
} from "../../hooks/scripts/shell-words.mjs";

type Seg = { words: string[]; redirects: string[]; heredocs: Array<{ delim: string; body: string }> };

/** Just the words of each segment, for the cases that only split. */
const words = (command: string, read: Record<string, boolean> = {}): string[][] =>
  (shellSegments(command, read) as Seg[]).map((s) => s.words);

describe("shellSegments", () => {
  it("quoted text stays inside its word; ; & | and newlines always split", () => {
    expect(words('git commit -m "explain git reset --hard"'))
      .toEqual([["git", "commit", "-m", "explain git reset --hard"]]);
    expect(words("a 'b c' d\\ e")).toEqual([["a", "b c", "d e"]]);
    expect(words("a; b && c || d | e & f\ng")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
  });

  it("each read option turns on exactly the feature it names", () => {
    expect(words("(a) `b` c", {})).toEqual([["(a)", "`b`", "c"]]);
    expect(words("(a) `b` c", { subshells: true })).toEqual([["a"], ["`b`", "c"]]);
    expect(words("a # b", {})).toEqual([["a", "#", "b"]]);
    expect(words("a # b\nc", { comments: true })).toEqual([["a"], ["c"]]);
    expect(words('echo "$(rm x)"', {})).toEqual([["echo", "$(rm x)"]]);
    expect(words('echo "$(rm x)" "`ls`"', { substitutions: true }))
      .toEqual([["echo", "$(rm x)", "`ls`"], ["rm", "x"], ["ls"]]);
    expect(words("a \\\nb", {})).toEqual([["a", "\\"], ["b"]]);
    expect(words("a \\\nb", { continuation: true })).toEqual([["a", "b"]]);
    expect(words('"a\\b"', {})).toEqual([["ab"]]);
    expect(words('"a\\b"', { posixEscapes: true })).toEqual([["a\\b"]]);
    expect(words("a\rb", {})).toEqual([["a\rb"]]);
    expect(words("a\rb", { anyWhitespace: true })).toEqual([["a", "b"]]);
  });

  // #319: an unquoted $(...) or backtick ended a segment, so `cp $(x)
  // hooks/hooks.json` read as three commands and the literal target was
  // never a cp operand. A substitution is one word now, whatever `read` says.
  it("an unquoted substitution is one word of its command, never a segment break (#319)", () => {
    const sub = { subshells: true, substitutions: true, redirects: true };
    expect(words("cp $(echo evil.json) hooks/hooks.json", sub))
      .toEqual([["cp", "$(echo evil.json)", "hooks/hooks.json"], ["echo", "evil.json"]]);
    expect(words("git checkout $(git rev-parse HEAD~1) -- hooks/hooks.json", sub))
      .toEqual([["git", "checkout", "$(git rev-parse HEAD~1)", "--", "hooks/hooks.json"],
        ["git", "rev-parse", "HEAD~1"]]);
    expect(words("git reset `git rev-parse HEAD~1` --hard", sub))
      .toEqual([["git", "reset", "`git rev-parse HEAD~1`", "--hard"], ["git", "rev-parse", "HEAD~1"]]);
    // nesting, inner quotes and a substitution joined to a word
    expect(words("rm -rf $(dirname \"$(pwd)/x)y\")/hooks", sub))
      .toEqual([["rm", "-rf", "$(dirname \"$(pwd)/x)y\")/hooks"], ["dirname", "$(pwd)/x)y"], ["pwd"]]);
    expect(words("echo foo$(x)bar `y`z", sub)).toEqual([["echo", "foo$(x)bar", "`y`z"], ["x"], ["y"]]);
    // arithmetic and process substitution are words with no command line inside
    expect(words("echo $((1+2)) >(cat)", sub)).toEqual([["echo", "$((1+2))", ">(cat)"]]);
    expect(words("diff <(sort a) <(sort b)", sub)).toEqual([["diff", "<(sort a)", "<(sort b)"]]);
    // a redirect past a substitution is still a redirect
    const [seg] = shellSegments("echo x > $(pwd)/hooks/hooks.json", sub) as Seg[];
    expect(seg.words).toEqual(["echo", "x"]);
    expect(seg.redirects).toEqual(["$(pwd)/hooks/hooks.json"]);
    // the body is queued only when substitutions are read; the word stays whole either way
    expect(words("cp $(echo a) b", { subshells: true })).toEqual([["cp", "$(echo a)", "b"]]);
    expect(words("cp $(echo a) b", {})).toEqual([["cp", "$(echo a)", "b"]]);
    // a subshell run as a command is still a break
    expect(words("(cd x && rm -rf hooks); echo $(date)", sub))
      .toEqual([["cd", "x"], ["rm", "-rf", "hooks"], ["echo", "$(date)"], ["date"]]);
  });

  it("redirects: targets are collected, descriptors and input are not", () => {
    const [seg] = shellSegments("cmd 2>&1 >out 2>>err &>both < in <<< str", { redirects: true }) as Seg[];
    expect(seg.words).toEqual(["cmd"]);
    expect(seg.redirects).toEqual(["out", "err", "both"]);
    expect(words("cmd > out", {})).toEqual([["cmd", ">", "out"]]);
  });

  it("redirects: `< file` and here-string text are kept apart from the words (#265)", () => {
    const [seg] = shellSegments("patch -p1 < fix.diff <<< 'rm x'", { redirects: true }) as Array<
      Seg & { inputs: string[]; herestrings: string[] }>;
    expect(seg.words).toEqual(["patch", "-p1"]);
    expect(seg.inputs).toEqual(["fix.diff"]);
    expect(seg.herestrings).toEqual(["rm x"]);
  });

  it("redirects: a heredoc body is data, kept on the segment that opened it", () => {
    const segs = shellSegments("cat <<'EOF' > f\nrm x\nEOF\nls", { redirects: true }) as Seg[];
    expect(segs.map((s) => s.words)).toEqual([["cat"], ["ls"]]);
    expect(segs[0].redirects).toEqual(["f"]);
    expect(segs[0].heredocs).toEqual([{ delim: "EOF", body: "rm x\n" }]);
    // <<- matches a tab-indented delimiter line
    const tabbed = shellSegments("cat <<-END\n\tbody\n\tEND\nls", { redirects: true }) as Seg[];
    expect(tabbed.map((s) => s.words)).toEqual([["cat"], ["ls"]]);
  });
});

describe("shellSegments: operators (#258)", () => {
  it("each segment names the operator that ended it, so a pipeline is told from a list", () => {
    const ops = (line: string) => (shellSegments(line, { redirects: true }) as Array<Seg & { op: string | null }>)
      .map((s) => [s.words[0], s.op]);
    expect(ops("a | b |& c || d && e ; f & g\nh")).toEqual([
      ["a", "|"], ["b", "|&"], ["c", "||"], ["d", "&&"], ["e", ";"], ["f", "&"], ["g", "\n"], ["h", null],
    ]);
    expect(ops("a||b&&c|d")).toEqual([["a", "||"], ["b", "&&"], ["c", "|"], ["d", null]]);
  });
});

describe("shellSegments: reserved words and grouping (#285)", () => {
  /** The command words found anywhere in the line, after unwrap. */
  const commands = (line: string): string[][] =>
    (shellSegments(line, { subshells: true }) as Seg[]).map((s) => unwrap(s.words).words);

  it("a keyword, a group or a loop header never stands in for the command word", () => {
    for (const line of [
      "if git reset --hard; then :; fi",
      "{ git reset --hard; }",
      "! git reset --hard",
      "while git reset --hard; do :; done",
      "until git reset --hard; do :; done",
      "if true; then git reset --hard; fi",
      "if a; then b; elif git reset --hard; then :; else c; fi",
      "if a; then b; else git reset --hard; fi",
      "for i in 1; do git reset --hard; done",
      "for i do git reset --hard; done",
      "select x in a b; do git reset --hard; done",
      "case x in x) git reset --hard;; esac",
      "true && { git reset --hard; }",
      "function f { git reset --hard; }; f",
      "function f() { git reset --hard; }",
      "f() { git reset --hard; }",
      "time { git reset --hard; }",
      "time -p ! git reset --hard",
      "! time git reset --hard",
      "coproc git reset --hard",
      "coproc worker { git reset --hard; }",
    ]) {
      expect(commands(line), line).toContainEqual(["git", "reset", "--hard"]);
    }
  });

  it("the plain neighbours read the same command, and a loop header is never one", () => {
    expect(commands("if git status; then :; fi")).toEqual([["git", "status"], [":"], []]);
    expect(commands("{ git status; }")).toEqual([["git", "status"], []]);
    expect(commands('for f in *; do cat "$f"; done')).toEqual([[], ["cat", "$f"], []]);
    // the word list is data, even when a word in it names a command
    expect(commands("for x in rm -rf hooks; do echo $x; done")).toEqual([[], ["echo", "$x"], []]);
    // only command position counts: an argument named `if` is an argument
    expect(commands("echo if then { git reset --hard")).toEqual([["echo", "if", "then", "{", "git", "reset", "--hard"]]);
  });

  it("the words it skips are kept on the segment as `reserved`", () => {
    const segs = shellSegments("if cd x; then rm y; fi", { subshells: true }) as Array<Seg & { reserved: string[] }>;
    expect(segs.map((s) => [s.reserved, s.words])).toEqual([
      [["if"], ["cd", "x"]], [["then"], ["rm", "y"]], [["fi"], []],
    ]);
  });
});

describe("unwrap", () => {
  it("skips a wrapper's flag values and basenames the wrapper (#254, #270)", () => {
    for (const line of [
      "sudo -u root git reset --hard",
      "/usr/bin/sudo -n git reset --hard",
      "timeout -s KILL 5 git reset --hard",
      "nice -n 5 git reset --hard",
      "env -u FOO git reset --hard",
      "stdbuf -o0 git reset --hard",
      "doas -u root git reset --hard",
      "xargs -n 1 git reset --hard",
      "nohup sudo -u root env -i nice -n 1 git reset --hard",
      "env -S 'git reset --hard'",
    ]) {
      const [seg] = shellSegments(line) as Seg[];
      expect(unwrap(seg.words).words, line).toEqual(["git", "reset", "--hard"]);
    }
  });

  it("collects every assignment on the way in, and files a wrapper writes", () => {
    const r = unwrap(["A=1", "sudo", "B=2", "env", "-i", "C=3", "time", "-o", "log", "cmd", "D=4"]);
    expect(r.words).toEqual(["cmd", "D=4"]);
    expect(r.assigns).toEqual(["A=1", "B=2", "C=3"]);
    expect(r.writes).toEqual(["log"]);
  });

  it("reports each wrapper peeled with the option words it took (#258)", () => {
    const r = unwrap(["sudo", "-u", "root", "xargs", "-n", "1", "-I{}", "rm", "{}"]);
    expect(r.words).toEqual(["rm", "{}"]);
    expect(r.wrappers).toEqual([{ name: "sudo", args: ["-u", "root"] }, { name: "xargs", args: ["-n", "1", "-I{}"] }]);
  });

  it("reports the folders env -C and sudo -D move the command into, in order (#258)", () => {
    expect(unwrap(["env", "-C", "hooks", "sh", "-c", "x"]).dirs).toEqual(["hooks"]);
    expect(unwrap(["env", "-iC/a", "--chdir=b", "rm", "x"]).dirs).toEqual(["/a", "b"]);
    expect(unwrap(["sudo", "-D", "/srv", "env", "--chdir", "sub", "rm", "x"]).dirs).toEqual(["/srv", "sub"]);
    expect(unwrap(["sudo", "--chdir=/srv", "rm", "x"]).dirs).toEqual(["/srv"]);
    // other wrappers' -C / -D are not folders: doas -C is a config file
    expect(unwrap(["doas", "-C", "conf", "rm", "x"]).dirs).toEqual([]);
    expect(unwrap(["env", "-u", "C", "rm", "x"]).dirs).toEqual([]);
  });

  it("an xargs flag whose value is optional never swallows the command (#285)", () => {
    for (const args of [
      ["--replace", "rm", "{}"],
      ["--replace=R", "rm", "R"],
      ["-i", "rm", "{}"],
      ["-iP", "rm", "P"], // P is -P's letter, but here it is -i's replace string
      ["-I", "R", "rm", "R"],
      ["--eof", "rm", "{}"],
      ["-e", "rm", "{}"],
      ["--max-lines", "rm", "{}"],
      ["-l", "rm", "{}"],
      ["--process-slot-var", "N", "rm", "{}"],
      ["-J", "%", "rm", "{}"], // BSD xargs, as macOS ships it
      ["-R", "1", "-I", "R", "rm", "{}"],
    ]) {
      expect(unwrap(["xargs", ...args]).words[0], args.join(" ")).toBe("rm");
    }
    expect(unwrap(["xargs", "--replace", "echo", "{}"]).words).toEqual(["echo", "{}"]);
  });

  it("macOS env -P takes its PATH, and zsh's noglob, nocorrect and repeat N are prefixes (#258)", () => {
    for (const line of [
      "env -P /usr/bin git reset --hard",
      "env -iP/usr/bin git reset --hard",
      "noglob git reset --hard",
      "nocorrect git reset --hard",
      "repeat 2 git reset --hard",
      "repeat 2 do git reset --hard; done",
      "repeat 2 { git reset --hard; }",
      "time repeat 2 git reset --hard",
    ]) {
      const cmds = (shellSegments(line, { subshells: true }) as Seg[]).map((s) => unwrap(s.words).words);
      expect(cmds, line).toContainEqual(["git", "reset", "--hard"]);
    }
  });

  it("covers the wrappers the issue names", () => {
    for (const w of ["sudo", "doas", "env", "nice", "timeout", "xargs", "stdbuf", "exec", "time", "nohup"]) {
      expect(WRAPPERS.has(w), w).toBe(true);
    }
  });
});

describe("unwrap: a wrapper in any letter case (#300)", () => {
  /** The command words of a line once the wrappers are peeled. */
  const peeled = (line: string): string[] => unwrap((shellSegments(line) as Seg[])[0].words).words;

  it("commandName drops the path and folds the case the way a Mac finds the program", () => {
    expect(commandName("GIT")).toBe("git");
    expect(commandName("/usr/bin/Git")).toBe("git");
    expect(commandName("SUDO")).toBe("sudo");
    expect(commandName("ſudo")).toBe("sudo"); // APFS reads the long s as s
    expect(commandName("git")).toBe("git");
    expect(commandName(undefined)).toBe("");
    expect(SHELLS.has(commandName("/bin/BASH"))).toBe(true);
  });

  it("each capitalised wrapper is peeled like its lowercase form", () => {
    // Each row: [capitalised, lowercase] -- the same command underneath
    const rows: Array<[upper: string, lower: string]> = [
      ["SUDO git reset --hard", "sudo git reset --hard"],
      ["/usr/bin/SUDO -u root git reset --hard", "/usr/bin/sudo -u root git reset --hard"],
      ["Sudo -u root GIT reset --hard", "sudo -u root GIT reset --hard"],
      ["ENV -i git reset --hard", "env -i git reset --hard"],
      ["Env -u FOO git reset --hard", "env -u FOO git reset --hard"],
      ["XARGS -n 1 git reset --hard", "xargs -n 1 git reset --hard"],
      ["TIMEOUT -s KILL 5 git reset --hard", "timeout -s KILL 5 git reset --hard"],
      ["NICE -n 5 git reset --hard", "nice -n 5 git reset --hard"],
      ["NOHUP DOAS -u root STDBUF -o0 git reset --hard", "nohup doas -u root stdbuf -o0 git reset --hard"],
      ["ENV -S 'git reset --hard'", "env -S 'git reset --hard'"],
      ["ſudo git reset --hard", "sudo git reset --hard"],
    ];
    for (const [upper, lower] of rows) {
      expect(peeled(upper), upper).toEqual(peeled(lower));
      expect(peeled(upper)[0].toLowerCase(), upper).toBe("git");
    }
  });

  it("a capitalised wrapper of a harmless command peels the same way", () => {
    expect(peeled("SUDO GIT status")).toEqual(["GIT", "status"]);
    expect(peeled("ENV -i git status")).toEqual(["git", "status"]);
    expect(peeled("XARGS echo")).toEqual(["echo"]);
  });

  it("reports wrappers and what they write under the folded name", () => {
    const r = unwrap(["SUDO", "-u", "root", "XARGS", "-I{}", "rm", "{}"]);
    expect(r.wrappers).toEqual([{ name: "sudo", args: ["-u", "root"] }, { name: "xargs", args: ["-I{}"] }]);
    expect(unwrap(["TIME", "-o", "log", "cmd"]).writes).toEqual(["log"]);
    expect(unwrap(["ENV", "-C", "hooks", "rm", "x"]).dirs).toEqual(["hooks"]);
    expect(unwrap(["SUDO", "-D", "/srv", "rm", "x"]).dirs).toEqual(["/srv"]);
  });
});

// #307: program runners outside the table (xcrun, arch, caffeinate, script,
// gtimeout, flock ...) read as the command itself, so the git or rm they ran
// reached no rule in either guard. Each is peeled now, flag values and all,
// next to the same runner around a harmless command.
describe("unwrap: program runners (#307)", () => {
  /** The command words of each segment of a line, wrappers peeled. */
  const peeled = (line: string): string[][] =>
    (shellSegments(line) as Seg[]).map((s) => unwrap(s.words).words);

  it("each runner is peeled to the command it runs, its harmless twin too", () => {
    const rows: Array<[runner: string]> = [
      ["xcrun"],
      ["xcrun --sdk macosx"],
      ["xcrun -sdk iphoneos -toolchain swift"],
      ["arch -arm64"],
      ["arch -x86_64 -i386"],
      ["arch -arch arm64e -c"],
      ["arch -e FOO=1 -d BAR"],
      ["arch -arm64e"], // the e is the arch name, not -e
      ["caffeinate -i"],
      ["caffeinate -dimsu -t 60 -w 123"],
      ["script -q /dev/null"],
      ["script -a -t 30 /tmp/log"],
      ["script -F -k /tmp/log"],
      ["gtimeout 10"],
      ["gtimeout -s KILL -k 2 10"],
      ["flock /tmp/l"],
      ["flock -n -w 5 -E 3 /tmp/l"],
      ["flock --timeout 5 9"],
      ["taskpolicy -b -c utility -t 4 -l 4"],
      ["sandbox-exec -f prof.sb -D A=1"],
      ["sandbox-exec -n no-network"],
      ["chroot -u me /"],
      ["chroot --userspec=a:b /"],
      ["unbuffer -p"],
      ["ionice -c 3 -n 7"],
      ["chrt -f 10"],
      ["taskset -c 0-3"],
      ["genv -i"],
      ["gnice -n 5"],
      ["gstdbuf -oL"],
      ["gnohup"],
    ];
    for (const [runner] of rows) {
      expect(peeled(`${runner} git reset --hard`), runner).toEqual([["git", "reset", "--hard"]]);
      expect(peeled(`${runner} git status`), runner).toEqual([["git", "status"]]);
    }
  });

  it("script -c, flock -c and watch hand a shell the command line, which both guards read", () => {
    const rows: Array<[line: string, script: string]> = [
      ["script -q -c 'git reset --hard' /dev/null", "git reset --hard"],
      ["script /tmp/log -c 'git reset --hard'", "git reset --hard"],
      ["script -t -c 'git reset --hard'", "git reset --hard"], // util-linux -t has no separate value
      ["script --command='git status; git reset --hard'", "git status; git reset --hard"],
      ["flock /tmp/l -c 'git reset --hard'", "git reset --hard"],
      ["flock -w 5 /tmp/l --command 'git reset --hard'", "git reset --hard"],
      ["flock /tmp/l --command='git reset --hard'", "git reset --hard"],
      ["watch -n 1 git reset --hard", "git reset --hard"],
      ["watch -d 'git status; git reset --hard'", "git status; git reset --hard"],
    ];
    for (const [line, script] of rows) {
      const [words] = peeled(line);
      expect(words, line).toEqual(["sh", "-c", script]);
      expect(shellCommandString(words.slice(1)), line).toBe(script);
    }
  });

  it("script reports the typescript and log files it writes; a playback or a flush interval writes none", () => {
    const writes = (words: string[]) => unwrap(words).writes;
    expect(writes(["script", "-q", "hooks/a", "ls"])).toEqual(["hooks/a"]);
    expect(writes(["script", "-a", "-t", "30", "log", "ls"])).toEqual(["log"]);
    expect(writes(["script", "-t0", "log", "ls"])).toEqual(["log"]);
    expect(writes(["script", "-O", "out", "-B", "io", "--log-timing", "tm", "-c", "ls"])).toEqual(["out", "io", "tm"]);
    expect(writes(["script", "--timing=tm", "-c", "ls", "log"])).toEqual(["tm", "log"]);
    expect(writes(["script", "-p", "hooks/a"])).toEqual([]);
    expect(writes(["script", "-dp", "hooks/a"])).toEqual([]);
    expect(writes(["flock", "/tmp/l", "ls"])).toEqual([]);
  });

  it("arch -e is an assignment the command runs with, like env's", () => {
    expect(unwrap(["arch", "-e", "GIT_DIR=../x/.git", "-arm64", "git", "push"]).assigns).toEqual(["GIT_DIR=../x/.git"]);
    expect(unwrap(["arch", "-d", "HOME", "git", "push"]).assigns).toEqual([]);
  });

  it("a g-prefixed GNU tool is reported under its plain name, and keeps its own rules", () => {
    const r = unwrap(["GTIMEOUT", "5", "gxargs", "-I{}", "genv", "-C", "hooks", "gtime", "-o", "log", "rm", "{}"]);
    expect(r.words).toEqual(["rm", "{}"]);
    expect(r.wrappers.map((x: { name: string }) => x.name)).toEqual(["timeout", "xargs", "env", "time"]);
    expect(r.dirs).toEqual(["hooks"]);
    expect(r.writes).toEqual(["log"]);
  });

  it("covers the runners the issue names", () => {
    for (const w of ["xcrun", "arch", "caffeinate", "script", "gtimeout", "flock"]) {
      expect(WRAPPERS.has(w), w).toBe(true);
    }
  });
});

describe("braceExpand (#258)", () => {
  it("spells out comma lists and sequences the way bash does", () => {
    expect(braceExpand("{hooks,}")).toEqual(["hooks", ""]);
    expect(braceExpand("a/{b,c}/d")).toEqual(["a/b/d", "a/c/d"]);
    expect(braceExpand("{a,{b,c}}x")).toEqual(["ax", "bx", "cx"]);
    expect(braceExpand("{x,y}{1,2}")).toEqual(["x1", "x2", "y1", "y2"]);
    expect(braceExpand("hook{r..t}")).toEqual(["hookr", "hooks", "hookt"]);
    expect(braceExpand("f{3..1}")).toEqual(["f3", "f2", "f1"]);
  });

  it("leaves what bash leaves: a parameter, an empty brace, a single word", () => {
    for (const w of ["${HOME}", "${a,b}", "{}", "{x}", "-I{}", "a{b", "{1..z}", "plain"]) {
      expect(braceExpand(w), w).toEqual([w]);
    }
  });

  it("past its cap, the rest of a brace is the stand-in the caller passes", () => {
    expect(braceExpand("f{1..1000}", "*")).toEqual(["f*"]);
    const many = braceExpand(`{${Array.from({ length: 70 }, (_, i) => `n${i}`).join(",")}}`, "*");
    expect(many).toEqual(["*"]);
  });
});

describe("shellCommandString", () => {
  it("finds the -c string after any options, and never mistakes a script path for one", () => {
    expect(shellCommandString(["-lc", "x"])).toBe("x");
    expect(shellCommandString(["-o", "pipefail", "-c", "x"])).toBe("x");
    expect(shellCommandString(["-c", "-x", "x"])).toBe("x");
    expect(shellCommandString(["-c", "--", "x"])).toBe("x");
    expect(shellCommandString(["script.sh", "-c", "x"])).toBeNull();
    expect(shellCommandString(["-x", "script.sh"])).toBeNull();
  });
});

describe("shellReadsStdin (#258)", () => {
  it("a shell with no -c and no script, or with -s, reads its commands from stdin", () => {
    expect(shellReadsStdin([])).toBe(true);
    expect(shellReadsStdin(["-x"])).toBe(true);
    expect(shellReadsStdin(["-s", "arg"])).toBe(true);
    expect(shellReadsStdin(["-o", "pipefail"])).toBe(true);
    expect(shellReadsStdin(["-c", "x"])).toBe(false);
    expect(shellReadsStdin(["script.sh"])).toBe(false);
    expect(shellReadsStdin(["--", "script.sh"])).toBe(false);
  });
});

describe("toolCommandLines (#310, #311)", () => {
  /** Just the lines of the shared MCP-field reader, for the cases that don't check the folder. */
  const lines = (input: Record<string, unknown>): string[] => toolCommandLines(input).lines;

  it("finds the command lines an MCP tool's input hands a shell, and the folder it names", () => {
    expect(toolCommandLines({ command: "rm -rf hooks", timeout_ms: 5 }))
      .toEqual({ lines: ["rm -rf hooks"], dir: null, concurrent: false });
    expect(toolCommandLines({ cmd: "ls", cwd: "src" })).toEqual({ lines: ["ls"], dir: "src", concurrent: false });
    expect(lines({ shell_command: "git status" })).toEqual(["git status"]);
    expect(lines({ commands: ["a", { label: "x", command: "b" }, { cmd: "c" }, 7] })).toEqual(["a", "b", "c"]);
    expect(lines({ language: "Shell", code: "echo x > y" })).toEqual(["echo x > y"]);
  });

  it("reads at the run guard's breadth: array command, arguments, script, code /bin/bash, every folder field (#311)", () => {
    expect(lines({ command: ["git", "reset", "--hard"] })).toEqual(["git reset --hard"]);
    expect(lines({ command: "rm", arguments: ["-rf", "hooks"] })).toEqual(["rm -rf hooks"]);
    expect(lines({ script: "rm -rf hooks" })).toEqual(["rm -rf hooks"]);
    expect(lines({ script: "rm -rf hooks", language: "javascript" })).toEqual([]);
    expect(lines({ lang: "bash", code: "rm -rf hooks" })).toEqual(["rm -rf hooks"]);
    expect(lines({ language: "/bin/bash", code: "rm -rf hooks" })).toEqual(["rm -rf hooks"]);
    for (const f of ["cwd", "workdir", "working_directory", "workingDirectory"]) {
      expect(toolCommandLines({ command: "ls", [f]: "d" }).dir, f).toBe("d");
    }
    expect(toolCommandLines({ commands: ["a", "b"], concurrency: 4 }).concurrent).toBe(true);
  });

  it("an args list follows its command word for word, quoted so each stays one word", () => {
    const [line] = lines({ command: "rm", args: ["-rf", "my hooks", "it's"] });
    expect(line).toBe("rm -rf 'my hooks' 'it'\\''s'");
    expect((shellSegments(line) as Seg[])[0].words).toEqual(["rm", "-rf", "my hooks", "it's"]);
  });

  it("code in another language, keystrokes, and inputs with no command field are not command lines", () => {
    expect(lines({ language: "python", code: "import os" })).toEqual([]);
    expect(lines({ pid: 1, input: "rm -rf hooks" })).toEqual([]);
    expect(lines({ path: "hooks/hooks.json" })).toEqual([]);
    expect(toolCommandLines(null as unknown as Record<string, unknown>)).toEqual({ lines: [], dir: null, concurrent: false });
    expect(lines({ command: 5 })).toEqual([]);
  });
});

describe("runnerCommands (#311)", () => {
  it("hands back the inner command an off-table runner's later words form", () => {
    const rows: Array<[words: string[], inner: string]> = [
      [["op", "run", "--", "git", "push", "origin", "feature:main"], "git push origin feature:main"],
      [["bundle", "exec", "rm", "-rf", "hooks"], "exec rm -rf hooks"],
      [["uv", "run", "pytest"], "run pytest"],
      [["bunx", "git", "reset", "--hard"], "git reset --hard"],
      [["tmux", "new-session", "-d", "git reset --hard"], "git reset --hard"],
      [["parallel", ":::", "git reset --hard"], "git reset --hard"],
      [["sg", "staff", "-c", "git reset --hard"], "git reset --hard"],
      [["osascript", "-e", 'do shell script "git reset --hard"'], "git reset --hard"],
      [["gdb", "-batch", "-ex", "run", "--args", "git", "reset", "--hard"], "git reset --hard"],
      [["lldb", "-b", "-o", "run", "--", "git", "reset", "--hard"], "git reset --hard"],
    ];
    for (const [words, inner] of rows) {
      expect(runnerCommands(words), words.join(" ")).toContain(inner);
    }
  });

  it("a program that only prints or searches its arguments runs none of them", () => {
    for (const safe of [["echo", "git reset --hard"], ["grep", "-rn", "git reset --hard", "docs"],
      ["gh", "issue", "create", "--title", "git reset --hard is refused"], ["cat", "git reset --hard"],
      ["printf", "git reset --hard"]]) {
      expect(runnerCommands(safe), safe.join(" ")).toEqual([]);
    }
    expect(ARG_SAFE.has("gh")).toBe(true);
    expect(ARG_SAFE.has("sh")).toBe(false); // a shell runs its args -- never arg-safe
    expect(runnerCommands(["strace"])).toEqual([]); // nothing after it
  });
});

// #315: man -P, gh alias set --shell and gh extension exec run an argument,
// yet ARG_SAFE exempted all of man's and gh's words. Each is modelled per
// option now -- the rest of the words stay data -- so gh pr create --body
// keeps passing while the one program-running value is read as a command.
describe("argCommands and pagerCommands (#315)", () => {
  const R = "git reset --hard";

  it("hands back the one value an ARG_SAFE program runs, in each spelling", () => {
    const rows: Array<[words: string[], inner: string]> = [
      [["man", "-P", R, "ls"], R],
      [["man", `-P${R}`, "ls"], R],
      [["man", "-aP", R, "ls"], R], // ends a cluster
      [["man", `--pager=${R}`, "ls"], R],
      [["man", "--pager", R, "ls"], R],
      [["man", "--pag", R, "ls"], R], // shortened, as getopt allows
      [["man", `-H${R}`, "ls"], R],
      [["gh", "alias", "set", "--shell", "r", R], R],
      [["gh", "alias", "set", "-s", "r", R], R],
      [["gh", "alias", "set", "r", "--shell", R], R],
      [["gh", "alias", "set", "r", `!${R}`], R],
      [["gh", "alias", "set", "--clobber", "-s", "r", "--", R], R],
      [["gh", "config", "set", "pager", R], R],
      [["gh", "config", "set", "-h", "github.com", "editor", R], R],
      [["gh", "extension", "exec", "evil", "--", "git", "reset", "--hard"], R],
      [["gh", "ext", "exec", "evil", "git", "reset", "--hard"], R],
      [["gh", "evil", "--", "git", "reset", "--hard"], R], // a word that isn't a gh command: an extension or alias
      [["rg", "--pre", R, "foo"], R],
      [["rg", `--pre=${R}`, "foo"], R],
      [["ag", "--pager", R, "foo"], R],
      [["ack", `--pager=${R}`, "foo"], R],
      [["sort", `--compress-program=${R}`, "x"], R],
    ];
    for (const [words, inner] of rows) {
      expect(argCommands(words), words.join(" ")).toContain(inner);
      expect(runnerCommands(words), words.join(" ")).toContain(inner); // reached through the backstop too
    }
    // rg runs --pre on each path it searches: that line is a candidate as well
    expect(argCommands(["rg", "--pre", "unzip", "x", "docs"])).toContain("unzip x docs .");
  });

  it("every other word of those programs stays data", () => {
    for (const safe of [
      ["man", "git-reset"], ["man", "-k", "reset"], ["man", "-M", `/P${R}`, "ls"],
      ["man", "-S", "1:P", "ls"], ["man", "--pager-x", R], // a longer option is a different one
      ["gh", "pr", "create", "--body", `never run ${R}`], ["gh", "alias", "set", "co", "pr checkout"],
      ["gh", "alias", "set", "rs", R], // no --shell: a gh command, not a shell line
      ["gh", "alias", "set", "--shell"], ["gh", "alias", "list"], ["gh", "alias", "delete", "r"],
      ["gh", "config", "get", "pager"], ["gh", "config", "set", "git_protocol", R],
      ["gh", "extension", "list"], ["gh", "extension", "install", "owner/gh-x"], ["gh", "extension", "exec"],
      ["gh", "--version"], ["gh", "issue", "view", "1", "--json", "title"],
      ["rg", "--pre-glob", "*.gz", "foo"], ["rg", "-n", R, "docs"], ["rg", "--pre"],
      ["ag", R], ["sort", "-k", "2", "x"], ["sort", "-t", "-", "x"], ["echo", "-P", R], ["grep", "--pager", R],
    ]) {
      expect(argCommands(safe), safe.join(" ")).toEqual([]);
      expect(runnerCommands(safe), safe.join(" ")).toEqual([]);
    }
    // a harmless pager is still handed back -- the guards find nothing in it
    expect(argCommands(["man", "-P", "less", "git"])).toEqual(["less"]);
  });

  // #317: `gh repo clone` plants a tree where it's told, like git clone
  // does, yet gh's words were all data. The clone is handed back as the
  // `git clone` line it runs, so the harness guard judges its folder the
  // way it judges git's -- and gh stays on ARG_SAFE for everything else.
  it("hands back the git clone a gh repo clone, fork --clone or create --clone runs", () => {
    const rows: Array<[words: string[], inner: string]> = [
      [["gh", "repo", "clone", "o/r", ".claude/skills/x"], "git clone o/r .claude/skills/x"],
      [["gh", "repo", "clone", "o/r"], "git clone o/r"], // lands in r, here
      [["gh", "repo", "clone", "-u", "up", "o/r", "x", "--", "--depth", "1"], "git clone --depth 1 o/r x"],
      [["gh", "repo", "fork", "o/skill", "--clone"], "git clone o/skill"],
      [["gh", "repo", "fork", "--clone", "o/skill", "--fork-name", "mine"], "git clone o/skill mine"],
      [["gh", "repo", "create", "o/x", "--clone", "--public"], "git clone o/x"],
    ];
    for (const [words, inner] of rows) {
      expect(argCommands(words), words.join(" ")).toEqual([inner]);
      expect(runnerCommands(words), words.join(" ")).toEqual([inner]);
    }
    for (const safe of [
      ["gh", "repo", "fork", "o/skill"], ["gh", "repo", "fork", "o/skill", "--clone=false"],
      ["gh", "repo", "create", "o/x", "--public"], ["gh", "repo", "view", "o/r"], ["gh", "repo", "clone"],
      ["gh", "pr", "create", "--body", "git clone x .claude/skills/x"],
    ]) {
      expect(argCommands(safe), safe.join(" ")).toEqual([]);
    }
    expect(ARG_SAFE.has("gh")).toBe(true);
  });

  it("a pager variable's value is a command line, set on a command, alone, or exported", () => {
    for (const name of ["PAGER", "MANPAGER", "GIT_PAGER", "GH_PAGER", "ACK_PAGER"]) {
      expect(pagerCommands([`${name}=${R}`], ["man", "ls"]), name).toEqual([R]);
      expect(pagerCommands([`${name}=${R}`], []), name).toEqual([R]);
      expect(pagerCommands([], ["export", `${name}=${R}`]), name).toEqual([R]);
    }
    expect(pagerCommands(["PAGER=cat"], ["git", "log"])).toEqual(["cat"]);
    expect(pagerCommands(["FOO=1", "PAGER="], ["man", "ls"])).toEqual([]);
    expect(pagerCommands(["GIT_DIR=/x", "EDITOR=vim"], ["git", "log"])).toEqual([]);
    expect(pagerCommands([], ["echo", "PAGER=x"])).toEqual([]);
    expect(pagerCommands(undefined, undefined)).toEqual([]);
  });
});

describe("unwrap: more program runners (#311)", () => {
  const peeled = (line: string): string[][] =>
    (shellSegments(line) as Seg[]).map((s) => unwrap(s.words).words);

  it("each clean prefix runner peels to the command it runs, its harmless twin too", () => {
    for (const runner of ["strace -f", "strace -o /tmp/t.log", "ltrace -e malloc", "valgrind --leak-check=full",
      "firejail --private", "unshare -r", "nsenter -t 1 -m --", "pkexec --user root", "runuser -u me --"]) {
      expect(peeled(`${runner} git reset --hard`), runner).toEqual([["git", "reset", "--hard"]]);
      expect(peeled(`${runner} git status`), runner).toEqual([["git", "status"]]);
    }
  });

  it("runuser -c and sg -c hand a shell the command line, which both guards read", () => {
    expect(peeled("runuser -u me -c 'git reset --hard'")).toEqual([["sh", "-c", "git reset --hard"]]);
    expect(peeled("sg staff -c 'git reset --hard'")).toEqual([["sh", "-c", "git reset --hard"]]);
    expect(peeled("strace -o hooks/log ls")[0]).toEqual(["ls"]);
    expect(unwrap(["strace", "-o", "hooks/log", "ls"]).writes).toEqual(["hooks/log"]);
  });

  it("covers the clean runners #311 adds to the table", () => {
    for (const w of ["strace", "ltrace", "valgrind", "firejail", "unshare", "nsenter", "pkexec", "runuser", "sg"]) {
      expect(WRAPPERS.has(w), w).toBe(true);
    }
  });
});

describe("suCommandString (#258)", () => {
  it("finds su's command string wherever the -c sits, and skips value flags", () => {
    expect(suCommandString(["-c", "x"])).toBe("x");
    expect(suCommandString(["-", "root", "-c", "x"])).toBe("x");
    expect(suCommandString(["root", "-c", "x"])).toBe("x");
    expect(suCommandString(["-lc", "x"])).toBe("x");
    expect(suCommandString(["--command=x"])).toBe("x");
    expect(suCommandString(["--command", "x"])).toBe("x");
    expect(suCommandString(["-s", "/bin/sh", "-c", "x", "root"])).toBe("x");
    expect(suCommandString(["-s", "-c"])).toBeNull(); // -s took "-c" as the shell
    expect(suCommandString(["-", "root"])).toBeNull();
  });
});
