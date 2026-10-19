/**
 * Purpose: the seat-finding dedup engine — N seats over one target
 * collapse to ONE finding set before anything reaches the tracker (the
 * phase's hard requirement). Pure library, no tool of its own: since #368
 * audit_record(dedup: true) runs it on intake, so the verbs reach it
 * through that call instead of a node one-liner against dist.
 * Dependency-free and deterministic on purpose: shuffled input, same
 * output, every time.
 *
 * removeWhen: one call can produce the whole panel's findings already
 *   merged, matching this engine's output on a recorded corpus (ADR 0012).
 *   Tested 2026-10-14 on Claude Code 2.1.299 (evals-corpus/, #334): the
 *   native `/code-review high --max-findings all` matched the panel on
 *   recall (100% / 100%) and lost on precision (27% vs 100%) -- it raises
 *   what dedup and the refutation vote would have removed. Unmet; the
 *   numbers and the method are in the ADR's Evidence section. Next test:
 *   the native call at its default finding limit (#372).
 * Author(s): John Reed
 */
// Constants
// Two findings merge only when they sit on the same file within this many
// lines of the cluster's anchor (its lowest-line member). ±2 catches the
// "same bug, seat quoted the line above/below" case without gluing
// together genuinely separate findings further apart.
export const LINE_WINDOW = 2;
// Claim similarity floor: normalized-token Jaccard overlap
// (|intersection| / |union|) must reach this for two claims to count as
// the same finding. 0.5 means the claims share at least as many tokens
// as they differ by — paraphrases of one bug clear it, distinct claims
// about the same location don't. Exact normalized match short-circuits.
export const CLAIM_SIMILARITY_THRESHOLD = 0.5;
// Highest severity first — a merged finding keeps the worst rating any
// seat gave it. Rank = index into this list.
export const SEVERITIES = ["critical", "important", "minor"];
// Claim normalization + similarity
/**
 * Lowercases and collapses every non-alphanumeric run to a single space —
 * the normalized form two claims are compared in. Exported (#215) so the
 * sweep manifest's baseline delta matches findings by the same rule.
 *
 * :param claim: raw claim text
 * :returns: normalized claim string
 */
