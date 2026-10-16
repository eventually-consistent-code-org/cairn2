export type TraceKind = "evidence" | "hypothesis" | "test" | "verdict";
export interface TraceInfo {
    id: string;
    status: "open" | "resolved";
    issue: string;
    created: string;
    resolved?: string;
    entryCounts: Record<TraceKind, number>;
    description: string;
}
export declare const traceId: (description: string) => string;
/**
 * Open a trace. `evidence`, when given, lands as the first entry in the same
 * motion (#367): the failed-verification route is one call, not two.
 */
export declare function startTrace(projectDir: string, description: string, issueId: string, evidence?: string): {
    id: string;
    path: string;
};
export declare const appendTrace: (projectDir: string, id: string, kind: TraceKind, text: string) => {
    path: string;
};
export declare const lastEntryKind: (projectDir: string, id: string) => TraceKind | null;
export declare const listTraces: (projectDir: string, status?: "open" | "resolved") => TraceInfo[];
/** The tracker issue an open trace is mirrored to, or null when no such trace is open. */
export declare const traceIssue: (projectDir: string, id: string) => string | null;
export interface TraceProvenance {
    file: string;
    commit: string;
}
/**
 * Derive card provenance from a trace's own evidence/test/verdict entries
 * (#367): every file named in those entries, paired with the commit named in
 * the same entry when there is one, else the last commit the trace named
 * anywhere (the verdict's fix sha, in the common shape). A file with no
 * commit to pair against is dropped — the card schema wants pairs, and a
 * guessed commit is worse than none.
 */
export declare function traceProvenance(entries: Array<{
    kind: TraceKind;
    text: string;
}>): TraceProvenance[];
/** Typed entries of a trace file (live or archived), in file order; empty texts dropped. */
export declare function traceEntries(path: string): Array<{
    kind: TraceKind;
    text: string;
}>;
export declare function closeTrace(projectDir: string, id: string, resolution: string): {
    id: string;
    issue: string;
    description: string;
    verdicts: string[];
    archivePath: string;
    /** The first `test` entry — the reproduction (command + observed failing output). */
    repro: string;
    /** Files + commits the trace's own evidence/test/verdict entries named (#367). */
    provenance: TraceProvenance[];
};
