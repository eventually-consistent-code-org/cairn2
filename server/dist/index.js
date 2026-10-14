#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CairnError } from "./errors.js";
import { loadConfig, writeConfigPatch } from "./config.js";
import { auditMemory } from "./memory/audit.js";
import { observationBacklog } from "./memory/observations.js";
import { compactCards, proposeCompaction } from "./memory/compaction.js";
import { ActiveContext } from "./active-context.js";
import { forgetProject, readRegistry, registerProject, } from "./core/registry.js";
import { emitOutlook, outlookAggregate } from "./core/outlook.js";
import { makeTracker } from "./tracker/registry.js";
import { CachedTracker } from "./tracker/cached.js";
import { probeVerdictForError } from "./tracker/probe.js";
import { danglingEdges, effectivePriorities, lineage, readyFrontier, } from "./tracker/graph.js";
import { finalizeMigration, migrateTracker } from "./tracker/migrate.js";
import { makeDocsConnector } from "./docs/registry.js";
import { defaultProjectName, publishTree } from "./docs/publish.js";
import { scaffoldProject, scaffoldPhase, writePlanIssues, readPlanMeta, writePlanMeta, isValidPhaseNumber, parsePhaseDirName, PHASE_NUMBER_ERROR, } from "./planning/artifacts.js";
import { projectStatus } from "./planning/status.js";
import { driftReport, ensurePhase, resolvePhaseParam, } from "./planning/mirror.js";
import { writeShipGateStamp } from "./planning/ship-gate.js";
import { unplannedReport } from "./planning/collab.js";
import { importPhase } from "./planning/import.js";
import { milestoneCreate, milestoneList, milestoneComplete, } from "./planning/milestones.js";
import { resyncReport } from "./planning/resync.js";
import { docsDriftReport } from "./planning/docs-drift.js";
import { distillManifest } from "./planning/distill-manifest.js";
import { estimatePhaseTokens, issueEstimate, metricsSegments } from "./planning/token-estimate.js";
import { clearClaim, readClaim, recordClaim, writeReceipt, } from "./planning/close-receipt.js";
import { measureAtClose, measuredText } from "./planning/duration.js";
import { snapshotNote, trackerDelta } from "./planning/tracker-delta.js";
import { MemoryIndex, indexDbPath, } from "./memory/index-store.js";
import { probeNativeBindings, } from "./memory/native.js";
import { createCard, listCards, readCard, updateCard, } from "./memory/cards.js";
import { checkCardStaleness } from "./memory/staleness.js";
import { readHandoff, writeHandoff, clearHandoff, metricsPath, validateArtifacts, } from "./core/continuity.js";
import { summarise, sessionSpans } from "./context/meter.js";
import { thresholdDrift } from "./context/threshold.js";
import { registerPlanResources } from "./core/resources.js";
import { installedVersions } from "./core/versions.js";
import { appendLedger } from "./planning/ledger.js";
import { checkBudget, openRunLedger, recordBoundary, refreshSpend, } from "./planning/budget-ledger.js";
import { createRunManifest, grantPushAuth, readRunManifestWithPath, setCurrentPhase, setRunStatus, } from "./planning/run-manifest.js";
import { writeBanner, bannerStats } from "./memory/banner.js";
import { startTrace, appendTrace, listTraces, closeTrace, } from "./trace/store.js";
import { KIND_SPECS, appendSession, closeSession, sessionLandscape, startSession, } from "./sessions/store.js";
import { planCheck } from "./planning/check.js";
import { writeAuditRecord } from "./audit/record.js";
import { mapGet, mapQuery, mapSet, } from "./map/store.js";
import { findWorkspace, resolveProjectDir, setFocus, } from "./workspace/context.js";
import { boardGet, boardUpdate } from "./workspace/board.js";
import { PROVIDERS, peerList, peerRun } from "./peers/run.js";
import { loadRoster } from "./seats/roster.js";
import { VERDICTS, runStart, runAbandon, runStatus, runClose, recordPeerOutput, recordFindings, recordVerdict, } from "./peers/state.js";
import { parseSections, flipSection, } from "./research/sections.js";
// Widened (CRN-26): canonical three or a backend-defined custom state name.
const StateEnum = z.string().min(1);
const HandoffSourceEnum = z.enum([
    "tool",
    "posttooluse",
    "precompact",
    "waypoint",
]);
// Phase numbers are widened to accept decimals (integers 1..99, or exactly
// one fractional digit .1-.9 with integer part 1..98 -- lets a phase slot in
// (1.5) between 1 and 2 without renumbering the roadmap). Deliberately NOT a
// Zod .refine() here: MCP SDK schema rejection happens before wrap() ever
// runs, so a refine failure surfaces as a raw SDK -32602 string, never the
// structured {code, message, nextAction} envelope every other CONFIG_INVALID
// case produces. plan_scaffold_phase/plan_phase_ensure let a bare z.number()
// through and rely on phaseDirName/ensurePhase (both call isValidPhaseNumber
// from planning/artifacts.ts) to throw a genuine CairnError, which wrap()
// converts correctly. continuity_checkpoint has no such downstream guard
// (writeHandoff doesn't validate), so its handler checks explicitly below.
const HandoffPhaseRefSchema = z.object({
    number: z.number(),
    slug: z.string(),
});
// Shared handler-level guard for every plain-number phase param above (CRN-40:
// plan_check's phase filter, mem_index/mem_search's phase, mem_card_create/
// mem_card_list/mem_card_recall's scopePhase, context_set's phase all
// converge on this instead of each hand-rolling the same isValidPhaseNumber
// check). null/undefined pass through untouched -- context_set relies on
// null surviving here to still mean "clear the field".
const assertValidPhase = (n) => {
    if (n !== null && n !== undefined && !isValidPhaseNumber(n)) {
        throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(n));
    }
};
// Zod mirrors of map/store.ts's NodeType/EdgeType/MapNode/MapEdge -- kept in
// sync by hand (the store module owns the types; this is just the MCP-layer
// schema for them, same duplication tradeoff as the mem_timeline helpers above).
const NodeTypeEnum = z.enum(["module", "phase", "issue", "decision", "person"]);
const EdgeTypeEnum = z.enum(["depends-on", "implements", "decided-in", "owns"]);
const NodeSchema = z.object({
    type: NodeTypeEnum,
    label: z.string(),
    detail: z.string().optional(),
});
const EdgeSchema = z.object({
    from: z.string(),
    to: z.string(),
    type: EdgeTypeEnum,
});
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
// mem_timeline support -- title/cost derivation mirrors memory/banner.ts's private
// helpers (duplicated rather than exported to keep this task's footprint to the
// files it's scoped to).
function timelineCardTitle(body) {
    const firstLine = (body.split("\n")[0] ?? "").trim();
    return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}
