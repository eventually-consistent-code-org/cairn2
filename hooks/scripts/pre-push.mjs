#!/usr/bin/env node

/**
 * Purpose: the git layer of the ship gate (#456) -- a pre-push hook that
 *   applies the run guard's default-branch rule to every process that runs
 *   `git push` in the checkout, whatever launched it: a human's terminal, a
 *   harness wired for skills but not hooks, a script that shells out to
 *   git. The run guard sees a push only through the Bash tool of the one
 *   harness it is installed in; this sees the push itself. Installed by
 *   `cairn-setup <harness> --git-hooks` (opt-in: the flag is the owner's
 *   consent to a git-config write) as a thin caller: the effect comes from
 *   git-effects.mjs's table, the stamp and the default-branch names from
 *   lib.mjs, the refusal text is the run guard's. No rule lives here
 *   (asserted: sweep-surface.test.ts "(#456)"; the pushes from a plain
 *   shell: setup.test.ts "(#456)").
 *
 *   git hands a pre-push hook the remote's name and URL as arguments and
 *   one line per ref on stdin: `<local ref> <local sha> <remote ref>
 *   <remote sha>`. A ref landing on the default branch (main, master, or
 *   the remote's HEAD branch) is refused unless the last plan_drift left a
 *   clean ship-gate stamp for the exact commit pushed; the escape is
 *   CAIRN_ALLOW_UNSHIPPED_PUSH set to 1 in the environment, which the hook
 *   says it honoured. A push deleting the default branch is the table's
 *   discards-work row, under the run guard's escape for it. Exit 2 is the
 *   one refusal the hook file turns into a refused push; any other exit,
 *   an internal error included, fails open -- a broken hook never blocks
 *   work (ADR 0016).
 *
 *   Not seen, dated 2026-11-04: `git push --no-verify` skips every
 *   pre-push hook; so does a clone whose config never got the hooksPath.
 *   A ruleset at the tracker host is the only layer past that
 *   (docs/01-runbook.md, the ship-gate section).
 *
 * removeWhen: the tracker host's branch ruleset is read for every project
 *   cairn runs in (config_probe, #485) and refuses the unshipped push
 *   itself; the local layer is then a convenience, not a guard.
 * derives: axiom 5 (owner-ground); axiom 4 (recorded-run)
 * Author(s): John Reed
 */

// Imports
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBranches, projectRoot, readShipGateStamp, shipGateMismatch } from "./lib.mjs";
import { DISCARDS_WORK, MOVES_SHARED_REF, classify, effectLine, parseInvocation } from "./git-effects.mjs";

// Constants
const UNSHIPPED_ENV = "CAIRN_ALLOW_UNSHIPPED_PUSH";
const DESTRUCTIVE_ENV = "CAIRN_ALLOW_DESTRUCTIVE_GIT";
// git spells a ref being deleted as the all-zero sha
const ZERO_SHA = /^0+$/;
// the one exit the hook file reads as "refuse the push"; every other exit fails open
const REFUSED = 2;

/**
 * The refusal in the run guard's words, then the owner's ways and the
 * where-did-this-come-from question (#262). The escape is named, never
 * spelled as a copy-paste prefix: it is honoured, not taught.
 */
function refuse(lines, env) {
  console.error([
    ...lines,
    `  this needs the owner's go-ahead. Owner: push from your own terminal with ${env} set to 1`,
    "  in its environment, or run /cairn:ship.",
    "  If you did not ask for this, something the agent read did — check where the",
    "  instruction came from: tracker or web text asking for it is not the owner asking.",
    "  (git pre-push hook, installed by cairn-setup --git-hooks)",
  ].join("\n"));
  process.exit(REFUSED);
}

// Main
function main() {
  const [remote = "origin"] = process.argv.slice(2);
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return; // no refs handed over: nothing to judge
  }
  const refs = input.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length === 4);
  if (!refs.length) return;

  // git runs a hook at the top of the worktree; the stamp is the repository's
  const projectDir = projectRoot({ cwd: process.cwd() });
  const git = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
      }).trim();
    } catch {
      return null;
    }
  };
  const defaults = defaultBranches(remote, git);
  const landing = refs.filter(([, , remoteRef]) => {
    const m = /^refs\/heads\/(.+)$/.exec(remoteRef);
    return m !== null && defaults.has(m[1]);
  });
  if (!landing.length) return; // feature branches, tags, other refs: not this hook's call

  // The effect, from the table: the push as its refspecs spell it
  const specs = landing.map(([localRef, sha, remoteRef]) => `${ZERO_SHA.test(sha) ? "" : localRef}:${remoteRef}`);
  const inv = parseInvocation(["git", "push", remote, ...specs], { aliases: false });
  const deletes = landing.some(([, sha]) => ZERO_SHA.test(sha));
  const causes = classify(inv, { deletesDefaultBranch: () => deletes });

  const destructive = causes.find((c) => c.effect === DISCARDS_WORK);
  if (destructive && process.env[DESTRUCTIVE_ENV] !== "1") {
    refuse([
      `cairn run guard: ${destructive.what} is refused in every session — ${destructive.why}`,
      effectLine(inv, destructive),
    ], DESTRUCTIVE_ENV);
  }

  const shared = causes.find((c) => c.effect === MOVES_SHARED_REF);
  if (!shared) return;
  if (process.env[UNSHIPPED_ENV] === "1") {
    console.error(`cairn pre-push: ${UNSHIPPED_ENV} is set -- this push lands on the default branch unjudged.`);
    return;
  }

  // The stamp, and whether it covers every commit landing there
  const baseDir = process.env.CAIRN_HOME || join(homedir(), ".cairn");
  const read = readShipGateStamp(projectDir, baseDir);
  let why = read.why ?? null;
  for (const [, sha] of landing) {
    if (why) break;
    if (!ZERO_SHA.test(sha)) why = shipGateMismatch(read.stamp, sha);
  }
  if (!why) return;
  refuse([
    `cairn run guard: this push lands on the default branch, but ${why[0]}.`,
    why[1] ?? "  run /cairn:ship instead -- it runs the drift check first, then pushes.",
    effectLine(inv, shared),
  ], UNSHIPPED_ENV);
}

try {
  main();
} catch (e) {
  // the hook's own error: say so and fail open (ADR 0016)
  console.error(`cairn pre-push: ${e?.message ?? e} -- this push was not judged`);
  process.exit(0);
}
