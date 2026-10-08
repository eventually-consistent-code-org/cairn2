/**
 * Purpose: the audit record writer — the single place a review/audit pass
 * lands its findings (.cairn/audit/<scope>-<date>.md). Since phase 21 it
 * is also where a finding is JUDGED: every finding carries a typed
 * failure_scenario, critical/important findings carry a refutation panel
 * whose quorum is computed here (never model-asserted), REFUTED findings
 * stay in the record but never reach the tracker, and survivors credit
 * the raising seats' yield. The record is stamped with the commit it
 * judged. Since #215 a `sweep-<YYYY-MM-DD>` scope is a sweep MANIFEST:
 * it carries the cairn version, a leg index, and a delta against the
 * previous manifest (new / persisting / fixed / regressed / unchecked) —
 * computed here, in the writer, never by a reader tool. Since #266 a prior
 * finding reads `fixed` only when its own leg ran again in this sweep;
 * otherwise it is `unchecked` and carried forward. parseAuditRecord reads
 * any record back.
 *
 * removeWhen: verifier votes reliably agree with human triage across a
 *   milestone, so the server-computed quorum can become advisory.
 * Author(s): John Reed
 */
export type AuditSeverity = "critical" | "important" | "minor";
/** One verifier's vote on one finding. */
export type PanelVerdict = "CONFIRMED" | "PLAUSIBLE" | "REFUTED";
export interface PanelVote {
    /** The lens the verifier read with (a roster seat name, or a peer). */
    seat: string;
    verdict: PanelVerdict;
    /** What the verifier actually checked — the evidence behind the vote. */
    evidence: string;
}
/** How the quorum landed for one finding. */
export type FindingOutcome = "confirmed" | "plausible" | "refuted" | "unpanelled";
/** The three claims a staged patch's independent verifier must state (#197). */
export interface PatchClaims {
    /** The patch changes only what the finding names. */
    targeted: boolean;
    /** The patch introduces no new finding of its own. */
    no_new_issue: boolean;
    /** Behavior outside the finding is unchanged (tests say so). */
    behavior_unchanged: boolean;
}
/** A staged fix for one finding — a patch FILE, never a working-tree edit. */
export interface StagedPatch {
    /** Where the patch file lives (under the project's scratch fix dir). */
    path: string;
    verifier: {
        seat: string;
        claims: PatchClaims;
        evidence: string;
        /** What was run to back the claims — suite names + counts, or "none". */
        testsRun: string;
    };
}
export interface AuditFinding {
    severity: AuditSeverity;
    title: string;
    /**
     * The concrete failure — "inputs/state → wrong output/crash". Required
     * since phase 21: a finding without one is a hunch, and the prose bar
     * ("name the scenario or cut it") is now enforced here, not asked for.
     */
    failure_scenario: string;
    detail?: string;
    issue?: string;
    /**
     * Refutation panel (#196). Required on critical/important findings —
     * at least one vote, two on a security scope; the quorum below decides
     * whether the finding survives to the tracker. Optional on minors.
     */
    panel?: PanelVote[];
    /** Seats that raised the finding (dedup's credit list) — yield attribution. */
    seats?: string[];
    /** Staged fix (#197) — present only when `--fix` produced a patch. */
    patch?: StagedPatch;
}
export interface FindingResult {
    title: string;
    severity: AuditSeverity;
    outcome: FindingOutcome;
    /** False only when the panel refuted it — the verb must not file it. */
    survived: boolean;
    /**
     * Present when a patch is staged: true only when the finding survived
     * AND the verifier stated all three claims true. The model asserts the
     * evidence; this bit decides whether the verb may offer "apply".
     */
    applyEligible?: boolean;
}
/** One leg of a sweep — the per-mode record the manifest indexes. */
export interface SweepLeg {
    /** The leg's own audit scope ("security-25", "review-working"). */
    scope: string;
    /** Where that leg's record lives (absolute, or relative to the project). */
    path: string;
}
/** One finding as the delta sees it. */
export interface DeltaFinding {
    title: string;
    severity: AuditSeverity;
    failure_scenario: string;
    /** The leg that raised it, when the manifest could attribute one. */
    leg?: string;
}
/** The sweep manifest's baseline delta (#215). */
export interface SweepDelta {
    baseline: {
        path: string;
        commit?: string;
        cairn?: string;
        created?: string;
    };
    /** Code commits between the baseline's stamp and HEAD; null when unknowable. */
    codeCommitsSince: number | null;
    new: DeltaFinding[];
    persisting: DeltaFinding[];
    /** A prior finding nothing matches now, from a leg this sweep re-checked. */
    fixed: DeltaFinding[];
    /** Fixed in the previous manifest's own delta, present again now. */
    regressed: DeltaFinding[];
    /**
     * A prior finding nothing matches now whose leg this sweep did NOT
     * re-check (or that names no leg) — not fixed, just unlooked-at. The next
     * sweep compares against these too, so a re-raise reads persisting (#266).
     */
    unchecked: DeltaFinding[];
    /** Legs the baseline named that this sweep's index doesn't cover. */
    uncoveredLegs: string[];
}
export interface AuditRecordResult {
    path: string;
    /** Total findings written, refuted ones included. */
    findings: number;
    /** Findings that may reach the tracker. */
    survived: number;
    /** Findings the panel killed — in the record, never in the tracker. */
    refuted: number;
    results: FindingResult[];
    commit?: string;
    dirty?: boolean;
    /** Advisory: the yield store couldn't be credited (never fails the write). */
    note?: string;
    /** Sweep scopes only: the baseline delta; null on the first sweep. */
    delta?: SweepDelta | null;
}
/** A sweep manifest's scope — the only shape that gets the #215 treatment. */
export declare const SWEEP_SCOPE_RE: RegExp;
/** Panel votes a critical/important finding needs before the record accepts it. */
export declare function requiredVotes(scope: string, severity: AuditSeverity): number;
/**
 * The quorum rule, computed in code (CONTEXT.md, phase 21): a finding is
 * REFUTED only when REFUTED votes hold a strict majority; CONFIRMED when
 * confirmations outnumber refutations; otherwise PLAUSIBLE (ties, or a
 * panel that could neither prove nor disprove) — plausible survives,
 * marked. No panel at all is "unpanelled" and survives (legal on minors
 * only; the writer refuses it elsewhere).
 *
 * :param panel: the votes, possibly empty/undefined
 * :returns: the outcome
 */
