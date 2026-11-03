#!/usr/bin/env node

/**
 * Purpose: the SessionStart line for a handoff the pause recorder marked
 *   (#379) -- what the last session was waiting for and since when, in
 *   place of the ordinary resume nudge. Lives apart from
 *   sessionstart-continuity.mjs on purpose: check-footprint counts that
 *   hook's fixed literals as cairn's standing rent, and these lines are
 *   per-event prose only a session that follows a usage-limit pause ever
 *   receives -- the hook imports this file on that path alone, so no other
 *   session pays for it. The time is the recorder's clock at the event,
 *   never the reset.
 * derives: axiom 6 (surface-is-rent)
 * Author(s): John Reed
 */

import { hhmmUtc } from "./lib.mjs";

/** One closing line for the resume block, by pause kind. */
export function pausedLine(paused) {
  const since = `${hhmmUtc(paused.since)} UTC`;
  switch (paused.kind) {
    case "stale":
      return `The last session was waiting since ${since}: its usage-limit auto-resume went stale (the machine `
        + "slept across the reset) and it sat waiting for Enter. This session is fresh -- pick up the next action "
        + "above; a batch run's umbrella issue already says when it paused.";
    case "stopped":
      return `The last session stopped after repeated usage-limit hits at ${since}: the platform switched automatic `
        + "continue off. Nothing resumes by itself -- re-enter the resume path by hand (the next action above, or "
        + "the auto verb's resume path for a batch run).";
    default: {
      const reset = paused.resetsAt ? `, resets at ${paused.resetsAt}` : "";
      return `The last session was paused on usage limit since ${since}${reset}. If the limit has reset, pick up `
        + "the next action above.";
    }
  }
}
