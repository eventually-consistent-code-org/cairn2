/**
 * Purpose: the audit record writer — the single place a review/audit pass
 * lands its findings (.cairn/audit/<scope>-<date>.md). Since phase 21 it
 * is also where a finding is JUDGED: every finding carries a typed
 * failure_scenario, critical/important findings carry a refutation panel
 * whose quorum is computed here (never model-asserted), REFUTED findings
 * stay in the record but never reach the tracker, and survivors credit
 * the raising seats' yield. The record is stamped with the commit it
 * judged. Since #215 a `sweep-<YYYY-MM-DD>` scope is a sweep MANIFEST:
 * it carries the cairn version, a leg index, and a delta against the
 * previous manifest (new / persisting / fixed / regressed / unchecked) —
 * computed here, in the writer, never by a reader tool. Since #266 a prior
 * finding reads `fixed` only when its own leg ran again in this sweep;
 * otherwise it is `unchecked` and carried forward. parseAuditRecord reads
 * any record back.
 *
 * removeWhen: verifier votes reliably agree with human triage across a
 *   milestone, so the server-computed quorum can become advisory.
 * Author(s): John Reed
 */
// Imports
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../planning/frontmatter.js";
import { codeCommitsSince, revisionStamp } from "../planning/resync.js";
import { textsMatch } from "../seats/dedup.js";
import { recordYield } from "../seats/yield.js";
// Constants
const auditDir = (p) => join(p, ".cairn", "audit");
const today = () => new Date().toISOString().slice(0, 10);
const SEVERITIES = ["critical", "important", "minor"];
const VERDICTS = ["CONFIRMED", "PLAUSIBLE", "REFUTED"];
const SECURITY_SCOPE_RE = /^security(-|$)/;
/** A sweep manifest's scope — the only shape that gets the #215 treatment. */
export const SWEEP_SCOPE_RE = /^sweep-(\d{4}-\d{2}-\d{2})$/;
// The runtime cairn version (server/package.json) — the same file index.ts
// reads for the MCP handshake. Resolves from src/audit and dist/audit alike.
const CAIRN_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
/** Panel votes a critical/important finding needs before the record accepts it. */
export function requiredVotes(scope, severity) {
    if (severity === "minor")
        return 0;
    return SECURITY_SCOPE_RE.test(scope) ? 2 : 1;
}
// Quorum
/**
 * The quorum rule, computed in code (CONTEXT.md, phase 21): a finding is
 * REFUTED only when REFUTED votes hold a strict majority; CONFIRMED when
 * confirmations outnumber refutations; otherwise PLAUSIBLE (ties, or a
 * panel that could neither prove nor disprove) — plausible survives,
 * marked. No panel at all is "unpanelled" and survives (legal on minors
 * only; the writer refuses it elsewhere).
 *
 * :param panel: the votes, possibly empty/undefined
 * :returns: the outcome
 */
export function judgePanel(panel) {
    if (!panel || panel.length === 0)
        return "unpanelled";
    const refuted = panel.filter((v) => v.verdict === "REFUTED").length;
    const confirmed = panel.filter((v) => v.verdict === "CONFIRMED").length;
    if (refuted * 2 > panel.length)
        return "refuted";
    if (confirmed > refuted)
        return "confirmed";
    return "plausible";
}
/** All three claims stated true — the only shape that may be applied. */
export function patchClaimsHold(c) {
    return c.targeted === true && c.no_new_issue === true && c.behavior_unchanged === true;
}
// Writer
/**
 * Validates, judges, and writes the record; credits yield for survivors.
 *
 * :param projectDir: repository root (record path + revision stamp)
 * :param scope: kebab-case mode+target ("security-21", "review-working")
 * :param verdict: "pass" (no findings) or "findings"
 * :param findings: the full finding list, refuted-to-be included
 * :param opts.yieldBaseDir: yield store root override (test seam)
 * :param opts.legs: sweep scopes only — the leg records this manifest indexes
 * :param opts.summary: also return panelSummary (#368)
 * :param opts.noYield: skip the yield credit — a rewrite of a record whose
 *   first write already credited it (filing adds the issue lines, #368)
 * :returns: path, counts, per-finding outcomes, stamp (+ delta on a sweep)
 * :raises CairnError: UNSUPPORTED on shape errors or a leg path outside
 *   the audit dir; PRECONDITION_FAILED on verdict mismatch, a missing
 *   failure_scenario, a missing panel, or (sweeps) a finding its leg
 *   refuted or carried with fewer votes than its leg required, a
 *   surviving finding no listed leg raised, or a leg path with no
 *   readable record behind it
 */
