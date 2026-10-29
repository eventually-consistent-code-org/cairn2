/**
 * Purpose: the convergence memory for a peers run — a per-run store under
 * .cairn/peers/<slug>/ that survives interruption. state.json is the index
 * (meta, which peer answered which round, findings with verdicts); the raw
 * peer outputs live in per-peer files beside it and are never re-read into
 * state. An interrupted run resumes from runStatus's report of what's
 * missing, and runClose is where audit provenance comes from — assembled
 * from the RECORDS, not from whatever the interrupted conversation
 * remembered.
 * Author(s): John Reed
 */
import { type Finding } from "./findings.js";
export declare const VERDICTS: readonly ["verified", "dead", "disputed", "open-disagreement"];
export type Verdict = (typeof VERDICTS)[number];
export interface RunMeta {
    mode: "review" | "plan" | "council";
    target: string;
    focus?: string;
    peers: string[];
    startedAt: string;
    closedAt?: string;
    abandonedAt?: string;
}
export interface OutputRecord {
    peer: string;
    round: number;
    file: string;
    recordedAt: string;
    /** The child's exit code as peer_run returned it (#339). Absent on
     *  records written before the field existed, or when the caller had
     *  none to give -- absent never reads as failed. */
    exitCode?: number;
}
/**
 * A seat the run cannot count on (#339): `silent` never answered round 1;
 * `failed` answered with a non-zero exit and raised no findings -- the
 * shape a not-logged-in or credit-capped CLI produces, which parses to
 * empty piles and would otherwise read exactly like a clean pass;
 * `skipped` (#364) is the rate-limited case of the same shape -- the
 * recorded output carries peer_run's RATE_LIMITED marker, or the CLI's
 * own limit shape on a non-zero exit. A skipped seat is out of the count
 * but never blocks close: the run goes on with the seats it has. `reason`
 * is plain language for the status line; for a failed or skipped seat it
 * ends with the tail of what the child said.
 */
export interface IncompleteSeat {
    peer: string;
    kind: "silent" | "failed" | "skipped";
    exitCode?: number;
    reason: string;
}
export interface FindingRecord {
    id: string;
    peer: string;
    round: number;
    finding: Finding;
    verdict?: Verdict;
    note?: string;
}
interface RunState {
    meta: RunMeta;
    outputs: OutputRecord[];
    findings: FindingRecord[];
}
export interface RunResumable {
    peersMissingRound1: string[];
    /** Silent, failed and skipped seats, each with its reason (#339, #364) --
     *  a superset of peersMissingRound1, which stays for callers that only
     *  knew silence. */
    incompleteSeats: IncompleteSeat[];
    disputedAwaitingRound2: string[];
    unresolved: string[];
    complete: boolean;
}
export interface RunStatusReport {
    slug: string;
    meta: RunMeta;
    outputs: OutputRecord[];
    findings: FindingRecord[];
    resumable: RunResumable;
}
export interface CloseSummary {
    slug: string;
    /** "no-quorum" (#364): no rostered seat was left to count -- every one
     *  was skipped (rate limited), or incomplete and waived. noQuorumReason
     *  says which and why; it is never a pass. */
    verdict: "pass" | "findings" | "no-quorum";
    findings: Array<{
        severity: Finding["severity"];
        title: string;
        /** The peer's evidence, carried as the typed failure scenario audit_record requires. */
        failure_scenario: string;
        detail: string;
        /**
         * The peer's own verdict as a panel vote, so the close summary feeds
         * audit_record's quorum unchanged: verified → CONFIRMED, dead →
         * REFUTED (the record keeps it, the tracker never sees it),
         * open-disagreement → PLAUSIBLE.
         */
        panel: Array<{
            seat: string;
            verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED";
            evidence: string;
        }>;
    }>;
    peers: string[];
    roundsRun: number;
    closedAt: string;
    /** Rostered peers the run could not count on — never answered round 1,
     *  or exited non-zero with no findings (#339) — present only on a close
     *  that went through with allowIncomplete, so provenance shows the
     *  degradation was deliberate. */
    incompleteSeats?: string[];
    /** One plain line per incomplete seat ("grok exited 1 with no findings
     *  -- see stderr: ..."), same order as incompleteSeats. */
    incompleteDetail?: string[];
    /** Rostered peers skipped because their CLI hit a usage limit (#364) --
     *  present whenever any was, no flag needed: a limited seat is a skipped
     *  seat, never a failed run. */
    skippedSeats?: string[];
    /** One plain line per skipped seat, same order as skippedSeats. */
    skippedDetail?: string[];
    /** Present only on a no-quorum close: why no seat was left, in plain words. */
    noQuorumReason?: string;
}
/**
 * Creates the run dir and state.json for a new convergence run. An
 * UNFINISHED run already sitting on the slug is a hard stop — the caller
 * resumes it (runStatus) or abandons it (runAbandon) explicitly; nothing
 * here silently clobbers in-flight work. A finished (closed/abandoned)
 * run gets wiped, raw outputs and all, and the slug starts fresh.
 *
 * :param projectDir: project root the .cairn tree lives under
 * :param slug: run identity — slugged like review's scopes (lowercase,
 *              non-[a-z0-9] runs collapse to one hyphen)
 * :param meta: mode/target/focus plus the peer roster for the run
 * :returns: { slug, state } with the normalized slug
 * :raises CairnError: CONFIG_INVALID on an unfinished run or bad meta
 */
