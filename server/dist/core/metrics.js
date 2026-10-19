/**
 * The metrics log's segment scheme, in one place (#237).
 *
 * The Stop hook segments the cost log instead of truncating it (#229): a full
 * segment is CLOSED by renaming it, and a fresh live segment takes over the
 * canonical name. Any reader that opens only the canonical name therefore sees
 * a truncated record the moment a project rotates for the first time -- and
 * reads that way silently, because a short file is indistinguishable from a
 * young one.
 *
 * Three readers learned to enumerate segments under #229 and two did not. This
 * module is the server's single copy, so the next reader inherits the
 * behaviour instead of reimplementing it. The hook scripts keep their own copy
 * in hooks/scripts/lib.mjs: hook scripts may never import server code, and
 * that boundary is the floor -- two copies, not one.
 *
 * The writer's naming rule lives in hooks/scripts/stop-costtracker.mjs. Change
 * it there and this must follow.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/**
 * Every segment of the metrics log, oldest first, the live one last.
 *
 * The live segment keeps the canonical name; a closed one is
 * "<stem>.<stamp>.jsonl" with a fixed-width UTC stamp, so a plain lexical sort
 * is chronological order.
 *
 * :param current: path to the live segment (the canonical name)
 * :returns: absolute paths, oldest segment first, always including `current`
 */
export function metricsSegments(current) {
    const dir = dirname(current);
    const stem = basename(current).replace(/\.jsonl$/, "");
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [current]; // no metrics dir yet -- the live segment is the whole story
    }
    const closed = names
        .filter((n) => n !== `${stem}.jsonl` && n.startsWith(`${stem}.`) && n.endsWith(".jsonl"))
        .sort();
    return [...closed.map((n) => join(dir, n)), current];
}
/**
 * Approximate agent spend for one issue, in USD -- the number
 * `hooks/scripts/cost-report.mjs --issue <id>` prints, read from the same
 * rows the same way, so the close fold (#365) can put it on the close
 * comment without a verb shelling out for it.
 *
 * Rows are cumulative per session, so the LATEST row per session_id across
 * every segment wins (a later one replaces, never adds); the issue's cost is
 * the sum of those winners naming it. A leading "#" is ignored on both
 * sides, so "365" and "#365" meet. Never throws: no log, a pruned segment
 * or a corrupt line all read as nothing, and nothing is 0.
 *
 * :param current: path to the live segment (the canonical name)
 * :param issueId: the issue the spend is attributed to
 * :returns: summed est_cost_usd, 0 when no row names the issue
 */
export function issueCostUsd(current, issueId) {
    const key = (v) => String(v).trim().replace(/^#/, "");
    const want = key(issueId);
    const bySession = new Map();
    for (const segment of metricsSegments(current)) {
        let raw;
        try {
            raw = readFileSync(segment, "utf8");
        }
        catch {
            continue; // pruned or never written -- not an error
        }
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const row = JSON.parse(line);
                if (typeof row?.session_id === "string")
                    bySession.set(row.session_id, row);
            }
            catch {
                // corrupt line -- skip, never guess
            }
        }
    }
    let usd = 0;
    for (const r of bySession.values()) {
        if (r.issue === undefined || r.issue === null || key(r.issue) !== want)
            continue;
        const n = Number(r.est_cost_usd ?? 0);
        if (Number.isFinite(n))
            usd += n;
    }
    return usd;
}
