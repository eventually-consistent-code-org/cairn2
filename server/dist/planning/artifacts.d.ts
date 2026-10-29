export declare const plansRoot: (projectDir: string) => string;
export declare function slugify(name: string): string;
export declare function isValidPhaseNumber(number: number): boolean;
export declare const PHASE_NUMBER_ERROR: (number: number) => string;
export declare function phaseDirPrefix(number: number): string;
export declare function phaseDirName(number: number, slug: string): string;
export declare function parsePhaseDirName(dirName: string): {
    number: number;
    slug: string;
} | null;
export declare const PROJECT_TEMPLATE: (name: string) => string;
export declare const ROADMAP_TEMPLATE: (name: string) => string;
export declare const CONTEXT_TEMPLATE: (number: number, name: string) => string;
export declare const PLAN_TEMPLATE: (number: number, name: string) => string;
export declare const RESEARCH_TEMPLATE: (number: number, name: string) => string;
/**
 * The ledger is append-only, so git's union merge driver is correct by
 * construction: two branches that each appended a line keep both. The
 * attribute lives at the planning root, where `**` reaches every phase.
 */
export declare const LEDGER_UNION_LINE = "**/LEDGER.md merge=union";
/** Whether the planning root's .gitattributes already carries the ledger union line. */
export declare function hasLedgerUnion(projectDir: string): boolean;
/** Idempotent: appends the union line when absent. Reports what it did. */
export declare function ensureLedgerUnion(projectDir: string): "added" | "present";
export declare function scaffoldProject(projectDir: string, name: string): {
    created: string[];
    skipped: string[];
    gitattributes: "added" | "present";
};
export declare function scaffoldPhase(projectDir: string, number: number, name: string, opts?: {
    research?: boolean;
}): {
    dir: string;
    created: string[];
    skipped: string[];
    gitattributes: "added" | "present";
};
export declare function readPlanIssues(projectDir: string, phaseDir: string): string[];
export declare function writePlanIssues(projectDir: string, phaseDir: string, issues: string[]): void;
export interface PlanMeta {
    issues: string[];
    waves: string[][];
    tdd: string[];
}
export declare function readPlanMeta(projectDir: string, phaseDir: string): PlanMeta;
export declare function writePlanMeta(projectDir: string, phaseDir: string, meta: {
    waves?: string[][];
    tdd?: string[];
}): void;
