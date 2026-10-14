/**
 * The auto-compact threshold cairn wants, against the one the harness has.
 *
 * Cairn cannot set an environment variable for a session that is already
 * running, and it will not edit a user's settings behind their back. So it
 * records a desired value and REPORTS the mismatch (ADR 0017) -- the fix is
 * the user's to apply, and probe output is where they learn it is needed.
 *
 * removeWhen: the harness lets a plugin declare its preferred compaction
 * threshold for the sessions it runs in, or its default lands at the
 * fraction cairn wants -- either makes the drift report moot. Half met
 * (SURVEY.md 2026-10-13, native-vs-cairn-subsystem-judgement): `autoCompactWindow`
 * in agent frontmatter (2.1.296) does this for subagents, and cairn's two
 * agents set it (#332). Still open: the main session, where this report
 * remains the only lever.
 */

export interface ContextEconomyConfig {
  /**
   * Desired value of CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: the fraction of the
   * context window at which the harness compacts. Simulation over the
   * recorded corpus puts 0.2 at a ~50% rent reduction. null means no
   * preference -- the harness default stands.
   */
  autocompactPct: number | null;
}

export interface ThresholdDrift {
  status: "unset" | "match" | "drift" | "invalid";
  desired: number | null;
  live: number | null;
}

/**
 * :param desiredPct: the project's configured preference, or null
 * :param liveEnv: the raw CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value, or undefined
 * :returns the comparison, never throwing on bad input
 */
export function thresholdDrift(
  desiredPct: number | null,
  liveEnv: string | undefined,
): ThresholdDrift {
  if (desiredPct === null) return { status: "unset", desired: null, live: null };

  if (liveEnv === undefined || liveEnv.trim() === "") {
    return { status: "drift", desired: desiredPct, live: null };
  }

  const live = Number(liveEnv);
  if (!Number.isFinite(live)) return { status: "invalid", desired: desiredPct, live: null };

  // Float noise, not disagreement: 0.2 and 0.200 are one setting.
  const same = Math.abs(live - desiredPct) < 1e-9;
  return { status: same ? "match" : "drift", desired: desiredPct, live };
}