export declare function judgePanel(panel: PanelVote[] | undefined): FindingOutcome;
/** All three claims stated true — the only shape that may be applied. */
export declare function patchClaimsHold(c: PatchClaims): boolean;
/**
 * Validates, judges, and writes the record; credits yield for survivors.
 *
 * :param projectDir: repository root (record path + revision stamp)
 * :param scope: kebab-case mode+target ("security-21", "review-working")
 * :param verdict: "pass" (no findings) or "findings"
 * :param findings: the full finding list, refuted-to-be included
 * :param opts.yieldBaseDir: yield store root override (test seam)
 * :param opts.legs: sweep scopes only — the leg records this manifest indexes
 * :returns: path, counts, per-finding outcomes, stamp (+ delta on a sweep)
 * :raises CairnError: UNSUPPORTED on shape errors or a leg path outside
 *   the audit dir; PRECONDITION_FAILED on verdict mismatch, a missing
 *   failure_scenario, a missing panel, or (sweeps) a finding its leg
 *   refuted or carried with fewer votes than its leg required, a
 *   surviving finding no listed leg raised, or a leg path with no
 *   readable record behind it
 */
export declare function writeAuditRecord(projectDir: string, scope: string, verdict: "pass" | "findings", findings: AuditFinding[], opts?: {
    yieldBaseDir?: string;
    legs?: SweepLeg[];
}): AuditRecordResult;
export interface AuditRecordSummary {
    scope: string;
    date: string;
    verdict: string;
    path: string;
    /** Revision stamp — undefined on records written before phase 21 or outside git. */
    commit?: string;
    dirty?: boolean;
}
export declare function listAuditRecords(projectDir: string): AuditRecordSummary[];
/** One finding as read back from a record. */
export interface ParsedFinding {
    title: string;
    severity: AuditSeverity;
    failure_scenario: string;
    outcome: FindingOutcome;
    /** Sweep manifests: the leg that raised it, when attributed. */
    leg?: string;
}
export interface ParsedAuditRecord {
    frontmatter: Record<string, string | string[]>;
    findings: ParsedFinding[];
    /** Sweep manifests: the leg index. Empty elsewhere. */
    legs: SweepLeg[];
    /** Sweep manifests: what this record's own delta called fixed — the
     *  next manifest's regression baseline. Empty elsewhere. */
    deltaFixed: DeltaFinding[];
    /** Sweep manifests: what this record's own delta left unchecked — still
     *  open as far as anyone knows, so the next manifest compares against
     *  them alongside the survivors (#266). Empty elsewhere. */
    deltaUnchecked: DeltaFinding[];
    /** Blocks skipped on the way in (legacy bodies), in plain words. */
    notes: string[];
}
/**
 * Reads a record back into frontmatter + findings. Tolerant of every
 * shape the writer has ever produced: a pre-phase-21 block with no
 * scenario is skipped with a note (it was a hunch then, and a delta can't
 * match on it now), never an error.
 *
 * :param path: the record file
 * :returns: frontmatter, findings, leg index, the record's own fixed and
 *   unchecked lists, notes
 * :raises CairnError: CONFIG_INVALID only on a broken frontmatter block
 */
export declare function parseAuditRecord(path: string): ParsedAuditRecord;