export function writeAuditRecord(projectDir, scope, verdict, findings, opts = {}) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(scope)) {
        throw new CairnError("UNSUPPORTED", `audit scope '${scope}' is empty or not kebab-case`, "use a short kebab-case scope like uat-phase-1");
    }
    if (verdict === "pass" && findings.length > 0) {
        throw new CairnError("PRECONDITION_FAILED", "verdict 'pass' with findings attached — pick one", "verdict must be 'findings' when any finding exists");
    }
    for (const f of findings) {
        if (!SEVERITIES.includes(f.severity) || f.title.trim().length === 0) {
            throw new CairnError("UNSUPPORTED", "finding needs a severity (critical|important|minor) and a title", "");
        }
        // Typed failure_scenario — the structural form of "a finding without a
        // scenario is a hunch". Same PRECONDITION_FAILED shape as the
        // verdict/findings mismatch: the record refuses, the caller decides.
        if (typeof f.failure_scenario !== "string" || f.failure_scenario.trim().length === 0) {
            throw new CairnError("PRECONDITION_FAILED", `finding '${f.title}' has no failure_scenario — a finding without one is a hunch`, "state the concrete inputs/state → wrong output/crash, or downgrade the finding out of the record");
        }
        for (const v of f.panel ?? []) {
            if (!v.seat?.trim() || !VERDICTS.includes(v.verdict) || !v.evidence?.trim()) {
                throw new CairnError("UNSUPPORTED", `finding '${f.title}': every panel vote needs a seat, a verdict (CONFIRMED|PLAUSIBLE|REFUTED), and evidence`, "");
            }
        }
        if (f.patch) {
            const v = f.patch.verifier;
            const c = v?.claims;
            if (!f.patch.path?.trim() || !v?.seat?.trim() || !v.evidence?.trim() || !v.testsRun?.trim()
                || !c || [c.targeted, c.no_new_issue, c.behavior_unchanged].some((b) => typeof b !== "boolean")) {
                throw new CairnError("UNSUPPORTED", `finding '${f.title}': a staged patch needs a path and a verifier with seat, evidence, testsRun, and the three boolean claims (targeted, no_new_issue, behavior_unchanged)`, "");
            }
        }
        // Verify-before-tracker: the panel is not optional where it matters.
        const need = requiredVotes(scope, f.severity);
        const have = f.panel?.length ?? 0;
        if (have < need) {
            throw new CairnError("PRECONDITION_FAILED", `${f.severity} finding '${f.title}' has ${have} panel vote${have === 1 ? "" : "s"}; ` +
                `scope '${scope}' needs ${need} before it can be recorded`, "convene the verifier(s) over the finding first — a finding reaches the tracker only after it survives refutation");
        }
    }
    const sweep = SWEEP_SCOPE_RE.test(scope);
    const legs = opts.legs ?? [];
    if (legs.length > 0 && !sweep) {
        throw new CairnError("UNSUPPORTED", `legs are a sweep manifest's index — scope '${scope}' is not sweep-<YYYY-MM-DD>`, "write the per-mode records first, then one sweep-<date> manifest that lists them as legs");
    }
    for (const l of legs) {
        if (!l.scope?.trim() || !l.path?.trim()) {
            throw new CairnError("UNSUPPORTED", "every leg needs a scope and a record path", "");
        }
    }
    // Judge every finding — in code, once, here.
    const results = findings.map((f) => {
        const outcome = judgePanel(f.panel);
        const survived = outcome !== "refuted";
        const r = { title: f.title, severity: f.severity, outcome, survived };
        // Apply-eligibility is decided here, in code: a refuted finding has no
        // fix to apply, and a verifier who couldn't state all three claims
        // true leaves the patch staged — never applied.
        if (f.patch)
            r.applyEligible = survived && patchClaimsHold(f.patch.verifier.claims);
        return r;
    });
    // Sweep manifest (#215): attribute each finding to the leg that raised
    // it. Since #248 the leg's own judgment binds the manifest — a finding
    // its leg refuted can't be resurrected here by a friendlier panel, and
    // a security leg's two-vote bar travels with its findings.
    const read = sweep ? readLegs(projectDir, legs) : [];
    const attributed = sweep ? attributeLegs(read, findings) : [];
    attributed.forEach((a, i) => {
        const f = findings[i];
        // #259: with a leg index given, every survivor must trace to a leg —
        // an unattributed one would skip both checks below. (No index at all
        // stays legal; the delta then calls nothing fixed.)
        if (!a) {
            if (legs.length > 0 && results[i].survived) {
                throw new CairnError("PRECONDITION_FAILED", `finding '${f.title}' matches nothing in any listed leg — a sweep manifest only carries ` +
                    "findings its legs raised, so each one must trace back to its leg's record", "carry the finding's title and scenario unedited from the leg record that holds it, or add " +
                    "that leg's record to legs");
            }
            return;
        }
        if (a.match.outcome === "refuted" && results[i].survived) {
            throw new CairnError("PRECONDITION_FAILED", `finding '${f.title}' was refuted in leg '${a.leg}' — a sweep manifest carries survivors only`, "leave refuted findings in their leg's record and out of the manifest's union");
        }
        const need = Math.max(requiredVotes(a.leg, f.severity), requiredVotes(a.recordScope, f.severity));
        const have = f.panel?.length ?? 0;
        if (have < need) {
            throw new CairnError("PRECONDITION_FAILED", `${f.severity} finding '${f.title}' has ${have} panel vote${have === 1 ? "" : "s"}; ` +
                `its leg '${a.leg}' needs ${need} — the manifest carries the leg's votes verbatim`, "carry the finding from its leg record unedited — title, severity, scenario, panel, seats");
        }
    });
    const sourceLeg = attributed.map((a) => a?.leg);
    mkdirSync(auditDir(projectDir), { recursive: true });
    const path = join(auditDir(projectDir), `${scope}-${today()}.md`);
    // Revision stamp (#195): which tree this record judged, captured by the
    // server at write time. Absent outside git — never invented.
    const stamp = revisionStamp(projectDir);
    // ...and diff the survivors against the previous manifest.
    let delta = null;
    if (sweep) {
        const current = [];
        findings.forEach((f, i) => {
            if (!results[i].survived)
                return;
            current.push({ title: f.title, severity: f.severity, failure_scenario: f.failure_scenario.trim(),
                ...(sourceLeg[i] ? { leg: sourceLeg[i] } : {}) });
        });
        delta = sweepDelta(projectDir, scope, path, current, coveredScopes(read));
    }
    const body = [`# Audit: ${scope}`, ""];
    if (sweep) {
        for (const l of read)
            body.push(`leg: ${l.scope} => ${l.path}`);
        if (read.length > 0)
            body.push("");
        body.push(...renderDelta(delta), "");
    }
    findings.forEach((f, i) => {
        body.push(`## finding — ${f.severity}`, f.title);
        body.push(`scenario: ${f.failure_scenario.trim()}`);
        if (f.at?.trim())
            body.push(`at: ${f.at.trim()}`);
        if (sourceLeg[i])
            body.push(`source leg: ${sourceLeg[i]}`);
        if (f.seats && f.seats.length > 0)
            body.push(`raised by: ${f.seats.join(", ")}`);
        if (f.panel && f.panel.length > 0) {
            body.push(`outcome: ${results[i].outcome}`);
            for (const v of f.panel)
                body.push(`vote: ${v.seat} ${v.verdict} — ${v.evidence.trim()}`);
            if (!results[i].survived)
                body.push("refuted: true — not filed to the tracker");
        }
        if (f.patch) {
            const { seat, claims, evidence, testsRun } = f.patch.verifier;
            body.push(`patch: ${f.patch.path.trim()}`);
            body.push(`patch verifier: ${seat} — targeted=${claims.targeted} no_new_issue=${claims.no_new_issue} ` +
                `behavior_unchanged=${claims.behavior_unchanged}; tests: ${testsRun.trim()}; ${evidence.trim()}`);
            body.push(`apply: ${results[i].applyEligible ? "eligible — on the user's choice" : "blocked — claims not all true"}`);
        }
        if (f.issue)
            body.push(`issue: ${f.issue}`);
        if (f.detail)
            body.push("", f.detail.trimEnd());
        body.push("");
    });
    const frontmatter = { scope, verdict, created: today() };
    if (stamp) {
        frontmatter.commit = stamp.commit;
        frontmatter.dirty = String(stamp.dirty);
    }
    if (sweep)
        frontmatter.cairn = CAIRN_VERSION;
    writeFileSync(path, serializeFrontmatter(frontmatter, `${body.join("\n").trimEnd()}\n`));
    // Yield credit (#196): a raising seat earns findingsSurvived only for a
    // finding that went through a panel and came out alive — "survived"
    // now means survived verification, not survived triage. Advisory:
    // a yield-store problem never fails the record. A sweep manifest earns
    // nothing (#255): its findings are its legs' survivors carried verbatim,
    // and each leg's own write already credited them — crediting here too
    // would count every sweep finding twice.
    const credit = new Map();
    findings.forEach((f, i) => {
        if (opts.noYield || sweep || !results[i].survived || results[i].outcome === "unpanelled")
            return;
        for (const seat of f.seats ?? [])
            credit.set(seat, (credit.get(seat) ?? 0) + 1);
    });
    let note;
    if (credit.size > 0) {
        const deltas = [...credit].map(([seat, n]) => ({ seat, findingsSurvived: n }));
        try {
            note = recordYield(projectDir, deltas, opts.yieldBaseDir).note;
        }
        catch (e) {
            note = `yield store not credited: ${e instanceof Error ? e.message : String(e)}`;
        }
    }
    return {
        path,
        findings: findings.length,
        survived: results.filter((r) => r.survived).length,
        refuted: results.filter((r) => !r.survived).length,
        results,
        ...(stamp ? { commit: stamp.commit, dirty: stamp.dirty } : {}),
        ...(note ? { note } : {}),
        ...(sweep ? { delta } : {}),
        ...(opts.summary ? { panelSummary: panelSummary(sweep && read.length > 0 ? read.flatMap((l) => l.record.findings.map((f) => f.outcome))
                : results.map((r) => r.outcome)) } : {}),
    };
}
/**
 * The closing report's panel line (#368). Unpanelled findings (minors)
 * never met a panel, so they count nowhere.
 *
 * :param outcomes: one outcome per finding
 * :returns: "panel: N confirmed, N plausible, N refuted (not filed)"
 */
