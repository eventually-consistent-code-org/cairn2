/**
 * Purpose: #362 -- shared state keys by the repository, not the folder. Every
 *   linked worktree of one repository reads one memory index, one metrics
 *   log, one observation log; the handoff and banner stay per worktree. The
 *   server's projectKey (run-manifest.ts) and the hook side's copy (lib.mjs)
 *   must agree byte for byte, a folder outside git keeps its pre-#362 key,
 *   and the one-shot move off the old names happens exactly once.
 *   Everything runs under a scratch HOME -- never the real cairn home.
 * Author(s): John Reed
 */

// Imports
import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  REPOSITORY_STATE_DIRS, createRunManifest, listRunManifests, migrateRepositoryState, projectKey, repositoryPath,
  worktreeKey,
} from "../src/planning/run-manifest.js";
import { bannerPath, handoffPath, metricsPath } from "../src/core/continuity.js";
import { indexDbPath } from "../src/memory/index-store.js";
import { observationBacklog, observationsPath } from "../src/memory/observations.js";

// Constants
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "scripts");
const LIB = join(SCRIPTS, "lib.mjs");
const OBSERVE = join(SCRIPTS, "posttooluse-observe.mjs");

// The hook side's copy, loaded the way a hook loads it.
type Lib = {
  REPOSITORY_STATE_DIRS: string[];
  projectKey: (d: string) => string;
  worktreeKey: (d: string) => string;
  metricsPath: (d: string) => string;
  handoffPath: (d: string) => string;
  observationsPath: (d: string, home?: string) => string;
  migrateRepositoryState: (d: string, home?: string) => string[];
};
let lib: Lib;

// Scratch HOME: the server reads the cairn home as os.homedir(), which
// follows $HOME, and so does every hook spawned below.
let savedHome: string | undefined;
let home = "";
beforeAll(async () => {
  lib = await import(pathToFileURL(LIB).href) as Lib;
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "cairn-key-home-"));
  process.env.HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch { /* gone already */ }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A repository with one commit and a linked worktree beside it. */
function repoWithWorktree(): { main: string; linked: string } {
  const root = freshDir("cairn-key-repo-");
  const main = join(root, "main");
  mkdirSync(main);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git(main, "init", "-q");
  git(main, "config", "user.email", "t@t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-q", "-m", "seed", "--no-gpg-sign");
  const linked = join(root, "linked");
  git(main, "worktree", "add", "-q", "-b", "side", linked);
  return { main, linked };
}

