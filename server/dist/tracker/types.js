import { CairnError } from "../errors.js";
/** List-filter semantics after the widening: a state filter matches by
 *  semantic category OR by exact display name. */
export function matchesState(issue, state) {
    return issue.category === state || issue.state === state;
}
/** Guard for backends with NO custom-state surface — anything beyond the
 *  canonical three is a config error there, never a silent no-op. */
export function assertCanonicalState(state, backend) {
    if (state === undefined)
        return;
    if (state === "open" || state === "in_progress" || state === "closed")
        return;
    throw new CairnError("CONFIG_INVALID", `${backend} has no custom-state surface — unknown state '${state}'`, "use open/in_progress/closed on this backend");
}
/** The category a requested state NAME resolves to on `tracker`, asked
 *  before any write (#427): the adapter's own vocabulary when it has one,
 *  else the canonical three by name (always writable on every backend);
 *  undefined for a name neither knows, which the adapter's own refusal
 *  then speaks to on the write. The freeze check keys on this, never on
 *  the literal name -- asserted by run-breaker.test.ts (#427). */
export function requestedCategory(tracker, state) {
    const own = tracker.stateCategory?.(state);
    if (own)
        return own;
    return state === "open" || state === "in_progress" || state === "closed" ? state : undefined;
}
