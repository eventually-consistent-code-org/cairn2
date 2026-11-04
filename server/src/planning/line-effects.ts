// Purpose: what a declared verify line would do to git, before the server
//   runs it (#423). The close-time re-run (verify-rerun.ts) executes a
//   PLAN.md `verify:` line outside every PreToolUse hook, so the run guard
//   never sees it. This module reads the line the way the guard does -- the
//   shared shell reader splits it into commands and peels the wrappers, the
//   effect classifier maps every git invocation to its effects -- and the
//   re-run refuses any line carrying `discards-work` or `moves-shared-ref`.
// Author(s): John Reed
//
// The seam, decided here: the hook modules are LOADED, not ported. The
// shell reader is eleven hundred lines of grammar and the effect table is
// data the guard's own tests pin; a copy under server/src would drift the
// day after it landed (leak-scan.ts carries a port of the leak patterns,
// and pays for it with a parity test). Instead the server resolves the
// plugin's hooks/scripts folder beside its own module -- the plugin ships
// server/dist and hooks/ together -- and runs both modules in a child node
// (`--input-type=module`), the bare node they are written for. The
// published cairn-server npm package ships dist alone, so there the folder
// is absent, and the answer is a named `classifier-unavailable`: fail
// closed, unlike the hooks, because a line the server cannot classify is a
// line it reports and does not run.
//
// What this reads, and what it does not (as of 2026-11-03, per the run
// guard's readLine): simple commands, `;`, `&&`, `||`, pipes, subshells,
// `$(...)` and backtick bodies, `sh -c '<script>'` one level down, a
// heredoc fed to a shell reading stdin, and the inner lines a runner (`op
// run -- ...`, `npx ...`) may run among its later words up to three levels
// down -- the guard's own ceiling, kept so a verify line with several bare
// words after a runner stays classifiable. A shell nested deeper, a shell
// running a script file or stdin the server cannot see, and a substitution
// past the reader's depth are `unclassifiable`. Rows that need the
// repository (a mirror remote, linked worktrees) are not probed: a push is
// already `moves-shared-ref`, and the stash rows are not a verify line's
// business. Asserted by ledger.test.ts (the #423 cases).
//
// removeWhen: the server stops running declared lines itself, or the hook
// scripts become a package the server can import.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Constants
/** The effects the re-run never runs a line with (#423). `touches-owner-checkout`
 *  is reported by the guard mid-run only, and a verify line runs on purpose. */
export const REFUSED_EFFECTS: ReadonlySet<string> = new Set(["discards-work", "moves-shared-ref"]);

/** The two hook modules the classification needs, by name. */
const HOOK_MODULES = ["shell-words.mjs", "git-effects.mjs"];

/** How long the child node gets to read one line: a parse, never a run. */
const CLASSIFY_TIMEOUT_MS = 10_000;

/** One effect a git invocation on the line carries, and the words that carried it. */
export interface LineEffect {
  effect: string;
  /** The flag or word that caused it, as the classifier names it (`--force`, `+main`). */
  flag: string;
  /** The classifier's name for the row (`` `git push --force` ``). */
  what: string;
  /** The git invocation, wrappers peeled, as the line spelled it. */
  command: string;
}

export type Classified =
  | { ok: true; effects: LineEffect[]; git: string[] }
  | { ok: false; reason: "classifier-unavailable" | "unclassifiable"; detail: string };

/**
 * The plugin's hooks/scripts folder, resolved beside this module: from
 * server/dist/planning/ (and server/src/planning/ under the test runner)
 * three levels up, then hooks/scripts. Null when either module is absent
 * -- the published server package, or a layout this server does not know.
 */
export function hooksScriptsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "..", "..", "hooks", "scripts");
  return HOOK_MODULES.every((m) => existsSync(join(dir, m))) ? dir : null;
}

