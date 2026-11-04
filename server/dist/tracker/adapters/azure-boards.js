import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson } from "../http.js";
import { runProbe } from "../probe.js";
import { matchesState } from "../types.js";
import { phaseCloseUnsupported } from "../unsupported.js";
const MAX_IDS = 100;
export const configSchema = z.object({
    orgUrl: z.string().url(), // https://dev.azure.com/org
    project: z.string().min(1),
    workItemType: z.string().default("Issue"),
    patEnv: z.string().default("AZURE_DEVOPS_PAT"),
    apiVersion: z.string().default("7.0"),
    // Extra keys are custom cairn states ("review": "In Review") — CRN-26.
    // Deliberate .default under zod 4 (#95): a provided map replaces wholesale
    // (no merge with defaults) and the refine below still guards partial maps.
    states: z
        .record(z.string(), z.string())
        .default({ in_progress: "Doing", closed: "Done", open: "To Do" })
        .refine((s) => ["open", "in_progress", "closed"].every((k) => typeof s[k] === "string"), "states must include open, in_progress, and closed"),
});
export function make(config, fetchImpl) {
    return new AzureBoardsTracker(config, fetchImpl);
}
export function resolveAzurePat(patEnv) {
    const env = process.env[patEnv];
    if (env)
        return env;
    throw new CairnError("AUTH_MISSING", `no Azure DevOps PAT (env var ${patEnv})`, `export ${patEnv} with a PAT that has Work Items (Read & Write) scope`);
}
export class AzureBoardsTracker {
    cfg;
    fetchImpl;
    tokenProvider;
    capabilities = {
        hasInProgress: true,
        hasPhases: true,
        hasPhaseReassign: true,
        hasDependencies: true,
        hasLabels: true,
        hasMilestones: true,
        hasPhaseClose: false,
        hasComments: true,
        hasWorklog: false,
        hasEstimates: false,
        hasIssueAttachments: false,
    };
    /** id (GUID) -> full iteration path, refreshed from listPhases() when an unknown id shows up. */
    phasePaths = new Map();
    /** Tracks whether we've called listPhases() once on this instance (guards against infinite refresh loops). */
    phasesLoaded = false;
    constructor(cfg, fetchImpl = fetch, tokenProvider = () => resolveAzurePat(cfg.patEnv)) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
        this.tokenProvider = tokenProvider;
    }
    headers(contentType = "application/json") {
        const pat = this.tokenProvider();
        return {
            authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
            accept: "application/json",
            "content-type": contentType,
        };
    }
    url(path, extraParams) {
        const base = this.cfg.orgUrl.replace(/\/$/, "");
        const u = new URL(`${base}${path}`);
        u.searchParams.set("api-version", this.cfg.apiVersion);
        if (extraParams) {
            for (const [k, v] of Object.entries(extraParams))
                u.searchParams.set(k, v);
        }
        return u.toString();
    }
    async api(method, path, body, opts = {}) {
        return fetchJson(this.fetchImpl, this.url(path, opts.params), {
            method,
            headers: this.headers(opts.contentType ?? "application/json"),
            body: body === undefined ? undefined : JSON.stringify(body),
        }, { context: opts.context ?? "azure-boards" });
    }
    assertId(id) {
        if (!/^\d+$/.test(id)) {
            throw new CairnError("NOT_FOUND", `invalid work item id: ${id}`, "work item id must be a numeric string");
        }
    }
    self;
    async resolveSelf() {
        if (this.self)
            return this.self;
        const data = (await this.api("GET", "/_apis/connectionData", undefined, {
            context: "azure-boards connectionData",
        }));
        // Account.$value is the sign-in email System.AssignedTo accepts
        this.self =
            data.authenticatedUser?.properties?.Account?.$value ??
                data.authenticatedUser?.providerDisplayName;
        return this.self;
    }
    /** Preflight: /_apis/projects/{project} over resolveSelf's connectionData
     *  -- connectionData only proves the PAT is valid, not that the configured
     *  project exists. A typo'd project now 404s instead of reading "ok". */
    async probe() {
        return runProbe(() => this.api("GET", `/_apis/projects/${this.projectPath}`, undefined, {
            context: "azure-boards probe",
        }));
    }
    get projectPath() {
        return encodeURIComponent(this.cfg.project);
    }
    normalizeState(fields) {
        const category = fields["System.StateCategory"];
        if (category) {
            const c = category.toLowerCase();
            if (c === "completed" || c === "removed")
                return "closed";
            if (c === "inprogress" || c === "resolved")
                return "in_progress";
            if (c === "proposed")
                return "open";
        }
        const state = fields["System.State"];
        const { states } = this.cfg;
        if (state === states.closed)
            return "closed";
        if (state === states.in_progress)
            return "in_progress";
        return "open";
    }
    // State names Azure has shown this instance with the category they
    // normalize to -- filled by every work item read, so the pre-write
    // question below answers from data already fetched and never fetches
    // for itself (#471). The work-item-type states call
    // (GET {project}/_apis/wit/workitemtypes/{type}/states, name + category
    // per state, as of 2026-11-04 per the Azure DevOps REST 7.0 reference)
    // could warm this for never-seen states; it is not wired, because the
    // question is answered with no network and a never-seen name falls
    // closed at the gate anyway.
    seenStates = new Map();
    /** The SPI's pre-write question (#427, #471): the canonical three by
     *  name; a states-map key by the native state it writes, and a native
     *  state by itself -- the three required entries carry their category,
     *  any other only once Azure has shown it on a work item read. undefined
     *  otherwise: the freeze gate then falls closed rather than letting the
     *  name through. Exact-case, as normalizeState compares. Asserted by
     *  azure-boards.unit.test.ts and tracker-contract.test.ts. */
    stateCategory(state) {
        if (state === "open" || state === "in_progress" || state === "closed")
            return state;
        const { states } = this.cfg;
        const native = states[state] ?? state;
        if (native === states.closed)
            return "closed";
        if (native === states.in_progress)
            return "in_progress";
        if (native === states.open)
            return "open";
        return this.seenStates.get(native);
    }
    normalize(raw) {
        const f = raw.fields;
        const category = this.normalizeState(f);
        if (f["System.State"])
            this.seenStates.set(f["System.State"], category);
        const tags = f["System.Tags"];
        const labels = tags ? tags.split("; ").filter(Boolean) : [];
        const assignedTo = f["System.AssignedTo"];
        const assignee = typeof assignedTo === "string"
            ? assignedTo
            : (assignedTo?.uniqueName ?? assignedTo?.displayName);
        const iterationPath = f["System.IterationPath"];
        let phase;
        if (iterationPath) {
            for (const [id, path] of this.phasePaths) {
                if (path === iterationPath) {
                    phase = id;
                    break;
                }
            }
        }
        return {
            id: String(raw.id),
            title: f["System.Title"] ?? "",
            body: f["System.Description"] ?? "",
            state: f["System.State"] ?? category,
            category,
            labels,
            phase,
            assignee,
            updatedAt: f["System.ChangedDate"] ?? new Date(0).toISOString(),
            url: raw.url ??
                this.url(`/${this.projectPath}/_apis/wit/workitems/${raw.id}`),
        };
    }
    /** Escapes single quotes in a WIQL string literal by doubling them. */
    escapeWiql(s) {
        return s.replace(/'/g, "''");
    }
    /**
     * Normalizes a classificationnodes iteration path to the System.IterationPath
     * format: strips a leading backslash and the literal "Iteration\" segment
     * classificationnodes includes but System.IterationPath doesn't, e.g.
     * `\Proj\Iteration\Sprint 1` -> `Proj\Sprint 1`.
     */
    normalizeIterationPath(path) {
        return path.replace(/^\\/, "").replace(/^([^\\]+)\\Iteration\\/, "$1\\");
    }
    /** Flattens a classificationnodes response into a flat list of leaf-ish iteration nodes, tolerating both response shapes. */
    flattenIterationNodes(raw) {
        if ("value" in raw && Array.isArray(raw.value))
            return raw.value;
        return raw.children ?? [];
    }
    /** Resolves a phase id (GUID) to its iteration path, refreshing the map from listPhases() if unknown. */
    async resolvePhasePath(phaseId) {
        if (!this.phasePaths.has(phaseId))
            await this.listPhases();
        const path = this.phasePaths.get(phaseId);
        if (!path) {
            throw new CairnError("NOT_FOUND", `unknown phase id: ${phaseId}`, "create the phase first via createPhase(), or check the phase id");
        }
        return path;
    }
    /** Resolves an iteration path to a phase id (GUID), self-healing the map on miss if not yet loaded. */
    async phaseIdForPath(iterationPath) {
        if (!iterationPath)
            return undefined;
        // Scan map for a match.
        for (const [id, path] of this.phasePaths) {
            if (path === iterationPath)
                return id;
        }
        // Miss: if map not yet refreshed this instance, call listPhases() once and rescan.
        if (!this.phasesLoaded) {
            await this.listPhases();
            for (const [id, path] of this.phasePaths) {
                if (path === iterationPath)
                    return id;
            }
        }
        // Still missing after refresh (or map already loaded and no match): give up.
        return undefined;
    }
    async createIssue(input) {
        const ops = [
            { op: "add", path: "/fields/System.Title", value: input.title },
            {
                op: "add",
                path: "/fields/System.Description",
                value: input.body ?? "",
            },
        ];
        if (input.labels?.length) {
            ops.push({
                op: "add",
                path: "/fields/System.Tags",
                value: input.labels.join("; "),
            });
        }
        if (input.phase) {
            const path = await this.resolvePhasePath(input.phase);
            ops.push({
                op: "add",
                path: "/fields/System.IterationPath",
                value: path,
            });
        }
        const wtype = encodeURIComponent(`$${this.cfg.workItemType}`);
        const raw = await this.api("POST", `/${this.projectPath}/_apis/wit/workitems/${wtype}`, ops, {
            contentType: "application/json-patch+json",
            context: "azure-boards issue_create",
        });
        return this.normalize(raw);
    }
    async getIssue(id) {
        this.assertId(id);
        const raw = await this.api("GET", `/${this.projectPath}/_apis/wit/workitems/${id}`, undefined, { context: "azure-boards issue_get" });
        const workItem = raw;
        const issue = this.normalize(workItem);
        if (issue.phase === undefined && workItem.fields["System.IterationPath"]) {
            issue.phase = await this.phaseIdForPath(workItem.fields["System.IterationPath"]);
        }
        return issue;
    }
    async updateIssue(id, patch) {
        this.assertId(id);
        const ops = [];
        if (patch.title !== undefined)
            ops.push({ op: "add", path: "/fields/System.Title", value: patch.title });
        if (patch.body !== undefined)
            ops.push({
                op: "add",
                path: "/fields/System.Description",
                value: patch.body,
            });
        if (patch.labels !== undefined)
            ops.push({
                op: "add",
                path: "/fields/System.Tags",
                value: patch.labels.join("; "),
            });
        if (patch.assignee !== undefined)
            ops.push({
                op: "add",
                path: "/fields/System.AssignedTo",
                value: patch.assignee,
            });
        // Re-phase: same mapping as createIssue — iteration path from the phase id.
        if (patch.phase) {
            const path = await this.resolvePhasePath(patch.phase);
            ops.push({
                op: "add",
                path: "/fields/System.IterationPath",
                value: path,
            });
        }
        if (patch.state) {
            const stateValue = this.cfg.states[patch.state];
            if (!stateValue) {
                throw new CairnError("CONFIG_INVALID", `no azure-boards state mapped for '${patch.state}'`, `add it to tracker.config.states in cairn.json (known: ${Object.keys(this.cfg.states).join(", ")})`);
            }
            ops.push({ op: "add", path: "/fields/System.State", value: stateValue });
        }
        const raw = await this.api("PATCH", `/${this.projectPath}/_apis/wit/workitems/${id}`, ops, {
            contentType: "application/json-patch+json",
            context: "azure-boards issue_update",
        });
        const workItem = raw;
        const issue = this.normalize(workItem);
        if (issue.phase === undefined && workItem.fields["System.IterationPath"]) {
            issue.phase = await this.phaseIdForPath(workItem.fields["System.IterationPath"]);
        }
        return issue;
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        let query = "SELECT [System.Id] FROM WorkItems";
        const projectClause = `[System.TeamProject] = '${this.escapeWiql(this.cfg.project)}'`;
        if (filter?.phase) {
            const path = await this.resolvePhasePath(filter.phase);
            query += ` WHERE ${projectClause} AND [System.IterationPath] = '${this.escapeWiql(path)}'`;
        }
        else {
            query += ` WHERE ${projectClause}`;
        }
        const wiqlRaw = (await this.api("POST", `/${this.projectPath}/_apis/wit/wiql`, { query }, { context: "azure-boards issue_list_wiql" }));
        let ids = wiqlRaw.workItems.map((w) => w.id);
        if (ids.length > MAX_IDS) {
            console.error(`[cairn] azure-boards listIssues truncated at ${MAX_IDS} ids (WIQL returned ${ids.length})`);
            ids = ids.slice(0, MAX_IDS);
        }
        if (ids.length === 0)
            return [];
        const batchRaw = (await this.api("GET", `/${this.projectPath}/_apis/wit/workitems`, undefined, {
            params: { ids: ids.join(","), $expand: "all" },
            context: "azure-boards issue_list_batch",
        }));
        const workItems = batchRaw.value;
        let issues = workItems.map((w) => this.normalize(w));
        // Self-heal phase resolution for all issues at once (one listPhases call per 100+ items)
        const unresolved = issues.filter((i) => i.phase === undefined &&
            workItems.find((w) => w.id === Number(i.id))?.fields["System.IterationPath"]);
        if (unresolved.length > 0) {
            for (const issue of unresolved) {
                const raw = workItems.find((w) => w.id === Number(issue.id));
                issue.phase = await this.phaseIdForPath(raw.fields["System.IterationPath"]);
            }
        }
        if (filter?.state)
            issues = issues.filter((i) => matchesState(i, filter.state));
        return issues;
    }
    async createPhase(name) {
        const raw = (await this.api("POST", `/${this.projectPath}/_apis/wit/classificationnodes/iterations`, { name }, { context: "azure-boards phase_create" }));
        const path = raw.path ?? `${this.cfg.project}\\${raw.name}`;
        this.phasePaths.set(raw.identifier, path);
        return { id: raw.identifier, name: raw.name, state: "open" };
    }
    async listPhases() {
        const raw = (await this.api("GET", `/${this.projectPath}/_apis/wit/classificationnodes/iterations`, undefined, { params: { $depth: "2" }, context: "azure-boards phase_list" }));
        // Tolerate both known live-response shapes: a { value: [...] } wrapper, or
        // the root classification node itself with a `children` array (no `value`).
        const nodes = this.flattenIterationNodes(raw);
        this.phasePaths.clear();
        for (const node of nodes) {
            const path = node.path
                ? this.normalizeIterationPath(node.path)
                : `${this.cfg.project}\\${node.name}`;
            this.phasePaths.set(node.identifier, path);
        }
        this.phasesLoaded = true; // mark map as refreshed for this instance
        return nodes.map((node) => ({
            id: node.identifier,
            name: node.name,
            state: "open",
        }));
    }
    async closePhase(_id) {
        return phaseCloseUnsupported("azure-boards");
    }
    /** Maps an Epic work item to a Milestone; "released" once it hits the configured closed state. */
    normalizeEpic(raw) {
        const state = raw.fields["System.State"] === this.cfg.states.closed
            ? "released"
            : "open";
        return {
            id: String(raw.id),
            name: raw.fields["System.Title"] ?? "",
            state,
            url: raw.url,
        };
    }
    async createMilestone(name) {
        const raw = await this.api("POST", `/${this.projectPath}/_apis/wit/workitems/${encodeURIComponent("$Epic")}`, [{ op: "add", path: "/fields/System.Title", value: name }], {
            contentType: "application/json-patch+json",
            context: "azure-boards milestone_create",
        });
        return this.normalizeEpic(raw);
    }
    async listMilestones() {
        const query = "SELECT [System.Id] FROM WorkItems WHERE " +
            `[System.TeamProject] = '${this.escapeWiql(this.cfg.project)}' ` +
            "AND [System.WorkItemType] = 'Epic'";
        const wiqlRaw = (await this.api("POST", `/${this.projectPath}/_apis/wit/wiql`, { query }, { context: "azure-boards milestone_list_wiql" }));
        const ids = wiqlRaw.workItems.map((w) => w.id).slice(0, MAX_IDS);
        if (ids.length === 0)
            return [];
        const batchRaw = (await this.api("GET", `/${this.projectPath}/_apis/wit/workitems`, undefined, {
            params: { ids: ids.join(",") },
            context: "azure-boards milestone_list_batch",
        }));
        return batchRaw.value.map((w) => this.normalizeEpic(w));
    }
    async completeMilestone(id) {
        const raw = await this.api("PATCH", `/${this.projectPath}/_apis/wit/workitems/${id}`, [
            {
                op: "add",
                path: "/fields/System.State",
                value: this.cfg.states.closed,
            },
        ], {
            contentType: "application/json-patch+json",
            context: "azure-boards milestone_complete",
        });
        return this.normalizeEpic(raw);
    }
    async commentIssue(id, text) {
        const raw = (await this.api("POST", `/${this.projectPath}/_apis/wit/workItems/${id}/comments`, { text }, {
            params: { "api-version": "7.1-preview.4" },
            context: "azure-boards issue_comment",
        }));
        return { id: String(raw.id), url: raw.url };
    }
}
