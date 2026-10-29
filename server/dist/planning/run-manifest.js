/**
 * Purpose: the run manifest for headless batch runs (#132) — the staging
 *   interview's output and the executor's SOLE source of authority. One
 *   manifest per run, written when the user approves the staging gate:
 *   which phases run, their estimate ranges, the budget ceiling, and the
 *   push pre-authorization (REC-5 moved to run start, scope-limited to
 *   the manifest's phases — a phase outside the manifest never pushes).
 *
 *   Lives under ~/.cairn (never the repo) with the same path/injection
 *   conventions as budget-ledger.ts: per-machine project hash, filename-
 *   safe runId, raw run_id verified on load so a sanitize collision can't
 *   silently merge two runs. Versioned state file — z.literal(1) +
 *   safeParse + atomic tmp-then-rename write, continuity.ts precedent.
 *
 *   pushAuth starts FALSE and only grantPushAuth() flips it — creation can
 *   never smuggle authority in. Status walks a one-way lifecycle:
 *   staged → running → complete|stopped (staged may also go straight to
 *   stopped when a run is abandoned before it starts). currentPhase walks
 *   forward through the manifest's own phases while running (#260), so
 *   the run guard can tie a push to a phase the owner authorized.
 *
 *   The circuit breaker (#358) is the one writer of this file that is not
 *   the server: the PreToolUse guards (hooks/scripts/breaker.mjs) freeze a
 *   running run at `auto.breaker` refusals by writing status `stopped` and
 *   a `stop` block (reason breaker, the last three refusal rows, the
 *   sessions they came from). A frozen run is terminal like any stopped
 *   one, and more: every move on it refuses RUN_FROZEN (a re-stop is a
 *   no-op), and no server write may clobber a freeze that landed between
 *   its read and its rename -- the re-read in writeManifestFile. Hooks have
 *   no tracker access, so the one plain-language comment a freeze owes is
 *   the server's: markFreezeCommented records it, once.
 *
 * removeWhen: never — push authority is an owner-decided policy gate, not
 *   a workaround for a model limit; a stronger agent does not change who
 *   decides what leaves the machine (ADR 0007).
 * Author(s): John Reed
 */
// Imports
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { appendFileSync, constants as fsConstants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
// Constants
/** The only legal status moves — anything else is a lifecycle bug. */
const STATUS_TRANSITIONS = {
    staged: ["running", "stopped"],
    running: ["complete", "stopped"],
    complete: [],
    stopped: [],
};
// Project key (#362)
//
// Per-machine state outside the repo is keyed one of two ways, by what the
// state is about rather than where it is written:
//   - worktreeKey -- the resolved checkout folder. A session's task in
//     flight: the handoff and the banner (active context lives in the
//     checkout itself).
//   - projectKey -- the repository, read as `git rev-parse --git-common-dir`.
//     Every linked worktree of one repo shares it, so knowledge of the
//     project (memory index, metrics, the meter, yield, loop state, the
//     outlook mirror, refusals, run manifests, the ship-gate stamp, budget
//     ledgers, observations) is one set of files, not one per folder.
// Both read `<base>-<16 hex of sha256>`. This is the server's one
// definition; hooks/scripts/lib.mjs mirrors it (hook scripts never import
// server code) and project-key.test.ts pins the two byte for byte.
/** The cairn home folders whose files belong to the repository, keyed by
 *  projectKey. handoff/ and banner/ are absent on purpose: per worktree. */
export const REPOSITORY_STATE_DIRS = [
    "index", "metrics", "outlook", "yield", "loop", "state", "refusals", "runs", "ship-gate", "budget",
];
/** Git location variables a hook can inherit from a git hook; any of them
 *  would make rev-parse answer for some other repository than the folder. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
const KEY_CACHE = new Map();
/** `<base>-<first 16 hex of sha256(abs)>`. */
function keyOf(abs, base) {
    return `${base}-${createHash("sha256").update(abs).digest("hex").slice(0, 16)}`;
}
/** The checkout folder's key -- the scheme every file used before #362. */
export function worktreeKey(projectDir) {
    const abs = resolve(projectDir);
    return keyOf(abs, basename(abs));
}
/** The repository's common git dir, real path, or null outside a repository. */
export function gitCommonDir(projectDir) {
    const cwd = resolve(projectDir);
    const env = { ...process.env };
    for (const k of GIT_LOCATION_ENV)
        delete env[k];
    try {
        const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
        }).trim();
        return out ? realpathSync(resolve(cwd, out)) : null;
    }
    catch {
        return null; // not a repository, no git on PATH, or no such folder
    }
}
/**
 * The repository's key: `git rev-parse --git-common-dir` resolved to a real
 * absolute path, hashed, named after the folder holding it (`repo/.git` reads
 * `repo`; a bare `repo.git` reads `repo`). Outside a repository it degrades to
 * worktreeKey, which is exactly the pre-#362 key. Cached per folder only on
 * the git answer, so a folder that becomes a repository is re-read.
 *
 * :param projectDir: any checkout of the repository
 * :returns: `<base>-<hash>`
 */
