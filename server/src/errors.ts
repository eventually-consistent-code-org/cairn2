export type ErrorCode =
  | "CONFIG_MISSING" | "CONFIG_INVALID" | "AUTH_MISSING"
  | "RATE_LIMITED" | "NOT_FOUND" | "TRACKER_DOWN" | "TRACKER_REJECTED"
  | "HANDOFF_INVALID" | "HANDOFF_STALE" | "BUDGET_INVALID"
  | "UNSUPPORTED" | "PRECONDITION_FAILED" | "NATIVE_MODULE_BROKEN"
  // #358: a headless batch run the circuit breaker froze -- its claim, close
  // and manifest moves are refused, and nextAction says how it ends
  | "RUN_FROZEN"
  // #466: a run manifest of the project already reads running, so a second
  // one is refused -- a running batch cannot stage the run the breaker would
  // count against instead; nextAction names the live run and how it ends
  | "RUN_LIVE"
  // #281: a config_set patch sets a key only the owner may set (the leak
  // guard's off switch, ship's confirmation, the breaker's limit, a peer's
  // execCapable, the write table) away from its safe value, and the
  // session carries no CAIRN_HARNESS_EDIT=1; nextAction names the owner's
  // ways in
  | "OWNER_ONLY";

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
