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
import type { DriftItem } from "./mirror.js";
export interface ShipGateStamp {
    head: string;
    clean: boolean;
    at: string;
}
/** <home>/ship-gate/<projectKey>.json -- per repository (#362), so a drift
 *  check run in one worktree is the stamp the run guard reads in another.
 *  baseDir injectable for tests. */
export declare function shipGateStampPath(projectDir: string, baseDir?: string): string;
/** True when nothing flagged is something ship stops on. */
export declare function driftIsClean(flagged: DriftItem[]): boolean;
/** The git layer of the gate (#456): "present" when the pre-push hook git
 *  runs from this checkout carries the cairn marker, "absent" when the folder
 *  or the hook is not there, "unknown" when git can't be asked or the file
 *  can't be read. A measurement plan_drift reports beside its flags, never
 *  one of them: the stamp stays clean either way (asserted:
 *  sweep-surface.test.ts "(#456)"). */
export declare function gitLayerReach(projectDir: string): "present" | "absent" | "unknown";
/**
 * Stamps the drift result against the project's current HEAD. Returns the
 * stamp written, or null when it couldn't be (no HEAD, unwritable home) --
 * never throws.
 */
export declare function writeShipGateStamp(projectDir: string, flagged: DriftItem[], opts?: {
    baseDir?: string;
    now?: Date;
}): ShipGateStamp | null;
