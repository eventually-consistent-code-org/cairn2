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
  WRAPPERS, shellSegments, unwrap, shellCommandString, shellReadsStdin, suCommandString,
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

  it("covers the wrappers the issue names", () => {
    for (const w of ["sudo", "doas", "env", "nice", "timeout", "xargs", "stdbuf", "exec", "time", "nohup"]) {
      expect(WRAPPERS.has(w), w).toBe(true);
    }
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
