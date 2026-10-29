#!/usr/bin/env node

/**
 * Purpose: the merge lead (#223). Before branch B merges after A (a wave
 *   merge) or origin/main merges into a rejected ship push, intersect the
 *   files each side changed since their merge base and render one line --
 *   `overlap: 3 files — a, b, c` or `overlap: none` -- so the human reads
 *   the collision first, not the conflict markers. Pure git, read-only.
 * Author(s): John Reed
 */

import { spawnSync } from "node:child_process";

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

// Main -- `node scripts/lib/merge-overlap.mjs <side-a> <side-b>` prints the lead
if (import.meta.url === `file://${process.argv[1]}`) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: merge-overlap.mjs <side-a> <side-b>");
    process.exit(2);
  }
  console.log(overlapLead(process.cwd(), a, b));
}
