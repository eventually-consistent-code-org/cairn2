import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { readRoadmapMeta } from "../src/planning/milestones.js";
import { codeCommitsSince, resyncReport } from "../src/planning/resync.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function commit(dir: string, file: string, msg: string): string {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), `${msg}\n`);
  // Stage only the named file (not "-A"): a hand-written LEDGER.md line
  // written directly via appendFileSync between commits would otherwise be
  // an untracked file that "-A" sweeps into the next commit(), bundling
  // it into whichever commit the test is trying to keep isolated.
  git(dir, "add", file);
  git(dir, "commit", "-m", msg, "--no-gpg-sign");
  return git(dir, "rev-parse", "HEAD");
}

describe("resyncReport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-rs-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    scaffoldProject(dir, "proj");
    scaffoldPhase(dir, 1, "core");
    commit(dir, "seed.txt", "seed");
  });

  it("first run initializes the marker and reports nothing", () => {
    const r = resyncReport(dir);
    expect(r.initialized).toBe(true);
    expect(r.outOfBand).toEqual([]);
    expect(readRoadmapMeta(dir).lastResync).toBe(r.headSha);
  });

  it("flags commits not covered by any ledger range; ledgered ranges are covered", () => {
    resyncReport(dir); // initialize at seed
    const base = git(dir, "rev-parse", "HEAD");
    const covered = commit(dir, "a.txt", "ledgered work");
    // hand-write a ledger line in the real format
    appendFileSync(join(dir, ".cairn/plans/phases/01-core/LEDGER.md"),
      `# Phase 1: core — Ledger\n\n- [x] T1 — did work — commits ${base.slice(0, 7)}..${covered.slice(0, 7)} — GH-1 closed 2026-07-18\n`);
    const rogue = commit(dir, "b.txt", "out of band hotfix");
    const r = resyncReport(dir);
    expect(r.outOfBand.map((c) => c.sha)).toEqual([rogue]);
    expect(r.outOfBand[0].subject).toBe("out of band hotfix");
    expect(r.outOfBand[0].files).toEqual(["b.txt"]);
    expect(r.sinceSha).toBeTruthy();
  });

  it("advances the marker: a second run sees nothing new", () => {
    resyncReport(dir);
    commit(dir, "c.txt", "rogue");
    expect(resyncReport(dir).outOfBand.length).toBe(1);
    expect(resyncReport(dir).outOfBand.length).toBe(0);
  });
});

describe("codeCommitsSince (#279)", () => {
  let dir: string;
  let stamp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cairn-ccs-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
    stamp = commit(dir, "src/a.ts", "seed");
  });

  // Readmes, release notes and the license never move what an audit examined.
  it.each([
    ["a root README", "README.md"],
    ["a nested README", "server/README.md"],
    ["a root CHANGELOG", "CHANGELOG.md"],
    ["a nested CHANGELOG", "server/CHANGELOG.md"],
    ["the LICENSE", "LICENSE"],
    ["a docs page", "docs/guide.md"],
  ])("%s-only commit is not a code commit", (_label, file) => {
    commit(dir, file, `edit ${file}`);
    expect(codeCommitsSince(dir, stamp)).toBe(0);
  });

  // Agent instruction files steer behavior, so they stay code.
  it.each([
    ["CLAUDE.md", "CLAUDE.md"],
    ["the harness spine", "harness/AGENTS-cairn.md"],
    ["a skills/ verb", "skills/cairn-trailhead/verbs/work.md"],
    ["a command shim", "commands/work.md"],
    ["a template", "templates/PLAN.md"],
    ["a source file", "server/src/planning/resync.ts"],
    ["a readme lookalike", "src/MY_README.md"],
  ])("%s edit counts as a code commit", (_label, file) => {
    commit(dir, file, `edit ${file}`);
    expect(codeCommitsSince(dir, stamp)).toBe(1);
  });

  it("a commit mixing a README with source still counts; prose-only commits never do", () => {
    writeFileSync(join(dir, "README.md"), "readme\n");
    writeFileSync(join(dir, "src/a.ts"), "changed\n");
    git(dir, "add", "README.md", "src/a.ts");
    git(dir, "commit", "-q", "-m", "mixed", "--no-gpg-sign");
    commit(dir, "CHANGELOG.md", "notes");
    commit(dir, "LICENSE", "license");
    expect(codeCommitsSince(dir, stamp)).toBe(1);
  });

  it("a custom excluded dir keeps readmes and release notes excluded", () => {
    commit(dir, "site/index.md", "site page");
    commit(dir, "README.md", "readme");
    expect(codeCommitsSince(dir, stamp, "site")).toBe(0);
    commit(dir, "docs/guide.md", "docs count once another dir is the excluded one");
    expect(codeCommitsSince(dir, stamp, "site")).toBe(1);
  });

  it("returns null when the stamp no longer resolves", () => {
    expect(codeCommitsSince(dir, "0".repeat(40))).toBeNull();
  });
});
