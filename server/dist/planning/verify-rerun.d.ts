import { type Observation } from "./close-receipt.js";
/** Lines of combined output kept as the observed tail. */
export declare const TAIL_LINES = 20;
export interface RerunSettings {
    rerun: boolean;
    timeoutSeconds: number;
}
/**
 * The `verify` block of cairn.json, fail-open: a missing or invalid config
 * reads as rerun off, because a config error is reported by the tools that
 * own config, and the close must never be the one to trip over it.
 *
 * :param projectDir: project root holding cairn.json
 * :returns the rerun switch and its timeout
 */
export declare function rerunSettings(projectDir: string): RerunSettings;
/** The minimal environment the declared line runs under. */
export declare function minimalEnv(from?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/**
 * Run the declared line in the project root and capture what happened.
 * stdout and stderr share ONE file descriptor, so the tail interleaves the
 * way a terminal would have shown it, and no output size can overflow a
 * pipe buffer. Never throws: the server's own failure is a named skip.
 *
 * :param projectDir: cwd for the run
 * :param command: the declared line, verbatim
 * :param timeoutSeconds: hard stop; the run is killed and reads "timeout"
 * :returns the observation
 */
export declare function runDeclared(projectDir: string, command: string, timeoutSeconds: number, now?: () => Date): Observation;
/**
 * The close-time observation for one close-kind ledger append, or null
 * when rerun is off (nothing recorded, the line byte-identical to before).
 * Every way of NOT running is a named skip, checked in this order:
 * evidence waived, no declared verify, the evidence command differs from
 * the declaration (character for character), the declaration is not a
 * plain shell line, PLAN.md is untracked, no owner approval is stamped on
 * it, the approved blob is unreadable, the declared line differs from the
 * approved one. Only then does the declared line run.
 *
 * :param o.declared: the task's declared verify, already read off PLAN.md
 * :returns the observation, or null when rerun is off
 */
export declare function observeDeclaredVerify(o: {
    projectDir: string;
    phaseDir: string;
    issueId: string;
    evidence?: {
        command: string;
    };
    declared: string | null;
    settings?: RerunSettings;
    now?: () => Date;
}): Observation | null;
