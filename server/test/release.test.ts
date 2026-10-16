// Release version bump (#80): scripts/release.mjs bumps all three version
// files + scaffolds a CHANGELOG entry, and refuses on pre-existing drift.
// Extended for #83: the marketplace pin (.claude-plugin/marketplace.json,
// github source "ref": "vX.Y.Z") is the fourth bump surface, and
// scripts/check-versions.mjs gates the pin + root/server runtime-dep
// mirroring in CI. Runs the real scripts against a throwaway repo layout —
// both derive their root from their own location, so copying them into
// <tmp>/scripts/ points every read/write at the fixture, never the real repo.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const SCRIPT = join(SCRIPTS_DIR, "release.mjs");
const CHECK = join(SCRIPTS_DIR, "check-versions.mjs");

const CHANGELOG = [
  "# Changelog",
  "",
  "## v2.2.0 — the planning intelligence (2026-08-13)",
  "",
  "- something that shipped.",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The marketplace manifest with the cairn plugin pinned to a release tag. */
function marketplaceJson(source: unknown): string {
  return JSON.stringify({
    name: "cairn-dev",
    plugins: [{ name: "cairn", source }],
  }, null, 2) + "\n";
}

function pinned(ref: string): unknown {
  return { source: "github", repo: "eventually-consistent-code-org/cairn2", ref };
}

/** Build a throwaway repo: three version files + marketplace pin + CHANGELOG. */
function makeRepo(
  versions: [string, string, string] = ["2.2.0", "2.2.0", "2.2.0"],
  pin: string = "v2.2.0",
): string {
  const repo = mkdtempSync(join(tmpdir(), "cairn-release-"));
  dirs.push(repo);
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "server"));
  mkdirSync(join(repo, ".claude-plugin"));
  copyFileSync(SCRIPT, join(repo, "scripts", "release.mjs"));
  copyFileSync(CHECK, join(repo, "scripts", "check-versions.mjs"));
  const [root, server, plugin] = versions;
  writeFileSync(join(repo, "package.json"),
    JSON.stringify({ name: "root", version: root, files: ["setup"] }, null, 2) + "\n");
  writeFileSync(join(repo, "server", "package.json"),
    JSON.stringify({ name: "server", version: server }, null, 2) + "\n");
  writeFileSync(join(repo, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "cairn", version: plugin }, null, 2) + "\n");
  writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), marketplaceJson(pinned(pin)));
  writeFileSync(join(repo, "CHANGELOG.md"), CHANGELOG);
  return repo;
}

function run(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(repo, "scripts", "release.mjs"), ...args],
    { encoding: "utf8" });
}

function versionsIn(repo: string): [string, string, string] {
  return [
    JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version,
    JSON.parse(readFileSync(join(repo, "server", "package.json"), "utf8")).version,
    JSON.parse(readFileSync(join(repo, ".claude-plugin", "plugin.json"), "utf8")).version,
  ];
}

function pinIn(repo: string): string | undefined {
  const mp = JSON.parse(readFileSync(join(repo, ".claude-plugin", "marketplace.json"), "utf8"));
  return mp.plugins.find((p: { name: string }) => p.name === "cairn")?.source?.ref;
}

function runCheck(repo: string) {
  return spawnSync(process.execPath, [join(repo, "scripts", "check-versions.mjs")],
    { encoding: "utf8" });
}

