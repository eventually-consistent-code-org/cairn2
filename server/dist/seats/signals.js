/**
 * Purpose: signal→seat dispatch — derives normalized scope signals from a
 * diff summary, selects which roster seats fire under the dispatch dial,
 * and resolves the model a seat's work routes to. Pure over its inputs
 * (no I/O): the caller loads the roster and yield stats and passes them
 * in. The model-routing blast-radius rule ALWAYS beats a seat's model
 * preference — encoded here, not left to verb prose.
 * Author(s): John Reed
 */
import { YIELD_MIN_DISPATCHES, YIELD_GATE_RATE, yieldRate, } from "./yield.js";
// Constants — the STANDARD signal vocabulary
//
// deriveSignals emits ONLY these names. Seat definitions keep a free
// vocabulary (schema-side), so a project seat may declare custom signals —
// but nothing derives them this iteration, so an unmatched custom signal
// simply never fires (the seat is gated in auto dial unless another of its
// signals matches, or it declares no signals at all). Custom derivation is
// a future maturity, not built here.
//
// Path-derived (a signal fires when ANY changed path matches its pattern;
// paths are matched lowercased):
//   touches-auth    — auth-shaped names anywhere in a path (auth, login,
//                     oauth, sso, credential, password, secret, session,
//                     token, perm...). Deliberately over-broad substring
//                     match: a false fire costs one extra seat pass, a
//                     false silence costs a missed security read.
//   touches-server  — code-shaped path segments: server, src, api,
//                     backend, services. Named for the common case; the
//                     matcher covers where application code usually lives.
//   touches-docs    — .md/.mdx files, or a docs/doc path segment
//   touches-tests   — test/tests/__tests__/spec segments, or filenames
//                     with a .test. / .spec. / _test. infix
//   touches-config  — .json/.yaml/.yml/.toml/.ini files, *.config.* files,
//                     or .env* basenames
//   touches-ci      — .github/workflows, .gitlab-ci*, .circleci,
//                     azure-pipelines*, Jenkinsfile, or a ci segment
//   touches-scripts — scripts/bin/hooks segments, or .sh files
//   touches-ui      — presentation-shaped files: .css/.scss/.less,
//                     .tsx/.jsx, .vue/.svelte, .html — or a components,
//                     ui, pages, views or layouts path segment. Gates
//                     the ux seat; a server-only diff never fires it.
//
// Size-derived (insertions + deletions, strict bounds — a mid-size diff
// between the two emits neither):
//   diff-small — total < DIFF_SMALL_MAX (50) changed lines
//   diff-large — total > DIFF_LARGE_MIN (500) changed lines
export const DIFF_SMALL_MAX = 50;
export const DIFF_LARGE_MIN = 500;
const AUTH_RE = /auth|login|oauth|sso|credential|passwd|password|secret|session|token|perm/;
const SERVER_SEG = new Set(["server", "src", "api", "backend", "services"]);
const DOCS_SEG = new Set(["docs", "doc"]);
const TEST_SEG = new Set(["test", "tests", "__tests__", "spec"]);
const SCRIPT_SEG = new Set(["scripts", "bin", "hooks"]);
const CONFIG_EXT = new Set(["json", "yaml", "yml", "toml", "ini"]);
const UI_EXT = new Set([
    "css", "scss", "less", "tsx", "jsx", "vue", "svelte", "html",
]);
const UI_SEG = new Set(["components", "ui", "pages", "views", "layouts"]);
// Seats never yield-gated by NAME — the conservative floor. Dose "full"
// seats are exempt alongside these (see selectSeats): evidence prunes
// convenience seats, never the safety-critical ones. A project exempts its
// own seat by giving it dose full.
export const YIELD_EXEMPT_SEAT_NAMES = new Set([
    "security",
]);
// Signal derivation
/** True when any path matches the predicate. */
function anyPath(paths, pred) {
    return paths.some(pred);
}
/** Path segments, lowercased ("server/src/a.ts" → [server, src, a.ts]). */
function segments(path) {
    return path.split("/").filter(Boolean);
}
/**
 * Derives the normalized signal set for one diff summary. Emits ONLY the
 * standard vocabulary documented above; output is deduped and sorted.
 * Negative or missing line counts read as 0 — garbage in never widens
 * the diff-size signals.
 *
 * :param diff: changed paths + insertion/deletion totals
 * :returns: sorted unique signal names
 */