export declare function runStart(projectDir: string, slug: string, meta: {
    mode: "review" | "plan" | "council";
    target: string;
    focus?: string;
    peers: string[];
}): {
    slug: string;
    state: RunState;
};
/**
 * Marks an unfinished run abandoned — its slug becomes startable again.
 * Raw outputs stay on disk until the next runStart wipes them.
 */
export declare function runAbandon(projectDir: string, slug: string): {
    slug: string;
    abandonedAt: string;
};
/**
 * Stores one peer's raw reply for a round, verbatim, in
 * <peer>.round<N>.txt beside state.json — big and write-once, never
 * folded into the index. Re-recording the same peer+round overwrites
 * (a retried send supersedes the interrupted one).
 */
export declare function recordPeerOutput(projectDir: string, slug: string, peer: string, round: number, rawOutput: string, exitCode?: number | null): OutputRecord;
/**
 * Enters parsed findings into the run under stable ids (f1, f2, ... —
 * assigned in arrival order, never reused), tagged with the peer and
 * round that raised them. Validation is all-or-nothing per call: one bad
 * finding rejects the batch so ids never end up half-assigned.
 *
 * Idempotent per peer+round: a repeat call REPLACES that peer's prior
 * findings for the round (a retried parse supersedes the interrupted
 * one, mirroring recordPeerOutput). A finding whose claim matches one
 * of the replaced batch keeps its id, verdict, and note; a genuinely
 * new claim gets a fresh id that has never been used on the run. Other
 * peers' and rounds' findings are untouched.
 *
 * :returns: { ids } — the assigned ids, in the order given
 */
export declare function recordFindings(projectDir: string, slug: string, peer: string, round: number, findings: Finding[]): {
    ids: string[];
};
/**
 * Sets a finding's verdict, with the transitions validated: anything can
 * be judged once; `disputed` may move on to verified/dead/
 * open-disagreement (that's convergence working); verified and dead are
 * TERMINAL — changing one is CONFIG_INVALID, re-stating the same verdict
 * is a harmless no-op (the note may still update).
 */
export declare function recordVerdict(projectDir: string, slug: string, findingId: string, verdict: Verdict, note?: string): FindingRecord;
/**
 * The resume map: everything recorded so far, plus what's still missing —
 * peers with no round-1 output, disputed findings whose peer hasn't
 * answered round 2 yet, and findings not yet at a final verdict. An
 * interrupted run picks up exactly here instead of re-running peers that
 * already answered.
 */
export declare function runStatus(projectDir: string, slug: string): RunStatusReport;
/**
 * Ends the run: every finding must sit at a FINAL verdict (verified,
 * dead, or open-disagreement — disputed and unjudged both block), then
 * closedAt is stamped and the provenance summary comes back shaped for
 * audit_record's findings[] — title from the claim, detail assembled
 * from the records ("raised by <peer> round <n>; verdict <v>"), dead
 * findings included so the record credits what got thrown out. Overall
 * verdict is "findings" iff anything survived (verified or
 * open-disagreement).
 *
 * A rostered peer with no round-1 output is a SILENT SEAT, and one whose
 * round-1 exit was non-zero with no findings raised is a FAILED SEAT (#339)
 * — closing over either hides a reviewer that never actually reviewed, so
 * it refuses (CONFIG_INVALID naming each seat and its reason) unless the
 * caller passes allowIncomplete, which closes anyway and stamps the
 * summary's incompleteSeats (+ incompleteDetail) so provenance shows the
 * degradation was deliberate. allowIncomplete never waives unresolved
 * findings — those always block.
 *
 * A SKIPPED seat (#364, rate limited) blocks nothing: close goes through
 * and stamps it in skippedSeats + skippedDetail. When no rostered seat is
 * left to count -- every one skipped, or incomplete and waived -- the
 * verdict is "no-quorum" with noQuorumReason saying why, never "pass".
 */
export declare function runClose(projectDir: string, slug: string, opts?: {
    allowIncomplete?: boolean;
}): CloseSummary;
export {};
