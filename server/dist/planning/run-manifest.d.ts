/**
 * Purpose: the run manifest for headless batch runs (#132) — the staging
 *   interview's output and the executor's SOLE source of authority. One
 *   manifest per run, written when the user approves the staging gate:
 *   which phases run, their estimate ranges, the budget ceiling, and the
 *   push pre-authorization (REC-5 moved to run start, scope-limited to
 *   the manifest's phases — a phase outside the manifest never pushes).
 *
 *   Lives under ~/.cairn (never the repo) with the same path/injection
 *   conventions as budget-ledger.ts: per-machine project hash, filename-
 *   safe runId, raw run_id verified on load so a sanitize collision can't
 *   silently merge two runs. Versioned state file — z.literal(1) +
 *   safeParse + atomic tmp-then-rename write, continuity.ts precedent.
 *
 *   pushAuth starts FALSE and only grantPushAuth() flips it — creation can
 *   never smuggle authority in. Status walks a one-way lifecycle:
 *   staged → running → complete|stopped (staged may also go straight to
 *   stopped when a run is abandoned before it starts). currentPhase walks
 *   forward through the manifest's own phases while running (#260), so
 *   the run guard can tie a push to a phase the owner authorized.
 *
 *   The circuit breaker (#358) is the one writer of this file that is not
 *   the server: the PreToolUse guards (hooks/scripts/breaker.mjs) freeze a
 *   running run at `auto.breaker` refusals by writing status `stopped` and
 *   a `stop` block (reason breaker, the last three refusal rows, the
 *   sessions they came from). A frozen run is terminal like any stopped
 *   one, and more: every move on it refuses RUN_FROZEN (a re-stop is a
 *   no-op), and no server write may clobber a freeze that landed between
 *   its read and its rename -- the re-read in writeManifestFile. Hooks have
 *   no tracker access, so the one plain-language comment a freeze owes is
 *   the server's: markFreezeCommented records it, once.
 *
 * removeWhen: never — push authority is an owner-decided policy gate, not
 *   a workaround for a model limit; a stronger agent does not change who
 *   decides what leaves the machine (ADR 0007).
 * Author(s): John Reed
 */
import { z } from "zod";
import { CairnError } from "../errors.js";
/** The cairn home folders whose files belong to the repository, keyed by
 *  projectKey. handoff/ and banner/ are absent on purpose: per worktree. */
export declare const REPOSITORY_STATE_DIRS: readonly ["index", "metrics", "outlook", "yield", "loop", "state", "refusals", "runs", "ship-gate", "budget"];
/** The checkout folder's key -- the scheme every file used before #362. */
export declare function worktreeKey(projectDir: string): string;
/** The repository's common git dir, real path, or null outside a repository. */
export declare function gitCommonDir(projectDir: string): string | null;
/**
 * The repository's key: `git rev-parse --git-common-dir` resolved to a real
 * absolute path, hashed, named after the folder holding it (`repo/.git` reads
 * `repo`; a bare `repo.git` reads `repo`). Outside a repository it degrades to
 * worktreeKey, which is exactly the pre-#362 key. Cached per folder only on
 * the git answer, so a folder that becomes a repository is re-read.
 *
 * :param projectDir: any checkout of the repository
 * :returns: `<base>-<hash>`
 */
export declare function projectKey(projectDir: string): string;
/**
 * Moves `from` to `to` without ever replacing a `to` that exists: a hard
 * link (fails EEXIST rather than clobbering) then unlink the old name; across
 * devices, an exclusive copy then unlink. False when nothing moved.
 *
 * Concurrency -- the three handoff questions:
 *   atomicity -- the link is one syscall and refuses an existing target, so
 *     two processes moving the same file cannot both win or overwrite a
 *     file a writer just created under the new name.
 *   visibility -- between link and unlink both names are one inode; a
 *     writer appending through the old name lands in the moved file. The
 *     copy fallback has no such promise: a row appended mid-copy is lost.
 *   ordering -- none needed; whoever links first moved it, the rest see
 *     EEXIST or ENOENT and move nothing.
 */
export declare function moveNoClobber(from: string, to: string): boolean;
/**
 * The one-shot rekey's record: one row on the project's metrics log naming
 * what moved. It carries no session_id, so every latest-row-per-session
 * reader skips it. One append of one line, so it never tears another row.
 */