export function deriveSignals(diff) {
    const out = new Set();
    const paths = diff.files.map((f) => f.toLowerCase());
    if (anyPath(paths, (p) => AUTH_RE.test(p)))
        out.add("touches-auth");
    if (anyPath(paths, (p) => segments(p).some((s) => SERVER_SEG.has(s)))) {
        out.add("touches-server");
    }
    if (anyPath(paths, (p) => {
        if (/\.mdx?$/.test(p))
            return true;
        return segments(p).some((s) => DOCS_SEG.has(s));
    })) {
        out.add("touches-docs");
    }
    if (anyPath(paths, (p) => {
        const segs = segments(p);
        const base = segs[segs.length - 1] ?? "";
        return (segs.some((s) => TEST_SEG.has(s)) ||
            /(\.test\.|\.spec\.|_test\.)/.test(base));
    })) {
        out.add("touches-tests");
    }
    if (anyPath(paths, (p) => {
        const segs = segments(p);
        const base = segs[segs.length - 1] ?? "";
        const ext = base.includes(".") ? base.split(".").pop() : "";
        return (CONFIG_EXT.has(ext) || base.includes(".config.") ||
            base.startsWith(".env"));
    })) {
        out.add("touches-config");
    }
    if (anyPath(paths, (p) => {
        return (p.includes(".github/workflows") || p.includes(".gitlab-ci") ||
            p.includes(".circleci") || p.includes("azure-pipelines") ||
            segments(p).some((s) => s === "ci" || s === "jenkinsfile"));
    })) {
        out.add("touches-ci");
    }
    if (anyPath(paths, (p) => {
        return segments(p).some((s) => SCRIPT_SEG.has(s)) || p.endsWith(".sh");
    })) {
        out.add("touches-scripts");
    }
    // Presentation files by extension, or a UI-shaped folder anywhere in the
    // path — the only way the ux seat gets a chair under auto dispatch.
    if (anyPath(paths, (p) => {
        const segs = segments(p);
        const base = segs[segs.length - 1] ?? "";
        const ext = base.includes(".") ? base.split(".").pop() : "";
        return UI_EXT.has(ext) || segs.some((s) => UI_SEG.has(s));
    })) {
        out.add("touches-ui");
    }
    const total = Math.max(0, diff.insertions || 0) + Math.max(0, diff.deletions || 0);
    if (total < DIFF_SMALL_MAX)
        out.add("diff-small");
    if (total > DIFF_LARGE_MIN)
        out.add("diff-large");
    return [...out].sort();
}
// Seat selection
/** One seat's yield-gate check: gated when it has enough history
 * (>= YIELD_MIN_DISPATCHES dispatches) and its survival rate — surviving
 * findings per dispatch — sits under YIELD_GATE_RATE. Exempt: any seat
 * named in YIELD_EXEMPT_SEAT_NAMES, and any seat whose dose is "full". */
function yieldGate(seat, counters) {
    if (YIELD_EXEMPT_SEAT_NAMES.has(seat.name) || seat.dose === "full") {
        return null;
    }
    if (!counters || counters.dispatched < YIELD_MIN_DISPATCHES)
        return null;
    const rate = yieldRate(counters);
    if (rate === null || rate >= YIELD_GATE_RATE)
        return null;
    return (`low yield — ${counters.findingsSurvived} surviving finding(s) over ` +
        `${counters.dispatched} dispatches (rate ${rate.toFixed(2)} < ` +
        `${YIELD_GATE_RATE}); edit the seat or clear its yield stats to re-seat it`);
}
/**
 * Picks which roster seats fire this pass.
 *
 * Selection rules:
 * - dial `off` (the DEFAULT): every valid seat fires — today's full-panel
 *   behavior, untouched.
 * - dial `inherit`: resolves to cairn.json `seats.dispatch` (carried on the
 *   roster), itself defaulting to off.
 * - dial `auto`:
 *   - a seat with NO signals declared always fires — declaring signals is
 *     how a seat opts into gating (signal AND yield);
 *   - a seat whose signals intersect the derived set fires, unless the
 *     yield gate holds: >= YIELD_MIN_DISPATCHES dispatches recorded AND
 *     survival rate < YIELD_GATE_RATE — then it's gated with an explicit
 *     note. The security seat and any dose "full" seat are never
 *     yield-gated (the conservative floor);
 *   - a seat whose signals miss entirely is gated "no-matching-signals".
 * - invalid roster entries neither fire nor gate — the roster's own notes
 *   already report them.
 * Every gated seat comes back with a reportable note — never silent.
 *
 * :param roster: resolved roster (loadRoster)
 * :param signals: derived signal set (deriveSignals)
 * :param opts.dial: auto | inherit | off
 * :param opts.yields: per-seat yield counters (loadYield().seats) —
 *   consulted ONLY in auto dial; omit to skip yield gating
 * :returns: fired seats (roster order) + gated seats with notes
 */
