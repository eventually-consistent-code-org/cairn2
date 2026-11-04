import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson } from "../http.js";
import { runProbe } from "../probe.js";
import { matchesState } from "../types.js";
import { milestonesUnsupported, phaseCloseUnsupported, } from "../unsupported.js";
const API = "https://api.clickup.com/api/v2";
const LIST_CAP = 100;
export const configSchema = z
    .object({
    defaultListId: z.string().min(1), // un-phased tasks land here
    folderId: z.string().optional(), // phases become Lists in this folder…
    spaceId: z.string().optional(), // …or directly in this space (exactly one required)
    tokenEnv: z.string().default("CLICKUP_TOKEN"),
    // Extra keys are custom cairn states ("review": "code review") — CRN-26.
    // Deliberate .default under zod 4 (#95): a provided map replaces wholesale
    // (no merge with defaults) and the refine below still guards partial maps.
    statuses: z
        .record(z.string(), z.string())
        .default({
        open: "to do",
        in_progress: "in progress",
        closed: "complete",
    })
        .refine((s) => ["open", "in_progress", "closed"].every((k) => typeof s[k] === "string"), "statuses must include open, in_progress, and closed"),
})
    .refine((c) => Boolean(c.folderId) !== Boolean(c.spaceId), {
    message: "exactly one of folderId or spaceId is required",
});
export function make(config, fetchImpl) {
    return new ClickUpTracker(config, fetchImpl);
}
export function resolveClickUpToken(tokenEnv) {
    const env = process.env[tokenEnv];
    if (env)
        return env;
    throw new CairnError("AUTH_MISSING", `no ClickUp credentials (${tokenEnv} not set)`, `export ${tokenEnv}`);
}
export class ClickUpTracker {
    cfg;
    fetchImpl;
    tokenProvider;
    capabilities = {
        hasInProgress: true,
        hasPhases: true,
        // A task's list is its creation-time parent: ClickUp API v2 has no
        // move-between-lists primitive (only the feature-gated multi-list
        // ClickApp), so updateIssue cannot re-phase. The tool layer drops
        // patch.phase here and reports phaseSkipped — same degradation
        // pattern as estimates on no-hasEstimates backends.
        hasPhaseReassign: false,
        hasDependencies: true,
        hasLabels: true,
        hasMilestones: false,
        hasPhaseClose: false,
        hasComments: true,
        hasWorklog: false,
        hasEstimates: false,
        hasIssueAttachments: false,
    };
    constructor(cfg, fetchImpl = fetch, tokenProvider = () => resolveClickUpToken(cfg.tokenEnv)) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
        this.tokenProvider = tokenProvider;
    }
    headers() {
        return {
            authorization: this.tokenProvider(),
            "content-type": "application/json",
        };
    }
    async api(method, path, body, context = "clickup") {
        return fetchJson(this.fetchImpl, `${API}${path}`, {
            method,
            headers: this.headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        }, { context });
    }
    assertId(id) {
        if (!/^[a-z0-9]+$/i.test(id)) {
            throw new CairnError("NOT_FOUND", `invalid task id: ${id}`, "task id must be alphanumeric");
        }
    }
    /** Preflight: /list/{defaultListId} over /team -- /team only proves the
     *  token is valid, not that the configured list exists. A typo'd
     *  defaultListId now 404s instead of reading "ok". */
    async probe() {
        return runProbe(() => this.api("GET", `/list/${this.cfg.defaultListId}`, undefined, "clickup probe"));
    }
    /** Validates a caller-supplied phase (list) id before it reaches a URL. defaultListId is trusted config, not user input. */
    assertPhaseId(id) {
        if (!/^[a-z0-9]+$/i.test(id)) {
            throw new CairnError("NOT_FOUND", `invalid phase id: ${id}`, "phase id must be alphanumeric");
        }
    }
    normalizeState(status) {
        if (status.type === "open")
            return "open";
        if (status.type === "done" || status.type === "closed")
            return "closed";
        // custom: compare to the configured in_progress status name, case-insensitively
        return status.status.toLowerCase() ===
            this.cfg.statuses.in_progress.toLowerCase()
            ? "in_progress"
            : "open";
    }
    // Status names ClickUp has shown this instance, lowercased, with the
    // category their type buckets to -- filled by every task read, so the
    // pre-write question below answers from data already fetched and never
    // fetches for itself (#471).
    seenStatuses = new Map();
    /** The SPI's pre-write question (#427, #471): the canonical three by
     *  name; a statuses-map key by the native status it writes, and a native
     *  status by itself -- the three required entries carry their category,
     *  any other only once ClickUp has shown it with its type. undefined
     *  otherwise: the freeze gate then falls closed rather than letting the
     *  name through. Case-insensitive, as normalizeState compares. Asserted
     *  by clickup.unit.test.ts and tracker-contract.test.ts. */
    stateCategory(state) {
        if (state === "open" || state === "in_progress" || state === "closed")
            return state;
        const { statuses } = this.cfg;
        const native = (statuses[state] ?? state).toLowerCase();
        if (native === statuses.closed.toLowerCase())
            return "closed";
        if (native === statuses.in_progress.toLowerCase())
            return "in_progress";
        if (native === statuses.open.toLowerCase())
            return "open";
        return this.seenStatuses.get(native);
    }
    normalize(raw) {
        const category = this.normalizeState(raw.status);
        if (raw.status?.status)
            this.seenStatuses.set(raw.status.status.toLowerCase(), category);
        return {
            id: raw.id,
            title: raw.name,
            body: raw.description ?? "",
            state: raw.status?.status ?? category,
            category,
            labels: raw.tags.map((t) => t.name),
            phase: raw.list?.id,
            assignee: raw.assignees[0]?.username ?? raw.assignees[0]?.email,
            updatedAt: new Date(Number(raw.date_updated)).toISOString(),
            url: raw.url,
        };
    }
    async createIssue(input) {
        if (input.phase)
            this.assertPhaseId(input.phase);
        const listId = input.phase ?? this.cfg.defaultListId;
        const body = {
            name: input.title,
            description: input.body ?? "",
        };
        const raw = (await this.api("POST", `/list/${listId}/task`, body, "clickup createIssue"));
        const issue = this.normalize(raw);
        if (input.labels?.length)
            return this.reconcileTags(issue.id, [], input.labels, issue);
        return issue;
    }
    async getIssue(id) {
        this.assertId(id);
        const raw = (await this.api("GET", `/task/${id}`, undefined, "clickup getIssue"));
        return this.normalize(raw);
    }
    /** Adds/removes tags to match `desired`, given the tags currently on the task (by name). */
    async reconcileTags(id, current, desired, base) {
        const toAdd = desired.filter((l) => !current.includes(l));
        const toRemove = current.filter((l) => !desired.includes(l));
        for (const label of toRemove) {
            await this.api("DELETE", `/task/${id}/tag/${encodeURIComponent(label)}`, undefined, "clickup removeTag");
        }
        for (const label of toAdd) {
            await this.api("POST", `/task/${id}/tag/${encodeURIComponent(label)}`, undefined, "clickup addTag");
        }
        if (toAdd.length === 0 && toRemove.length === 0)
            return base;
        return { ...base, labels: desired };
    }
    async updateIssue(id, patch) {
        this.assertId(id);
        const body = {};
        if (patch.title !== undefined)
            body.name = patch.title;
        if (patch.body !== undefined)
            body.description = patch.body;
        // patch.phase deliberately ignored — hasPhaseReassign: false (see capabilities)
        // assignee writes need numeric user-id resolution — deferred until assignee semantics are speced
        if (patch.state !== undefined) {
            const native = this.cfg.statuses[patch.state];
            if (!native) {
                throw new CairnError("CONFIG_INVALID", `no clickup status mapped for state '${patch.state}'`, `add it to tracker.config.statuses in cairn.json (known: ${Object.keys(this.cfg.statuses).join(", ")})`);
            }
            body.status = native;
        }
        const raw = (Object.keys(body).length > 0
            ? await this.api("PUT", `/task/${id}`, body, "clickup updateIssue")
            : await this.api("GET", `/task/${id}`, undefined, "clickup getIssue"));
        let issue = this.normalize(raw);
        if (patch.labels !== undefined) {
            issue = await this.reconcileTags(id, issue.labels, patch.labels, issue);
        }
        return issue;
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        // v1: unfiltered listIssues() covers only the default list — ClickUp has
        // no "all tasks across lists" endpoint without iterating every list, so
        // an unphased call is scoped to defaultListId just like a phased call is
        // scoped to that phase's list.
        if (filter?.phase)
            this.assertPhaseId(filter.phase);
        const listId = filter?.phase ?? this.cfg.defaultListId;
        const raw = (await this.api("GET", `/list/${listId}/task?include_closed=true`, undefined, "clickup listIssues"));
        const tasks = raw.tasks ?? [];
        if (tasks.length >= LIST_CAP) {
            console.error(`[cairn] clickup listIssues truncated at ${LIST_CAP} items for list ${listId}`);
        }
        let issues = tasks.slice(0, LIST_CAP).map((t) => this.normalize(t));
        if (filter?.state)
            issues = issues.filter((i) => matchesState(i, filter.state));
        return issues;
    }
    async createPhase(name) {
        const parentPath = this.cfg.folderId
            ? `/folder/${this.cfg.folderId}/list`
            : `/space/${this.cfg.spaceId}/list`;
        const raw = (await this.api("POST", parentPath, { name }, "clickup createPhase"));
        return { id: raw.id, name: raw.name, state: "open" };
    }
    async listPhases() {
        const parentPath = this.cfg.folderId
            ? `/folder/${this.cfg.folderId}/lists`
            : `/space/${this.cfg.spaceId}/lists`;
        const raw = (await this.api("GET", parentPath, undefined, "clickup listPhases"));
        return (raw.lists ?? []).map((l) => ({
            id: l.id,
            name: l.name,
            state: "open",
        }));
    }
    async closePhase(_id) {
        return phaseCloseUnsupported("clickup");
    }
    async createMilestone(_name) {
        return milestonesUnsupported("clickup");
    }
    async listMilestones() {
        return milestonesUnsupported("clickup");
    }
    async completeMilestone(_id) {
        return milestonesUnsupported("clickup");
    }
    async commentIssue(id, text) {
        this.assertId(id);
        const raw = (await this.api("POST", `/task/${id}/comment`, { comment_text: text }, "clickup issue_comment"));
        return { id: String(raw.id) };
    }
}