export declare function recordRekey(baseDir: string, projectDir: string, moved: string[]): void;
/**
 * Moves every repository-state file this folder kept under its worktree
 * key to the project key (#362): a name is `<key><rest>` where rest starts
 * with `.` or `-` (a closed metrics segment, a sqlite sidecar, a run id).
 * A name whose project-key twin exists is left where it is -- a linked
 * worktree that ran before the upgrade keeps its own leftovers, and the
 * shared file is never replaced. Nothing to move, nothing logged, so the
 * move is one-shot by construction: the old name is gone once it lands.
 *
 * :param projectDir: the checkout
 * :param baseDir: the cairn home
 * :returns: `<dir>/<old name>` for each file moved
 */
export declare function migrateRepositoryState(projectDir: string, baseDir?: string): string[];
/**
 * `<baseDir>/<dir>/<projectKey><suffix>`, after the one-shot move. When the
 * new name is still absent but the old one survived (the move could not
 * land), the old one is read instead -- nothing goes dark on an upgrade.
 *
 * :param projectDir: the checkout
 * :param dir: one of REPOSITORY_STATE_DIRS
 * :param suffix: what follows the key (`.jsonl`, `-<runId>.json`, ...)
 * :param baseDir: the cairn home
 */
export declare function repositoryPath(projectDir: string, dir: (typeof REPOSITORY_STATE_DIRS)[number], suffix: string, baseDir?: string): string;
/** ~/.cairn/runs/<projectKey>-<runId>.json — one manifest per run, outside
 * the repo, per repository: a batch run spans worktrees (#362). baseDir
 * injectable for tests (budget-ledger convention). */
export declare function runManifestPath(projectDir: string, runId: string, baseDir?: string): string;
export type RunStatus = "staged" | "running" | "complete" | "stopped";
export interface ManifestPhase {
    number: number;
    name: string;
    estimate: {
        low: number;
        high: number;
        estUsd: {
            low: number;
            high: number;
        };
    };
    waves?: number;
}
export interface StagedAnswer {
    phase?: number | string;
    question: string;
    answer: string;
}
export interface RunManifestState {
    version: 1;
    runId: string;
    project: string;
    created: string;
    phases: ManifestPhase[];
    /** Budget ceiling the run was staged under; null = explicitly uncapped. */
    ceiling: {
        tokens?: number;
        usd?: number;
    } | null;
    /** Push pre-authorization (REC-5 at run start). granted=false means the
     * run is verify-stop: phases run headless but NOTHING pushes. Scope is
     * always the manifest's own phases — never wider. */
    pushAuth: {
        granted: boolean;
        scope: "manifest-phases";
        grantedAt?: string;
    };
    /** Staging question-round answers (scout batch form) that travel with
     * the run so the executor never has to ask mid-flight. */
    answers?: StagedAnswer[];
    status: RunStatus;
    /** The Agent `effort` dial the run was staged under (#332), so
     * estimate-vs-actual can tell a cheap run from a thorough one. Absent on
     * manifests written before the dial existed. */
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    /** The manifest phase in flight (#260), set by setCurrentPhase at each
     * phase start. Absent until the first phase starts — and on manifests
     * written before it existed, which the run guard reads as "no push". */
    currentPhase?: number;
    /** Why the run stopped, when something other than the executor stopped
     * it (#358): today only the circuit breaker, written by the guards. */
    stop?: RunStop;
}
/** One guard refusal as breaker.mjs logs it (#358) -- fixed text and a
 * digest, never the raw command or path. */