export function selectSeats(roster, signals, opts) {
    const effectiveDial = opts.dial === "inherit" ? (roster.dispatch ?? "off") : opts.dial;
    const valid = roster.seats.filter((s) => s.valid && s.seat !== undefined);
    if (effectiveDial === "off") {
        return { effectiveDial, fired: valid, gated: [] };
    }
    const fired = [];
    const gated = [];
    const derived = new Set(signals);
    for (const entry of valid) {
        const declared = entry.seat.signals;
        if (declared.length === 0) {
            fired.push(entry); // no signals declared = never gated
            continue;
        }
        if (!declared.some((s) => derived.has(s))) {
            gated.push({
                name: entry.name,
                reason: "no-matching-signals",
                note: `no matching signals — declares [${declared.join(", ")}], diff derived [${signals.join(", ")}]`,
            });
            continue;
        }
        const yieldNote = yieldGate(entry.seat, opts.yields?.[entry.name]);
        if (yieldNote !== null) {
            gated.push({ name: entry.name, reason: "low-yield", note: yieldNote });
            continue;
        }
        fired.push(entry);
    }
    return { effectiveDial, fired, gated };
}
/** The server-side copy of the rubric table. `label` is the row's work-class
 * cell in skills/cairn-planning/SKILL.md; a test pins this table equal to
 * that one so the two cannot drift. */
export const ROUTING_TABLE = {
    mechanical: { label: "mechanical", model: "haiku", effort: "low" },
    routine: { label: "routine synthesis", model: "sonnet", effort: "medium" },
    complex: { label: "complex synthesis", model: "opus", effort: "high" },
    gate: { label: "judgment gates", model: "strongest", effort: "high" },
};
const TIER = {
    haiku: 0,
    sonnet: 1,
    opus: 2,
    strongest: 3,
};
/**
 * Resolves the model a seat's work routes to. The seat's `model` field is
 * ADVISORY ONLY — the cairn-planning blast-radius rule always wins:
 * output that gates a lifecycle transition (work class `gate`) routes to
 * the strongest tier regardless of any seat preference, and no preference
 * ever routes a work class BELOW its rubric floor (downgrade only
 * mechanical work). A preference at or above the floor is honored.
 * Verbs consume this as guidance; the rule lives here so it is tested,
 * not re-derived in prose.
 *
 * :param seat: validated seat definition (its `model` is the preference)
 * :param workClass: mechanical | routine | complex | gate
 * :returns: the routed model + whether the seat's preference was overridden
 */
export function resolveSeatModel(seat, workClass) {
    const floor = ROUTING_TABLE[workClass].model;
    const pref = seat.model;
    if (workClass === "gate") {
        return {
            model: "strongest",
            overrode: pref !== undefined,
            reason: "output gates a lifecycle transition — routes to the strongest tier" +
                (pref
                    ? ` (seat preference '${pref}' overridden by the blast-radius rule)`
                    : ""),
        };
    }
    if (pref === undefined) {
        return {
            model: floor,
            overrode: false,
            reason: `rubric default for ${workClass} work`,
        };
    }
    if (TIER[pref] < TIER[floor]) {
        return {
            model: floor,
            overrode: true,
            reason: `seat preference '${pref}' sits below the ${workClass} floor — routed up (downgrade only mechanical work)`,
        };
    }
    return {
        model: pref,
        overrode: false,
        reason: `seat preference honored (at or above the ${workClass} floor)`,
    };
}