export function panelSummary(outcomes) {
    const n = (o) => outcomes.filter((x) => x === o).length;
    return `panel: ${n("confirmed")} confirmed, ${n("plausible")} plausible, ${n("refuted")} refuted (not filed)`;
}
export function listAuditRecords(projectDir) {
    const dir = auditDir(projectDir);
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith(".md"))
            continue;
        try {
            const { data } = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
            const rec = { scope: String(data.scope ?? ""),
                date: String(data.created ?? ""), verdict: String(data.verdict ?? ""),
                path: join(dir, entry) };
            if (typeof data.commit === "string" && data.commit) {
                rec.commit = data.commit;
                rec.dirty = data.dirty === "true";
            }
            out.push(rec);
        }
        catch { /* malformed record: skip, list must not brick (cards precedent) */ }
    }
    return out;
}
const FINDING_HEAD_RE = /^## finding — (critical|important|minor)\s*$/;
const DELTA_ITEM_RE = /^- (new|persisting|fixed|regressed|unchecked) — (critical|important|minor): (.*)$/;
const OUTCOMES = ["confirmed", "plausible", "refuted", "unpanelled"];
/**
 * Reads a record back into frontmatter + findings. Tolerant of every
 * shape the writer has ever produced: a pre-phase-21 block with no
 * scenario is skipped with a note (it was a hunch then, and a delta can't
 * match on it now), never an error.
 *
 * :param path: the record file
 * :returns: frontmatter, findings, leg index, the record's own fixed and
 *   unchecked lists, notes
 * :raises CairnError: CONFIG_INVALID only on a broken frontmatter block
 */
