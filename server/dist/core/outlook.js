import { z } from "zod";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { projectStatus } from "../planning/status.js";
import { sessionLandscape } from "../sessions/store.js";
import { metricsSegments } from "./metrics.js";
import { readRegistry } from "./registry.js";
import { readHandoff, writeHandoff, waveNotes, waveNextVerb, } from "./continuity.js";
export const OutlookSnapshotSchema = z.object({
    version: z.literal(1),
    ts: z.string(),
    name: z.string(),
    path: z.string(),
    head: z.string().optional(),
    phases: z.array(z.object({
        number: z.number(),
        name: z.string(),
        planned: z.boolean(),
        verified: z.boolean(),
        issueCount: z.number(),
    })),
    sessions: z.object({
        trace: z.number(), probe: z.number(), draft: z.number(), thread: z.number(),
    }),
    tracker: z.object({
        open: z.number().optional(),
        inProgress: z.number().optional(),
        blocked: z.number().optional(),
        nextVerb: z.string().optional(),
        asOf: z.string().optional(),
    }).optional(),
});
/** Same per-machine hashing scheme as handoffPath/indexDbPath. */
function pathHash(projectDir) {
    const abs = resolve(projectDir);
    const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
    return { base: basename(abs), hash };
}
/** The machine-wide mirror the aggregate reads (never walks repos). */
export function outlookMirrorPath(projectDir, home = homedir()) {
    const { base, hash } = pathHash(projectDir);
    return join(home, ".cairn", "outlook", `${base}-${hash}.json`);
}
/** The in-repo copy -- travels with the project, diffable when committed. */
export function outlookLocalPath(projectDir) {
    return join(resolve(projectDir), ".cairn", "outlook.json");
}
function atomicWrite(path, snapshot) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    renameSync(tmp, path);
}
function readSnapshot(path) {
    if (!existsSync(path))
        return null;
    try {
        const parsed = OutlookSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
        return parsed.success ? parsed.data : null;
    }
    catch {
        return null;
    }
}
function gitHead(projectDir) {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: resolve(projectDir), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        return undefined;
    }
}
/**
 * The tracker block a wave checkpoint composes server-side (#370). The
 * server has no network at emit time, so the counts it "already can"
 * derive are the ones the previous snapshot carried; a project with no
 * prior block gets zeros. asOf is this emit, nextVerb is the resume line.
 */
export function waveTracker(previous, wave, now = new Date().toISOString()) {
    return {
        open: previous?.open ?? 0,
        inProgress: previous?.inProgress ?? 0,
        blocked: previous?.blocked ?? 0,
        nextVerb: waveNextVerb(wave),
        asOf: now,
    };
}
/**
 * Derives a fresh snapshot and dual-writes it (in-repo + machine mirror),
 * both atomic. Mirrors writeHandoff's guards: unregistered projects skip
 * silently (CONFIG_MISSING, returns null), and the previous snapshot's
 * verb-supplied `tracker` block carries forward unless this emit brings a
 * newer one -- the outlook cousin of the handoff's monotonic-richness rule.
 * A `wave` patch composes that newer block itself (waveTracker).
 *
 * Callers treat this as fire-and-forget; the refreshHandoff wrapper (and
 * any other call site) swallows what this throws. The written snapshot
 * comes back for the one caller that reports it (waveCheckpoint).
 */
export function emitOutlook(projectDir, patch, home) {
    try {
        loadConfig(projectDir);
    }
    catch (e) {
        if (e instanceof CairnError && e.code === "CONFIG_MISSING")
            return null;
        throw e;
    }
    const abs = resolve(projectDir);
    const mirror = outlookMirrorPath(projectDir, home);
    const previous = readSnapshot(mirror);
    const status = projectStatus(abs);
    const landscape = sessionLandscape(abs);
    const snapshot = {
        version: 1,
        ts: new Date().toISOString(),
        name: basename(abs),
        path: abs,
        head: gitHead(abs),
        phases: status.phases.map((p) => ({
            number: p.number,
            name: p.name,
            planned: p.hasPlan,
            verified: p.hasVerification,
            issueCount: p.issues.length,
        })),
        sessions: landscape.openByKind,
        tracker: patch?.wave
            ? waveTracker(previous?.tracker, patch.wave)
            : patch?.tracker ?? previous?.tracker,
    };
    atomicWrite(mirror, snapshot);
    atomicWrite(outlookLocalPath(projectDir), snapshot);
    return snapshot;
}
/**
 * The wave fold (#370): one call writes the handoff AND emits the outlook
 * snapshot, both carrying the same run id, so a wave can never be
 * resumable from the handoff yet invisible on the board (or the reverse).
 * The server composes both strings from the one WaveRef; a caller's own
 * notes ride behind the composed line. Source is always "tool" -- a wave
 * dispatch is a tool checkpoint and the wave identity lives in notes.
 *
 * Fail-open on the outlook half: the handoff is the resume path and must
 * land; a broken snapshot never blocks it and comes back as emitted:false
 * with the reason, so the caller reads a measurement, not a claim.
 */
