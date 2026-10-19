/**
 * Purpose: the audit closing chain, behind audit_record's flags (#368).
 * Everything after the panel votes is known before any result is seen —
 * dedup the seats' findings, file each surviving critical/important one
 * with a severity-first body, sum the filed issues' agent spend — so the
 * server does it instead of N hand-typed issue bodies. writeAuditRecord
 * still judges; this module only feeds it (dedupIntake) and acts on its
 * verdicts (fileSurvivors, filedCost).
 * Author(s): John Reed
 */
import type { Issue, Tracker } from "../tracker/types.js";
import type { AuditFinding, FindingResult } from "./record.js";
/**
 * Collapses the submitted findings through the dedup engine — the same
 * clusterFindings that backs dedupFindings, so the recorded set IS the
 * library result. Each finding enters once per raising seat (`seats`), at
 * its `at` location, with its title as the claim. A merged finding takes
 * the engine's claim, severity, scenario and seat credits; its panel is
 * every member's votes (exact repeats once), and its detail, issue and
 * patch come from the canonical member, else the first member with one.
 *
 * :param findings: the raw per-seat findings, any order
 * :returns: the deduplicated findings, in the engine's order
 */
export declare function dedupIntake(findings: AuditFinding[]): AuditFinding[];
/**
 * The filed issue's body: the severity as the literal first line, then the
 * failure, where, who raised it, how the panel landed, and the detail.
 *
 * :param scope: the audit scope the record was written under
 * :param f: the finding
 * :param r: its judged result
 * :returns: the body text
 */
export declare function issueBody(scope: string, f: AuditFinding, r: FindingResult): string;
export interface FilingOutcome {
    /** Issues created by this call. */
    created: Issue[];
    /** One plain line per filing (or sweep-label) call the tracker refused. */
    errors: string[];
}
/**
 * Files every surviving critical/important finding that has no issue yet
 * and stamps the id on its result (refuted and minor findings never reach
 * here). A finding that already carries an issue keeps it; on a sweep
 * manifest that issue also gains the cairn:sweep label, so one filter
 * shows everything the sweep raised. Fail-open per finding: a refusal is
 * an error line, never a lost record.
 *
 * :param tracker: the project's tracker
 * :param scope: the record's scope
 * :param findings: the recorded findings
 * :param results: writeAuditRecord's results, same order — mutated with `issue`
 * :param sweep: true on a sweep manifest scope
 * :returns: the created issues and any refusals
 */
export declare function fileSurvivors(tracker: Tracker, scope: string, findings: AuditFinding[], results: FindingResult[], sweep: boolean): Promise<FilingOutcome>;
/**
 * Summed agent spend for a set of issues, from the Stop hook's cost log —
 * the latest row per session (rows are cumulative), oldest segment first,
 * the same collapse cost-report.mjs makes for `--issue`.
 *
 * :param projectDir: repository root (keys the log)
 * :param ids: issue ids to sum over
 * :param path: the log's live segment (test seam)
 * :returns: dollars, or null when the log has no rows for any of them
 */
export declare function filedCost(projectDir: string, ids: string[], path?: string): number | null;