export function parseAuditRecord(path) {
    const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const out = { frontmatter: data, findings: [], legs: [], deltaFixed: [],
        deltaUnchecked: [], notes: [] };
    let section = "head";
    let cur = null;
    let deltaItem = null;
    const flush = () => {
        if (!cur)
            return;
        const title = cur.title?.trim() ?? "";
        if (!title || !cur.scenario) {
            out.notes.push(`skipped ${cur.severity} finding '${title || "(untitled)"}' — no scenario (pre-phase-21 body)`);
        }
        else {
            out.findings.push({ title, severity: cur.severity, failure_scenario: cur.scenario,
                outcome: cur.refuted ? "refuted" : (cur.outcome ?? "unpanelled"),
                ...(cur.leg ? { leg: cur.leg } : {}) });
        }
        cur = null;
    };
    for (const line of body.split("\n")) {
        const head = FINDING_HEAD_RE.exec(line);
        if (head) {
            flush();
            section = "finding";
            cur = { severity: head[1], keys: true };
            continue;
        }
        if (line.startsWith("## ")) {
            flush();
            section = line.startsWith("## delta") ? "delta" : "other";
            continue;
        }
        // Leg index — the lines between the title and the first section.
        if (section === "head") {
            const m = /^leg: (.+?) => (.+)$/.exec(line);
            if (m)
                out.legs.push({ scope: m[1].trim(), path: m[2].trim() });
            continue;
        }
        // Delta items — only the fixed and unchecked lists matter to the next sweep.
        if (section === "delta") {
            const m = DELTA_ITEM_RE.exec(line);
            if (m) {
                const keep = m[1] === "fixed" ? out.deltaFixed : m[1] === "unchecked" ? out.deltaUnchecked : null;
                deltaItem = keep ? { title: m[3].trim(), severity: m[2], failure_scenario: "" } : null;
                if (keep && deltaItem)
                    keep.push(deltaItem);
                continue;
            }
            const sc = /^ {2}scenario: (.*)$/.exec(line);
            if (sc && deltaItem)
                deltaItem.failure_scenario = sc[1].trim();
            const lg = /^ {2}leg: (.*)$/.exec(line);
            if (lg && deltaItem)
                deltaItem.leg = lg[1].trim();
            continue;
        }
        // Finding key lines run from the title to the first blank line;
        // anything after that is free-text detail and is not parsed.
        if (section !== "finding" || !cur || !cur.keys)
            continue;
        if (line.trim() === "") {
            if (cur.title !== undefined)
                cur.keys = false;
            continue;
        }
        if (cur.title === undefined) {
            cur.title = line;
            continue;
        }
        const kv = /^([a-z ]+): (.*)$/.exec(line);
        if (!kv)
            continue;
        const key = kv[1];
        const val = kv[2].trim();
        if (key === "scenario")
            cur.scenario = val;
        else if (key === "outcome" && OUTCOMES.includes(val))
            cur.outcome = val;
        else if (key === "refuted" && val.startsWith("true"))
            cur.refuted = true;
        else if (key === "source leg")
            cur.leg = val;
    }
    flush();
    return out;
}
// Sweep delta
/**
 * Same finding? Exact title is the fast path; otherwise the dedup
 * engine's scenario-similarity rule (normalized-token Jaccard >= 0.5).
 * No file:line survives into records, so the scenario is the identity.
 *
 * :param a: one finding
 * :param b: the other
 * :returns: true when they describe the same failure
 */
