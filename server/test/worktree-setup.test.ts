// Worktree setup derived from the repo (#352): a fresh wave worktree has
// tracked files only -- no node_modules, no .env, no port -- and the brief
// used to carry whatever installer the coordinator remembered. These tests
// pin the derivation: the lockfile picks the installer (never a bare
// `npm install`), every package with its own lockfile is listed, the
// `.worktreeinclude` paths and the `.worktree-port` convention ride along,
// and a repo with none of them yields NO setup line rather than an
// invented one. Tracked files decide inside a git repository; outside one
// the walk stands in.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeSetup } from "../src/planning/worktree-setup.js";

const made: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "cairn-wt-setup-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes `rel` under `root`, making the folders on the way. */
function put(root: string, rel: string, body = ""): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A real repository with every current file tracked. */
function gitTrack(root: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore", env: {
      ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    } });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

describe("worktreeSetup — the lockfile picks the installer", () => {
  const cases: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn --immutable"],
    ["go.sum", "go mod download"],
    ["Cargo.lock", "cargo fetch --locked"],
    ["uv.lock", "uv sync --frozen"],
    ["poetry.lock", "poetry install"],
    ["requirements.txt", "pip install -r requirements.txt"],
    ["pyproject.toml", "pip install -e ."],
    ["Gemfile.lock", "bundle install"],
  ];
  for (const [lockfile, command] of cases) {
    it(`${lockfile} → ${command}`, () => {
      const d = fresh();
      put(d, lockfile);
      const s = worktreeSetup(d);
      expect(s.installs).toEqual([{ dir: ".", lockfile, command }]);
      expect(s.lines.join("\n")).toContain(`\`${command}\``);
    });
  }

  it("a package.json with no lockfile gets no installer — never an invented `npm install`", () => {
    const d = fresh();
    put(d, "package.json", "{}");
    const s = worktreeSetup(d);
    expect(s.installs).toEqual([]);
    expect(s.lines).toEqual([]);
  });

  it("one installer per folder: pnpm beats a stray package-lock beside it", () => {
    const d = fresh();
    put(d, "pnpm-lock.yaml");
    put(d, "package-lock.json");
    expect(worktreeSetup(d).installs.map((i) => i.command)).toEqual([
      "pnpm install --frozen-lockfile",
    ]);
  });

  it("python: the lock beats the loose manifest in the same folder", () => {
    const d = fresh();
    put(d, "pyproject.toml");
    put(d, "uv.lock");
    expect(worktreeSetup(d).installs.map((i) => i.command)).toEqual(["uv sync --frozen"]);
  });
});

describe("worktreeSetup — every package with its own lockfile", () => {
  it("a workspace with mixed lockfiles reports each, root first then by path", () => {
    const d = fresh();
    put(d, "pnpm-lock.yaml");
    put(d, "tools/go/go.sum");
    put(d, "services/api/bun.lock");
    const s = worktreeSetup(d);
    expect(s.installs).toEqual([
      { dir: ".", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
      { dir: "services/api", lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
      { dir: "tools/go", lockfile: "go.sum", command: "go mod download" },
    ]);
    const line = s.lines.find((l) => l.includes("Setup"))!;
    expect(line).toContain("at the repo root `pnpm install --frozen-lockfile`");
    expect(line).toContain("in `services/api/` `bun install --frozen-lockfile`");
    expect(line).toContain("in `tools/go/` `go mod download`");
  });

  it("node_modules, dot folders and build output are never packages", () => {
    const d = fresh();
    put(d, "package-lock.json");
    put(d, "node_modules/dep/package-lock.json");
    put(d, ".cache/x/yarn.lock");
    put(d, "dist/pnpm-lock.yaml");
    expect(worktreeSetup(d).installs.map((i) => i.dir)).toEqual(["."]);
  });

  it("inside a repository only TRACKED lockfiles count — a stray install's lockfile is not setup", () => {
    const d = fresh();
    put(d, "server/package-lock.json");
    put(d, ".gitignore", "scratch/\n");
    gitTrack(d);
    // an untracked lockfile a stray `npm install` left, and an ignored one
    put(d, "package-lock.json");
    put(d, "scratch/pnpm-lock.yaml");
    expect(worktreeSetup(d).installs).toEqual([
      { dir: "server", lockfile: "package-lock.json", command: "npm ci" },
    ]);
  });
});

describe("worktreeSetup — .worktreeinclude and .worktree-port", () => {
  it("lists the include paths, comments and blanks dropped, and says to copy them before installing", () => {
    const d = fresh();
    put(d, "package-lock.json");
    put(d, ".worktreeinclude", "# local secrets\n.env\n\nconfig/local.json\n");
    const s = worktreeSetup(d);
    expect(s.include).toEqual([".env", "config/local.json"]);
    const line = s.lines.find((l) => l.includes(".worktreeinclude"))!;
    expect(line).toContain("`.env`, `config/local.json`");
    expect(line).toMatch(/copy, never symlink/i);
    expect(line).toMatch(/before/);
    // copies come before the installer in the brief
    expect(s.lines.indexOf(line)).toBeLessThan(s.lines.findIndex((l) => l.includes("Setup")));
  });

  it("a .worktree-port file at the root means the convention exists", () => {
    const d = fresh();
    put(d, ".worktree-port", "3100\n");
    const s = worktreeSetup(d);
    expect(s.port).toBe(true);
    expect(s.lines.some((l) => l.includes("`.worktree-port`"))).toBe(true);
  });

  it("a gitignored .worktree-port is the convention too — the file itself never reaches a fresh worktree", () => {
    const d = fresh();
    put(d, ".gitignore", "node_modules/\n.worktree-port\n");
    expect(worktreeSetup(d).port).toBe(true);
  });

  it("a repo with none of them reports an empty setup — no line to put in a brief", () => {
    const d = fresh();
    put(d, "README.md", "hi");
    expect(worktreeSetup(d)).toEqual({ installs: [], include: [], port: false, lines: [] });
  });
});