export function normalizeClaim(claim) {
    return claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/**
 * Token-set Jaccard similarity between two normalized claims, with an
 * exact-match fast path. Deterministic, dependency-free. Exported (#215)
 * for the sweep manifest's scenario-similarity delta.
 *
 * :param aNorm: first normalized claim
 * :param aSet: its token set
 * :param bNorm: second normalized claim
 * :param bSet: its token set
 * :returns: true when the claims describe the same finding
 */
export function claimsMatch(aNorm, aSet, bNorm, bSet) {
    // Exact fast path — identical normalized text is the same claim, no
    // set math needed.
    if (aNorm === bNorm)
        return true;
    if (aSet.size === 0 || bSet.size === 0)
        return false;
    let intersection = 0;
    for (const token of aSet) {
        if (bSet.has(token))
            intersection++;
    }
    const union = aSet.size + bSet.size - intersection;
    return intersection / union >= CLAIM_SIMILARITY_THRESHOLD;
}
/**
 * Convenience over normalizeClaim + claimsMatch for two raw strings —
 * normalizes both, builds the token sets, and applies the same rule.
 *
 * :param a: first raw claim (or failure scenario)
 * :param b: second raw claim
 * :returns: true when the two describe the same finding
 */
export function textsMatch(a, b) {
    const aNorm = normalizeClaim(a);
    const bNorm = normalizeClaim(b);
    // Two texts with nothing comparable left after normalization are not
    // "the same finding" — the exact fast path would otherwise say so.
    if (aNorm === "" || bNorm === "")
        return false;
    return claimsMatch(aNorm, new Set(aNorm.split(" ").filter(Boolean)), bNorm, new Set(bNorm.split(" ").filter(Boolean)));
}
/**
 * Second merge path (phase 21): two findings whose CLAIMS differ but whose
 * failure scenarios match describe the same failure under different
 * headlines. Only fires when both sides supplied a scenario — absent on
 * either side, the claim path alone decides, exactly as before.
 *
 * :param a: cluster anchor's scenario form
 * :param b: candidate member's scenario form
 * :returns: true when both scenarios exist and match
 */
function scenariosMatch(a, b) {
    if (a.norm === undefined || b.norm === undefined)
        return false;
    return claimsMatch(a.norm, a.tokens, b.norm, b.tokens);
}
/**
 * Rank of a severity — lower is worse (critical = 0).
 *
 * :param s: severity label
 * :returns: index into SEVERITIES
 */
function severityRank(s) {
    return SEVERITIES.indexOf(s);
}
/**
 * Collapses N seats' findings over one target into one finding set.
 *
 * Merge rule (documented here, tested in test/dedup.test.ts): two
 * findings merge when they name the SAME file, sit within LINE_WINDOW
 * (±2) lines of the cluster's anchor — its lowest-line member — and
 * their claims match: exact normalized text, or normalized-token Jaccard
 * overlap at or above CLAIM_SIMILARITY_THRESHOLD (0.5) — OR, when both
 * supplied a failure_scenario, their scenarios match by the same rule
 * (same failure, different headline). Distinct claims with distinct (or
 * absent) scenarios at the same location stay separate findings.
 *
 * A merged finding credits every raising seat (`seats`, sorted by name,
 * one entry per seat with that seat's own score attributed), keeps the
 * HIGHEST severity any seat assigned, anchors at the lowest merged line,
 * and carries the claim of the highest-severity raising finding.
 *
 * Deterministic: input is sorted (file, line, severity, seat, claim)
 * before clustering, so shuffled input yields byte-identical output.
 * Output order is (file, line, severity, claim).
 *
 * :param findings: raw per-seat findings, any order
 * :returns: the deduplicated finding set, deterministically ordered
 */
export function dedupFindings(findings) {
    return clusterFindings(findings).map((c) => c.finding);
}
/**
 * dedupFindings with its working shown: each merged finding alongside the
 * input indices it absorbed, so audit_record's intake (#368) can carry a
 * cluster's panel votes and detail onto the one finding it records. Same
 * engine, same order — dedupFindings is this, minus the indices.
 *
 * :param findings: raw per-seat findings, any order
 * :returns: one cluster per deduplicated finding, in dedupFindings' order
 */
export function clusterFindings(findings) {
    // Sort first — clustering order is what makes the greedy pass
    // deterministic under shuffled input.
    const sorted = findings.map((finding, index) => ({ finding, index })).sort(({ finding: a }, { finding: b }) => a.file.localeCompare(b.file) ||
        a.line - b.line ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.seat.localeCompare(b.seat) ||
        a.claim.localeCompare(b.claim));
    // Greedy anchored clustering: each finding joins the first cluster
    // whose anchor it matches, else starts its own. Anchoring the window
    // to the lowest-line member keeps chains from drifting (10 and 12
    // merge; 14 does not ride along on 12's coattails).
    const clusters = [];
    for (const { finding, index } of sorted) {
        const norm = normalizeClaim(finding.claim);
        const tokens = new Set(norm.split(" ").filter(Boolean));
        const member = { finding, index, norm, tokens };
        if (finding.failure_scenario !== undefined && finding.failure_scenario.trim() !== "") {
            member.scenarioNorm = normalizeClaim(finding.failure_scenario);
            member.scenarioTokens = new Set(member.scenarioNorm.split(" ").filter(Boolean));
        }
        const home = clusters.find((c) => c.file === finding.file &&
            Math.abs(finding.line - c.anchorLine) <= LINE_WINDOW &&
            (claimsMatch(c.anchorNorm, c.anchorTokens, norm, tokens) ||
                scenariosMatch({ norm: c.anchorScenarioNorm, tokens: c.anchorScenarioTokens }, { norm: member.scenarioNorm, tokens: member.scenarioTokens })));
        if (home) {
            home.members.push(member);
        }
        else {
            clusters.push({
                file: finding.file,
                anchorLine: finding.line,
                anchorNorm: norm,
                anchorTokens: tokens,
                anchorScenarioNorm: member.scenarioNorm,
                anchorScenarioTokens: member.scenarioTokens,
                members: [member],
            });
        }
    }
    // Fold each cluster into one finding.
    const out = clusters.map((cluster) => {
        // Members arrive in (line, severity, seat, claim) order — the first
        // member at the best (lowest) severity rank owns the canonical claim.
        const bestRank = Math.min(...cluster.members.map((m) => severityRank(m.finding.severity)));
        const canonical = cluster.members.find((m) => severityRank(m.finding.severity) === bestRank);
        // One credit per seat; a seat that raised it twice keeps the score
        // from its first (highest-severity, per sort) instance.
        const credits = new Map();
        for (const m of [...cluster.members].sort((a, b) => severityRank(a.finding.severity) - severityRank(b.finding.severity))) {
            if (!credits.has(m.finding.seat)) {
                credits.set(m.finding.seat, {
                    seat: m.finding.seat,
                    ...(m.finding.score !== undefined ? { score: m.finding.score } : {}),
                });
            }
        }
        // The winner's scenario survives the merge; a winner without one
        // borrows the first member's that has one (sorted order, so stable).
        const scenario = canonical.scenarioNorm !== undefined
            ? canonical.finding.failure_scenario
            : cluster.members.find((m) => m.scenarioNorm !== undefined)?.finding.failure_scenario;
        const finding = {
            file: cluster.file,
            line: cluster.anchorLine,
            claim: canonical.finding.claim,
            ...(scenario !== undefined ? { failure_scenario: scenario } : {}),
            severity: SEVERITIES[bestRank],
            seats: [...credits.values()].sort((a, b) => a.seat.localeCompare(b.seat)),
        };
        return { finding, members: cluster.members.map((m) => m.index), canonical: canonical.index };
    });
    // Deterministic output order: file, line, severity, claim.
    out.sort(({ finding: a }, { finding: b }) => a.file.localeCompare(b.file) ||
        a.line - b.line ||
        severityRank(a.severity) - severityRank(b.severity) ||
        a.claim.localeCompare(b.claim));
    return out;
}