function sameFinding(a, b) {
    if (a.title.trim() === b.title.trim())
        return true;
    return textsMatch(a.failure_scenario, b.failure_scenario);
}
/**
 * One-to-one matching: every current finding claims at most one prior,
 * titles first (so an exact title is never stolen by a fuzzy scenario
 * match), then scenarios.
 *
 * :param current: this sweep's findings
 * :param prior: the baseline's findings
 * :returns: prior index per current index (-1 when unmatched)
 */
function matchFindings(current, prior) {
    const taken = new Set();
    const pair = current.map(() => -1);
    current.forEach((c, i) => {
        const j = prior.findIndex((p, k) => !taken.has(k) && p.title.trim() === c.title.trim());
        if (j >= 0) {
            pair[i] = j;
            taken.add(j);
        }
    });
    current.forEach((c, i) => {
        if (pair[i] >= 0)
            return;
        const j = prior.findIndex((p, k) => !taken.has(k) && sameFinding(p, c));
        if (j >= 0) {
            pair[i] = j;
            taken.add(j);
        }
    });
    return pair;
}
/**
 * The latest prior sweep manifest — sweep-* scope, not the file being
 * written now, dated (by scope) no later than this sweep.
 *
 * :param projectDir: repository root
 * :param scope: this sweep's scope
 * :param path: this sweep's record path (excluded — a same-day rerun overwrites it)
 * :returns: the baseline's path, or null on the first sweep
 */
