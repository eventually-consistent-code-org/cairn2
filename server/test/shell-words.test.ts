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
  WRAPPERS, SHELLS, braceExpand, commandName, shellSegments, unwrap, shellCommandString, shellReadsStdin,
  suCommandString,
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
    expect(words("(a) `b` c", { subshells: true })).toEqual([["a"], ["b"], ["c"]]);
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
