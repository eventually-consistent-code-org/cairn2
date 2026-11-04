/**
 * Purpose: the ship-gate stamp (#251) -- what the last drift check said,
 *   and about which commit, so the run guard can refuse an agent push to
 *   the default branch that skipped it. plan_drift writes one stamp per
 *   project after every run: { head, clean, at }. `clean` is false only
 *   for what ship stops on (missing / closed-unverified issues, a stale
 *   security audit); the advisory kinds (stale-issue, stale-branch,
 *   roadmap-row) never make it dirty.
 *
 *   Lives in the per-machine cairn home beside the run manifests, keyed
 *   with the manifests' own project hash, so the hook and the server
 *   agree on the path without talking to each other.
 *
 *   Best effort, always: a stamp that can't be written leaves the gate
 *   shut (the guard treats a missing or stale stamp as "not checked"),
 *   so a write failure never fails the drift check itself.
 *
 * removeWhen: never -- "never push with flagged drift" is an owner policy,
 *   not a workaround for a model limit.
 * Author(s): John Reed
 */
// Imports
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repositoryPath } from "./run-manifest.js";
// Constants
/** Drift kinds ship reports but never stops on. */
const ADVISORY = new Set(["stale-issue", "stale-branch", "roadmap-row"]);
/** <home>/ship-gate/<projectKey>.json -- per repository (#362), so a drift
 *  check run in one worktree is the stamp the run guard reads in another.
 *  baseDir injectable for tests. */
export function shipGateStampPath(projectDir, baseDir = join(homedir(), ".cairn")) {
    return repositoryPath(projectDir, "ship-gate", ".json", baseDir);
}
/** True when nothing flagged is something ship stops on. */
export function driftIsClean(flagged) {
    return flagged.every((f) => ADVISORY.has(f.reason));
}
/** The git layer of the gate (#456): "present" when the pre-push hook git
 *  runs from this checkout carries the cairn marker, "absent" when the folder
 *  or the hook is not there, "unknown" when git can't be asked or the file
 *  can't be read. A measurement plan_drift reports beside its flags, never
 *  one of them: the stamp stays clean either way (asserted:
 *  sweep-surface.test.ts "(#456)"). */
export function gitLayerReach(projectDir) {
    let hooks;
    try {
        hooks = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
            cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        }).trim();
    }
    catch {
        return "unknown";
    }
    if (!hooks)
        return "unknown";
    const dir = resolve(projectDir, hooks.replace(/^~(?=\/|$)/, homedir()));
    try {
        return readFileSync(join(dir, "pre-push"), "utf8").includes("# cairn:begin") ? "present" : "absent";
    }
    catch (e) {
        return e?.code === "ENOENT" ? "absent" : "unknown";
    }
}
/**
 * Stamps the drift result against the project's current HEAD. Returns the
 * stamp written, or null when it couldn't be (no HEAD, unwritable home) --
 * never throws.
 */
export function writeShipGateStamp(projectDir, flagged, opts = {}) {
    try {
        const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const stamp = {
            head, clean: driftIsClean(flagged), at: (opts.now ?? new Date()).toISOString(),
        };
        const path = shipGateStampPath(projectDir, opts.baseDir);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(stamp) + "\n");
        renameSync(tmp, path);
        return stamp;
    }
    catch {
        return null; // best effort -- the guard reads a missing stamp as "not checked"
    }
}