function previousManifest(projectDir, scope, path) {
    const mine = SWEEP_SCOPE_RE.exec(scope)?.[1] ?? "";
    const prior = listAuditRecords(projectDir)
        .map((r) => ({ r, date: SWEEP_SCOPE_RE.exec(r.scope)?.[1] ?? "" }))
        .filter((x) => x.date !== "" && x.r.path !== path && x.date <= mine)
        .sort((a, b) => a.date.localeCompare(b.date) || a.r.date.localeCompare(b.r.date)
        || a.r.path.localeCompare(b.r.path));
    return prior.at(-1)?.r.path ?? null;
}
/**
 * Classifies this sweep's survivors against the previous manifest:
 * persisting (matched a prior), regressed (unmatched, but the previous
 * manifest's own delta had called it fixed), new (otherwise). A prior
 * nothing matches now is fixed only when its leg is one this sweep
 * re-checked; any other prior — a leg retargeted, skipped, or never named
 * — is unchecked, never a false fixed (#266). "Prior" is the baseline's
 * survivors plus its own unchecked items, so a finding that went unlooked-at
 * for a sweep and comes back reads persisting, not new. Null on the first
 * sweep, or when the baseline can't be read.
 *
 * :param projectDir: repository root
 * :param scope: this sweep's scope
 * :param path: this sweep's record path
 * :param current: this sweep's surviving findings
 * :param covered: the leg scopes this sweep re-checked (coveredScopes)
 * :returns: the delta, or null when there is no baseline
 */
