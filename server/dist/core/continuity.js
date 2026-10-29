import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { isValidPhaseNumber } from "../planning/artifacts.js";
const STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** Same per-machine hashing scheme as indexDbPath: sha256(resolve(dir)).slice(0,16), keyed off basename. */
function pathHash(projectDir) {
    const abs = resolve(projectDir);
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
    return { base: basename(abs), hash };
}
export function handoffPath(projectDir) {
    const { base, hash } = pathHash(projectDir);
    return join(homedir(), ".cairn", "handoff", `${base}-${hash}.json`);
}
export function bannerPath(projectDir) {
    const { base, hash } = pathHash(projectDir);
    return join(homedir(), ".cairn", "banner", `${base}-${hash}.md`);
}
/** The Stop hook's cumulative cost log (stop-costtracker.mjs writes it; the
 *  token estimator reads it). Scheme mirrored in hooks/scripts/lib.mjs. */
export function metricsPath(projectDir) {
    const { base, hash } = pathHash(projectDir);
    return join(homedir(), ".cairn", "metrics", `${base}-${hash}.jsonl`);
}
/** The one definition of who wrote a handoff -- the MCP input schema in
 *  index.ts imports this rather than restating it (#370 collapsed the copy). */
export const HandoffSourceEnum = z.enum(["tool", "posttooluse", "precompact", "waypoint"]);
/** The handoff `notes` line for a wave checkpoint. */
export function waveNotes(wave) {
    return `wave ${wave.phase} run ${wave.runId}`;
}
/** The outlook `nextVerb` for a wave checkpoint -- what a fresh session
 *  types to pick the run up where it stopped. */
export function waveNextVerb(wave) {
    return `work ${wave.phase} --wave — resume run ${wave.runId}`;
}
export const HandoffSchema = z.object({
    version: z.literal(1),
    created: z.string(),
    source: HandoffSourceEnum,
    project: z.string(),
    // Widened for decimal phase numbers -- same rule 1 as
    // isValidPhaseNumber: integers 1..99, or N.1-N.9 with N=1..98.
    phase: z.object({ number: z.number().refine(isValidPhaseNumber), slug: z.string() }).optional(),
    issue: z.string().optional(),
    plan: z.string().optional(),
    task: z.object({ current: z.string(), title: z.string() }),
    tasks_completed: z.array(z.string()),
    tasks_remaining: z.array(z.string()),
    blockers: z.array(z.string()),
    decisions_in_flight: z.array(z.string()),
    uncommitted_files: z.array(z.string()),
    next_action: z.string(),
    notes: z.string(),
    partial: z.boolean(),
});
/** Handoff with no task in flight and no next action -- the baseline every write patches over. */
function blankHandoff(project, source) {
    return {
        version: 1,
        created: new Date().toISOString(),
        source,
        project,
        task: { current: "", title: "" },
        tasks_completed: [],
        tasks_remaining: [],
        blockers: [],
        decisions_in_flight: [],
        uncommitted_files: [],
        next_action: "",
        notes: "",
        partial: false,
    };
}
/** A handoff counts as "rich" once there's a task in flight or a stated next action. */
function isRich(h) {
    return h.task.current !== "" || h.next_action !== "";
}
/** Reads the raw handoff file at `path`, returning null when absent. Throws HANDOFF_INVALID on corrupt content. */
function readRaw(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        throw new CairnError("HANDOFF_INVALID", `handoff at ${path} is not valid JSON: ${e}`, "inspect or discard ~/.cairn/handoff/…");
    }
    const result = HandoffSchema.safeParse(parsed);
    if (!result.success) {
        throw new CairnError("HANDOFF_INVALID", `handoff at ${path} failed schema validation: ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "inspect or discard ~/.cairn/handoff/…");
    }
    return result.data;
}
/**
 * Reads the project's handoff. Never errors the session for staleness -- callers
 * get `stale: true` and decide what to do with it. Invalid JSON/schema still
 * throws HANDOFF_INVALID, since that's a corrupt file, not a stale one.
 */
export function readHandoff(projectDir) {
    const handoff = readRaw(handoffPath(projectDir));
    if (!handoff)
        return null;
    const stale = Date.now() - new Date(handoff.created).getTime() > STALE_MS;
    return { handoff, stale };
}
/**
 * Merges `patch` over the existing handoff (or a blank skeleton) and writes it
 * atomically. Two guards keep this safe to call from hot paths like PostToolUse:
 *  - unregistered guard: no loadable cairn.json -> skip silently, never scaffold.
 *  - skeleton guard: richness is monotonic between clears -- a write can't
 *    replace a rich handoff (task.current or next_action non-empty) with an
 *    empty one. clearHandoff() is the explicit way to wipe a handoff.
 */
export function writeHandoff(projectDir, patch) {
    try {
        loadConfig(projectDir);
    }
    catch (e) {
        if (e instanceof CairnError && e.code === "CONFIG_MISSING")
            return;
        throw e;
    }
    const path = handoffPath(projectDir);
    // A corrupt existing file (crashed session, partial write from an older cairn)
    // must not wedge every subsequent automated write -- treat it as absent and
    // let this write replace it with a valid handoff. Anything else still surfaces.
    let existing;
    try {
        existing = readRaw(path);
    }
    catch (e) {
        if (e instanceof CairnError && e.code === "HANDOFF_INVALID")
            existing = null;
        else
            throw e;
    }
    const project = patch.project ?? existing?.project ?? basename(resolve(projectDir));
    const base = existing ?? blankHandoff(project, patch.source);
    const merged = {
        ...base,
        ...patch,
        version: 1,
        created: new Date().toISOString(),
    };
    if (existing && isRich(existing) && !isRich(merged))
        return; // silently keep the richer file
    mkdirSync(dirname(path), { recursive: true });
    // Per-writer tmp name (#351): a fixed `${path}.tmp` let two concurrent
    // writers share one tmp, so the second rename threw ENOENT. Mirrored in
    // hooks/scripts/lib.mjs atomicWriteJson.
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
    renameSync(tmp, path);
}
/** Deletes the project's handoff file, if any. Returns whether one existed. */
export function clearHandoff(projectDir) {
    const path = handoffPath(projectDir);
    if (!existsSync(path))
        return false;
    unlinkSync(path);
    return true;
}
/** Thrown instead of persisting a checkpoint that would not survive a resume. */
export class DegradedCheckpointError extends Error {
    missing;
    constructor(missing) {
        super(`checkpoint is degraded and was NOT written -- missing: ${missing.join(", ")}. ` +
            "A bad checkpoint is worse than none: by the time it is written the " +
            "context it replaced is already gone. Fill these in and retry.");
        this.name = "DegradedCheckpointError";
        this.missing = missing;
    }
}
/** A state summary shorter than this cannot carry enough to resume from. */
const MIN_STATE_CHARS = 20;
/**
 * The abort rule. Required: at least one decision, a usable state summary,
 * and the user's requirements verbatim. Not required: rejected approaches,
 * skills, next steps, files touched -- a session may genuinely have none of
 * those, and demanding them would teach the caller to invent them.
 *
 * :param a: the artifacts a caller proposes to persist
 * :throws DegradedCheckpointError naming every missing artifact at once
 */
export function validateArtifacts(a) {
    const missing = [];
    if (!a.decisions || a.decisions.filter((d) => d.trim()).length === 0)
        missing.push("decisions");
    if (!a.state || a.state.trim().length < MIN_STATE_CHARS)
        missing.push("state");
    if (!a.requirements || a.requirements.trim() === "")
        missing.push("requirements");
    if (missing.length > 0)
        throw new DegradedCheckpointError(missing);
}