export function waveCheckpoint(projectDir, patch, wave, home) {
    const composed = waveNotes(wave);
    const own = patch.notes?.trim() ?? "";
    const notes = own === "" ? composed : `${composed} — ${own}`;
    writeHandoff(projectDir, { ...patch, notes, source: "tool" });
    const read = readHandoff(projectDir);
    let outlook;
    try {
        const snapshot = emitOutlook(projectDir, { wave }, home);
        outlook = snapshot ? { emitted: true, tracker: snapshot.tracker } : { emitted: false };
    }
    catch (e) {
        outlook = { emitted: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { handoff: read?.handoff ?? null, stale: read?.stale ?? false, outlook };
}
/** Reads a project's mirror snapshot; corrupt or missing reads as null. */
export function readOutlook(projectDir, home) {
    return readSnapshot(outlookMirrorPath(projectDir, home));
}
/** Metrics file for a project -- same basename+hash scheme as the mirror.
 *  This join is WHY the registry keeps absolute paths: the hash alone is
 *  not reversible. */
export function metricsPathFor(projectDir, home = homedir()) {
    const { base, hash } = pathHash(projectDir);
    return join(home, ".cairn", "metrics", `${base}-${hash}.jsonl`);
}
/**
 * Per-project agent spend (#92): rows are cumulative per session, so the
 * total is the sum of each session's LATEST row (cost-report.mjs contract).
 * Missing or corrupt metrics read as zero -- cost is decoration on the
 * board, never a reason a card fails.
 *
 * Segments are read oldest first (#237), so a session that opened in a closed
 * segment and picked up a later row in the live one is REPLACED rather than
 * summed. Reading the live segment alone made the board's spend figure shrink
 * at each rotation, which reads as spend falling rather than as history lost.
 */
export function projectCost(projectDir, home) {
    const path = metricsPathFor(projectDir, home);
    if (!existsSync(path))
        return null;
    const latest = new Map();
    for (const segment of metricsSegments(path)) {
        let raw;
        try {
            raw = readFileSync(segment, "utf8");
        }
        catch {
            continue; // pruned or never written -- not an error
        }
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const row = JSON.parse(line);
                if (!row.session_id)
                    continue;
                latest.set(row.session_id, { cost: row.est_cost_usd ?? 0, kind: row.kind ?? "other" });
            }
            catch { /* skip bad line */ }
        }
    }
    let costUsd = 0;
    const costByKind = {};
    for (const { cost, kind } of latest.values()) {
        costUsd += cost;
        costByKind[kind] = (costByKind[kind] ?? 0) + cost;
    }
    return {
        costUsd: Number(costUsd.toFixed(2)),
        costByKind: Object.fromEntries(Object.entries(costByKind)
            .map(([k, v]) => [k, Number(v.toFixed(2))])),
    };
}
/** The written board (#91) -- machine-level on purpose: an in-repo copy of
 *  the FLEET board would leak every other project's name into whichever repo
 *  committed it. One artifact per machine, shareable by hand. */