function sweepDelta(projectDir, scope, path, current, covered) {
    const basePath = previousManifest(projectDir, scope, path);
    if (!basePath)
        return null;
    let base;
    try {
        base = parseAuditRecord(basePath);
    }
    catch {
        return null;
    }
    const str = (v) => (typeof v === "string" && v ? v : undefined);
    const commit = str(base.frontmatter.commit);
    const cairn = str(base.frontmatter.cairn);
    const created = str(base.frontmatter.created);
    const prior = [
        ...base.findings
            .filter((f) => f.outcome !== "refuted")
            .map((f) => ({ title: f.title, severity: f.severity, failure_scenario: f.failure_scenario,
            ...(f.leg ? { leg: f.leg } : {}) })),
        ...base.deltaUnchecked,
    ];
    const delta = {
        baseline: { path: basePath, ...(commit ? { commit } : {}), ...(cairn ? { cairn } : {}),
            ...(created ? { created } : {}) },
        codeCommitsSince: commit ? codeCommitsSince(projectDir, commit) : null,
        new: [], persisting: [], fixed: [], regressed: [], unchecked: [], uncoveredLegs: [],
    };
    const pair = matchFindings(current, prior);
    const unmatched = [];
    current.forEach((c, i) => { (pair[i] >= 0 ? delta.persisting : unmatched).push(c); });
    const fixedPair = matchFindings(unmatched, base.deltaFixed);
    unmatched.forEach((c, i) => { (fixedPair[i] >= 0 ? delta.regressed : delta.new).push(c); });
    const claimed = new Set(pair.filter((j) => j >= 0));
    prior.forEach((p, j) => {
        if (claimed.has(j))
            return;
        (p.leg && covered.has(p.leg) ? delta.fixed : delta.unchecked).push(p);
    });
    // Every leg the baseline named — its index and its carried findings' legs —
    // that nothing in this sweep re-checked.
    const named = new Set([...base.legs.map((l) => l.scope), ...prior.flatMap((p) => (p.leg ? [p.leg] : []))]);
    delta.uncoveredLegs = [...named].filter((l) => !covered.has(l));
    return delta;
}
/**
 * The record's delta section — heading, baseline, counts, the legs left
 * uncovered, then one item per finding with its scenario (and leg)
 * indented below, so the next sweep can read this one's fixed and
 * unchecked lists back.
 *
 * :param delta: the computed delta, or null on the first sweep
 * :returns: body lines
 */
