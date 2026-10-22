export type ErrorCode =
  | "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING"
  | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN" | "TRACKER_REJECTED"
  | "HANDOFF_INVALID" | "HANDOFF_STALE" | "BUDGET_INVALID"
  | "UNSUPPORTED" | "PRECONDITION_FAILED" | "NATIVE_MODULE_BROKEN"
  // #358: a headless batch run the circuit breaker froze -- its claim, close
  // and manifest moves are refused, and nextAction says how it ends
  | "RUN_FROZEN";

export class CairnError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly nextAction?: string,
  ) {
    super(message);
    this.name = "CairnError";
  }
}
