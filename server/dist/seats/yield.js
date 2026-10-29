/**
 * Purpose: the per-seat yield store — dispatch that prunes itself with
 * evidence. One versioned JSON file per project under ~/.cairn/yield/
 * (outside the repo, budget-ledger's conventions: injectable base dir,
 * per-machine path hashing, atomic tmp+rename writes, zod-validated
 * versioned schema). Per seat it counts dispatched / findingsRaised /
 * findingsSurvived; selection (signals.ts) consults these ONLY in auto
 * dial and gates a seat whose evidence says it isn't earning its pass.
 *
 * Posture on corruption: yield stats are advisory EVIDENCE, not config —
 * a corrupt file loads as a fresh empty state with a note, never a throw
 * (missing evidence means no pruning; it must never break a review).
 * That's a deliberate divergence from budget-ledger, where a corrupt
 * ledger guards real money and fails loud.
 *
 * removeWhen: a full panel on every diff costs little enough that gating
 * saves nothing worth the risk of muting a seat — the dial then stays at
 * off and this store has no reader (ADR 0011).
 * Author(s): John Reed
 */
// Imports
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
import { repositoryPath } from "../planning/run-manifest.js";
// Constants — the gating thresholds (consumed by signals.ts's selectSeats)
/** Minimum dispatches before yield evidence may gate a seat — under this,
 * the sample is too small to prune on. */
export const YIELD_MIN_DISPATCHES = 10;
/** The gate line: a seat whose survival rate (surviving findings per
 * dispatch) sits UNDER this, with enough history, gets gated in auto
 * dial — fewer than one surviving finding per ten dispatches is the
 * evidence it isn't earning its pass. */
export const YIELD_GATE_RATE = 0.1;
const CounterSchema = z.number().int().min(0);
const YieldCountersSchema = z.object({
    dispatched: CounterSchema,
    findingsRaised: CounterSchema,
    findingsSurvived: CounterSchema,
});
export const YieldStateSchema = z.object({
    version: z.literal(1),
    project: z.string(),
    seats: z.record(z.string(), YieldCountersSchema),
});
// Paths
/** ~/.cairn/yield/<projectKey>.json — one store per repository (#362),
 * outside the repo. baseDir injectable for tests (budget-ledger convention). */
export function yieldStatePath(projectDir, baseDir = join(homedir(), ".cairn")) {
    return repositoryPath(projectDir, "yield", ".json", baseDir);
}
// Internals
function freshState(projectDir) {
    return {
        version: 1,
        project: basename(resolve(projectDir)),
        seats: {},
    };
}
/** Atomic write — tmp then rename, same as budget-ledger's writer.
 *
 * Concurrency: the store is per repository (#362), so worktrees running at
 * once share it. The rename is atomic and the tmp name is per writer (pid +
 * random, #351), so no write tears or throws -- but load, update, write is a
 * read-modify-write: two sessions recording at the same moment keep the
 * last writer's counts. The yield numbers are an advisory tally, and that
 * loss is accepted rather than locked. */
function writeState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    renameSync(tmp, path);
}
// API
/**
 * Loads the project's yield store. Missing file = fresh empty state.
 * Corrupt or wrong-versioned file = fresh empty state PLUS a note naming
 * the problem — advisory evidence never breaks the caller (see module
 * doc for why this diverges from budget-ledger's fail-loud posture).
 *
 * :param projectDir: project root (keys the per-machine file)
 * :param baseDir: state root override — test seam (default ~/.cairn)
 * :returns: the state plus a note when the file couldn't be trusted
 */
export function loadYield(projectDir, baseDir) {
    const path = yieldStatePath(projectDir, baseDir);
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return { state: freshState(projectDir) };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {
            state: freshState(projectDir),
            note: `yield store at ${path} is not valid JSON — starting fresh (no seat gets yield-gated without evidence)`,
        };
    }
    const result = YieldStateSchema.safeParse(parsed);
    if (!result.success) {
        return {
            state: freshState(projectDir),
            note: `yield store at ${path} failed schema validation — starting fresh (no seat gets yield-gated without evidence)`,
        };
    }
    return { state: result.data };
}
/**
 * Applies one pass's per-seat increments and persists atomically.
 * Load-modify-write against the file on disk; a corrupt existing file is
 * replaced by a fresh state carrying only these deltas (its note surfaces
 * through the return value's `note`).
 *
 * :param projectDir: project root
 * :param deltas: per-seat increments — integers >= 0 only
 * :param baseDir: state root override — test seam (default ~/.cairn)
 * :returns: the persisted state (+ load note when the old file was bad)
 * :raises CairnError: CONFIG_INVALID on a malformed delta
 */
export function recordYield(projectDir, deltas, baseDir) {
    for (const d of deltas) {
        if (!d.seat || !d.seat.trim()) {
            throw new CairnError("CONFIG_INVALID", "yield delta needs a seat name");
        }
        for (const field of ["dispatched", "findingsRaised", "findingsSurvived"]) {
            const v = d[field];
            if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
                throw new CairnError("CONFIG_INVALID", `yield delta for seat '${d.seat}': ${field} must be an integer >= 0, got ${v}`);
            }
        }
    }
    const { state, note } = loadYield(projectDir, baseDir);
    for (const d of deltas) {
        const c = state.seats[d.seat] ?? {
            dispatched: 0,
            findingsRaised: 0,
            findingsSurvived: 0,
        };
        c.dispatched += d.dispatched ?? 0;
        c.findingsRaised += d.findingsRaised ?? 0;
        c.findingsSurvived += d.findingsSurvived ?? 0;
        state.seats[d.seat] = c;
    }
    writeState(yieldStatePath(projectDir, baseDir), state);
    return note ? { state, note } : { state };
}
/**
 * Survival rate — surviving findings per dispatch (the currency the gate
 * judges in). Null when the seat has never been dispatched: no evidence
 * is not the same as zero yield.
 *
 * :param c: one seat's counters
 * :returns: findingsSurvived / dispatched, or null when dispatched is 0
 */
export function yieldRate(c) {
    if (c.dispatched === 0)
        return null;
    return c.findingsSurvived / c.dispatched;
}