describe("release.mjs", () => {
  it("explicit version bumps all three files and scaffolds the changelog", () => {
    const repo = makeRepo();
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(0);
    expect(versionsIn(repo)).toEqual(["2.3.0", "2.3.0", "2.3.0"]);
    expect(pinIn(repo)).toBe("v2.3.0");
    const log = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
    const today = new Date().toISOString().slice(0, 10);
    expect(log.startsWith("# Changelog")).toBe(true);
    expect(log).toContain(`## v2.3.0 — <headline> (${today})`);
    // scaffold sits above the previous entry, blank-line separated, untouched
    expect(log).toContain("- <what shipped — fill in before tagging>\n\n## v2.2.0");
    expect(log).toContain("## v2.2.0 — the planning intelligence (2026-08-13)");
    expect(res.stdout).toContain("2.2.0 -> 2.3.0");
  });

  it("preserves surrounding formatting in the version files", () => {
    const repo = makeRepo();
    const before = readFileSync(join(repo, "package.json"), "utf8");
    expect(run(repo, "2.3.0").status).toBe(0);
    const after = readFileSync(join(repo, "package.json"), "utf8");
    expect(after).toBe(before.replace('"version": "2.2.0"', '"version": "2.3.0"'));
  });

  it.each([
    ["patch", "2.2.1"],
    ["minor", "2.3.0"],
    ["major", "3.0.0"],
  ])("bump keyword %s -> %s", (keyword, expected) => {
    const repo = makeRepo();
    expect(run(repo, keyword).status).toBe(0);
    expect(versionsIn(repo)).toEqual([expected, expected, expected]);
    expect(pinIn(repo)).toBe(`v${expected}`);
  });

  it("refuses when the three files already disagree, naming each version", () => {
    const repo = makeRepo(["2.2.0", "2.1.0", "2.2.0"]);
    const res = run(repo, "patch");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("already disagree");
    expect(res.stderr).toContain("package.json");
    expect(res.stderr).toContain("server/package.json");
    expect(res.stderr).toContain(".claude-plugin/plugin.json");
    expect(res.stderr).toContain("2.1.0");
    // nothing written
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.1.0", "2.2.0"]);
    expect(pinIn(repo)).toBe("v2.2.0");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("refuses when the marketplace pin disagrees with the version files", () => {
    const repo = makeRepo(["2.2.0", "2.2.0", "2.2.0"], "v2.1.0");
    const res = run(repo, "patch");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("already disagree");
    expect(res.stderr).toContain("marketplace.json");
    expect(res.stderr).toContain("v2.1.0");
    // nothing written
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
    expect(pinIn(repo)).toBe("v2.1.0");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("refuses an unpinned marketplace source (the old mutable './')", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), marketplaceJson("./"));
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no pinned github source");
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("atomic: a marketplace pin missing the exact literal blocks every write", () => {
    const repo = makeRepo();
    // valid JSON, right pin, but compact — the surgical swap can't land
    writeFileSync(join(repo, ".claude-plugin", "marketplace.json"),
      '{"name":"cairn-dev","plugins":[{"name":"cairn","source":{"source":"github","repo":"o/r","ref":"v2.2.0"}}]}\n');
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("marketplace.json");
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("rejects a malformed version argument without writing", () => {
    const repo = makeRepo();
    const res = run(repo, "banana");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not a semver version");
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
  });

  it("rejects a missing argument with usage", () => {
    const repo = makeRepo();
    const res = run(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("usage:");
  });

  it("refuses to bump to the version already set", () => {
    const repo = makeRepo();
    const res = run(repo, "2.2.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("nothing to bump");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("uses a pre-written changelog entry for the target — cut-first workflow (#146)", () => {
    const repo = makeRepo();
    const prewritten =
      "# Changelog\n\n## v2.3.0 — already here (2026-08-10)\n\n- old.\n" + CHANGELOG.slice("# Changelog\n\n".length);
    writeFileSync(join(repo, "CHANGELOG.md"), prewritten);
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("changelog entry present — using it");
    expect(versionsIn(repo)).toEqual(["2.3.0", "2.3.0", "2.3.0"]);
    // the pre-written entry is used verbatim — no scaffold prepended
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(prewritten);
  });

  it("refuses a pre-written entry that still carries scaffold placeholders (#146)", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "CHANGELOG.md"),
      "# Changelog\n\n## v2.3.0 — <headline> (2026-08-10)\n\n- <what shipped — fill in before tagging>\n\n" +
      CHANGELOG.slice("# Changelog\n\n".length));
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("placeholder text");
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
  });

  it("atomic: an unscaffoldable changelog blocks the version writes too", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\nno entries yet\n");
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("no '## v...' entry");
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
  });

  it("atomic: a version file missing the exact literal blocks every write", () => {
    const repo = makeRepo();
    // valid JSON, right version, but formatted so the surgical swap can't land
    writeFileSync(join(repo, ".claude-plugin", "plugin.json"),
      '{"name":"cairn","version":"2.2.0"}\n');
    const res = run(repo, "2.3.0");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(".claude-plugin/plugin.json");
    // the two well-formed files were not touched either
    expect(versionsIn(repo)).toEqual(["2.2.0", "2.2.0", "2.2.0"]);
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });

  it("refuses drift even when a file's version is not valid semver", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "server", "package.json"),
      JSON.stringify({ name: "server", version: "next" }, null, 2) + "\n");
    const res = run(repo, "patch");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("server/package.json");
    expect(readFileSync(join(repo, "CHANGELOG.md"), "utf8")).toBe(CHANGELOG);
  });
});

// Version-sync gate (#79, extended #83): the marketplace pin and the
// root/server runtime-dep mirror are CI-checked surfaces too.
describe("check-versions.mjs", () => {
  it("passes when version files, pin, and deps all agree", () => {
    const repo = makeRepo();
    const res = runCheck(repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("clean");
    expect(res.stdout).toContain("2.2.0");
  });

  it("fails when a version file disagrees, naming the stale file", () => {
    const repo = makeRepo(["2.2.0", "2.1.0", "2.2.0"]);
    const res = runCheck(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("server/package.json is 2.1.0, package.json is 2.2.0");
  });

  it("fails when the marketplace pin disagrees with the version files", () => {
    const repo = makeRepo(["2.2.0", "2.2.0", "2.2.0"], "v2.1.0");
    const res = runCheck(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("pin is v2.1.0, package.json is 2.2.0");
  });

  it("fails when the marketplace source is unpinned (the old mutable './')", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), marketplaceJson("./"));
    const res = runCheck(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("not pinned to a release tag");
  });

  it("fails when a server runtime dep is missing from the root package.json", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "server", "package.json"),
      JSON.stringify({ name: "server", version: "2.2.0", dependencies: { zod: "^3.24.0" } }, null, 2) + "\n");
    const res = runCheck(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("missing server runtime dep zod");
  });

  it("fails when the root declares a different range than the server", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "package.json"),
      JSON.stringify({ name: "root", version: "2.2.0", dependencies: { zod: "^3.0.0" } }, null, 2) + "\n");
    writeFileSync(join(repo, "server", "package.json"),
      JSON.stringify({ name: "server", version: "2.2.0", dependencies: { zod: "^3.24.0" } }, null, 2) + "\n");
    const res = runCheck(repo);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("zod@^3.0.0");
    expect(res.stderr).toContain("^3.24.0");
  });

  it("passes when the root mirrors the server deps exactly", () => {
    const repo = makeRepo();
    const deps = { zod: "^3.24.0", "better-sqlite3": "^12.11.1" };
    writeFileSync(join(repo, "package.json"),
      JSON.stringify({ name: "root", version: "2.2.0", dependencies: deps }, null, 2) + "\n");
    writeFileSync(join(repo, "server", "package.json"),
      JSON.stringify({ name: "server", version: "2.2.0", dependencies: deps }, null, 2) + "\n");
    expect(runCheck(repo).status).toBe(0);
  });
});