function renderDelta(delta) {
    if (!delta)
        return ["## delta", "first baseline — no earlier sweep manifest to compare against"];
    const b = delta.baseline;
    const name = b.path.split(/[\\/]/).at(-1)?.replace(/\.md$/, "") ?? b.path;
    const out = [`## delta vs ${name}`,
        `baseline: ${b.path}${b.commit ? ` @ ${b.commit.slice(0, 7)}` : ""}` +
            `${b.cairn ? ` (cairn ${b.cairn})` : ""}${b.created ? `, ${b.created}` : ""}`,
        `code commits since: ${delta.codeCommitsSince ?? "unknown"}`,
        `counts: new ${delta.new.length}, persisting ${delta.persisting.length}, ` +
            `fixed ${delta.fixed.length}, regressed ${delta.regressed.length}, unchecked ${delta.unchecked.length}`,
        `uncovered legs: ${delta.uncoveredLegs.length > 0 ? delta.uncoveredLegs.join(", ") : "none"}`];
    for (const cls of ["regressed", "new", "persisting", "fixed", "unchecked"]) {
        for (const f of delta[cls]) {
            out.push(`- ${cls} — ${f.severity}: ${f.title}`, `  scenario: ${f.failure_scenario}`);
            if (f.leg)
                out.push(`  leg: ${f.leg}`);
        }
    }
    return out;
}
/** True when `p` sits strictly below `base` (both already resolved). */
function under(base, p) {
    const rel = relative(base, p);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/**
 * Where a leg's record may be read from: a regular file under the
 * project's audit dir, symlinks resolved — the leg index is caller input,
 * and the manifest must not become a reader of arbitrary files. Since
 * #259 a path that names no file is refused too: a leg the manifest can't
 * read would silently attribute nothing and skip its leg's checks.
 *
 * :param projectDir: repository root (relative leg paths resolve here)
 * :param leg: one leg index entry
 * :returns: the record's real (symlink-free) absolute path
 * :raises CairnError: UNSUPPORTED when the path escapes the audit dir or
 *   isn't a regular file; PRECONDITION_FAILED when no file is there
 */
function legRecordPath(projectDir, leg) {
    const dir = resolve(auditDir(projectDir));
    const p = resolve(projectDir, leg.path.trim());
    const refuse = (why) => new CairnError("UNSUPPORTED", `leg '${leg.scope.trim()}' path ${why} — a leg is a record under the project's audit dir`, "pass the path the leg's own audit_record call returned");
    if (!under(dir, p))
        throw refuse("is outside the audit dir");
    let st;
    try {
        st = lstatSync(p);
    }
    catch {
        throw new CairnError("PRECONDITION_FAILED", `leg '${leg.scope.trim()}' points at a record that isn't there (${leg.path.trim()}) — ` +
            "a sweep can only index legs that wrote a record", "pass the exact path that leg's own audit_record call returned; a leg that didn't run stays " +
            "out of the index as a 'leg skipped' line");
    }
    if (!st.isFile())
        throw refuse("is not a regular file");
    const real = realpathSync(p);
    if (!under(realpathSync(dir), real))
        throw refuse("resolves outside the audit dir");
    return real;
}
/**
 * Reads every leg record the index names, once per file: entries that
 * resolve to the same record collapse to the first (#259). Every entry
 * must resolve to a readable audit record — one that won't parse, or
 * carries no scope of its own, is refused rather than quietly
 * attributing nothing.
 *
 * :param projectDir: repository root (relative leg paths resolve here)
 * :param legs: the leg index
 * :returns: one ReadLeg per distinct record, in index order
 * :raises CairnError: UNSUPPORTED on a leg path outside the audit dir;
 *   PRECONDITION_FAILED on a leg path with no readable record behind it
 */
function readLegs(projectDir, legs) {
    const seen = new Set();
    const out = [];
    for (const l of legs) {
        const real = legRecordPath(projectDir, l);
        if (seen.has(real))
            continue;
        seen.add(real);
        const unreadable = (why) => new CairnError("PRECONDITION_FAILED", `leg '${l.scope.trim()}' points at a file that isn't a readable audit record (${l.path.trim()}): ${why}`, "pass the exact path that leg's own audit_record call returned");
        let record;
        try {
            record = parseAuditRecord(real);
        }
        catch (e) {
            throw unreadable(e instanceof Error ? e.message : String(e));
        }
        const own = record.frontmatter.scope;
        if (typeof own !== "string" || own.trim() === "")
            throw unreadable("it names no scope");
        out.push({ scope: l.scope.trim(), path: l.path.trim(), recordScope: own.trim(), record });
    }
    return out;
}
/**
 * Which leg scopes this sweep actually re-checked (#266): a leg covers
 * its index scope only when its record was written under that same
 * scope — a mislabelled index entry (scope security-25 pointing at a
 * security-26 record) covers nothing, so it can't turn untouched findings
 * into a false fixed.
 *
 * :param read: the legs as readLegs returned them
 * :returns: the covered scopes
 */
function coveredScopes(read) {
    return new Set(read.filter((l) => l.recordScope === l.scope).map((l) => l.scope));
}
/**
 * Which leg raised each finding: match every finding against the legs'
 * records by the delta's identity rule.
 *
 * :param read: the legs as readLegs returned them
 * :param findings: the manifest's findings
 * :returns: leg attribution per finding index (undefined when unattributed)
 */
function attributeLegs(read, findings) {
    const legFindings = read.map((l) => l.record.findings);
    // Within a leg, a surviving copy wins over a refuted one of the same identity.
    const pick = (fs, same) => fs.find((x) => same(x) && x.outcome !== "refuted") ?? fs.find(same);
    return findings.map((f) => {
        // An exact title in any leg wins over a fuzzy scenario match in an earlier one.
        const exact = (x) => x.title.trim() === f.title.trim();
        const fuzzy = (x) => sameFinding(x, f);
        let same = exact;
        let k = legFindings.findIndex((fs) => fs.some(exact));
        if (k < 0) {
            same = fuzzy;
            k = legFindings.findIndex((fs) => fs.some(fuzzy));
        }
        const match = k >= 0 ? pick(legFindings[k], same) : undefined;
        if (!match)
            return undefined;
        return { leg: read[k].scope, recordScope: read[k].recordScope, match };
    });
}