export function projectKey(projectDir) {
    const abs = resolve(projectDir);
    const hit = KEY_CACHE.get(abs);
    if (hit)
        return hit;
    const common = gitCommonDir(abs);
    if (common === null)
        return worktreeKey(abs);
    const name = basename(common);
    const base = name === ".git" ? basename(dirname(common)) : name.replace(/\.git$/, "") || name;
    const key = keyOf(common, base);
    KEY_CACHE.set(abs, key);
    return key;
}
/**
 * Moves `from` to `to` without ever replacing a `to` that exists: a hard
 * link (fails EEXIST rather than clobbering) then unlink the old name; across
 * devices, an exclusive copy then unlink. False when nothing moved.
 *
 * Concurrency -- the three handoff questions:
 *   atomicity -- the link is one syscall and refuses an existing target, so
 *     two processes moving the same file cannot both win or overwrite a
 *     file a writer just created under the new name.
 *   visibility -- between link and unlink both names are one inode; a
 *     writer appending through the old name lands in the moved file. The
 *     copy fallback has no such promise: a row appended mid-copy is lost.
 *   ordering -- none needed; whoever links first moved it, the rest see
 *     EEXIST or ENOENT and move nothing.
 */
export function moveNoClobber(from, to) {
    try {
        linkSync(from, to);
    }
    catch (e) {
        const code = e?.code;
        if (code === "EEXIST" || code === "ENOENT")
            return false;
        try {
            copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
        }
        catch {
            return false;
        }
    }
    try {
        unlinkSync(from);
    }
    catch {
        // the move landed; a leftover old name is clutter the next sweep skips
    }
    return true;
}
/**
 * The one-shot rekey's record: one row on the project's metrics log naming
 * what moved. It carries no session_id, so every latest-row-per-session
 * reader skips it. One append of one line, so it never tears another row.
 */
export function recordRekey(baseDir, projectDir, moved) {
    if (moved.length === 0)
        return;
    const key = projectKey(projectDir);
    const path = join(baseDir, "metrics", `${key}.jsonl`);
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify({
            ts: new Date().toISOString(), event: "rekey", from: worktreeKey(projectDir), to: key, moved,
        }) + "\n");
    }
    catch {
        // the record is a measurement; a home it cannot write never fails the caller
    }
}
/**
 * Moves every repository-state file this folder kept under its worktree
 * key to the project key (#362): a name is `<key><rest>` where rest starts
 * with `.` or `-` (a closed metrics segment, a sqlite sidecar, a run id).
 * A name whose project-key twin exists is left where it is -- a linked
 * worktree that ran before the upgrade keeps its own leftovers, and the
 * shared file is never replaced. Nothing to move, nothing logged, so the
 * move is one-shot by construction: the old name is gone once it lands.
 *
 * :param projectDir: the checkout
 * :param baseDir: the cairn home
 * :returns: `<dir>/<old name>` for each file moved
 */
