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
// Imports
import { readFileSync } from "node:fs";
import { metricsPath } from "../core/continuity.js";
import { metricsSegments } from "../core/metrics.js";
import { clusterFindings } from "../seats/dedup.js";
// Dedup on intake
/** "path:line" → file + line; anything else is a file with no line. */
function location(at) {
    const m = /^(.*):(\d+)$/.exec(at?.trim() ?? "");
    return m ? { file: m[1], line: Number(m[2]) } : { file: at?.trim() ?? "", line: 0 };
}
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
export function dedupIntake(findings) {
    const origin = [];
    const seatFindings = [];
    findings.forEach((f, i) => {
        const seats = f.seats && f.seats.length > 0 ? f.seats : [""];
        for (const seat of seats) {
            origin.push(i);
            seatFindings.push({ seat, ...location(f.at), claim: f.title,
                failure_scenario: f.failure_scenario, severity: f.severity });
        }
    });
    return clusterFindings(seatFindings).map((c) => {
        const canon = findings[origin[c.canonical]];
        const members = [canon, ...[...new Set(c.members.map((m) => origin[m]))].map((i) => findings[i])];
        const pick = (k) => members.find((m) => m[k] !== undefined)?.[k];
        const votes = new Map();
        for (const m of members) {
            for (const v of m.panel ?? [])
                votes.set(JSON.stringify([v.seat, v.verdict, v.evidence]), v);
        }
        const seats = c.finding.seats.map((s) => s.seat).filter((s) => s !== "");
        const { file, line } = c.finding;
        const merged = {
            severity: c.finding.severity, title: c.finding.claim,
            failure_scenario: c.finding.failure_scenario ?? canon.failure_scenario,
        };
        if (file)
            merged.at = line > 0 ? `${file}:${line}` : file;
        if (seats.length > 0)
            merged.seats = seats;
        if (votes.size > 0)
            merged.panel = [...votes.values()];
        const detail = pick("detail");
        if (detail !== undefined)
            merged.detail = detail;
        const issue = pick("issue");
        if (issue !== undefined)
            merged.issue = issue;
        const patch = pick("patch");
        if (patch !== undefined)
            merged.patch = patch;
        return merged;
    });
}
// Filing
/** "the a seat" / "the a and b seats" / "the a, b, and c seats". */
function seatPhrase(seats) {
    if (seats.length === 1)
        return `the ${seats[0]} seat`;
    const head = seats.slice(0, -1).join(", ");
    return `the ${head}${seats.length > 2 ? "," : ""} and ${seats.at(-1)} seats`;
}
/**
 * The filed issue's body: the severity as the literal first line, then the
 * failure, where, who raised it, how the panel landed, and the detail.
 *
 * :param scope: the audit scope the record was written under
 * :param f: the finding
 * :param r: its judged result
 * :returns: the body text
 */
export function issueBody(scope, f, r) {
    const sev = f.severity[0].toUpperCase() + f.severity.slice(1);
    const lines = [`${sev}: ${f.title.trim()}`, "", `What fails: ${f.failure_scenario.trim()}`];
    if (f.at?.trim())
        lines.push(`Where: ${f.at.trim()}`);
    if (f.seats && f.seats.length > 0)
        lines.push(`Raised by ${seatPhrase(f.seats)}.`);
    if (f.panel && f.panel.length > 0) {
        lines.push(`Panel: ${r.outcome} (${f.panel.map((v) => `${v.seat} ${v.verdict}`).join(", ")}).`);
    }
    if (f.detail?.trim())
        lines.push("", f.detail.trim());
    lines.push("", `From the ${scope} audit record.`);
    return lines.join("\n");
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
export async function fileSurvivors(tracker, scope, findings, results, sweep) {
    const labels = sweep ? ["cairn:audit", "cairn:sweep"] : ["cairn:audit"];
    const out = { created: [], errors: [] };
    for (const [i, f] of findings.entries()) {
        const r = results[i];
        if (!r.survived || f.severity === "minor")
            continue;
        try {
            if (f.issue) {
                r.issue = f.issue;
                if (!sweep)
                    continue;
                const have = (await tracker.getIssue(f.issue)).labels;
                if (!have.includes("cairn:sweep"))
                    await tracker.updateIssue(f.issue, { labels: [...have, "cairn:sweep"] });
                continue;
            }
            const issue = await tracker.createIssue({ title: f.title.trim(), body: issueBody(scope, f, r), labels });
            r.issue = issue.id;
            out.created.push(issue);
        }
        catch (e) {
            out.errors.push(`${f.title.trim()}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return out;
}
// Spend
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
export function filedCost(projectDir, ids, path = metricsPath(projectDir)) {
    const latest = new Map();
    for (const segment of metricsSegments(path)) {
        let raw;
        try {
            raw = readFileSync(segment, "utf8");
        }
        catch {
            continue;
        }
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const row = JSON.parse(line);
                if (typeof row?.session_id === "string")
                    latest.set(row.session_id, row);
            }
            catch { /* corrupt line -- skip, never guess */ }
        }
    }
    const want = new Set(ids);
    const rows = [...latest.values()].filter((r) => typeof r.issue === "string" && want.has(r.issue));
    if (rows.length === 0)
        return null;
    return Number(rows.reduce((s, r) => s + (r.est_cost_usd ?? 0), 0).toFixed(2));
}
