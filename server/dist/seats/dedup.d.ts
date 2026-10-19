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
export declare const LINE_WINDOW = 2;
export declare const CLAIM_SIMILARITY_THRESHOLD = 0.5;
export declare const SEVERITIES: readonly ["critical", "important", "minor"];
export type Severity = (typeof SEVERITIES)[number];
/** One seat's raw finding, exactly as the seat raised it. */
export interface SeatFinding {
    /** Name of the seat that raised it (e.g. "security"). */
    seat: string;
    /** File the finding points at. */
    file: string;
    /** 1-based line the finding points at. */
    line: number;
    /** The claim — what's wrong, in the seat's words. */
    claim: string;
    /**
     * The concrete failure ("inputs/state → wrong output/crash"). Optional
     * here so the pure library stays backward compatible; when two seats
     * both give one, matching scenarios are a second merge path (same
     * failure under different headlines). audit_record requires it.
     */
    failure_scenario?: string;
    severity: Severity;
    /** The seat's anchored 0-10 score for its walk, when it gave one. */
    score?: number;
}
/** One seat's credit on a merged finding — name plus its own score. */
export interface SeatCredit {
    seat: string;
    score?: number;
}
/** One deduplicated finding, crediting every seat that raised it. */
export interface DedupedFinding {
    file: string;
    /** Lowest line among the merged findings (the cluster anchor). */
    line: number;
    /** Canonical claim — from the highest-severity raising finding. */
    claim: string;
    /**
     * Canonical failure scenario — the winner's (highest-severity raising
     * finding) when it gave one, else the first merged member that did.
     * Absent only when no raising seat supplied one.
     */
    failure_scenario?: string;
    /** Highest severity any raising seat assigned. */
    severity: Severity;
    /** Every raising seat, sorted by name, each with its own score. */
    seats: SeatCredit[];
}
/**
 * Lowercases and collapses every non-alphanumeric run to a single space —
 * the normalized form two claims are compared in. Exported (#215) so the
 * sweep manifest's baseline delta matches findings by the same rule.
 *
 * :param claim: raw claim text
 * :returns: normalized claim string
 */
export declare function normalizeClaim(claim: string): string;
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
export declare function claimsMatch(aNorm: string, aSet: Set<string>, bNorm: string, bSet: Set<string>): boolean;
/**
 * Convenience over normalizeClaim + claimsMatch for two raw strings —
 * normalizes both, builds the token sets, and applies the same rule.
 *
 * :param a: first raw claim (or failure scenario)
 * :param b: second raw claim
 * :returns: true when the two describe the same finding
 */
export declare function textsMatch(a: string, b: string): boolean;
/** One merged finding plus which inputs it absorbed (#368). */
export interface FindingCluster {
    finding: DedupedFinding;
    /** Indices into the input array, in clustering order. */
    members: number[];
    /** Input index that owns the canonical claim. */
    canonical: number;
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
export declare function dedupFindings(findings: SeatFinding[]): DedupedFinding[];
/**
 * dedupFindings with its working shown: each merged finding alongside the
 * input indices it absorbed, so audit_record's intake (#368) can carry a
 * cluster's panel votes and detail onto the one finding it records. Same
 * engine, same order — dedupFindings is this, minus the indices.
 *
 * :param findings: raw per-seat findings, any order
 * :returns: one cluster per deduplicated finding, in dedupFindings' order
 */
export declare function clusterFindings(findings: SeatFinding[]): FindingCluster[];
