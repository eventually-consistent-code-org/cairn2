export interface PlanFinding {
    /**
     * contract-drift / unanchored-threshold: PLAN.md text findings.
     * missing-approaches (phase 23): a planned, non-quick phase whose
     * CONTEXT.md lacks the "Approaches considered" block — two-plus
     * candidates and a chosen line — the divergent-design step the plan
     * verb owes before PLAN.md exists.
     * missing-verify (phase 24.5): a task line in a planned, non-quick,
     * unverified PLAN.md that never says how it will be proved. Criteria
     * written after the fact are chosen to fit what happened.
     * tdd-missing / evidence-missing / closure-superseded (#366): the
     * LEDGER.md gates verify holds a phase to -- a `tdd:` id whose closing
     * line has no red..green pair, a planned issue whose closing line has
     * neither evidence nor a waiver, a closure an evidence-only line for the
     * same task later corrected. Anchored on the ledger line, or on the
     * PLAN.md frontmatter that declared the id when no closing line exists.
     */
    type: "contract-drift" | "unanchored-threshold" | "missing-approaches" | "missing-verify" | "tdd-missing" | "evidence-missing" | "closure-superseded";
    plan: string;
    line: number;
    detail: string;
    counterpart?: {
        plan: string;
        line: number;
    };
}
export declare const APPROACHES_HEADING: RegExp;
export declare const APPROACHES_MIN_CANDIDATES = 2;
/**
 * Task lines in a plan that never declare how they will be proved.
 *
 * The declaration may appear anywhere in the task's own paragraph, not
 * only on the bullet's first line — plan prose wraps, and forcing the
 * clause onto line one would push authors toward one-line tasks, which is
 * worse writing for a marginal parsing gain.
 *
 * :param lines: PLAN.md split into lines
 * :returns: one entry per undeclared task — the line to anchor on and the issue id
 */
export declare function judgeVerifyDeclarations(lines: string[]): {
    line: number;
    issue: string;
}[];
/**
 * Judges a CONTEXT.md's approaches block. Null when it satisfies the
 * shape; otherwise the line to anchor the finding on and what's missing.
 *
 * :param lines: CONTEXT.md split into lines
 * :returns: null, or { line, detail }
 */
export declare function judgeApproaches(lines: string[]): {
    line: number;
    detail: string;
} | null;
/**
 * The pre-phase-23 exemption, stated once. The close-evidence gate shipped
 * in phase 23, so a phase numbered 23 or below that is already verified
 * closed its issues before the gate existed (phase 23's own lines
 * included), and the ledger is append-only, so those lines can never grow
 * the segment: exempt. An unverified phase is held to the gate whatever its
 * number. The tdd and superseded gates have no exemption.
 */
export declare const EVIDENCE_GATE_SHIPPED = 23;
export declare function planCheck(projectDir: string, phase?: number): {
    findings: PlanFinding[];
    scanned: number;
};