export function migrateRepositoryState(projectDir, baseDir = join(homedir(), ".cairn")) {
    const key = projectKey(projectDir);
    const legacy = worktreeKey(projectDir);
    if (key === legacy)
        return [];
    const moved = [];
    for (const sub of REPOSITORY_STATE_DIRS) {
        const dir = join(baseDir, sub);
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue; // never written on this machine
        }
        for (const name of names) {
            const rest = name.slice(legacy.length);
            if (!name.startsWith(legacy) || !(rest.startsWith(".") || rest.startsWith("-")))
                continue;
            if (rest.endsWith(".tmp"))
                continue; // a write in flight renames itself
            if (moveNoClobber(join(dir, name), join(dir, `${key}${rest}`)))
                moved.push(`${sub}/${name}`);
        }
    }
    recordRekey(baseDir, projectDir, moved);
    return moved;
}
/**
 * `<baseDir>/<dir>/<projectKey><suffix>`, after the one-shot move. When the
 * new name is still absent but the old one survived (the move could not
 * land), the old one is read instead -- nothing goes dark on an upgrade.
 *
 * :param projectDir: the checkout
 * :param dir: one of REPOSITORY_STATE_DIRS
 * :param suffix: what follows the key (`.jsonl`, `-<runId>.json`, ...)
 * :param baseDir: the cairn home
 */
export function repositoryPath(projectDir, dir, suffix, baseDir = join(homedir(), ".cairn")) {
    migrateRepositoryState(projectDir, baseDir);
    const path = join(baseDir, dir, `${projectKey(projectDir)}${suffix}`);
    if (existsSync(path))
        return path;
    const old = join(baseDir, dir, `${worktreeKey(projectDir)}${suffix}`);
    return existsSync(old) ? old : path;
}
// Paths
/** Filename-safe runId — exotic characters collapse to '-'; the raw run_id
 * stays inside the file and is verified on load. */
function safeRunId(runId) {
    return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}
/** ~/.cairn/runs/<projectKey>-<runId>.json — one manifest per run, outside
 * the repo, per repository: a batch run spans worktrees (#362). baseDir
 * injectable for tests (budget-ledger convention). */