export function outlookArtifactPath(home = homedir()) {
    return join(home, ".cairn", "OUTLOOK.md");
}
/** Renders the board as manager-facing markdown -- same data as the cards. */
export function renderOutlookMd(cards, now) {
    const spend = cards.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    const lines = [
        "# Portfolio outlook",
        "",
        `_As of ${now}. ${cards.length} project${cards.length === 1 ? "" : "s"}; `
            + `${cards.filter((c) => c.stale === false).length} current, `
            + `${cards.filter((c) => c.stale === true).length} stale, `
            + `${cards.filter((c) => c.error).length} unreadable.`
            + (spend > 0 ? ` Agent spend ~$${spend.toFixed(2)} (approximate).` : "") + "_",
        "",
    ];
    for (const c of cards) {
        lines.push(`## ${c.name}`);
        lines.push("");
        if (c.error) {
            lines.push(`- status: unavailable — ${c.error}`);
            lines.push("");
            continue;
        }
        const s = c.snapshot;
        const verified = s.phases.filter((p) => p.verified).map((p) => p.number);
        const next = s.phases.find((p) => p.planned && !p.verified);
        lines.push(`- last activity: ${s.ts}${c.stale ? ` — STALE: ${c.staleReason}` : ""}`);
        if (verified.length)
            lines.push(`- verified through phase ${Math.max(...verified)}`);
        if (next)
            lines.push(`- next up: phase ${next.number} (${next.name}, ${next.issueCount} issues)`);
        const open = Object.entries(s.sessions).filter(([, n]) => n > 0)
            .map(([k, n]) => `${n} ${k}`).join(", ");
        if (open)
            lines.push(`- open sessions: ${open}`);
        if (s.tracker) {
            const t = s.tracker;
            const bits = [
                t.open !== undefined ? `${t.open} open` : null,
                t.inProgress !== undefined ? `${t.inProgress} in progress` : null,
                t.blocked !== undefined ? `${t.blocked} blocked` : null,
            ].filter(Boolean).join(", ");
            if (bits)
                lines.push(`- work items: ${bits}${t.asOf ? ` (as of ${t.asOf})` : ""}`);
            if (t.nextVerb)
                lines.push(`- suggested next: ${t.nextVerb}`);
        }
        if (c.costUsd !== undefined) {
            const kinds = Object.entries(c.costByKind ?? {})
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ");
            lines.push(`- agent spend: ~$${c.costUsd.toFixed(2)}${kinds ? ` (${kinds})` : ""} — approximate`);
        }
        lines.push("");
    }
    return lines.join("\n");
}
/**
 * The portfolio aggregate (#89): registry + mirror snapshots ONLY -- never
 * walks the filesystem for repos. Staleness is the card pattern, not a
 * date: the snapshot's recorded HEAD vs the repo's live HEAD. Per-project
 * failures become `{name, error}` cards (workspace_status precedent);
 * one broken project can never take down the board.
 */
export function outlookAggregate(home, opts) {
    const registry = readRegistry(home);
    const projects = [];
    for (const entry of registry.projects) {
        try {
            const snapshot = readOutlook(entry.path, home) ?? undefined;
            const card = {
                name: entry.name, path: entry.path, lastSeen: entry.lastSeen, snapshot,
            };
            const cost = projectCost(entry.path, home);
            if (cost) {
                card.costUsd = cost.costUsd;
                card.costByKind = cost.costByKind;
            }
            if (!snapshot) {
                card.error = "no snapshot yet -- run any cairn verb in this project to emit one";
            }
            else if (snapshot.head !== undefined) {
                // Frontmatter-adjacent data is attacker-influenceable; validate the
                // recorded sha before shelling out (same rule as card staleness).
                if (!/^[0-9a-f]{4,40}$/i.test(snapshot.head)) {
                    card.stale = true;
                    card.staleReason = "snapshot records an invalid commit id";
                }
                else {
                    const live = gitHead(entry.path);
                    if (live !== undefined && live !== snapshot.head) {
                        card.stale = true;
                        card.staleReason = `repo moved since snapshot (${snapshot.head.slice(0, 7)} -> ${live.slice(0, 7)})`;
                    }
                    else {
                        card.stale = false;
                    }
                }
            }
            projects.push(card);
        }
        catch (e) {
            projects.push({
                name: entry.name, path: entry.path, lastSeen: entry.lastSeen,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    if (opts?.artifact) {
        const path = outlookArtifactPath(home);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, renderOutlookMd(projects, new Date().toISOString()));
        renameSync(tmp, path);
        return { projects, artifactPath: path };
    }
    return { projects };
}
