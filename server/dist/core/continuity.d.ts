import { z } from "zod";
export declare function handoffPath(projectDir: string): string;
export declare function bannerPath(projectDir: string): string;
/** The Stop hook's cumulative cost log (stop-costtracker.mjs writes it; the
 *  token estimator reads it). Scheme mirrored in hooks/scripts/lib.mjs. */
export declare function metricsPath(projectDir: string): string;
/** The one definition of who wrote a handoff -- the MCP input schema in
 *  index.ts imports this rather than restating it (#370 collapsed the copy). */
export declare const HandoffSourceEnum: z.ZodEnum<{
    tool: "tool";
    posttooluse: "posttooluse";
    precompact: "precompact";
    waypoint: "waypoint";
}>;
export type HandoffSource = z.infer<typeof HandoffSourceEnum>;
/**
 * A wave dispatch, as the Workflow path in work.md hands it over (#370):
 * the phase the wave belongs to and the run id the harness returned. The
 * server composes every string that carries the id from this one pair,
 * so the handoff notes and the outlook nextVerb can never disagree.
 */
export interface WaveRef {
    phase: number;
    runId: string;
}
/** The handoff `notes` line for a wave checkpoint. */
export declare function waveNotes(wave: WaveRef): string;
/** The outlook `nextVerb` for a wave checkpoint -- what a fresh session
 *  types to pick the run up where it stopped. */
export declare function waveNextVerb(wave: WaveRef): string;
export interface Handoff {
    version: 1;
    created: string;
    source: HandoffSource;
    project: string;
    phase?: {
        number: number;
        slug: string;
    };
    issue?: string;
    plan?: string;
    task: {
        current: string;
        title: string;
    };
    tasks_completed: string[];
    tasks_remaining: string[];
    blockers: string[];
    decisions_in_flight: string[];
    uncommitted_files: string[];
    next_action: string;
    notes: string;
    partial: boolean;
}
export declare const HandoffSchema: z.ZodType<Handoff>;
/**
 * Reads the project's handoff. Never errors the session for staleness -- callers
 * get `stale: true` and decide what to do with it. Invalid JSON/schema still
 * throws HANDOFF_INVALID, since that's a corrupt file, not a stale one.
 */
export declare function readHandoff(projectDir: string): {
    handoff: Handoff;
    stale: boolean;
} | null;
/**
 * Merges `patch` over the existing handoff (or a blank skeleton) and writes it
 * atomically. Two guards keep this safe to call from hot paths like PostToolUse:
 *  - unregistered guard: no loadable cairn.json -> skip silently, never scaffold.
 *  - skeleton guard: richness is monotonic between clears -- a write can't
 *    replace a rich handoff (task.current or next_action non-empty) with an
 *    empty one. clearHandoff() is the explicit way to wipe a handoff.
 */
export declare function writeHandoff(projectDir: string, patch: Partial<Handoff> & {
    source: Handoff["source"];
}): void;
/** Deletes the project's handoff file, if any. Returns whether one existed. */
export declare function clearHandoff(projectDir: string): boolean;
/**
 * What a compaction checkpoint must carry to be worth keeping.
 *
 * Four typed artifacts: durable memory (decisions, constraints, and the
 * approaches already rejected -- the most commonly lost and the most
 * expensive to rediscover), a summary written for resumability, the user's
 * requirements preserved verbatim, and the skills in play.
 */
export interface CheckpointArtifacts {
    decisions: string[];
    constraints: string[];
    rejected: string[];
    state: string;
    filesTouched: string[];
    nextSteps: string[];
    requirements: string;
    skills: string[];
}
/** Thrown instead of persisting a checkpoint that would not survive a resume. */
export declare class DegradedCheckpointError extends Error {
    readonly missing: string[];
    constructor(missing: string[]);
}
/**
 * The abort rule. Required: at least one decision, a usable state summary,
 * and the user's requirements verbatim. Not required: rejected approaches,
 * skills, next steps, files touched -- a session may genuinely have none of
 * those, and demanding them would teach the caller to invent them.
 *
 * :param a: the artifacts a caller proposes to persist
 * :throws DegradedCheckpointError naming every missing artifact at once
 */
export declare function validateArtifacts(a: Partial<CheckpointArtifacts>): void;