/** The pre-#362 key: the resolved folder, hashed. */
function pathKey(dir: string): string {
  const abs = resolve(dir);
  return `${basename(abs)}-${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
}

/** Rows of a jsonl file, parsed; a missing file is no rows. */
function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Main

describe("projectKey: one key per repository (#362)", () => {
  it("the server and the hook side agree byte for byte", () => {
    const { main, linked } = repoWithWorktree();
    const plain = freshDir("cairn-key-plain-");
    for (const d of [main, linked, join(main, "."), plain]) {
      expect(lib.projectKey(d), d).toBe(projectKey(d));
      expect(lib.worktreeKey(d), d).toBe(worktreeKey(d));
    }
    expect(lib.REPOSITORY_STATE_DIRS).toEqual([...REPOSITORY_STATE_DIRS]);
  });

  it("names the key after the repository folder and hashes the common git dir", () => {
    const { main } = repoWithWorktree();
    const key = projectKey(main);
    expect(key.startsWith("main-")).toBe(true);
    expect(key).not.toBe(pathKey(main));
  });

  it("two worktrees share the index and the metrics file, and keep separate handoffs", () => {
    const { main, linked } = repoWithWorktree();
    expect(projectKey(linked)).toBe(projectKey(main));
    expect(indexDbPath(linked)).toBe(indexDbPath(main));
    expect(metricsPath(linked)).toBe(metricsPath(main));
    expect(lib.metricsPath(linked)).toBe(metricsPath(main));
    expect(observationsPath(linked)).toBe(observationsPath(main));
    expect(handoffPath(linked)).not.toBe(handoffPath(main));
    expect(bannerPath(linked)).not.toBe(bannerPath(main));
    expect(lib.handoffPath(linked)).toBe(handoffPath(linked));
    // per worktree means the folder's own pre-#362 key, unchanged
    expect(basename(handoffPath(linked))).toBe(`${pathKey(linked)}.json`);
  });

  it("a folder outside git degrades to the path hash", () => {
    const plain = freshDir("cairn-key-plain-");
    expect(projectKey(plain)).toBe(pathKey(plain));
    expect(lib.projectKey(plain)).toBe(pathKey(plain));
    expect(basename(indexDbPath(plain))).toBe(`${pathKey(plain)}.db`);
    // nothing to move when the two keys are one
    expect(migrateRepositoryState(plain, freshDir("cairn-key-home-"))).toEqual([]);
  });
});

describe("the one-shot move off the folder key (#362)", () => {
  /** Old-named files a pre-#362 checkout left in a cairn home. */
  function seedLegacy(base: string, proj: string): void {
    const old = pathKey(proj);
    for (const [dir, name, body] of [
      ["metrics", `${old}.jsonl`, `${JSON.stringify({ session_id: "s1", est_cost_usd: 1 })}\n`],
      ["metrics", `${old}.20260101-000000-00.jsonl`, `${JSON.stringify({ session_id: "s0" })}\n`],
      ["index", `${old}.db`, "sqlite"],
      ["runs", `${old}-r1.json`, "{}"],
      ["state", `${old}-meter.json`, "{}"],
    ]) {
      mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, dir, name), body);
    }
    mkdirSync(join(base, "handoff"), { recursive: true });
    writeFileSync(join(base, "handoff", `${old}.json`), "{}");
  }

  it("moves every repository file exactly once and logs it in one metrics row", () => {
    const { main } = repoWithWorktree();
    const base = freshDir("cairn-key-home-");
    seedLegacy(base, main);
    const key = projectKey(main);
    const old = pathKey(main);

    const moved = migrateRepositoryState(main, base);
    expect(moved.sort()).toEqual([
      `index/${old}.db`, `metrics/${old}.20260101-000000-00.jsonl`, `metrics/${old}.jsonl`,
      `runs/${old}-r1.json`, `state/${old}-meter.json`,
    ]);
    for (const p of [
      join(base, "index", `${key}.db`), join(base, "runs", `${key}-r1.json`),
      join(base, "metrics", `${key}.20260101-000000-00.jsonl`), join(base, "state", `${key}-meter.json`),
    ]) expect(existsSync(p), p).toBe(true);
    for (const dir of ["index", "metrics", "runs", "state"]) {
      expect(readdirSync(join(base, dir)).filter((n) => n.startsWith(old))).toEqual([]);
    }
    // the handoff is per worktree: it never moves
    expect(existsSync(join(base, "handoff", `${old}.json`))).toBe(true);

    const live = join(base, "metrics", `${key}.jsonl`);
    const rekeys = () => jsonl(live).filter((r) => r.event === "rekey");
    expect(rekeys()).toHaveLength(1);
    expect(rekeys()[0]).toMatchObject({ from: old, to: key });
    expect(jsonl(live)[0]).toMatchObject({ session_id: "s1" });

    // Second run, either runtime: nothing left to move, nothing logged again.
    expect(migrateRepositoryState(main, base)).toEqual([]);
    expect(lib.migrateRepositoryState(main, base)).toEqual([]);
    // An old name that turns up again beside its twin is left alone.
    writeFileSync(join(base, "index", `${old}.db`), "stale");
    expect(migrateRepositoryState(main, base)).toEqual([]);
    expect(readFileSync(join(base, "index", `${key}.db`), "utf8")).toBe("sqlite");
    expect(rekeys()).toHaveLength(1);
  });

  it("the hook side moves the same files the same way", () => {
    const { main } = repoWithWorktree();
    const base = freshDir("cairn-key-home-");
    seedLegacy(base, main);
    expect(lib.migrateRepositoryState(main, base)).toHaveLength(5);
    expect(migrateRepositoryState(main, base)).toEqual([]);
    expect(jsonl(join(base, "metrics", `${projectKey(main)}.jsonl`))
      .filter((r) => r.event === "rekey")).toHaveLength(1);
  });

  it("reads the old name when the move cannot land", () => {
    const { main } = repoWithWorktree();
    const base = freshDir("cairn-key-home-");
    mkdirSync(join(base, "yield"), { recursive: true });
    const old = join(base, "yield", `${pathKey(main)}.json`);
    writeFileSync(old, "{}");
    chmodSync(join(base, "yield"), 0o555); // no new name can be made here
    try {
      expect(repositoryPath(main, "yield", ".json", base)).toBe(old);
    } finally {
      chmodSync(join(base, "yield"), 0o755);
    }
    expect(repositoryPath(main, "yield", ".json", base))
      .toBe(join(base, "yield", `${projectKey(main)}.json`));
  });

  it("a run staged in one worktree is listed from the other", () => {
    const { main, linked } = repoWithWorktree();
    const base = freshDir("cairn-key-home-");
    // staged before the upgrade, so named by the linked worktree's folder key
    createRunManifest(linked, {
      runId: "r9", baseDir: base,
      phases: [{ number: 1, name: "one", estimate: { low: 1, high: 2, estUsd: { low: 0, high: 0 } } }],
    });
    renameSync(join(base, "runs", `${projectKey(linked)}-r9.json`), join(base, "runs", `${pathKey(linked)}-r9.json`));
    // the linked worktree reads it by its old name and moves it once...
    expect(listRunManifests(linked, base).map((m) => m.runId)).toEqual(["r9"]);
    expect(readdirSync(join(base, "runs"))).toEqual([`${projectKey(main)}-r9.json`]);
    // ...and from then on the main checkout sees the same run
    expect(listRunManifests(main, base).map((m) => m.runId)).toEqual(["r9"]);
  });
});

describe("the shared observation log (#362)", () => {
  const observe = (proj: string, target: string) => spawnSync(process.execPath, [OBSERVE], {
    cwd: proj,
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ session_id: "s", tool_name: "Bash", tool_input: { command: target }, tool_response: {} }),
    encoding: "utf8",
  });

  it("both worktrees' hooks append to one log, and the server reads it", () => {
    const { main, linked } = repoWithWorktree();
    for (const d of [main, linked]) mkdirSync(join(d, ".cairn"), { recursive: true });
    expect(observe(main, "from-main").status).toBe(0);
    expect(observe(linked, "from-linked").status).toBe(0);
    const live = observationsPath(main);
    expect(lib.observationsPath(linked)).toBe(live);
    expect(jsonl(live).map((r) => r.target)).toEqual(["from-main", "from-linked"]);
    const backlog = observationBacklog(linked);
    expect(backlog.count).toBe(2);
    expect(backlog.path).toBe(live);
    // nothing lands in either checkout any more
    for (const d of [main, linked]) expect(existsSync(join(d, ".cairn", "observations"))).toBe(false);
  });

  it("moves an in-repo log into the shared one once, every row kept", () => {
    const { main } = repoWithWorktree();
    const oldDir = join(main, ".cairn", "observations");
    mkdirSync(oldDir, { recursive: true });
    const row = (t: string) => `${JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", tool: "Edit", target: t })}\n`;
    writeFileSync(join(oldDir, "observations.jsonl"), row("old-live"));
    writeFileSync(join(oldDir, "observations.20260901-000000-00.jsonl"), row("old-closed"));

    expect(observe(main, "new-row").status).toBe(0);
    const live = observationsPath(main);
    const key = projectKey(main);
    const shared = readdirSync(dirname(live)).filter((n) => n.startsWith(`${key}.`)).sort();
    expect(shared).toContain(`${key}.20260901-000000-00.jsonl`);
    expect(shared).toContain(`${key}.jsonl`);
    expect(shared).toHaveLength(3); // closed, old live as a closed segment, the new live
    const rows = shared.flatMap((n) => jsonl(join(dirname(live), n))).map((r) => r.target).sort();
    expect(rows).toEqual(["new-row", "old-closed", "old-live"]);
    expect(readdirSync(oldDir)).toEqual([]); // the folder is left, empty

    const metrics = join(home, ".cairn", "metrics", `${key}.jsonl`);
    const rekeys = () => jsonl(metrics).filter((r) => r.event === "rekey");
    expect(rekeys()).toHaveLength(1);
    expect(observe(main, "again").status).toBe(0);
    expect(observationBacklog(main).count).toBe(4);
    expect(rekeys()).toHaveLength(1);
  });
});
