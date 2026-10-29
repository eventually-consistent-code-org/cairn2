import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DriftItem } from "../src/planning/mirror.js";
import { projectKey, runManifestPath } from "../src/planning/run-manifest.js";
import { driftIsClean, shipGateStampPath, writeShipGateStamp } from "../src/planning/ship-gate.js";

// The ship-gate stamp plan_drift leaves for the run guard (#251). Every
// write goes to a temp base dir -- never the real per-machine cairn home.

const dirs: string[] = [];
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { proj: string; head: string } {
  const proj = freshDir("cairn-shipgate-proj-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: proj, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(proj, "a.txt"), "a\n");
  git("add", "a.txt"); git("commit", "-q", "-m", "seed", "--no-gpg-sign");
  return { proj, head: git("rev-parse", "HEAD") };
}

const advisory: DriftItem[] = [
  { reason: "stale-issue", ref: "#1", idleDays: 9, detail: "quiet" },
  { reason: "stale-branch", ref: "old", idleDays: 9, detail: "quiet" },
  { reason: "roadmap-row", phase: 2, from: "planned", to: "verified", detail: "fixed" },
];

describe("ship-gate stamp (#251)", () => {
  it("writes clean:true against HEAD when only advisory drift is flagged", () => {
    const { proj, head } = repo();
    const home = freshDir("cairn-shipgate-home-");
    const now = new Date("2026-10-02T00:00:00Z");
    const stamp = writeShipGateStamp(proj, advisory, { baseDir: home, now });
    expect(stamp).toEqual({ head, clean: true, at: now.toISOString() });
    expect(JSON.parse(readFileSync(shipGateStampPath(proj, home), "utf8"))).toEqual(stamp);
  });

  it("writes clean:false for anything ship stops on", () => {
    const { proj } = repo();
    const home = freshDir("cairn-shipgate-home-");
    const blocking: DriftItem[][] = [
      [{ issueId: "#7", phase: 1, reason: "missing" }],
      [{ issueId: "#7", phase: 1, reason: "closed" }],
      [{ reason: "stale-audit", scope: "full", commit: "abc", cause: "dirty", detail: "re-run" }],
    ];
    for (const flagged of blocking) {
      writeShipGateStamp(proj, [...advisory, ...flagged], { baseDir: home });
      const stamp = JSON.parse(readFileSync(shipGateStampPath(proj, home), "utf8"));
      expect(stamp.clean, flagged[0].reason).toBe(false);
    }
    expect(driftIsClean([])).toBe(true);
  });

  it("keys beside the run manifests with the same project key the hook derives", async () => {
    const { proj } = repo();
    const home = freshDir("cairn-shipgate-home-");
    // The hook side's copy (#362) -- the run guard reads the stamp by it.
    const lib = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)),
      "..", "..", "hooks", "scripts", "lib.mjs")).href);
    const key: string = lib.projectKey(proj);
    expect(key).toBe(projectKey(proj));
    expect(shipGateStampPath(proj, home)).toBe(join(home, "ship-gate", `${key}.json`));
    expect(runManifestPath(proj, "r", home)).toContain(`${key}-`);
  });

  it("never throws -- no repo or an unwritable home just skips the stamp", () => {
    const notRepo = freshDir("cairn-shipgate-norepo-");
    expect(writeShipGateStamp(notRepo, [], { baseDir: freshDir("cairn-shipgate-home-") }))
      .toBeNull();
    const { proj } = repo();
    const fileAsHome = join(freshDir("cairn-shipgate-file-"), "f");
    writeFileSync(fileAsHome, "not a dir");
    expect(writeShipGateStamp(proj, [], { baseDir: fileAsHome })).toBeNull();
  });
});
