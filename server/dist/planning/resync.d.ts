export interface OutOfBandCommit {
    sha: string;
    subject: string;
    files: string[];
}
export interface ResyncReport {
    outOfBand: OutOfBandCommit[];
    sinceSha: string | null;
    headSha: string;
    initialized?: boolean;
}
/** What the working tree looked like when something was recorded (#195). */
export interface RevisionStamp {
    /** Full HEAD sha at capture time. */
    commit: string;
    /** True when tracked files carried uncommitted changes — the recorded
     *  judgment covered content HEAD does not have. Untracked files are
     *  ignored on purpose (scratch files are common, and .cairn/ itself is
     *  usually untracked). */
    dirty: boolean;
}
/**
 * Captures HEAD + dirty flag for a record writer — server-side, at write
 * time, never model-asserted. Returns null outside a git repo or before
 * the first commit, so writers that never needed git keep working
 * (audit records in a bare temp dir, say) and simply carry no stamp.
 *
 * :param projectDir: repository root
 * :returns: the stamp, or null when git can't answer
 */
export declare function revisionStamp(projectDir: string): RevisionStamp | null;
/**
 * Counts commits reachable from HEAD but not from `commit` that touch any
 * path outside `excludeDir` and the non-code prose above — "how much code
 * moved since this stamp". Null when git can't resolve the range (commit
 * rebased away, gc'd, or not a repo): the caller decides whether
 * unknowable means stale.
 *
 * :param projectDir: repository root
 * :param commit: the stamp's commit
 * :param excludeDir: top-level directory whose changes don't count (docs)
 * :returns: commit count, or null when unknowable
 */
export declare function codeCommitsSince(projectDir: string, commit: string, excludeDir?: string): number | null;
export declare function resyncReport(projectDir: string): ResyncReport;
