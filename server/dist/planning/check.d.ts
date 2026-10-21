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
     * observed-mismatch (#357): a standing closing line carrying the
     * `observed-mismatch` marker -- the server re-ran the declared verify at
     * close and saw a non-zero exit or a timeout. Severity `important`.
     */
    type: "contract-drift" | "unanchored-threshold" | "missing-approaches" | "missing-verify" | "tdd-missing" | "evidence-missing" | "closure-superseded" | "observed-mismatch";
    /** Set only where a kind carries one; today `observed-mismatch` is `important`. */
    severity?: "important";
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
 * The declared command on one line, or null when the line carries no
 * declaration (see the span rule above).
 *
 * :param line: one PLAN.md line
 * :returns the command, trimmed, or null
 */
export declare function verifyClauseOf(line: string): string | null;
/**
 * The `verify:` command PLAN.md declares for one issue (#206), or null.
 * The search covers the task's own block -- its bullet line down to the
 * next task bullet or heading -- and the LAST clause in that block wins,
 * so a task that restates its check after a revision reads the restated
 * one.
 *
 * :param lines: PLAN.md split into lines
 * :param issueId: the tracker id, with or without a leading "#"
 * :returns the declared command, or null when the task declares none
 */
export declare function declaredVerifyIn(lines: string[], issueId: string): string | null;
/**
 * Whether a declared command is a plain shell line the server may run
 * verbatim at close (#357), rather than prose or a template. Refused: more
 * than one line, an em/en dash or ellipsis (plan prose, never shell), a
 * `<placeholder>`, and a manual-check opener ("manual", "none", "n/a",
 * "tbd", "todo"). Everything else is the owner's own shell line.
 *
 * :param command: the declared command
 * :returns true when it is safe to hand to a shell as written
 */
export declare function isPlainShellLine(command: string): boolean;
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
