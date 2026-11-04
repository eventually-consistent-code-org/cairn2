#!/usr/bin/env node

/**
 * Purpose: the merge lead (#223). Before branch B merges after A (a wave
 *   merge) or origin/main merges into a rejected ship push, intersect the
 *   files each side changed since their merge base and render one line --
 *   `overlap: 3 files — a, b, c` or `overlap: none` -- so the human reads
 *   the collision first, not the conflict markers. Pure git, read-only.
 *
 *   Lives under hooks/scripts (#443) because that is a folder the npm
 *   package ships; the plugin's verbs call it through $CLAUDE_PLUGIN_ROOT,
 *   the way status.md calls cost-report.mjs (asserted: sweep-surface.test.ts,
 *   #443). Only Claude Code sets that variable, so cairn-setup copies this
 *   file and cost-report.mjs, with their imports, from here into every
 *   harness install and re-points the copied verbs at the copy (asserted:
 *   setup.test.ts, #474). Not a hook.
 * derives: convention — a merge lead is judgment for the human; no axiom
 *   governs it, it only has to be reachable from every install.
 * Author(s): John Reed
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Run git in cwd, return the non-empty stdout lines.
 *  :throws when git exits non-zero, so a bad ref is loud, never "none" */
function gitLines(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

/** Files changed on both sides since the merge base of a and b.
 *  :returns sorted array of repo-relative paths */
export function overlapFiles(cwd, a, b) {
  const [base] = gitLines(cwd, ["merge-base", a, b]);
  if (!base) throw new Error(`no merge base for ${a} and ${b}`);
  const left = new Set(gitLines(cwd, ["diff", "--name-only", `${base}...${a}`]));
  const right = gitLines(cwd, ["diff", "--name-only", `${base}...${b}`]);
  return right.filter((f) => left.has(f)).sort();
}

/** The one-line lead for a merge message and its tracker note.
 *  :returns `overlap: none` or `overlap: N files — x, y` */
export function overlapLead(cwd, a, b) {
  const files = overlapFiles(cwd, a, b);
  if (files.length === 0) return "overlap: none";
  return `overlap: ${files.length} file${files.length === 1 ? "" : "s"} — ${files.join(", ")}`;
}

/** Was this module launched as the command (`node <path> a b`), not imported?
 *  The module URL is percent-encoded and already symlink-resolved; argv[1]
 *  is neither. Decode the URL the standard way and resolve BOTH sides, so a
 *  symlinked plugin folder (a dev marketplace link) or a path with a space
 *  still runs the body (#444, asserted: sweep-surface.test.ts). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

// Main -- `node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/merge-overlap.mjs" <side-a> <side-b>` prints the lead.
// Every path out of here prints the lead or exits non-zero: an empty line
// with exit 0 reads as "no overlap", the quiet collision this exists to stop.
if (isMain()) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: merge-overlap.mjs <side-a> <side-b>");
    process.exit(2);
  }
  let lead = "";
  try {
    lead = overlapLead(process.cwd(), a, b);
  } catch (e) {
    console.error(`merge-overlap: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (!lead) {
    console.error("merge-overlap: no lead produced — do not merge on this line");
    process.exit(2);
  }
  console.log(lead);
}