export interface RefusalRow {
    ts: string;
    guard: string;
    tool: string;
    effect: string;
    reason: string;
    session_id: string | null;
    run_id?: string;
    input_sha256: string;
}
/** The breaker's freeze record (#358). */
export interface RunStop {
    reason: "breaker";
    at: string;
    /** auto.breaker as the guard read it, and the refusals it had counted. */
    limit: number;
    count: number;
    /** The last three refusals -- what the run report lists. */
    refusals: RefusalRow[];
    /** The sessions those refusals came from: the run guard refuses their pushes. */
    sessions: string[];
    /** The one tracker comment the freeze owes, once posted (server-written). */
    commentedAt?: string;
    commentedOn?: string;
}
export declare const RunManifestSchema: z.ZodType<RunManifestState>;
/** True for a manifest the circuit breaker froze (#358). */
export declare function isFrozenByBreaker(state: RunManifestState | null | undefined): boolean;
/** The typed refusal every move on a frozen run gets (#358), with the way it ends. */
export declare function runFrozenError(state: RunManifestState): CairnError;
/**
 * Writes a fresh manifest at staging time. One manifest per run — an
 * existing manifest for this runId throws instead of being overwritten
 * (re-staging a run means a new runId; history never gets clobbered).
 * pushAuth always starts granted:false — only grantPushAuth() can flip it.
 *
 * :param projectDir: the project the run belongs to
 * :returns the manifest state as written
 */
export declare function createRunManifest(projectDir: string, opts: {
    runId: string;
    phases: ManifestPhase[];
    ceiling?: {
        tokens?: number;
        usd?: number;
    } | null;
    answers?: StagedAnswer[];
    effort?: RunManifestState["effort"];
    createdAt?: string;
    baseDir?: string;
}): RunManifestState;
/**
 * Reads a run's manifest without mutating anything — the executor's (and
 * status displays') view. Throws NOT_FOUND when the run was never staged.
 */
export declare function readRunManifest(projectDir: string, runId: string, baseDir?: string): RunManifestState;
/**
 * Reads the manifest AND says where it lives. The run report (#134) writes
 * beside the manifest file, so the read carries the real resolved path —
 * the agent never re-derives hashed filenames from naming conventions.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to read
 * :returns the manifest state plus its absolute file path
 */
export declare function readRunManifestWithPath(projectDir: string, runId: string, baseDir?: string): RunManifestState & {
    path: string;
};
/**
 * Records the user's explicit push pre-authorization from the staging gate.
 * Only callable while the run is still 'staged' — authority is granted at
 * the front door or not at all, never mid-run.
 */
export declare function grantPushAuth(projectDir: string, runId: string, opts?: {
    grantedAt?: string;
    baseDir?: string;
}): RunManifestState;
/**
 * Advances the run's status along the legal lifecycle
 * (staged → running → complete|stopped; staged → stopped for a run
 * abandoned before start). Any other move throws. A run the breaker froze
 * (#358) is already stopped: stopping it again -- auto's wrap -- is a
 * no-op, and any other move is RUN_FROZEN.
 */
export declare function setRunStatus(projectDir: string, runId: string, status: RunStatus, baseDir?: string): RunManifestState;
/**
 * Marks which manifest phase is in flight (#260) — auto calls it at each
 * phase start, and the run guard honours push authority only while it
 * names one of the manifest's phases. Running runs only, the phase must be
 * in the manifest, and it only moves forward in manifest order: re-marking
 * the current phase (a resumed run) is a no-op, an earlier one throws.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to advance
 * :param phase: a phases[].number from this manifest
 * :returns the manifest state as written
 */
export declare function setCurrentPhase(projectDir: string, runId: string, phase: number, baseDir?: string): RunManifestState;
/**
 * Every valid manifest for a project, newest staged first (#358) -- what
 * the outlook board reads to say a project's latest run is frozen. A file
 * that fails to read or validate is skipped: the board decorates, it never
 * fails on a bad manifest.
 *
 * :param projectDir: the project the runs belong to
 * :returns manifest states, sorted by `created`, newest first
 */
export declare function listRunManifests(projectDir: string, baseDir?: string): RunManifestState[];
/**
 * Records that the one plain-language comment a freeze owes was posted
 * (#358), and on which issue. The comment is the server's -- hooks have no
 * tracker access -- and goes out at most once per freeze: a manifest that
 * already says commentedAt is left as it is.
 *
 * :param on: the issue the comment went to
 * :returns the manifest state as written (or as found, already commented)
 */
export declare function markFreezeCommented(projectDir: string, runId: string, opts: {
    on: string;
    at?: string;
    baseDir?: string;
}): RunManifestState;
/**
 * The tracker comment a freeze owes (#358), in plain language: what froze
 * the run, the refusals that tripped it, and the owner's way back. Reasons
 * and effects are the guards' fixed text, so no command or path reaches
 * the tracker.
 */
export declare function composeFreezeComment(state: RunManifestState): string;
