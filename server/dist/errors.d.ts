export type ErrorCode = "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING" | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN" | "TRACKER_REJECTED" | "HANDOFF_INVALID" | "HANDOFF_STALE" | "BUDGET_INVALID" | "UNSUPPORTED" | "PRECONDITION_FAILED" | "NATIVE_MODULE_BROKEN" | "RUN_FROZEN";
export declare class CairnError extends Error {
    readonly code: ErrorCode;
    readonly nextAction?: string | undefined;
    constructor(code: ErrorCode, message: string, nextAction?: string | undefined);
}