function timelineCardCost(body) {
    return Math.ceil(body.length / 4);
}
const timelineCmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Cards carry a day-precision `created` string; chunks carry a full ISO `createdAt`
// string. Comparing them as plain strings is the "day-precision caveat" the tool
// description calls out: same-day chunks sort after same-day cards (a day string
// is a lexicographic prefix of, and therefore less than, any timestamp on that same
// day). Same-day cards are true ties, so they tie-break on id.
const timelineSortKey = (item) => "created" in item ? [item.created, item.id] : [item.createdAt, item.source];
const timelineMergeSort = (items) => [...items].sort((a, b) => {
    const [ka, sa] = timelineSortKey(a);
    const [kb, sb] = timelineSortKey(b);
    return ka === kb ? timelineCmp(sa, sb) : timelineCmp(ka, kb);
});
export function buildServer(deps) {
    const server = new McpServer({ name: "cairn", version: VERSION });
    const now = deps.now ?? (() => new Date());
    // Workspace resolution: the injected projectDir is the LAUNCH dir, fixed for the
    // server's lifetime. Every tool call resolves its effective project dir
    // through dir() -- workspace focus redirects it, no workspace (or no focus)
    // falls through to the launch dir byte-identically (single-project compat).
    const launchDir = deps.projectDir;
    const dir = () => resolveProjectDir(launchDir);
    // Per-dir memos -- focus can move between members mid-session, so trackers,
    // memory indexes, and active context all key off the resolved dir, never a
    // build-time singleton. A test-injected tracker binds to the launch dir.
    const trackers = new Map();
    if (deps.tracker)
        trackers.set(launchDir, deps.tracker);
    // Accepts an optional pre-resolved dir -- handlers that already snapshotted
    // `dir()` once (to survive a mid-call workspace_focus flip) pass it through
    // here instead of letting this resolve dir() again on its own.
    const getTracker = async (dOverride) => {
        const d = dOverride ?? dir();
        let t = trackers.get(d);
        if (!t) {
            t = new CachedTracker(await makeTracker(loadConfig(d), d));
            trackers.set(d, t);
        }
        return t;
    };
    // Docs connectors memo per resolved dir, same lifecycle as trackers.
    const docsConnectors = new Map();
    if (deps.docsConnector)
        docsConnectors.set(launchDir, deps.docsConnector);
    const getDocsConnector = async (dOverride) => {
        const d = dOverride ?? dir();
        let c = docsConnectors.get(d);
        if (!c) {
            c = await makeDocsConnector(loadConfig(d));
            docsConnectors.set(d, c);
        }
        return c;
    };
    const getCtx = (d = dir()) => new ActiveContext(d);
    const ok = (value) => ({
        content: [{ type: "text", text: JSON.stringify(value) }],
    });
    const wrap = (fn) => async (args) => {
        try {
            return ok(await fn(args));
        }
        catch (e) {
            const body = e instanceof CairnError
                ? { code: e.code, message: e.message, nextAction: e.nextAction }
                : { code: "TRACKER_DOWN", message: String(e) };
            return { ...ok(body), isError: true };
        }
    };
    // Best-effort handoff refresh for the write-through points below. Continuity
    // is a hint, never authority (trust order: tracker + git > ledger > handoff)
    // -- so a refresh failure (unwritable ~/.cairn/handoff, corrupt file, etc.)
    // must never fail the primary tool call that triggered it.
    const refreshHandoff = (patch, d = dir()) => {
        try {
            writeHandoff(d, patch);
        }
        catch {
            // swallowed by design -- see comment above.
        }
        // Outlook snapshot rides the same write-through points (#88): one call
        // here covers every refresh site, same swallow-by-design contract.
        try {
            emitOutlook(d);
        }
        catch {
            // swallowed by design -- see comment above.
        }
    };
    // Resolves a phase number to the {number, slug} shape the handoff wants, by
    // matching against locally scaffolded phase dirs (NN-slug). Returns
    // undefined when the phase hasn't been scaffolded locally -- best-effort,
    // same spirit as the rest of write-through refresh.
    const phaseHandoffRef = (number, d = dir()) => {
        const match = projectStatus(d).phases.find((p) => p.number === number);
        return match
            ? { number, slug: parsePhaseDirName(match.dir)?.slug ?? match.dir }
            : undefined;
    };
    // Reads every metrics segment for this project (the live one plus any
    // closed, dated ones) and parses each line to a raw row. No collapse here
    // -- summarise() and sessionSpans() each need the latest-per-session rule
    // applied their own way, and sessionSpans additionally needs every row's
    // timestamp, not just the winner's.
    const readMetricsRows = (projectDir) => {
        const rows = [];
        for (const segment of metricsSegments(metricsPath(projectDir))) {
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
                    rows.push(JSON.parse(line));
                }
                catch {
                    // corrupt line -- skip, never guess
                }
            }
        }
        return rows;
    };
    /**
     * Rent rollup for this project. Reads the metrics log the Stop hook writes;
     * returns zeros rather than throwing when no session has been recorded yet,
     * because an empty meter is a true answer, not an error.
     */
    const contextMeterReport = (projectDir) => {
        const rows = readMetricsRows(projectDir);
        return { ...summarise(rows), spans: sessionSpans(rows).length };
    };
    server.registerTool("context_get", {
        description: "Get the active cairn context (phase, issue)",
        inputSchema: z.object({}),
    }, wrap(() => getCtx().get()));
    server.registerTool("context_set", {
        description: "Set/clear active cairn context fields (null clears)",
        inputSchema: z.object({
            phase: z.number().nullable().optional(),
            issueId: z.string().nullable().optional(),
        }),
    }, wrap((a) => {
        // CRN-40: reject an invalid phase number (over-precise decimal, etc.)
        // as a structured CONFIG_INVALID before it ever reaches active-context
        // -- null still passes through untouched (that's the clear-the-field
        // signal handled below).
        assertValidPhase(a.phase);
        // Snapshot once -- this handler touches active-context, handoff, and the
        // banner; a workspace_focus flip mid-call must not split those three
        // writes across two different member projects.
        const d = dir();
        const ctx = getCtx(d);
        ctx.set(a);
        const state = ctx.get();
        const patch = {
            source: "tool",
        };
        // Explicit null means "clear this field" -- map it to an own-property `undefined`
        // on the patch so the {...base, ...patch} merge in writeHandoff overwrites the
        // stale value and JSON.stringify drops it, instead of silently omitting the key
        // (which would leave the prior phase/issue in the handoff forever).
        if (a.phase === null) {
            patch.phase = undefined;
        }
        else if (a.phase !== undefined && state.phase !== undefined) {
            const ref = phaseHandoffRef(state.phase, d);
            if (ref)
                patch.phase = ref;
        }
        if (a.issueId === null) {
            patch.issue = undefined;
        }
        else if (a.issueId !== undefined) {
            patch.issue = state.issueId;
        }
        refreshHandoff(patch, d);
        writeBanner(d);
        return state;
    }));
    server.registerTool("context_meter", {
        description: "Context rent rollup: per-turn average, bands, residency, prefix",
        inputSchema: z.object({}),
    }, wrap(() => contextMeterReport(dir())));
    server.registerTool("issue_create", {
        description: "Create an issue in the configured tracker. `phase`: cairn phase " +
            "number ('14', '1.5' -- matches the 'Phase N: <name>' title) or " +
            "tracker phase id ('id:<raw>' if numeric). Estimates " +
            "(story points / original minutes) land in the backend's native " +
            "fields where supported; elsewhere they're skipped and the result " +
            "says so via estimateSkipped",
        inputSchema: z.object({
            title: z.string(),
            body: z.string().optional(),
            labels: z.array(z.string()).optional(),
            phase: z.string().optional(),
            estimatePoints: z.number().positive().optional(),
            estimateMinutes: z.number().int().positive().optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        const { estimatePoints, estimateMinutes, ...input } = a;
        const wantsEstimate = estimatePoints !== undefined || estimateMinutes !== undefined;
        const tracker = await getTracker(d);
        // phase is a cairn phase number (by title) or a raw id (#138, #271)
        const phase = input.phase === undefined
            ? undefined
            : await resolvePhaseParam(tracker, input.phase);
        const estimate = wantsEstimate && tracker.capabilities.hasEstimates
            ? { points: estimatePoints, minutes: estimateMinutes }
            : undefined;
        const result = await tracker.createIssue({ ...input, phase, estimate });
        const { estimateSkipped: partialSkip, ...issue } = result;
        snapshotNote(d, issue);
        // mirrors the worklogError note on issue_close -- a silently dropped
        // estimate reads as a bug, so say why it never reached the backend.
        // Two ways to lose one: the backend has no estimate support at all
        // (capability, known up front), or it supports estimates and still
        // lost half of this one (a Jira site with no story-point field --
        // that verdict is per call, so the adapter reports it, #231).
        const estimateSkipped = wantsEstimate && !tracker.capabilities.hasEstimates
            ? "backend has no estimate support; fold points/minutes into the issue body"
            : partialSkip;
        return { ...issue, ...(estimateSkipped ? { estimateSkipped } : {}) };
    }));
    server.registerTool("issue_get", {
        description: "Fetch one issue",
        inputSchema: z.object({ id: z.string() }),
    }, wrap(async (a) => (await getTracker()).getIssue(a.id)));
    server.registerTool("issue_update", {
        description: "Update an issue (title/body/state/labels/assignee/estimate/phase). " +
            "`phase` re-parents it: cairn phase number ('14', '1.5' -- matches " +
            "the 'Phase N: <name>' title) or tracker phase id ('id:<raw>' if " +
            "numeric); backends that can't re-parent skip " +
            "it and the result says so via phaseSkipped",
        inputSchema: z.object({
            id: z.string(),
            title: z.string().optional(),
            body: z.string().optional(),
            state: StateEnum.optional(),
            labels: z.array(z.string()).optional(),
            assignee: z.string().optional(),
            phase: z.string().optional(),
            estimatePoints: z.number().positive().optional(),
            estimateMinutes: z.number().int().positive().optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        const { id, phase: phaseParam, estimatePoints, estimateMinutes, ...rest } = a;
        const wantsEstimate = estimatePoints !== undefined || estimateMinutes !== undefined;
        const tracker = await getTracker(d);
        const canRephase = tracker.capabilities.hasPhaseReassign;
        // phase is a cairn phase number (by title) or a raw id (#138, #271) —
        // resolved only where the backend can actually re-parent; elsewhere
        // it's dropped with a note (mirrors the estimate degradation).
        const phase = phaseParam === undefined || !canRephase
            ? undefined
            : await resolvePhaseParam(tracker, phaseParam);
        const patch = {
            ...rest,
            ...(phase !== undefined ? { phase } : {}),
            ...(wantsEstimate && tracker.capabilities.hasEstimates
                ? { estimate: { points: estimatePoints, minutes: estimateMinutes } }
                : {}),
        };
        let autoAssigned = false;
        if (patch.state === "in_progress" && patch.assignee === undefined) {
            // best-effort claim attribution — identity failures never block the claim
            try {
                const current = await tracker.getIssue(id);
                if (!current.assignee) {
                    const who = loadConfig(d).user?.handle ?? (await tracker.resolveSelf?.());
                    if (who) {
                        patch.assignee = who;
                        autoAssigned = true;
                    }
                }
            }
            catch {
                /* claim proceeds unassigned */
            }
        }
        const result = await tracker.updateIssue(id, patch);
        const { estimateSkipped: partialSkip, ...issue } = result;
        // Rung two of the duration ladder (#232): the server was there when
        // the issue went in progress, so it keeps the time. First claim
        // wins; recordClaim never throws.
        if (patch.state !== undefined && issue.category === "in_progress") {
            recordClaim(d, id, now().toISOString());
        }
        snapshotNote(d, issue);
        refreshHandoff({ source: "tool", issue: id }, d);
        // mirrors the worklogError note on issue_close -- a silently dropped
        // estimate reads as a bug, so say why it never reached the backend.
        // Same two sources as issue_create: no estimate support at all, or a
        // backend that supports estimates and still lost half of this one.
        const estimateSkipped = wantsEstimate && !tracker.capabilities.hasEstimates
            ? "backend has no estimate support; fold points/minutes into the issue body"
            : partialSkip;
        // same pattern for a phase the backend can't re-parent to -- a
        // silently ignored re-phase bit two live sessions before #142.
        const phaseSkipped = phaseParam !== undefined && !canRephase
            ? "backend can't move an existing issue between phases; recreate the issue in the target phase"
            : undefined;
        return {
            ...issue,
            ...(autoAssigned ? { autoAssigned: true } : {}),
            ...(estimateSkipped ? { estimateSkipped } : {}),
            ...(phaseSkipped ? { phaseSkipped } : {}),
        };
    }));
    const LinkTypeEnum = z.enum([
        "blocks",
        "parent-of",
        "relates-to",
        "supersedes",
    ]);
    const linkCapable = async () => {
        const t = await getTracker(dir());
        if (!t.capabilities.hasDependencies || !t.linkIssues) {
            throw new CairnError("UNSUPPORTED", "this tracker has no dependency links", "issue links need a backend with hasDependencies (e.g. tracker.type: local)");
        }
        return t;
    };
    server.registerTool("issue_link", {
        description: "Link two issues (blocks/parent-of/relates-to/supersedes); " +
            "UNSUPPORTED unless the tracker hasDependencies",
        inputSchema: z.object({
            from: z.string(),
            type: LinkTypeEnum,
            to: z.string(),
        }),
    }, wrap(async (a) => {
        const t = await linkCapable();
        await t.linkIssues(a.from, a.type, a.to);
        return { linked: { from: a.from, type: a.type, to: a.to } };
    }));
    server.registerTool("issue_unlink", {
        description: "Remove an issue link; UNSUPPORTED unless the tracker hasDependencies",
        inputSchema: z.object({
            from: z.string(),
            type: LinkTypeEnum,
            to: z.string(),
        }),
    }, wrap(async (a) => {
        const t = await linkCapable();
        await t.unlinkIssues(a.from, a.type, a.to);
        return { unlinked: { from: a.from, type: a.type, to: a.to } };
    }));
    server.registerTool("issue_links", {
        description: "List issue links — for one issue (either direction) or the whole project",
        inputSchema: z.object({ id: z.string().optional() }),
    }, wrap(async (a) => {
        const t = await linkCapable();
        return { links: await t.listLinks(a.id) };
    }));
    server.registerTool("graph_report", {
        description: "Dependency-graph report: ready frontier (open issues with no open " +
            "blockers), inherited effective priorities, dangling edges, and optionally " +
            "one issue's supersedes lineage. UNSUPPORTED unless the tracker hasDependencies",
        inputSchema: z.object({ lineageOf: z.string().optional() }),
    }, wrap(async (a) => {
        const t = await linkCapable();
        const [issues, links] = await Promise.all([
            t.listIssues(),
            t.listLinks(),
        ]);
        return {
            frontier: readyFrontier(issues, links),
            priorities: effectivePriorities(issues, links),
            dangling: danglingEdges(issues, links),
            ...(a.lineageOf
                ? { lineage: lineage(issues, links, a.lineageOf) }
                : {}),
        };
    }));
    server.registerTool("tracker_migrate", {
        description: "Promote a local-tracker project to a hosted backend: phases, " +
            "issues, comments, worklogs, and links carry over with an id remap and " +
            "provenance backlinks. Source must be tracker.type: local. dryRun reports " +
            "what would migrate without writing anything.",
        inputSchema: z.object({
            targetType: z.enum([
                "github",
                "gitlab",
                "jira",
                "asana",
                "azure-boards",
                "clickup",
                "linear",
            ]),
            targetConfig: z.record(z.string(), z.unknown()),
            dryRun: z.boolean().optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        const cfg = loadConfig(d);
        if (cfg.tracker.type !== "local") {
            throw new CairnError("CONFIG_INVALID", `source tracker is not local (found '${cfg.tracker.type}')`, "tracker_migrate promotes a local store; nothing to do here");
        }
        const src = await getTracker(d);
        if (a.dryRun) {
            const [issues, phases, links] = await Promise.all([
                src.listIssues(),
                src.listPhases(),
                src.listLinks?.() ?? [],
            ]);
            return {
                dryRun: true,
                wouldMigrate: {
                    phases: phases.length,
                    issues: issues.length,
                    links: links.length,
                },
            };
        }
        const dst = await makeTracker({
            ...cfg,
            tracker: { type: a.targetType, config: a.targetConfig },
        }, d);
        const result = await migrateTracker(src, dst);
        const storeDir = resolve(d, cfg.tracker.config.dir ?? ".tracker");
        const recordPath = finalizeMigration(storeDir, a.targetType, result);
        return { ...result, record: recordPath };
    }));
    server.registerTool("issue_close", {
        description: "Close an issue. The server measures the duration itself (claim comment, else the claim " +
            "it saw; result `measured` names the rung) — `timeSpentMinutes` is only the caller's claim, " +
            "kept beside it. Optional typed close evidence `{ command, result }` is posted with the " +
            "measured line as one standardized comment before the close",
        inputSchema: z.object({
            id: z.string(),
            timeSpentMinutes: z.number().int().positive().optional(),
            evidence: z.object({ command: z.string().min(1), result: z.string().min(1) }).optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        const tracker = await getTracker(d);
        // Measured duration (#232), rungs one and two. Comment enumeration is
        // optional on the SPI; a backend without it, or a listing that fails,
        // just starts the ladder one rung down.
        const closedAt = now().toISOString();
        let comments;
        if (tracker.listComments) {
            try {
                comments = await tracker.listComments(a.id);
            }
            catch {
                comments = undefined;
            }
        }
        const { claimedAt, ...measured } = measureAtClose({
            comments, observedClaimAt: readClaim(d, a.id), closedAt,
        });
        const measuredLine = measuredText(measured);
        // Typed close evidence (phase 23): one standard line, same shape on
        // every backend, posted before the state change so the close reads
        // "here is what proved it" in order. The measured duration rides in
        // the same comment -- one comment per close, not two. Best-effort —
        // the close is the state change that matters.
        let evidenceCommented = false;
        try {
            await tracker.commentIssue(a.id, a.evidence
                ? `evidence: \`${a.evidence.command.trim()}\` → ${a.evidence.result.trim()}\n${measuredLine}`
                : measuredLine);
            if (a.evidence)
                evidenceCommented = true;
        }
        catch { /* the ledger line still carries both */ }
        const result = await tracker.closeIssue(a.id);
        clearClaim(d, a.id);
        snapshotNote(d, result);
        let worklogLogged = false;
        let worklogError;
        // The worklog gets the measurement when there is one; the claim is
        // only the fallback. Logging the claim and reading it back later is
        // how the fiction this replaces got recorded in the first place.
        const worklogMinutes = measured.minutes !== null && measured.minutes > 0
            ? measured.minutes : a.timeSpentMinutes;
        if (a.timeSpentMinutes &&
            worklogMinutes &&
            tracker.capabilities.hasWorklog &&
            tracker.logWork) {
            try {
                await tracker.logWork(a.id, worklogMinutes);
                worklogLogged = true;
            }
            catch (e) {
                // worklog is best-effort — the close comment already carries the time
                // line as fallback, so a worklog failure must never fail the close.
                worklogError = e instanceof Error ? e.message : String(e);
            }
        }
        else if (a.timeSpentMinutes) {
            // a silent worklogLogged:false is indistinguishable from a bug — say
            // why the worklog was skipped so the time isn't presumed recorded.
            worklogError = tracker.capabilities.hasWorklog
                ? "tracker advertises hasWorklog but exposes no logWork method"
                : "backend has no worklog support; time recorded in the close comment only";
        }
        // Close receipt (#233): hand the tracker facts this close saw to the
        // ledger append that runs later and holds the commit range. The
        // estimate is read off the issue the close already returned -- no
        // second network call. writeReceipt never throws.
        const worklog = worklogLogged ? "logged"
            : a.timeSpentMinutes === undefined ? "not_requested"
                : tracker.capabilities.hasWorklog && tracker.logWork ? "failed"
                    : "unsupported";
        const est = issueEstimate(result);
        const receiptWritten = writeReceipt(d, {
            version: 1,
            issueId: a.id,
            closedAt,
            claimedAt,
            measured,
            claimedMinutes: a.timeSpentMinutes ?? null,
            estimate: {
                points: est.points, pointsSource: est.pointsSource,
                minutes: est.minutes, minutesSource: est.minutesSource,
            },
            worklog,
        });
        refreshHandoff({ source: "tool", issue: a.id }, d);
        return {
            ...result,
            worklogLogged,
            ...(worklogError ? { worklogError } : {}),
            ...(a.evidence ? { evidenceCommented } : {}),
            measured,
            claimedMinutes: a.timeSpentMinutes ?? null,
            receiptWritten,
        };
    }));
    server.registerTool("issue_list", {
        description: "List issues, optionally by phase/state (phase: cairn phase number " +
            "or tracker phase id, 'id:<raw>' if numeric; state matches the semantic " +
            "category — open/in_progress/closed — or an exact state name)",
        inputSchema: z.object({
            phase: z.string().optional(),
            state: StateEnum.optional(),
        }),
    }, wrap(async (a) => {
        const tracker = await getTracker();
        // phase is a cairn phase number (by title) or a raw id (#138/#142/#271)
        const phase = a.phase === undefined
            ? undefined
            : await resolvePhaseParam(tracker, a.phase);
        return tracker.listIssues({ ...a, phase });
    }));
    server.registerTool("phase_create", {
        description: "Create a phase (milestone/epic/list per backend)",
        inputSchema: z.object({ name: z.string() }),
    }, wrap(async (a) => (await getTracker()).createPhase(a.name)));
    server.registerTool("phase_list", { description: "List phases", inputSchema: z.object({}) }, wrap(async () => (await getTracker()).listPhases()));
    server.registerTool("plan_scaffold_project", {
        description: "Create .cairn/plans/PROJECT.md + roadmap.md (never overwrites)",
        inputSchema: z.object({ name: z.string() }),
    }, wrap((a) => scaffoldProject(dir(), a.name)));
    server.registerTool("plan_scaffold_phase", {
        description: "Create phases/NN-slug/ (or NN.F-slug/ for a decimal insert) with " +
            "CONTEXT.md + PLAN.md (+RESEARCH.md)",
        inputSchema: z.object({
            number: z.number(),
            name: z.string(),
            research: z.boolean().optional(),
        }),
    }, wrap((a) => scaffoldPhase(dir(), a.number, a.name, { research: a.research })));
    server.registerTool("plan_status", {
        description: "Phases, artifact presence, and referenced tracker issues",
        inputSchema: z.object({}),
    }, wrap(() => projectStatus(dir())));
    server.registerTool("plan_phase_ensure", {
        description: "Ensure the tracker has a phase named 'Phase N: <name>' (idempotent)",
        inputSchema: z.object({ number: z.number(), name: z.string() }),
    }, wrap(async (a) => ensurePhase(await getTracker(), a.number, a.name)));
    server.registerTool("plan_drift", {
        description: "Flag plan-referenced issues that are missing or closed-unverified, a stale " +
            "security audit (latest security record written dirty or before code commits since " +
            "its stamp), and work that has gone quiet (an issue held in progress with no tracker " +
            "update and no commit naming it, or a branch with no recent commit); also repairs " +
            "roadmap.md Status cells that still say 'planned' for a phase with VERIFICATION.md, " +
            "reporting each as a 'roadmap-row' item",
        inputSchema: z.object({}),
    }, wrap(async () => {
        const d = dir();
        const report = await driftReport(await getTracker(d), d, { staleDays: loadConfig(d).drift.staleDays });
        // Stamp the result for the run guard's default-branch push gate (#251)
        writeShipGateStamp(d, report.flagged);
        return report;
    }));
    server.registerTool("plan_issues_set", {
        description: "Set the tracker issue ids a phase's PLAN.md advances",
        inputSchema: z.object({
            phaseDir: z.string(),
            issues: z.array(z.string()),
        }),
    }, wrap((a) => {
        const parsed = parsePhaseDirName(a.phaseDir);
        if (!parsed) {
            throw new CairnError("CONFIG_INVALID", `phaseDir must look like 01-name or 01.5-name, got '${a.phaseDir}'`);
        }
        const d = dir();
        const planPath = join(d, ".cairn", "plans", "phases", a.phaseDir, "PLAN.md");
        if (!existsSync(planPath)) {
            throw new CairnError("NOT_FOUND", `no PLAN.md at phaseDir '${a.phaseDir}' — scaffold it first with plan_scaffold_phase`);
        }
        writePlanIssues(d, a.phaseDir, a.issues);
        refreshHandoff({
            source: "tool",
            phase: { number: parsed.number, slug: parsed.slug },
            plan: join(".cairn", "plans", "phases", a.phaseDir, "PLAN.md"),
        }, d);
        return { ok: true };
    }));
    const memIndexes = new Map();
    const getMemIndex = (d = dir()) => {
        const path = indexDbPath(d);
        let idx = memIndexes.get(path);
        if (!idx) {
            idx = new MemoryIndex(path, deps.loadSqlite);
            memIndexes.set(path, idx);
        }
        return idx;
    };
    server.registerTool("mem_index", {
        description: "Index reference material into the searchable memory store (disposable, rebuildable)",
        inputSchema: z.object({
            content: z.string(),
            source: z.string(),
            // CRN-40: widened from .int() -- a decimal phase (1.5) must
            // tag a memory chunk same as an integer one. Deliberately not
            // a Zod .refine() -- see the HandoffPhaseRefSchema comment
            // above for why that produces a raw SDK -32602 instead of a
            // structured CONFIG_INVALID envelope.
            phase: z.number().optional(),
            issueId: z.string().optional(),
            role: z.string().optional(),
        }),
    }, wrap((a) => {
        assertValidPhase(a.phase);
        getMemIndex().index({
            content: a.content,
            source: a.source,
            phase: a.phase ?? null,
            issueId: a.issueId ?? null,
            role: a.role ?? null,
            createdAt: new Date().toISOString(),
        });
        return { ok: true };
    }));
    server.registerTool("mem_search", {
        description: "Full-text search the memory index, optionally scoped to a phase/issue",
        inputSchema: z.object({
            query: z.string(),
            phase: z.number().optional(), // CRN-40: widened from .int()
            issueId: z.string().optional(),
            role: z.string().optional(),
            limit: z.number().int().positive().optional(),
        }),
    }, wrap((a) => {
        assertValidPhase(a.phase);
        return getMemIndex().search(a.query, { phase: a.phase, issueId: a.issueId, role: a.role }, a.limit ?? 10);
    }));
    server.registerTool("mem_stats", {
        description: "Memory index size — chunk count and approximate token usage (capacity guard signal), " +
            "recall-banner token accounting, card-store health for `audit memory`: cards that " +
            "fail to parse (silently skipped by list and recall), broken provenance, near-duplicates, " +
            "and aged low-confidence cards, plus the observation backlog waiting on retro (count, " +
            "oldest-entry age, warn threshold)",
        inputSchema: z.object({}),
    }, wrap(() => {
        const d = dir();
        // Card health reads plain files and git, so it must survive a broken
        // FTS binding — a memory audit that dies when memory is unhealthy is
        // the wrong shape (#171). Index stats degrade to a note instead.
        const cards = auditMemory(d);
        // Same independence rule for the observation backlog (#173): it reads
        // one plain JSONL file, so a broken index never hides the warning.
        const observations = observationBacklog(d);
        let index;
        try {
            index = { ...getMemIndex(d).stats(), ...bannerStats(d) };
        }
        catch (e) {
            index = { indexUnavailable: e.message ?? String(e) };
        }
        return { ...index, cards, observations };
    }));
    server.registerTool("mem_card_create", {
        description: "Write a durable memory card (decision/constraint/gotcha/reference/note) with provenance",
        inputSchema: z.object({
            type: z.enum(["decision", "constraint", "gotcha", "reference", "note"]),
            body: z.string(),
            scopePhase: z.number().optional(), // CRN-40: widened from .int()
            scopeIssue: z.string().optional(),
            scopeRole: z.string().optional(),
            confidence: z.enum(["high", "medium", "low"]).optional(),
            provenance: z
                .array(z.object({ file: z.string(), commit: z.string() }))
                .optional(),
            // #164: flat arrays were silently stripped before -- now a first-class
            // input shape alongside the paired form.
            provenanceFiles: z.array(z.string()).optional(),
            provenanceCommits: z.array(z.string()).optional(),
        }),
    }, wrap((a) => {
        assertValidPhase(a.scopePhase);
        const d = dir();
        const card = createCard(d, a);
        const patch = {
            source: "tool",
        };
        if (a.scopePhase !== undefined) {
            const ref = phaseHandoffRef(a.scopePhase, d);
            if (ref)
                patch.phase = ref;
        }
        if (a.scopeIssue !== undefined)
            patch.issue = a.scopeIssue;
        refreshHandoff(patch, d);
        writeBanner(d);
        return card;
    }));
    server.registerTool("mem_card_list", {
        description: "List memory cards, optionally filtered by phase/issue/role scope",
        inputSchema: z.object({
            scopePhase: z.number().optional(),
            scopeIssue: z.string().optional(),
            scopeRole: z.string().optional(),
        }),
    }, // CRN-40: widened from .int()
    wrap((a) => {
        assertValidPhase(a.scopePhase);
        return listCards(dir(), a);
    }));
    server.registerTool("mem_card_recall", {
        description: "List memory cards with staleness checked against their provenance (the anti-rot check)",
        inputSchema: z.object({
            scopePhase: z.number().optional(),
            scopeIssue: z.string().optional(),
            scopeRole: z.string().optional(),
        }),
    }, // CRN-40: widened from .int()
    wrap((a) => {
        assertValidPhase(a.scopePhase);
        const d = dir();
        return listCards(d, a).map((card) => {
            const provenance = card.frontmatter.provenanceFiles.map((file, i) => ({
                file,
                commit: card.frontmatter.provenanceCommits[i],
            }));
            const check = checkCardStaleness(d, provenance);
            return { ...card, stale: check.stale, staleReasons: check.reasons };
        });
    }));
    server.registerTool("mem_card_update", {
        description: "Patch a memory card's frontmatter -- confidence, scopeRole, and/or provenance " +
            "(all optional, at least one required; body and id are immutable)",
        inputSchema: z.object({
            id: z.string(),
            confidence: z.enum(["high", "medium", "low"]).optional(),
            scopeRole: z.string().optional(),
            provenanceFiles: z.array(z.string()).optional(),
            provenanceCommits: z.array(z.string()).optional(),
        }),
    }, 
    // #164: partial patches -- the empty-patch guard lives in updateCard so
    // it surfaces as a structured CONFIG_INVALID, not a raw SDK -32602.
    wrap((a) => {
        const d = dir();
        const card = updateCard(d, a.id, {
            confidence: a.confidence,
            scopeRole: a.scopeRole,
            provenanceFiles: a.provenanceFiles,
            provenanceCommits: a.provenanceCommits,
        });
        writeBanner(d);
        return card;
    }));
    server.registerTool("mem_compact", {
        description: "Retro-gated card compaction (#172) -- the capacity guard's action. 'propose' reports " +
            "the card store's token size against its threshold plus the aged low-confidence cards " +
            "that would be retired, the exact archive body, and the provenance union, without " +
            "touching anything. 'apply' writes ONE dated archive card carrying that union and then " +
            "deletes the ids passed in -- exactly the ids given, never a re-derived batch, so what " +
            "the human approved is what is retired. Card bodies stay immutable: the archive is a " +
            "new card, the retired ones are deleted, never edited.",
        inputSchema: z.object({
            mode: z.enum(["propose", "apply"]),
            // Required for 'apply': the approved batch. Ignored by 'propose'.
            ids: z.array(z.string()).optional(),
            threshold: z.number().int().positive().optional(),
        }),
    }, wrap((a) => {
        const d = dir();
        if (a.mode === "propose")
            return proposeCompaction(d, { threshold: a.threshold });
        if (a.ids === undefined || a.ids.length === 0) {
            throw new CairnError("CONFIG_INVALID", "mode 'apply' needs the approved ids", "run mode 'propose' first and pass the ids it lists under 'retiring'");
        }
        const result = compactCards(d, a.ids);
        // The banner prices and lists cards by id -- a retired card must stop
        // being offered for recall the moment its file is gone.
        writeBanner(d);
        return result;
    }));
    server.registerTool("mem_timeline", {
        description: "Chronological neighbors around an anchor (a memory card id or an index chunk source) -- " +
            'answers "what was happening around this decision?" at index cost. Day-precision caveat: cards ' +
            "carry a day-precision created date while index chunks carry a full ISO timestamp, so entries are " +
            "ordered by whatever precision they actually carry (a same-day chunk timestamp sorts after a " +
            "same-day card); same-day cards tie-break by id.",
        inputSchema: z.object({
            anchor: z.string(),
            before: z.number().int().nonnegative().optional(),
            after: z.number().int().nonnegative().optional(),
        }),
    }, wrap((a) => {
        // Snapshot once -- this handler resolves the dir up to four times
        // (card lookup, chunk lookup, card list, chunk timeline); a mid-call
        // focus flip must not stitch a timeline together from two members.
        const d = dir();
        const before = a.before ?? 3;
        const after = a.after ?? 3;
        let anchorCreatedAt;
        let anchorCardId;
        try {
            const card = readCard(d, a.anchor);
            anchorCreatedAt = card.frontmatter.created;
            anchorCardId = card.id;
        }
        catch {
            const chunkCreatedAt = getMemIndex(d).sourceCreatedAt(a.anchor);
            if (chunkCreatedAt === undefined) {
                throw new CairnError("NOT_FOUND", `no card or index chunk '${a.anchor}'`, "check the id with mem_card_list or the source with mem_search");
            }
            anchorCreatedAt = chunkCreatedAt;
        }
        const isBeforeAnchor = (created, id) => created < anchorCreatedAt ||
            (created === anchorCreatedAt &&
                anchorCardId !== undefined &&
                id < anchorCardId);
        const isAfterAnchor = (created, id) => created > anchorCreatedAt ||
            (created === anchorCreatedAt &&
                anchorCardId !== undefined &&
                id > anchorCardId);
        const cardItems = listCards(d)
            .filter((c) => c.id !== anchorCardId)
            .map((c) => ({
            id: c.id,
            type: c.frontmatter.type,
            title: timelineCardTitle(c.body),
            created: c.frontmatter.created,
            cost: timelineCardCost(c.body),
        }));
        const cardsBefore = cardItems.filter((c) => isBeforeAnchor(c.created, c.id));
        const cardsAfter = cardItems.filter((c) => isAfterAnchor(c.created, c.id));
        const chunkNeighbors = getMemIndex(d).timeline(anchorCreatedAt, before, after);
        const chunksBefore = chunkNeighbors
            .filter((c) => c.createdAt < anchorCreatedAt)
            .map((c) => ({ source: c.source, createdAt: c.createdAt }));
        const chunksAfter = chunkNeighbors
            .filter((c) => c.createdAt > anchorCreatedAt)
            .map((c) => ({ source: c.source, createdAt: c.createdAt }));
        const beforeMerged = before > 0
            ? timelineMergeSort([...cardsBefore, ...chunksBefore]).slice(-before)
            : [];
        const afterMerged = after > 0
            ? timelineMergeSort([...cardsAfter, ...chunksAfter]).slice(0, after)
            : [];
        return [...beforeMerged, ...afterMerged];
    }));
    server.registerTool("plan_unplanned", {
        description: "Tracker issues (non-closed) that no phase's PLAN.md references — work at risk of being missed",
        inputSchema: z.object({}),
    }, wrap(async () => {
        const d = dir();
        return unplannedReport(await getTracker(d), d);
    }));
    server.registerTool("plan_import", {
        description: "Reverse-mirror a tracker phase (by id or name substring) into .cairn/plans/ artifacts",
        inputSchema: z.object({ phaseRef: z.string() }),
    }, wrap(async (a) => {
        const d = dir();
        const result = await importPhase(await getTracker(d), d, a.phaseRef);
        refreshHandoff({
            source: "tool",
            phase: {
                number: result.number,
                slug: parsePhaseDirName(result.dir)?.slug ?? result.dir,
            },
            plan: join(".cairn", "plans", "phases", result.dir, "PLAN.md"),
        }, d);
        return result;
    }));
    server.registerTool("continuity_checkpoint", {
        description: "Write/refresh the session handoff (checkpoint) for this project",
        inputSchema: z.object({
            source: HandoffSourceEnum.optional(),
            phase: HandoffPhaseRefSchema.optional(),
            issue: z.string().optional(),
            plan: z.string().optional(),
            task: z.object({ current: z.string(), title: z.string() }).optional(),
            tasks_completed: z.array(z.string()).optional(),
            tasks_remaining: z.array(z.string()).optional(),
            blockers: z.array(z.string()).optional(),
            decisions_in_flight: z.array(z.string()).optional(),
            uncommitted_files: z.array(z.string()).optional(),
            next_action: z.string().optional(),
            notes: z.string().optional(),
            partial: z.boolean().optional(),
            artifacts: z.object({
                decisions: z.array(z.string()).default([]),
                constraints: z.array(z.string()).default([]),
                rejected: z.array(z.string()).default([]),
                state: z.string().default(""),
                filesTouched: z.array(z.string()).default([]),
                nextSteps: z.array(z.string()).default([]),
                requirements: z.string().default(""),
                skills: z.array(z.string()).default([]),
            }).optional(),
        }),
    }, wrap((a) => {
        // writeHandoff doesn't independently validate -- unlike phaseDirName/
        // ensurePhase, there's no downstream CairnError to catch a bad phase
        // number here, so check explicitly before it ever reaches disk.
        if (a.phase && !isValidPhaseNumber(a.phase.number)) {
            throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(a.phase.number));
        }
        // The abort rule: refuse a degraded checkpoint rather than persist it.
        // Optional overall -- a caller that passes no artifacts gets the old
        // behaviour -- but a caller that passes some must pass enough.
        if (a.artifacts)
            validateArtifacts(a.artifacts);
        const d = dir();
        writeHandoff(d, { ...a, source: a.source ?? "tool" });
        return readHandoff(d);
    }));
    server.registerTool("continuity_get", {
        description: "Read the current session handoff, if any (flags handoffs older than 14 days as stale, never errors on staleness)",
        inputSchema: z.object({}),
    }, wrap(() => readHandoff(dir())));
    server.registerTool("continuity_clear", {
        description: "Delete the session handoff for this project, if any",
        inputSchema: z.object({}),
    }, wrap(() => ({ cleared: clearHandoff(dir()) })));
    server.registerTool("ledger_append", {
        description: "Append a verified-task line to a phase's LEDGER.md (append-only). Requires typed evidence " +
            "`{ command, result }` or an `evidenceWaived` reason (docs/planning-only); neither is refused, " +
            "and verify fails a phase whose lines carry neither. kind \"evidence\" logs evidence with no " +
            "closure claim; one for the same taskRef supersedes a mistaken closure line",
        inputSchema: z.object({
            phaseDir: z.string(),
            taskRef: z.string(),
            summary: z.string(),
            baseCommit: z.string(),
            headCommit: z.string(),
            issueId: z.string(),
            closedDate: z.string(),
            redCommit: z.string().optional(),
            greenCommit: z.string().optional(),
            evidence: z.object({ command: z.string().min(1), result: z.string().min(1) }).optional(),
            evidenceWaived: z.string().min(1).optional(),
            kind: z.enum(["close", "evidence"]).optional(),
            note: z.string().min(1).optional(),
        }),
    }, wrap((a) => {
        const d = dir();
        const { phaseDir, ...entry } = a;
        const result = appendLedger(d, phaseDir, entry);
        const parsed = parsePhaseDirName(phaseDir);
        refreshHandoff({
            source: "tool",
            phase: {
                number: parsed?.number ?? Number(phaseDir.slice(0, 2)),
                slug: parsed?.slug ?? phaseDir.slice(3),
            },
            issue: entry.issueId,
        }, d);
        return result;
    }));
    server.registerTool("budget_check", {
        description: "Spend ledger gate for headless batch runs — re-reads actual spend (latest metrics row per session; "
            + "sessions since the run opened count in full, pre-existing sessions count as the delta past their "
            + "run-open baseline) and answers proceed/stop against the run's ceilings. "
            + "'stop' means START no new phase/wave; in-flight work finishes (bounded overshoot ≤ one wave). "
            + "Pass phase to record an append-only boundary row; omit it for a read-only status poll. "
            + "Wave subagents write no metrics rows — pass agentTokens (integer ≥ 0) at a boundary with the "
            + "completed wave's reported agent token total; it accumulates as the ledger's agent-spend "
            + "component (result exposes sessionTokens + agentTokens = spentTokens). "
            + "Token unit: input+output tokens only, matching token_estimate's ranges — cache read/write "
            + "traffic is excluded from the token count and priced through the USD component instead. "
            + "innerBudgetSuggestion is the inner in-run Workflow budget the executor passes down.",
        inputSchema: z.object({
            runId: z.string(),
            phase: z.union([z.number(), z.string()]).optional(),
            wave: z.union([z.number(), z.string()]).optional(),
            note: z.string().optional(),
            agentTokens: z.number().int().min(0).optional(),
            ceilingTokens: z.number().positive().optional(),
            ceilingUsd: z.number().positive().optional(),
            startedAt: z.string().optional(),
        }),
    }, wrap((a) => {
        const ledger = openRunLedger(dir(), {
            runId: a.runId,
            ceilingTokens: a.ceilingTokens,
            ceilingUsd: a.ceilingUsd,
            startedAt: a.startedAt,
        });
        // phase given -> this is a real boundary: persist the row. Otherwise
        // a status poll: refresh totals in memory, never grow the history.
        if (a.phase !== undefined) {
            return recordBoundary(ledger, {
                phase: a.phase, wave: a.wave, note: a.note,
                agentTokens: a.agentTokens,
            });
        }
        return checkBudget(refreshSpend(ledger));
    }));
    server.registerTool("run_manifest", {
        description: "The run manifest for headless batch runs (#132) — the executor's SOLE source of "
            + "authority, under ~/.cairn/runs/ (never the repo). action 'create' writes one per "
            + "run (pushAuth ALWAYS starts false); 'read' returns it plus its file path (the run "
            + "report writes beside it); 'grant_push' records the staging gate's push "
            + "pre-authorization (REC-5, the manifest's phases only; staged runs only); "
            + "'set_status' moves staged → running → complete|stopped; 'set_phase' marks the "
            + "phase in flight (running, forward-only) — no push without one",
        inputSchema: z.object({
            action: z.enum(["create", "read", "grant_push", "set_status", "set_phase"]),
            runId: z.string(),
            phases: z
                .array(z.object({
                number: z.number(),
                name: z.string(),
                estimate: z.object({
                    low: z.number(),
                    high: z.number(),
                    estUsd: z.object({ low: z.number(), high: z.number() }),
                }),
                waves: z.number().optional(),
            }))
                .optional(),
            ceilingTokens: z.number().positive().optional(),
            ceilingUsd: z.number().positive().optional(),
            answers: z
                .array(z.object({
                phase: z.union([z.number(), z.string()]).optional(),
                question: z.string(),
                answer: z.string(),
            }))
                .optional(),
            status: z.enum(["staged", "running", "complete", "stopped"]).optional(),
            phase: z.number().optional(),
            effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        }),
    }, wrap((a) => {
        const d = dir();
        switch (a.action) {
            case "create": {
                const ceiling = a.ceilingTokens !== undefined || a.ceilingUsd !== undefined
                    ? {
                        ...(a.ceilingTokens !== undefined
                            ? { tokens: a.ceilingTokens } : {}),
                        ...(a.ceilingUsd !== undefined ? { usd: a.ceilingUsd } : {}),
                    }
                    : null;
                return createRunManifest(d, {
                    runId: a.runId,
                    phases: a.phases ?? [],
                    ceiling,
                    answers: a.answers,
                    effort: a.effort,
                });
            }
            case "read":
                // path rides along (#134) -- the run report writes beside the
                // manifest, so the read says exactly where that is.
                return readRunManifestWithPath(d, a.runId);
            case "grant_push":
                return grantPushAuth(d, a.runId);
            case "set_status": {
                if (a.status === undefined) {
                    throw new CairnError("CONFIG_INVALID", "set_status needs a status", "pass status: staged|running|complete|stopped");
                }
                return setRunStatus(d, a.runId, a.status);
            }
            case "set_phase": {
                // #260 -- the run guard ties push authority to the phase in flight
                if (a.phase === undefined) {
                    throw new CairnError("CONFIG_INVALID", "set_phase needs a phase", "pass phase: one of the manifest's phases[].number");
                }
                return setCurrentPhase(d, a.runId, a.phase);
            }
        }
    }));
    server.registerTool("milestone_create", {
        description: "Start the next milestone — native tracker object when the backend supports it; stamps milestone_id into roadmap.md",
        inputSchema: z.object({ name: z.string() }),
    }, wrap(async (a) => {
        const d = dir();
        return milestoneCreate(await getTracker(d), d, a.name);
    }));
    server.registerTool("milestone_list", {
        description: "Current milestone number, archived milestones, and the tracker's native list when supported",
        inputSchema: z.object({}),
    }, wrap(async () => {
        const d = dir();
        return milestoneList(await getTracker(d), d);
    }));
    server.registerTool("milestone_complete", {
        description: "Complete the current milestone: gate on all-phases-verified, close tracker phases, " +
            "release the native milestone when supported, archive phases/ to milestones/vN/, bump roadmap. " +
            "Idempotent — safe to re-run after a partial tracker failure",
        inputSchema: z.object({ summary: z.string() }),
    }, wrap(async (a) => {
        const d = dir();
        return milestoneComplete(await getTracker(d), d, a.summary);
    }));
    server.registerTool("plan_resync", {
        description: "Detect out-of-band commits (covered by no LEDGER.md range) since the last resync marker; " +
            "advances the marker. First run initializes the marker and reports nothing",
        inputSchema: z.object({}),
    }, wrap(() => resyncReport(dir())));
    server.registerTool("plan_tracker_delta", {
        description: "Diff the live tracker against the last-seen snapshot cursor: new issues/phases, " +
            "field edits, external state changes. Peek by default; ack: true advances the cursor. " +
            "First run initializes the cursor and reports nothing",
        inputSchema: z.object({ ack: z.boolean().optional() }),
    }, wrap(async (a) => {
        const d = dir();
        return trackerDelta(d, await getTracker(d), { ack: a.ack });
    }));
    server.registerTool("plan_meta_set", {
        description: "Set wave grouping (wave_N frontmatter) and/or the TDD-eligible task list on a phase's PLAN.md",
        inputSchema: z.object({
            phaseDir: z.string(),
            waves: z.array(z.array(z.string())).optional(),
            tdd: z.array(z.string()).optional(),
        }),
    }, wrap((a) => {
        const parsed = parsePhaseDirName(a.phaseDir);
        if (!parsed) {
            throw new CairnError("CONFIG_INVALID", `phaseDir must look like 01-name or 01.5-name, got '${a.phaseDir}'`);
        }
        const d = dir();
        writePlanMeta(d, a.phaseDir, { waves: a.waves, tdd: a.tdd });
        refreshHandoff({
            source: "tool",
            phase: { number: parsed.number, slug: parsed.slug },
        }, d);
        return { ok: true, ...readPlanMeta(d, a.phaseDir) };
    }));
    server.registerTool("config_get", {
        description: "Read cairn.json as the validated, post-defaults effective config",
        inputSchema: z.object({}),
    }, wrap(() => loadConfig(dir())));
    server.registerTool("config_set", {
        description: "Merge-patch cairn.json (null deletes a key). Validates the merged result before " +
            "writing; refuses secret-looking keys/values — credentials live in env vars",
        inputSchema: z.object({ patch: z.record(z.string(), z.unknown()) }),
    }, wrap((a) => {
        const d = dir();
        const result = writeConfigPatch(d, a.patch);
        // The tracker memo binds an adapter to the config it was built from --
        // a config write may change backend or baseUrl, so drop it and let the
        // next call rebuild. A test-injected tracker is config-independent.
        if (!(deps.tracker && d === launchDir))
            trackers.delete(d);
        if (!(deps.docsConnector && d === launchDir))
            docsConnectors.delete(d);
        return result;
    }));
    // Best-effort probe runner: construction failures (bad adapter type/config,
    // CONFIG_MISSING, an import that fails to load) are exactly as much "the
    // backend isn't reachable right now" as a network error mid-call, so they
    // fold into the same verdict mapping instead of a distinct failure shape.
    const safeProbe = async (fn) => {
        try {
            return await fn();
        }
        catch (e) {
            return probeVerdictForError(e);
        }
    };
    server.registerTool("config_probe", {
        description: "Credential preflight (CRN-48) -- one cheap authenticated call to the configured " +
            "tracker (and docs connector, when configured), each mapped to a specific verdict: " +
            "ok / bad_host / bad_token / missing_scope / rate_limited / down. A probe failure IS " +
            "the result -- this tool never throws for a bad backend. Also reports installed " +
            "versions (#82): running server, plugin cache entry, repo version files, latest npm " +
            "-- with plain-language drift lines when they disagree. Also preflights the " +
            "better-sqlite3 native binding (#108): ok, or broken with the rebuild command",
        inputSchema: z.object({}),
    }, wrap(async () => {
        const d = dir();
        const out = {
            tracker: await safeProbe(async () => {
                const t = await getTracker(d);
                return t.probe ? t.probe() : { verdict: "ok" };
            }),
        };
        const cfg = loadConfig(d);
        if (cfg.docs) {
            out.docs = await safeProbe(async () => {
                const connector = await getDocsConnector(d);
                return connector.probe ? connector.probe() : { verdict: "ok" };
            });
        }
        out.contextEconomy = thresholdDrift(cfg.contextEconomy?.autocompactPct ?? null, process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
        // Installed-version visibility (#82) -- never throws, npm lookup fails
        // soft to "unknown" so an offline probe stays green.
        out.versions = await installedVersions({
            serverVersion: VERSION,
            modulePath: fileURLToPath(import.meta.url),
            projectDir: d,
            fetchLatest: deps.fetchLatestVersion,
        });
        // Native-bindings preflight (#108) -- advisory line, never fails the
        // probe: a fresh plugin cache under a newer node ABI ships no compiled
        // better-sqlite3 binding, and this names the rebuild command before
        // any memory index tool trips over it.
        out.native = probeNativeBindings(deps.loadSqlite);
        return out;
    }));
    server.registerTool("issue_comment", {
        description: "Post a plain-language comment on a tracker issue (management-visible progress note)",
        inputSchema: z.object({ id: z.string(), text: z.string() }),
    }, wrap(async (a) => (await getTracker()).commentIssue(a.id, a.text)));
    const ATTACH_MEDIA_TYPES = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
    };
    server.registerTool("issue_attach", {
        description: "Attach a file (screenshot, render, visual evidence) to a tracker issue. " +
            "UNSUPPORTED on backends without native attachments",
        inputSchema: z.object({
            id: z.string(),
            path: z.string(),
            filename: z.string().optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        const tracker = await getTracker(d);
        if (!tracker.capabilities.hasIssueAttachments || !tracker.attachFile) {
            throw new CairnError("UNSUPPORTED", "this tracker has no attachment support", "attachments need a backend with hasIssueAttachments (jira, local)");
        }
        const abs = resolve(d, a.path);
        let data;
        try {
            data = readFileSync(abs);
        }
        catch {
            throw new CairnError("NOT_FOUND", `no file at ${abs}`, "path resolves against the project directory");
        }
        const filename = a.filename ?? basename(abs);
        const mediaType = ATTACH_MEDIA_TYPES[extname(abs).toLowerCase()];
        return tracker.attachFile(a.id, filename, data, mediaType);
    }));
    server.registerTool("trace_start", {
        description: "Open a persistent debugging session (.cairn/trace/<id>.md). Creates the tracker " +
            "bug issue (label cairn:bug) when no issueId is given. Survives /clear by construction",
        inputSchema: z.object({
            description: z.string(),
            issueId: z.string().optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        let issueId = a.issueId;
        if (!issueId) {
            const issue = await (await getTracker(d)).createIssue({
                title: a.description,
                labels: ["cairn:bug"],
            });
            snapshotNote(d, issue);
            issueId = issue.id;
        }
        const { id } = startTrace(d, a.description, issueId);
        refreshHandoff({ source: "tool", issue: issueId }, d);
        return { id, issue: issueId };
    }));
    server.registerTool("trace_log", {
        description: "Append a typed entry (evidence|hypothesis|test|verdict) to an open trace — append-only",
        inputSchema: z.object({
            id: z.string(),
            kind: z.enum(["evidence", "hypothesis", "test", "verdict"]),
            text: z.string().min(1),
        }),
    }, wrap((a) => {
        const d = dir();
        const out = appendTrace(d, a.id, a.kind, a.text);
        refreshHandoff({ source: "tool" }, d);
        return out;
    }));
    server.registerTool("trace_list", {
        description: "List trace sessions (open and/or resolved) with entry counts",
        inputSchema: z.object({
            status: z.enum(["open", "resolved"]).optional(),
        }),
    }, wrap((a) => listTraces(dir(), a.status)));
    server.registerTool("trace_close", {
        description: "Resolve a trace: requires >=1 evidence entry, >=1 test entry (the first test is the repro: " +
            "command + observed failing output), and a verdict entry; archives the session, comments the " +
            "resolution plus the repro on the bug issue and closes it",
        inputSchema: z.object({ id: z.string(), resolution: z.string() }),
    }, wrap(async (a) => {
        const d = dir();
        const out = closeTrace(d, a.id, a.resolution);
        let issueClosed = false;
        if (out.issue) {
            const tracker = await getTracker(d);
            try {
                // The repro rides the close: a bug's typed evidence is the failure
                // someone actually reproduced, not the fix's description.
                await tracker.commentIssue(out.issue, `Resolved: ${a.resolution}\n\nReproduced by: ${out.repro}`);
            }
            catch {
                // comment is best-effort mirror; close is the state change that matters
            }
            const closed = await tracker.closeIssue(out.issue);
            snapshotNote(d, closed);
            issueClosed = true;
        }
        return { ...out, issueClosed };
    }));
    const registerSessionTools = (kind, label) => {
        const spec = KIND_SPECS[kind];
        server.registerTool(`${kind}_start`, {
            description: `Open a persistent ${kind} session (.cairn/${kind}/<id>.md). Creates the tracker ` +
                `issue (label ${label}) when no issueId is given. Survives /clear by construction`,
            inputSchema: z.object({
                description: z.string(),
                issueId: z.string().optional(),
            }),
        }, wrap(async (a) => {
            const d = dir();
            let issueId = a.issueId;
            if (!issueId) {
                const issue = await (await getTracker(d)).createIssue({
                    title: a.description,
                    labels: [label],
                });
                snapshotNote(d, issue);
                issueId = issue.id;
            }
            const active = getCtx(d).get();
            const phase = active.phase !== undefined ? String(active.phase) : undefined;
            const { id } = startSession(d, kind, a.description, issueId, phase);
            refreshHandoff({ source: "tool", issue: issueId }, d);
            return { id, issue: issueId };
        }));
        server.registerTool(`${kind}_log`, {
            description: `Append a typed entry (${spec.entryKinds.join("|")}) to an open ${kind} session — append-only`,
            inputSchema: z.object({
                id: z.string(),
                kind: z.enum(spec.entryKinds),
                text: z.string().min(1),
            }),
        }, wrap((a) => {
            const d = dir();
            const out = appendSession(d, kind, a.id, a.kind, a.text);
            refreshHandoff({ source: "tool" }, d);
            return out;
        }));
        server.registerTool(`${kind}_close`, {
            description: `Resolve a ${kind} session: requires a ${spec.closeGate} entry; archives it, comments ` +
                `the resolution on the issue and closes it`,
            inputSchema: z.object({ id: z.string(), resolution: z.string() }),
        }, wrap(async (a) => {
            const d = dir();
            const out = closeSession(d, kind, a.id, a.resolution);
            let issueClosed = false;
            if (out.issue) {
                const tracker = await getTracker(d);
                try {
                    await tracker.commentIssue(out.issue, `Resolved: ${a.resolution}`);
                }
                catch {
                    /* best-effort mirror; close is the state change that matters */
                }
                const closed = await tracker.closeIssue(out.issue);
                snapshotNote(d, closed);
                issueClosed = true;
            }
            return { ...out, issueClosed };
        }));
    };
    registerSessionTools("probe", "cairn:spike");
    registerSessionTools("draft", "cairn:sketch");
    registerSessionTools("thread", "cairn:thread");
    server.registerTool("session_landscape", {
        description: "Deterministic join over trace/probe/draft/thread sessions — open + resolved with " +
            "resolutions, counts by kind, phase linkage. Frontier-mode grounding: never re-propose " +
            "an archived stop-verdict probe",
        inputSchema: z.object({}),
    }, wrap(() => sessionLandscape(dir())));
    server.registerTool("plan_check", {
        description: "Deterministic plan-quality scan (#2891): cross-plan contract drift " +
            "(Produces/Consumes without a shared fixture), unanchored quantitative thresholds, " +
            "a planned phase whose CONTEXT.md lacks the approaches-considered block, and a task " +
            "line that never declares how it will be proved (`verify: <command>`)",
        // CRN-40: widened from .int().positive() -- a decimal phase filter (1.5)
        // must match its real 01.5-slug dir instead of dying as a raw SDK -32602.
        inputSchema: z.object({ phase: z.number().optional() }),
    }, wrap((a) => {
        assertValidPhase(a.phase);
        return planCheck(dir(), a.phase);
    }));
    server.registerTool("audit_record", {
        description: "Write the audit record (.cairn/audit/<scope>-<date>.md) — single writer; same scope+date " +
            "supersedes, prior dates immutable. Every finding needs a failure_scenario (inputs/state → wrong " +
            "output/crash). Critical/important need a refutation `panel` (>=1 vote, >=2 on security); quorum " +
            "computed here: REFUTED strict majority kills it (kept in the record, never filed — " +
            "`results[].survived` false), CONFIRMED > REFUTED confirms, else plausible. Survivors credit " +
            "their `seats`' yield. A staged `patch` is apply-eligible only if the finding survived and its " +
            "verifier's three claims are true (`results[].applyEligible`). A sweep-<YYYY-MM-DD> scope is a " +
            "manifest: `legs` index leg records; returns `delta` vs the prior sweep",
        inputSchema: z.object({
            scope: z.string(),
            verdict: z.enum(["pass", "findings"]),
            findings: z
                .array(z.object({
                severity: z.enum(["critical", "important", "minor"]),
                title: z.string().min(1),
                failure_scenario: z.string().min(1),
                detail: z.string().optional(),
                issue: z.string().optional(),
                panel: z
                    .array(z.object({
                    seat: z.string().min(1),
                    verdict: z.enum(["CONFIRMED", "PLAUSIBLE", "REFUTED"]),
                    evidence: z.string().min(1),
                }))
                    .optional(),
                seats: z.array(z.string().min(1)).optional(),
                patch: z
                    .object({
                    path: z.string().min(1),
                    verifier: z.object({
                        seat: z.string().min(1),
                        claims: z.object({
                            targeted: z.boolean(),
                            no_new_issue: z.boolean(),
                            behavior_unchanged: z.boolean(),
                        }),
                        evidence: z.string().min(1),
                        testsRun: z.string().min(1),
                    }),
                })
                    .optional(),
            }))
                .default([]),
            legs: z
                .array(z.object({ scope: z.string().min(1), path: z.string().min(1) }))
                .optional(),
        }),
    }, wrap((a) => writeAuditRecord(dir(), a.scope, a.verdict, a.findings, { legs: a.legs })));
    server.registerTool("map_set", {
        description: "Merge-patch the project knowledge graph (.cairn/map/map.json) -- nodes merge by id " +
            "(null deletes). Edge ops: edgesAdd/edgesRemove patch by exact from+to+type triple (removes " +
            "before adds; adds dedupe silently; removing a missing edge is a no-op); edges replaces the " +
            "list wholesale (rebuild-only: requires rebuild: true, CONFIG_INVALID without it) and " +
            "can't be combined with the edge ops (CONFIG_INVALID). " +
            "Validates edge endpoints exist and rejects deleting a node still edged in the final list. " +
            "Every write stamps meta (updatedAt, generation++); rebuild: true marks a from-scratch " +
            "rebuild (resets builtAt, generation restarts at 1)",
        inputSchema: z.object({
            patch: z.object({
                nodes: z
                    .record(z.string(), z.union([NodeSchema, z.null()]))
                    .optional(),
                edges: z.array(EdgeSchema).optional(),
                edgesAdd: z.array(EdgeSchema).optional(),
                edgesRemove: z.array(EdgeSchema).optional(),
            }),
            rebuild: z.boolean().optional(),
        }),
    }, wrap((a) => mapSet(dir(), a.patch, { rebuild: a.rebuild })));
    server.registerTool("map_get", {
        description: "Read the project knowledge graph, optionally filtered by nodeType, edgeType, or a " +
            "node id (self + touching edges + neighbor nodes). Missing store reads as empty",
        inputSchema: z.object({
            nodeType: NodeTypeEnum.optional(),
            edgeType: EdgeTypeEnum.optional(),
            node: z.string().optional(),
        }),
    }, wrap((a) => mapGet(dir(), a)));
    server.registerTool("map_query", {
        description: "Composite graph query: node + depth (0-3, default 1) walks a BFS neighborhood over " +
            "edges in both directions; nodeType/edgeType/label (case-insensitive substring) filters AND " +
            "together. Returns { nodes, edges, meta } with edges limited to both endpoints in the result",
        inputSchema: z.object({
            node: z.string().optional(),
            depth: z.number().int().min(0).max(3).optional(),
            nodeType: NodeTypeEnum.optional(),
            edgeType: EdgeTypeEnum.optional(),
            label: z.string().optional(),
        }),
    }, wrap((a) => mapQuery(dir(), a)));
    // ---- workspace tools (basecamp) -- these operate on the LAUNCH dir, never
    // the focus-resolved dir: they are the layer that manages focus itself.
    server.registerTool("workspace_list", {
        description: "Workspace name, root, members (name/path/configured), and current focus. " +
            "No workspace resolves to { workspace: null } — never an error",
        inputSchema: z.object({}),
    }, wrap(() => findWorkspace(launchDir) ?? { workspace: null }));
    server.registerTool("workspace_focus", {
        description: "Set (or clear, with project: null) the workspace focus — every tool then " +
            "operates on the focused member's project dir. Validates the member exists and is configured",
        inputSchema: z.object({ project: z.string().nullable() }),
    }, wrap((a) => setFocus(launchDir, a.project)));
    server.registerTool("workspace_status", {
        description: "Curated cross-project read: per configured member { name, phase, openIssues, " +
            "openSessions } from that member's own stores/tracker. Read-only, never switches focus; " +
            "a member whose tracker errors reports { name, error } instead of failing the call",
        inputSchema: z.object({}),
    }, wrap(async () => {
        const info = findWorkspace(launchDir);
        if (!info)
            return { workspace: null, members: [] };
        const members = [];
        for (const m of info.members.filter((member) => member.configured)) {
            try {
                // per-member paths/trackers constructed directly -- no focus switch
                let t = trackers.get(m.absPath);
                if (!t) {
                    t = new CachedTracker(await makeTracker(loadConfig(m.absPath), m.absPath));
                    trackers.set(m.absPath, t);
                }
                const openIssues = (await t.listIssues({ state: "open" })).length;
                const phase = new ActiveContext(m.absPath).get().phase ?? null;
                const { openByKind } = sessionLandscape(m.absPath);
                const openSessions = Object.values(openByKind).reduce((sum, n) => sum + n, 0);
                members.push({ name: m.name, phase, openIssues, openSessions });
            }
            catch (e) {
                members.push({
                    name: m.name,
                    error: e instanceof CairnError ? e.message : String(e),
                });
            }
        }
        return { workspace: info.workspace, focus: info.focus, members };
    }));
    const WorkstreamPatchSchema = z.object({
        title: z.string().optional(),
        project: z.string().optional(),
        status: z.enum(["queued", "active", "blocked", "done"]).optional(),
        issue: z.string().optional(),
        session: z.string().optional(),
        note: z.string().optional(),
    });
    server.registerTool("board_get", {
        description: "Read the workspace dispatch board (.cairn/basecamp/board.json) — workstreams " +
            "sorted by id plus counts by status. Missing board reads as empty",
        inputSchema: z.object({}),
    }, wrap(() => boardGet(launchDir)));
    server.registerTool("board_update", {
        description: "Merge-patch the dispatch board: workstreams merge by id (null deletes); " +
            "title+project required on create; project must name a workspace member. Rejected " +
            "patches leave the board untouched",
        inputSchema: z.object({
            patch: z.record(z.string(), z.union([WorkstreamPatchSchema, z.null()])),
        }),
    }, wrap((a) => boardUpdate(launchDir, a.patch)));
    server.registerTool("outlook_refresh", {
        description: "Re-derive another registered project's outlook snapshot in place (#92) -- " +
            "used by outlook --refresh on stale cards. project matches a registry entry by " +
            "case-insensitive name substring or exact path; ambiguous or missing matches error " +
            "with the candidates. Local derivation only, no tracker calls",
        inputSchema: z.object({ project: z.string() }),
    }, wrap((a) => {
        const entries = readRegistry().projects.filter((p) => p.path === a.project ||
            p.name.toLowerCase().includes(a.project.toLowerCase()));
        if (entries.length === 0) {
            throw new CairnError("NOT_FOUND", `no registered project matches '${a.project}'`, "outlook_get lists what is registered");
        }
        if (entries.length > 1) {
            throw new CairnError("PRECONDITION_FAILED", `'${a.project}' is ambiguous: ${entries.map((e) => e.name).join(", ")}`, "narrow the name or pass the exact path");
        }
        emitOutlook(entries[0].path);
        return { refreshed: entries[0].name, path: entries[0].path };
    }));
    server.registerTool("outlook_forget", {
        description: "Prune a project from the machine registry (#92) -- outlook forget <project>. " +
            "Matches by case-insensitive name substring or exact path; returns what was removed " +
            "(empty = no match). Does not touch the project itself or its snapshots",
        inputSchema: z.object({ project: z.string() }),
    }, wrap((a) => ({ removed: forgetProject(a.project) })));
    server.registerTool("outlook_emit", {
        description: "Explicit outlook snapshot emit for lifecycle gates (verify/ship/summit). " +
            "Re-derives the local snapshot and optionally attaches a verb-supplied tracker block " +
            "(open/inProgress/blocked counts, nextVerb, asOf) that carries forward through later " +
            "plain emits. Ship/summit call this BEFORE continuity_clear — the snapshot outlives " +
            "the handoff",
        inputSchema: z.object({
            tracker: z
                .object({
                open: z.number().optional(),
                inProgress: z.number().optional(),
                blocked: z.number().optional(),
                nextVerb: z.string().optional(),
                asOf: z.string().optional(),
            })
                .optional(),
        }),
    }, wrap((a) => {
        emitOutlook(dir(), a.tracker ? { tracker: a.tracker } : undefined);
        return { emitted: true };
    }));
    server.registerTool("outlook_get", {
        description: "Portfolio aggregate (#55): every registered cairn project on this machine as a " +
            "card — snapshot (phases/sessions/tracker block), staleness vs live git HEAD, per-project " +
            "{name, error} isolation. Reads ~/.cairn/registry.json + outlook mirrors only; never walks " +
            "the filesystem. artifact: true also writes the shareable board to ~/.cairn/OUTLOOK.md " +
            "(machine-level on purpose -- an in-repo fleet board would leak other projects' names) " +
            "and returns artifactPath",
        inputSchema: z.object({ artifact: z.boolean().optional() }),
    }, wrap((a) => outlookAggregate(undefined, a.artifact ? { artifact: true } : undefined)));
    server.registerTool("peer_list", {
        description: "Detected external AI peer CLIs (codex/opencode/antigravity/grok) — {peers: [on PATH, enabled, " +
            "input cap, execCapable (config-declared trust to execute the product during review)], maxConcurrent: " +
            "resource-aware fan-out budget — dispatch peers in batches of at most this many, never all at once",
        inputSchema: z.object({}),
    }, wrap(() => peerList(dir())));
    server.registerTool("peer_run", {
        description: "Run one external peer CLI with capped stdin input — advisory output, non-zero exit is a result. " +
            "Outbound content leaves the machine: the capped input is leak-scanned first and a hit refuses the run. " +
            "cwdMode 'scratch' (default) runs the child contained in a throwaway temp dir with the capped input " +
            "staged as packet.txt — the peer never sees the repo; 'project' runs from the project dir, refused " +
            "unless cairn.json marks the peer execCapable — grant it only on the functionality dimension",
        inputSchema: z.object({
            provider: z.enum(PROVIDERS),
            input: z.string().min(1),
            timeoutMs: z.number().int().positive().optional(),
            cwdMode: z.enum(["scratch", "project"]).optional(),
        }),
    }, wrap(async (a) => {
        const d = dir();
        return peerRun(d, a.provider, a.input, a.timeoutMs, {
            cwdMode: a.cwdMode,
        });
    }));
    server.registerTool("peer_state", {
        description: "Per-run peers convergence state (.cairn/peers/<slug>/) — ops: start (mode/target/" +
            "focus/peers; refuses an unfinished run on the slug), record_output (peer/round raw reply, " +
            "verbatim file), record_findings (peer/round, stable ids f1, f2, ...), verdict (findingId + " +
            "verified|dead|disputed|open-disagreement; verified/dead terminal), status (what's recorded + " +
            "what's missing to resume), close (blocks on unresolved findings AND on rostered seats with " +
            "no round-1 output — allowIncomplete: true closes anyway and stamps incompleteSeats; returns " +
            "audit_record-shaped provenance), abandon",
        // Permissive envelope on purpose -- op-specific requirements are
        // checked in-handler so a missing field comes back as a structured
        // CONFIG_INVALID naming the op, not a raw SDK -32602.
        inputSchema: z.object({
            slug: z.string().min(1),
            op: z.enum([
                "start",
                "record_output",
                "record_findings",
                "verdict",
                "status",
                "close",
                "abandon",
            ]),
            mode: z.enum(["review", "plan", "council"]).optional(),
            target: z.string().optional(),
            focus: z.string().optional(),
            peers: z.array(z.string()).optional(),
            peer: z.string().optional(),
            round: z.number().int().optional(),
            output: z.string().optional(),
            findings: z.array(z.record(z.string(), z.unknown())).optional(),
            findingId: z.string().optional(),
            verdict: z.enum(VERDICTS).optional(),
            note: z.string().optional(),
            allowIncomplete: z.boolean().optional(),
        }),
    }, wrap((a) => {
        const d = dir();
        const need = (value, name) => {
            if (value === undefined) {
                throw new CairnError("CONFIG_INVALID", `op '${a.op}' requires '${name}'`, `pass ${name} alongside slug + op`);
            }
            return value;
        };
        switch (a.op) {
            case "start":
                return runStart(d, a.slug, {
                    mode: need(a.mode, "mode"),
                    target: need(a.target, "target"),
                    focus: a.focus,
                    peers: need(a.peers, "peers"),
                });
            case "record_output":
                return recordPeerOutput(d, a.slug, need(a.peer, "peer"), need(a.round, "round"), need(a.output, "output"));
            case "record_findings":
                // recordFindings re-validates each element against FindingSchema,
                // so the loose Record shape here can't smuggle in a bad finding.
                return recordFindings(d, a.slug, need(a.peer, "peer"), need(a.round, "round"), need(a.findings, "findings"));
            case "verdict":
                return recordVerdict(d, a.slug, need(a.findingId, "findingId"), need(a.verdict, "verdict"), a.note);
            case "status":
                return runStatus(d, a.slug);
            case "close":
                return runClose(d, a.slug, { allowIncomplete: a.allowIncomplete });
            case "abandon":
                return runAbandon(d, a.slug);
        }
    }));
    server.registerTool("seat_roster", {
        description: "Merged seat roster — shipped default seats (templates/seats/) overridden by project seats " +
            "(.cairn/roles/*.md, matched by name; a read path — the server never writes there), then " +
            "filtered/ordered by cairn.json's optional `seats` block (absent = all defaults enabled). " +
            "Per-seat {name, lens, categories, dose, stage: review|plan|any (when the seat convenes — " +
            "review's diff panel seats stage review|any; plan-stage seats convene at plan time only), " +
            "signals, source: default|project, valid, note?}; a " +
            "seat file that fails validation is skipped with a note, never the roster. Also carries " +
            "`dispatch` (cairn.json seats.dispatch, when set) — what a verb's inherit dial resolves to " +
            "for signal→seat selection (absent = off, full roster fires). Internal seats are " +
            "framing lenses — cheap, same-model; peers remain the genuinely adversarial external council",
        inputSchema: z.object({}),
    }, wrap(() => {
        const roster = loadRoster(dir());
        return {
            seats: roster.seats.map((s) => ({
                name: s.name,
                lens: s.seat?.lens,
                categories: s.seat?.categories,
                dose: s.seat?.dose,
                stage: s.seat?.stage,
                signals: s.seat?.signals,
                source: s.source,
                valid: s.valid,
                note: s.note,
            })),
            ...(roster.dispatch !== undefined ? { dispatch: roster.dispatch } : {}),
            ...(roster.notes.length > 0 ? { notes: roster.notes } : {}),
        };
    }));
    server.registerTool("research_sections", {
        description: "Parse a research artifact's ##+ section markers " +
            "(<!-- namespace: done|pending|failed [date] [model] [— note] -->) for one " +
            "namespace (scout, survey, ...). Unmarked sections report state 'unmarked'; a " +
            "typo'd marker is CONFIG_INVALID, never silently done. With flip, rewrites that " +
            "section's marker atomically and returns the re-parsed sections",
        inputSchema: z.object({
            path: z.string(),
            namespace: z.string(),
            flip: z
                .object({
                heading: z.string(),
                state: z.enum(["done", "pending", "failed"]),
                date: z.string().optional(),
                model: z.string().optional(),
                note: z.string().optional(),
            })
                .optional(),
        }),
    }, wrap((a) => {
        const d = dir();
        // Containment: the artifact must live under the project dir -- a
        // ..-escape (or an absolute path outside it) is a config error, not a read.
        const abs = resolve(d, a.path);
        const rel = relative(d, abs);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
            throw new CairnError("CONFIG_INVALID", `path '${a.path}' escapes the project directory`, "pass a path relative to the project root, e.g. .cairn/plans/phases/07-x/RESEARCH.md");
        }
        // The lexical check above can't see symlinks -- realpath the existing
        // file and require containment against the realpathed project dir, so
        // a link inside the project pointing outside it can't smuggle a read
        // OR redirect the flip-write. (The file's realpath covers the parent
        // dir too: the .tmp sibling lands beside the real file.) A missing
        // file stays NOT_FOUND, exactly as before.
        let realAbs;
        try {
            realAbs = realpathSync(abs);
        }
        catch {
            throw new CairnError("NOT_FOUND", `no research artifact at ${abs}`, "path resolves against the project directory");
        }
        const realRel = relative(realpathSync(d), realAbs);
        if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
            throw new CairnError("CONFIG_INVALID", `path '${a.path}' resolves outside the project directory (symlink escape)`, "research artifacts must really live under the project root");
        }
        let markdown;
        try {
            markdown = readFileSync(realAbs, "utf8");
        }
        catch {
            throw new CairnError("NOT_FOUND", `no research artifact at ${abs}`, "path resolves against the project directory");
        }
        if (!a.flip)
            return { path: rel, sections: parseSections(markdown, a.namespace) };
        const { heading, state, ...meta } = a.flip;
        const flipped = flipSection(markdown, a.namespace, heading, state, meta);
        // Validate the WHOLE flipped doc BEFORE anything persists -- a typo'd
        // marker in another section must fail the call with the file untouched,
        // never after the mutation already landed on disk.
        const sections = parseSections(flipped, a.namespace);
        // tmp+rename so a crash mid-write never leaves a half-written artifact
        // (same idiom as map/store.ts).
        const tmp = `${realAbs}.tmp`;
        writeFileSync(tmp, flipped);
        renameSync(tmp, realAbs);
        return { path: rel, flipped: heading, sections };
    }));
    server.registerTool("docs_publish", {
        description: "Publish project docs to the configured docs connector: README.md as the landing page " +
            "(with a contents section), docs/ (+ CHANGELOG.md) as its child page tree. Idempotent. " +
            "Refused unless confirm: true — the owner's explicit yes",
        inputSchema: z.object({
            projectName: z.string().optional(),
            confirm: z.boolean().optional(),
        }),
    }, wrap(async (a) => {
        // Never auto-publish -- the owner's explicit yes is the only key
        if (a.confirm !== true) {
            throw new CairnError("PRECONDITION_FAILED", "docs_publish refused: publishing pushes repo docs to an external site and needs the owner's explicit yes", "ask the project owner whether to publish the docs; on an explicit yes, call docs_publish again with confirm: true");
        }
        const d = dir();
        return publishTree(await getDocsConnector(d), d, a.projectName);
    }));
    server.registerTool("docs_status", {
        description: "Docs connector status — configured connector and the project's landing page, when one exists. " +
            "A configured-but-unreachable connector reports {configured:true, reachable:false, error, message} " +
            "instead of throwing",
        inputSchema: z.object({ projectName: z.string().optional() }),
    }, wrap(async (a) => {
        const d = dir();
        const cfg = loadConfig(d);
        if (!cfg.docs)
            return { configured: false };
        try {
            const connector = await getDocsConnector(d);
            const root = await connector.findPage(a.projectName ?? defaultProjectName(d));
            return { configured: true, connector: cfg.docs.connector, root };
        }
        catch (e) {
            // The connector is configured but couldn't be reached (auth, network,
            // rate limit, ...) -- report that gracefully rather than rethrowing;
            // an unreachable docs backend shouldn't look like a crashed tool.
            if (e instanceof CairnError) {
                const message = e.message.length > 200 ? `${e.message.slice(0, 200)}…` : e.message;
                return { configured: true, reachable: false, error: e.code, message };
            }
            throw e;
        }
    }));
    server.registerTool("docs_drift", {
        description: "Deterministic docs-drift report — flags verified phases (live and archived) the public " +
            "docs have NOT caught up with: no CHANGELOG.md/docs/ entry mentions the phase, or the " +
            "newest docs commit predates the phase's last LEDGER.md commit. Pure filesystem + git " +
            "reads, no tracker calls, no LLM judgment",
        inputSchema: z.object({}),
    }, wrap(async () => docsDriftReport(dir())));
    server.registerTool("distill_manifest", {
        description: "Assemble one phase's distill manifest — the scope an incremental distill run may " +
            "synthesize from: the phase's PLAN.md issues, its parsed LEDGER.md entries (each " +
            "carrying the commit range the task landed as), and the union commit range those " +
            "entries span. Resolves live phases and archived ones under milestones/vN " +
            "(decimal phase numbers like 1.5 accepted); malformed ledger lines are skipped " +
            "with a note. Pure filesystem reads — no tracker, no git, no LLM judgment",
        inputSchema: z.object({ phase: z.number() }),
    }, wrap((a) => distillManifest(dir(), a.phase)));
    server.registerTool("token_estimate", {
        description: "Predict a phase's approximate agent-token spend as a RANGE before it runs (#129), " +
            "calibrated from the metrics history the Stop hook writes (latest row per session — " +
            "rows are cumulative). Tokens-per-point and tokens-per-issue distributions from " +
            "completed phases scale by the target phase's PLAN.md issue count + tracker/body-line " +
            "point estimates; no usable history degrades to a published wide default with " +
            "confidence 'wide'. Decimal phase numbers (1.5) accepted. Deterministic given its " +
            "inputs — the staging interview consumes this",
        inputSchema: z.object({ phase: z.number() }),
    }, wrap(async (a) => {
        assertValidPhase(a.phase);
        const d = dir();
        // points are a nice-to-have -- an unconfigured/broken tracker must not
        // sink the estimate, it just degrades to issue-count grain.
        let tracker;
        try {
            tracker = await getTracker(d);
        }
        catch {
            tracker = undefined;
        }
        return estimatePhaseTokens(d, a.phase, { tracker });
    }));
    // Read-only plan artifacts as cairn:// resources (#99) -- the server's
    // first resources surface. Reads resolve dir() fresh, same as the tools.
    registerPlanResources(server, dir);
    return server;
}
// CLI entry — stdio transport; config loads lazily per tool call.
const isMain = (() => {
    const argv1 = process.argv[1];
    if (!argv1)
        return false;
    try {
        return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
    }
    catch {
        return false;
    }
})();
if (isMain) {
    // Resolve to an absolute path up front -- the workspace resolver's
    // no-workspace compat branch returns the launch dir verbatim, so a relative
    // CLAUDE_PROJECT_DIR would otherwise leak relative paths into every store.
    const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
    // Fire-and-forget portfolio registration (#87) -- a registry problem must
    // never keep the server from coming up.
    try {
        registerProject(projectDir);
    }
    catch {
        /* swallow by design */
    }
    const server = buildServer({ projectDir });
    await server.connect(new StdioServerTransport());
}