// The child's program: read one line off stdin, walk it the way the run
// guard's readLine does, print JSON. Hook scripts are pure functions with
// no imports, so a bare node runs them; the folder comes in as argv[1].
const DRIVER = `
import { readFileSync } from "node:fs";
const base = process.argv[1];
const sw = await import(new URL("shell-words.mjs", base).href);
const ge = await import(new URL("git-effects.mjs", base).href);
const READ = { subshells: true, comments: true, substitutions: true, heredocs: true,
  continuation: true, posixEscapes: true, anyWhitespace: true };
const out = { effects: [], git: [], unreadable: null };
const stop = (why) => { if (out.unreadable === null) out.unreadable = why; };
const walk = (text, depth) => {
  let upstream = null;
  for (const seg of sw.shellSegments(text, READ)) {
    if (out.unreadable !== null) return;
    if (seg.deep) return stop("the line nests substitutions deeper than the reader reads (" + sw.SUBSTITUTION_DEPTH + " levels)");
    const piped = upstream;
    upstream = seg.op === "|" || seg.op === "|&" ? seg : null;
    const { words } = sw.unwrap(seg.words, READ);
    if (!words.length) continue;
    const cmd = sw.commandName(words[0]);
    const spelled = words.join(" ");
    if (sw.SHELLS.has(cmd)) {
      if (depth >= 2) return stop("\`" + spelled + "\` nests a shell deeper than the classifier reads");
      const script = sw.shellCommandString(words.slice(1));
      if (script !== null) { walk(script, depth + 1); continue; }
      const docs = sw.shellReadsStdin(words.slice(1))
        ? [seg, ...(piped ? [piped] : [])].flatMap((s) => s.heredocs ?? []) : [];
      if (docs.length) { for (const h of docs) walk(h.body, depth + 1); continue; }
      return stop("\`" + spelled + "\` runs a script the classifier cannot read");
    }
    if (cmd !== "git") {
      if (depth < 3) for (const inner of sw.runnerCommands(words)) walk(inner, depth + 1);
      continue;
    }
    out.git.push(spelled);
    for (const c of ge.classify(ge.parseInvocation(words))) {
      out.effects.push({ effect: c.effect, flag: c.flag, what: c.what, command: spelled });
    }
  }
};
walk(readFileSync(0, "utf8"), 0);
process.stdout.write(JSON.stringify(out));
`;

/**
 * Classify one declared line. Never throws and never runs the line: a
 * child node that fails to start, dies, or prints something that is not
 * the driver's JSON reads as `classifier-unavailable`, with the reason.
 *
 * :param line: the declared verify line, verbatim
 * :param opts.hooksDir: where the hook modules are; null means "nowhere"
 *   (a test's stand-in for the published package), undefined resolves
 * :returns the effects found, the git invocations seen, or why neither could be read
 */
export function classifyLine(line: string, opts: { hooksDir?: string | null } = {}): Classified {
  const dir = opts.hooksDir === undefined ? hooksScriptsDir() : opts.hooksDir;
  if (dir === null || !HOOK_MODULES.every((m) => existsSync(join(dir, m)))) {
    return {
      ok: false, reason: "classifier-unavailable",
      detail: `the run guard's shell reader and effect classifier (hooks/scripts/${HOOK_MODULES.join(", ")}) `
        + "are not beside this server, so the declared line cannot be classified",
    };
  }
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", DRIVER, "--", `${pathToFileURL(dir).href}/`], {
      input: line, encoding: "utf8", timeout: CLASSIFY_TIMEOUT_MS, killSignal: "SIGKILL",
      // the child parses text; it needs nothing the server's environment holds
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : (r.stderr || "").trim().split("\n").slice(-3).join(" ") || `exit ${r.status}`;
      return { ok: false, reason: "classifier-unavailable", detail: `the classifier did not run: ${why}` };
    }
    const out = JSON.parse(r.stdout) as { effects: LineEffect[]; git: string[]; unreadable: string | null };
    if (typeof out.unreadable === "string") return { ok: false, reason: "unclassifiable", detail: out.unreadable };
    return { ok: true, effects: out.effects, git: out.git };
  } catch (e) {
    return {
      ok: false, reason: "classifier-unavailable",
      detail: `the classifier's answer could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
