/** The stamp as written: `by` is the checkout's git identity -- a record of
 *  whose checkout approved, not an authentication. */
export interface PlanApproval {
    version: 1;
    phaseDir: string;
    /** The blob of PLAN.md exactly as approved; `git cat-file -p` reads it back. */
    blob: string;
    at: string;
    by: string;
}
/** Stamps live beside the receipts in local state, never in git: the
 *  directory ignores itself, whatever the project's .gitignore knows. */
export declare function approvalsDir(projectDir: string): string;
/**
 * Records the owner's approval of a phase's PLAN.md as it reads right now.
 * The latest approval wins -- a re-approval after an edit is a new human
 * act and replaces the stamp. Throws a typed error when there is nothing
 * to approve (no PLAN.md) or no git to hold the blob; the caller is a tool
 * handler and renders it.
 *
 * :param projectDir: project root
 * :param phaseDir: the phase directory name ("01-core")
 * :returns the stamp as written
 */
export declare function approvePlan(projectDir: string, phaseDir: string, now?: () => Date): PlanApproval;
/**
 * The approval stamp for a phase, or null when there is none or it is not
 * a stamp. Never throws: a corrupt file is the same as no approval, and
 * the re-run fails closed on either.
 */
export declare function readPlanApproval(projectDir: string, phaseDir: string): PlanApproval | null;
