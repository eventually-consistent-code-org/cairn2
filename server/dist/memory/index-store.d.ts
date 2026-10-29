import { type SqliteLoader } from "./native.js";
export interface Chunk {
    content: string;
    source: string;
    phase: number | null;
    issueId: string | null;
    role?: string | null;
    createdAt: string;
}
export interface SearchResult {
    content: string;
    source: string;
    phase: number | null;
    issueId: string | null;
    role: string | null;
    createdAt: string;
}
export interface IndexStats {
    chunkCount: number;
    approxBytes: number;
    approxTokens: number;
}
/** ~/.cairn/index/<projectKey>.db -- one FTS index per repository (#362), so
 *  a linked worktree searches the memory the main checkout built. */
export declare function indexDbPath(projectDir: string): string;
export declare class MemoryIndex {
    private db;
    constructor(dbPath: string, load?: SqliteLoader);
    index(chunk: Chunk): void;
    search(query: string, filter?: {
        phase?: number;
        issueId?: string;
        role?: string;
    }, limit?: number): SearchResult[];
    /** createdAt of the earliest-indexed chunk for `source`, or undefined if none exists. */
    sourceCreatedAt(source: string): string | undefined;
    /**
     * Chronologically adjacent index chunks around `anchorCreatedAt` -- up to
     * `before` chunks strictly earlier (closest first reversed to ascending)
     * and up to `after` chunks strictly later, concatenated ascending. Ties
     * on the exact anchor timestamp are excluded (that's the anchor itself,
     * or a same-millisecond collision -- neither belongs in its own neighbor
     * list).
     */
    timeline(anchorCreatedAt: string, before: number, after: number): SearchResult[];
    stats(): IndexStats;
    close(): void;
}