export function runManifestPath(projectDir, runId, baseDir = join(homedir(), ".cairn")) {
    return repositoryPath(projectDir, "runs", `-${safeRunId(runId)}.json`, baseDir);
}
const ManifestPhaseSchema = z.object({
    number: z.number(),
    name: z.string(),
    estimate: z.object({
        low: z.number(),
        high: z.number(),
        estUsd: z.object({ low: z.number(), high: z.number() }),
    }),
    waves: z.number().optional(),
});
const RefusalRowSchema = z.object({
    ts: z.string(),
    guard: z.string(),
    tool: z.string(),
    effect: z.string(),
    reason: z.string(),
    session_id: z.string().nullable(),
    run_id: z.string().optional(),
    input_sha256: z.string(),
});
const RunStopSchema = z.object({
    reason: z.literal("breaker"),
    at: z.string(),
    limit: z.number(),
    count: z.number(),
    refusals: z.array(RefusalRowSchema),
    sessions: z.array(z.string()),
    commentedAt: z.string().optional(),
    commentedOn: z.string().optional(),
});
const StagedAnswerSchema = z.object({
    phase: z.union([z.number(), z.string()]).optional(),
    question: z.string(),
    answer: z.string(),
});
export const RunManifestSchema = z.object({
    version: z.literal(1),
    runId: z.string(),
    project: z.string(),
    created: z.string(),
    phases: z.array(ManifestPhaseSchema),
    ceiling: z
        .object({ tokens: z.number().optional(), usd: z.number().optional() })
        .nullable(),
    pushAuth: z.object({
        granted: z.boolean(),
        scope: z.literal("manifest-phases"),
        grantedAt: z.string().optional(),
    }),
    answers: z.array(StagedAnswerSchema).optional(),
    status: z.enum(["staged", "running", "complete", "stopped"]),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    currentPhase: z.number().optional(),
    stop: RunStopSchema.optional(),
});
// Internals
/** Reads and validates the manifest file at `path`; null when absent. */
function readManifestFile(path) {
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
        throw new CairnError("HANDOFF_INVALID", `run manifest at ${path} is not valid JSON: ${e}`, "inspect or discard ~/.cairn/runs/…");
    }
    const result = RunManifestSchema.safeParse(parsed);
    if (!result.success) {
        throw new CairnError("HANDOFF_INVALID", `run manifest at ${path} failed schema validation: ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "inspect or discard ~/.cairn/runs/…");
    }
    return result.data;
}
/** True for a manifest the circuit breaker froze (#358). */
export function isFrozenByBreaker(state) {
    return state?.status === "stopped" && state.stop?.reason === "breaker";
}
/** The typed refusal every move on a frozen run gets (#358), with the way it ends. */
export function runFrozenError(state) {
    const stop = state.stop;
    return new CairnError("RUN_FROZEN", `batch run '${state.runId}' is frozen — the circuit breaker stopped it after ` +
        `${stop?.count ?? "repeated"} guard refusals (limit ${stop?.limit ?? "?"})`, "stop working this run: claim, close and push are refused for it. Wrap up — " +
        "run_manifest read shows the refusals in its stop block for the run report — and leave " +
        "re-staging to the owner (/cairn:auto --batch, a new run id)");
}
/**
 * Atomic write — tmp then rename, continuity's handoff writer pattern.
 *
 * The manifest has a second writer (#358): the breaker, in a PreToolUse
 * hook, can freeze it between this process's read and its write. So the
 * file is read again just before the rename, and a freeze found there is
 * never clobbered by a state that isn't one -- RUN_FROZEN instead. That
 * narrows the lost-update window to the gap between this read and the
 * rename; a freeze still lost there is re-made by the next refusal, whose
 * count is still past the limit (see breaker.mjs).
 */
function writeManifestFile(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    let onDisk = null;
    try {
        onDisk = readManifestFile(path);
    }
    catch {
        onDisk = null; // a corrupt file is no freeze; the write replaces it as before
    }
    if (onDisk && isFrozenByBreaker(onDisk) && !isFrozenByBreaker(state))
        throw runFrozenError(onDisk);
    // pid + random suffix, never a fixed name: two writers never share a tmp
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, path);
}
/** Loads the manifest for a run, guarding against sanitize collisions the
 * same way the budget ledger does. Throws NOT_FOUND when absent. */
function loadManifest(projectDir, runId, baseDir) {
    const path = runManifestPath(projectDir, runId, baseDir);
    const state = readManifestFile(path);
    if (!state) {
        throw new CairnError("NOT_FOUND", `no run manifest for run '${runId}'`, "stage the run first (auto --batch writes the manifest at the staging gate)");
    }
    if (state.runId !== runId) {
        throw new CairnError("HANDOFF_INVALID", `manifest at ${path} belongs to run '${state.runId}', not '${runId}'`, "pick a runId that differs in more than punctuation");
    }
    return { path, state };
}
// API
/**
 * Writes a fresh manifest at staging time. One manifest per run — an
 * existing manifest for this runId throws instead of being overwritten
 * (re-staging a run means a new runId; history never gets clobbered).
 * pushAuth always starts granted:false — only grantPushAuth() can flip it.
 *
 * :param projectDir: the project the run belongs to
 * :returns the manifest state as written
 */
export function createRunManifest(projectDir, opts) {
    if (!opts.runId || !opts.runId.trim()) {
        throw new CairnError("HANDOFF_INVALID", "runId must be a non-empty string");
    }
    if (!opts.phases.length) {
        throw new CairnError("PRECONDITION_FAILED", `run '${opts.runId}' has no phases — nothing to stage`, "pick at least one phase (--phases) or widen the budget");
    }
    const baseDir = opts.baseDir ?? join(homedir(), ".cairn");
    const path = runManifestPath(projectDir, opts.runId, baseDir);
    const existing = readManifestFile(path);
    if (existing) {
        throw new CairnError("PRECONDITION_FAILED", `a manifest for run '${existing.runId}' already exists at ${path}`, "one manifest per run — pick a new runId to re-stage");
    }
    const state = {
        version: 1,
        runId: opts.runId,
        project: basename(resolve(projectDir)),
        created: opts.createdAt ?? new Date().toISOString(),
        phases: opts.phases,
        ceiling: opts.ceiling ?? null,
        pushAuth: { granted: false, scope: "manifest-phases" },
        ...(opts.answers !== undefined ? { answers: opts.answers } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        status: "staged",
    };
    writeManifestFile(path, state);
    return state;
}
/**
 * Reads a run's manifest without mutating anything — the executor's (and
 * status displays') view. Throws NOT_FOUND when the run was never staged.
 */
export function readRunManifest(projectDir, runId, baseDir) {
    const base = baseDir ?? join(homedir(), ".cairn");
    return loadManifest(projectDir, runId, base).state;
}
/**
 * Reads the manifest AND says where it lives. The run report (#134) writes
 * beside the manifest file, so the read carries the real resolved path —
 * the agent never re-derives hashed filenames from naming conventions.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to read
 * :returns the manifest state plus its absolute file path
 */
export function readRunManifestWithPath(projectDir, runId, baseDir) {
    const base = baseDir ?? join(homedir(), ".cairn");
    const { path, state } = loadManifest(projectDir, runId, base);
    return { ...state, path };
}
/**
 * Records the user's explicit push pre-authorization from the staging gate.
 * Only callable while the run is still 'staged' — authority is granted at
 * the front door or not at all, never mid-run.
 */
export function grantPushAuth(projectDir, runId, opts) {
    const base = opts?.baseDir ?? join(homedir(), ".cairn");
    const { path, state } = loadManifest(projectDir, runId, base);
    if (isFrozenByBreaker(state))
        throw runFrozenError(state);
    if (state.status !== "staged") {
        throw new CairnError("PRECONDITION_FAILED", `run '${runId}' is '${state.status}' — push authorization is granted at staging only`, "stage a new run to grant push authority");
    }
    state.pushAuth = {
        granted: true,
        scope: "manifest-phases",
        grantedAt: opts?.grantedAt ?? new Date().toISOString(),
    };
    writeManifestFile(path, state);
    return state;
}
/**
 * Advances the run's status along the legal lifecycle
 * (staged → running → complete|stopped; staged → stopped for a run
 * abandoned before start). Any other move throws. A run the breaker froze
 * (#358) is already stopped: stopping it again -- auto's wrap -- is a
 * no-op, and any other move is RUN_FROZEN.
 */
export function setRunStatus(projectDir, runId, status, baseDir) {
    const base = baseDir ?? join(homedir(), ".cairn");
    const { path, state } = loadManifest(projectDir, runId, base);
    if (isFrozenByBreaker(state)) {
        if (status === "stopped")
            return state;
        throw runFrozenError(state);
    }
    if (!STATUS_TRANSITIONS[state.status].includes(status)) {
        throw new CairnError("PRECONDITION_FAILED", `run '${runId}' cannot move '${state.status}' → '${status}'`, `legal moves from '${state.status}': ${STATUS_TRANSITIONS[state.status].join(", ") || "(none — terminal)"}`);
    }
    state.status = status;
    writeManifestFile(path, state);
    return state;
}
/**
 * Marks which manifest phase is in flight (#260) — auto calls it at each
 * phase start, and the run guard honours push authority only while it
 * names one of the manifest's phases. Running runs only, the phase must be
 * in the manifest, and it only moves forward in manifest order: re-marking
 * the current phase (a resumed run) is a no-op, an earlier one throws.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to advance
 * :param phase: a phases[].number from this manifest
 * :returns the manifest state as written
 */
export function setCurrentPhase(projectDir, runId, phase, baseDir) {
    const base = baseDir ?? join(homedir(), ".cairn");
    const { path, state } = loadManifest(projectDir, runId, base);
    if (isFrozenByBreaker(state))
        throw runFrozenError(state);
    if (state.status !== "running") {
        throw new CairnError("PRECONDITION_FAILED", `run '${runId}' is '${state.status}' — only a running run has a phase in flight`, "set_status running first; a stopped or complete run starts no phase");
    }
    const order = state.phases.map((p) => p.number);
    const at = order.indexOf(phase);
    if (at < 0) {
        throw new CairnError("PRECONDITION_FAILED", `phase ${phase} is not in run '${runId}' — its manifest stages ${order.join(", ")}`, "a run only ever works the phases approved at staging");
    }
    if (state.currentPhase !== undefined) {
        const was = order.indexOf(state.currentPhase);
        if (at === was)
            return state; // a resumed run re-marking where it was
        if (at < was) {
            throw new CairnError("PRECONDITION_FAILED", `run '${runId}' is on phase ${state.currentPhase} — phase ${phase} comes before it`, "the phase in flight only moves forward in manifest order");
        }
    }
    state.currentPhase = phase;
    writeManifestFile(path, state);
    return state;
}
/**
 * Every valid manifest for a project, newest staged first (#358) -- what
 * the outlook board reads to say a project's latest run is frozen. A file
 * that fails to read or validate is skipped: the board decorates, it never
 * fails on a bad manifest.
 *
 * :param projectDir: the project the runs belong to
 * :returns manifest states, sorted by `created`, newest first
 */
export function listRunManifests(projectDir, baseDir) {
    const base = baseDir ?? join(homedir(), ".cairn");
    migrateRepositoryState(projectDir, base);
    const entries = runFilesFor(projectDir, join(base, "runs"));
    const out = [];
    for (const file of entries) {
        try {
            const state = readManifestFile(join(base, "runs", file));
            if (state)
                out.push(state);
        }
        catch {
            // invalid or unreadable -- not a run the board can describe
        }
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
}
/**
 * The project's manifest file names in `dir`: every `<projectKey>-*.json`,
 * then any `<worktreeKey>-*.json` the one-shot move left behind whose run has
 * no project-key twin (the old-name read fallback, #362).
 */
function runFilesFor(projectDir, dir) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const files = [];
    const seen = new Set();
    for (const prefix of [`${projectKey(projectDir)}-`, `${worktreeKey(projectDir)}-`]) {
        for (const name of names) {
            if (!name.startsWith(prefix) || !name.endsWith(".json"))
                continue;
            const run = name.slice(prefix.length);
            if (seen.has(run))
                continue;
            seen.add(run);
            files.push(name);
        }
    }
    return files;
}
/**
 * Records that the one plain-language comment a freeze owes was posted
 * (#358), and on which issue. The comment is the server's -- hooks have no
 * tracker access -- and goes out at most once per freeze: a manifest that
 * already says commentedAt is left as it is.
 *
 * :param on: the issue the comment went to
 * :returns the manifest state as written (or as found, already commented)
 */
export function markFreezeCommented(projectDir, runId, opts) {
    const base = opts.baseDir ?? join(homedir(), ".cairn");
    const { path, state } = loadManifest(projectDir, runId, base);
    if (!isFrozenByBreaker(state) || !state.stop || state.stop.commentedAt)
        return state;
    state.stop = { ...state.stop, commentedAt: opts.at ?? new Date().toISOString(), commentedOn: opts.on };
    writeManifestFile(path, state);
    return state;
}
/**
 * The tracker comment a freeze owes (#358), in plain language: what froze
 * the run, the refusals that tripped it, and the owner's way back. Reasons
 * and effects are the guards' fixed text, so no command or path reaches
 * the tracker.
 */
export function composeFreezeComment(state) {
    const stop = state.stop;
    const rows = (stop?.refusals ?? []).map((r) => `- ${r.ts} — the ${r.guard} guard refused ${r.reason} (${r.effect})`);
    return [
        `Batch run ${state.runId} was frozen by cairn's circuit breaker: its guards refused ` +
            `${stop?.count ?? "repeated"} actions since the run started (the limit is ${stop?.limit ?? "?"}), ` +
            "so it stopped instead of pressing on.",
        "",
        "The last refusals:",
        ...rows,
        "",
        "Nothing in this run claims, closes or pushes from here. Owner: review what it kept reaching for, " +
            "fix the plan, then re-stage the remaining phases with /cairn:auto --batch.",
    ].join("\n");
}
