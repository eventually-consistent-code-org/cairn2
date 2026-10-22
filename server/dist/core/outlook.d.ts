import { z } from "zod";
import { type Handoff, type WaveRef } from "./continuity.js";
/**
 * The outlook snapshot (#55/#88): a compact, machine-readable "where this
 * project stands" written as a side effect of state-changing tool calls.
 * Everything derivable locally is re-derived fresh on every emit; the
 * `tracker` block is verb-supplied (issue counts, next verb) and merges
 * forward from the previous snapshot so a plain emit can't erase it.
 * Zero network at emit time, always.
 */
export interface OutlookPhase {
    number: number;
    name: string;
    planned: boolean;
    verified: boolean;
    issueCount: number;
}
export interface OutlookTracker {
    open?: number;
    inProgress?: number;
    blocked?: number;
    nextVerb?: string;
    asOf?: string;
}
/** The project's latest batch run, when the circuit breaker froze it (#358). */
export interface OutlookFrozen {
    runId: string;
    at: string;
    refusals: number;
}
export interface OutlookSnapshot {
    version: 1;
    ts: string;
    name: string;
    path: string;
    head?: string;
    phases: OutlookPhase[];
    sessions: {
        trace: number;
        probe: number;
        draft: number;
        thread: number;
    };
    tracker?: OutlookTracker;
    frozen?: OutlookFrozen;
}
export declare const OutlookSnapshotSchema: z.ZodType<OutlookSnapshot>;
/** The machine-wide mirror the aggregate reads (never walks repos). */
export declare function outlookMirrorPath(projectDir: string, home?: string): string;
/** The in-repo copy -- travels with the project, diffable when committed. */
export declare function outlookLocalPath(projectDir: string): string;
/**
 * The tracker block a wave checkpoint composes server-side (#370). The
 * server has no network at emit time, so the counts it "already can"
 * derive are the ones the previous snapshot carried; a project with no
 * prior block gets zeros. asOf is this emit, nextVerb is the resume line.
 */
export declare function waveTracker(previous: OutlookTracker | undefined, wave: WaveRef, now?: string): OutlookTracker;
/**
 * The project's latest batch run, when the circuit breaker froze it
 * (#358) -- re-derived from the run manifests on every emit, like the rest
 * of the snapshot. Only the newest staged run counts: once the owner
 * re-stages, the board stops saying frozen. Never throws -- the board
 * decorates, it doesn't fail.
 */
export declare function frozenRun(projectDir: string, home?: string): OutlookFrozen | undefined;
/**
 * Derives a fresh snapshot and dual-writes it (in-repo + machine mirror),
 * both atomic. Mirrors writeHandoff's guards: unregistered projects skip
 * silently (CONFIG_MISSING, returns null), and the previous snapshot's
 * verb-supplied `tracker` block carries forward unless this emit brings a
 * newer one -- the outlook cousin of the handoff's monotonic-richness rule.
 * A `wave` patch composes that newer block itself (waveTracker).
 *
 * Callers treat this as fire-and-forget; the refreshHandoff wrapper (and
 * any other call site) swallows what this throws. The written snapshot
 * comes back for the one caller that reports it (waveCheckpoint).
 */
export declare function emitOutlook(projectDir: string, patch?: {
    tracker?: OutlookTracker;
    wave?: WaveRef;
}, home?: string): OutlookSnapshot | null;
export interface WaveCheckpointResult {
    handoff: Handoff | null;
    stale: boolean;
    outlook: {
        emitted: boolean;
        tracker?: OutlookTracker;
        error?: string;
    };
}
/**
 * The wave fold (#370): one call writes the handoff AND emits the outlook
 * snapshot, both carrying the same run id, so a wave can never be
 * resumable from the handoff yet invisible on the board (or the reverse).
 * The server composes both strings from the one WaveRef; a caller's own
 * notes ride behind the composed line. Source is always "tool" -- a wave
 * dispatch is a tool checkpoint and the wave identity lives in notes.
 *
 * Fail-open on the outlook half: the handoff is the resume path and must
 * land; a broken snapshot never blocks it and comes back as emitted:false
 * with the reason, so the caller reads a measurement, not a claim.
 */
export declare function waveCheckpoint(projectDir: string, patch: Partial<Handoff>, wave: WaveRef, home?: string): WaveCheckpointResult;
/** Reads a project's mirror snapshot; corrupt or missing reads as null. */
export declare function readOutlook(projectDir: string, home?: string): OutlookSnapshot | null;
export interface OutlookCard {
    name: string;
    path: string;
    lastSeen: string;
    snapshot?: OutlookSnapshot;
    stale?: boolean;
    staleReason?: string;
    error?: string;
    costUsd?: number;
    costByKind?: Record<string, number>;
}
/** Metrics file for a project -- same basename+hash scheme as the mirror.
 *  This join is WHY the registry keeps absolute paths: the hash alone is
 *  not reversible. */
export declare function metricsPathFor(projectDir: string, home?: string): string;
/**
 * Per-project agent spend (#92): rows are cumulative per session, so the
 * total is the sum of each session's LATEST row (cost-report.mjs contract).
 * Missing or corrupt metrics read as zero -- cost is decoration on the
 * board, never a reason a card fails.
 *
 * Segments are read oldest first (#237), so a session that opened in a closed
 * segment and picked up a later row in the live one is REPLACED rather than
 * summed. Reading the live segment alone made the board's spend figure shrink
 * at each rotation, which reads as spend falling rather than as history lost.
 */
export declare function projectCost(projectDir: string, home?: string): {
    costUsd: number;
    costByKind: Record<string, number>;
} | null;
/** The written board (#91) -- machine-level on purpose: an in-repo copy of
 *  the FLEET board would leak every other project's name into whichever repo
 *  committed it. One artifact per machine, shareable by hand. */
export declare function outlookArtifactPath(home?: string): string;
/** Renders the board as manager-facing markdown -- same data as the cards. */
export declare function renderOutlookMd(cards: OutlookCard[], now: string): string;
/**
 * The portfolio aggregate (#89): registry + mirror snapshots ONLY -- never
 * walks the filesystem for repos. Staleness is the card pattern, not a
 * date: the snapshot's recorded HEAD vs the repo's live HEAD. Per-project
 * failures become `{name, error}` cards (workspace_status precedent);
 * one broken project can never take down the board.
 */
export declare function outlookAggregate(home?: string, opts?: {
    artifact?: boolean;
}): {
    projects: OutlookCard[];
    artifactPath?: string;
};
