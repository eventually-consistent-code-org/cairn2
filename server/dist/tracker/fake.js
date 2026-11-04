import { CairnError } from "../errors.js";
import { matchesState } from "./types.js";
export class FakeTracker {
    states;
    capabilities = {
        hasInProgress: true, hasPhases: true, hasPhaseReassign: true, hasDependencies: true, hasLabels: true,
        hasMilestones: true, hasPhaseClose: true, hasComments: true, hasWorklog: false,
        hasEstimates: true,
        hasIssueAttachments: true,
    };
    issues = new Map();
    phases = new Map();
    milestones = new Map();
    issueComments = new Map();
    /** Clock for comment timestamps -- tests move it to put minutes between a
     *  claim comment and the close without waiting for them (#232). */
    now = () => new Date();
    issueAttachments = new Map();
    seq = 0;
    /** Custom state vocabulary, name → category, the local adapter's shape:
     *  a test hands the server a tracker whose in-progress or closed state
     *  has a display name (#427). Empty by default -- the canonical three. */
    constructor(states = {}) {
        this.states = states;
    }
    stateCategory(state) {
        if (state === "open" || state === "in_progress" || state === "closed")
            return state;
        return this.states[state];
    }
    async attachFile(id, filename, _data, _mediaType) {
        await this.getIssue(id);
        const names = this.issueAttachments.get(id) ?? [];
        names.push(filename);
        this.issueAttachments.set(id, names);
        return { id: `att-${names.length}` };
    }
    async createIssue(input) {
        const id = `FAKE-${++this.seq}`;
        const issue = {
            id, title: input.title, body: input.body ?? "", state: "open", category: "open",
            labels: input.labels ?? [], phase: input.phase, estimate: input.estimate,
            updatedAt: new Date().toISOString(), url: `fake://issue/${id}`,
        };
        this.issues.set(id, issue);
        return { ...issue };
    }
    async getIssue(id) {
        const i = this.issues.get(id);
        if (!i)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        return { ...i };
    }
    async updateIssue(id, patch) {
        const i = await this.getIssue(id);
        const next = {
            ...i,
            title: patch.title ?? i.title,
            body: patch.body ?? i.body,
            state: (patch.state ?? i.state),
            category: patch.state === undefined
                ? i.category
                : (this.stateCategory(patch.state) ?? i.category),
            labels: patch.labels ?? i.labels,
            assignee: patch.assignee ?? i.assignee,
            estimate: patch.estimate ?? i.estimate,
            phase: patch.phase ?? i.phase,
            updatedAt: new Date().toISOString(),
        };
        this.issues.set(id, next);
        return { ...next };
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        return [...this.issues.values()]
            .filter((i) => (filter?.phase ? i.phase === filter.phase : true))
            .filter((i) => (filter?.state ? matchesState(i, filter.state) : true))
            .map((i) => ({ ...i }));
    }
    async createPhase(name) {
        const id = `FP-${++this.seq}`;
        const p = { id, name, state: "open" };
        this.phases.set(id, p);
        return { ...p };
    }
    async listPhases() {
        return [...this.phases.values()].map((p) => ({ ...p }));
    }
    async closePhase(id) {
        const p = this.phases.get(id);
        if (!p)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        const next = { ...p, state: "closed" };
        this.phases.set(id, next);
        return { ...next };
    }
    async createMilestone(name) {
        const id = `FM-${++this.seq}`;
        const m = { id, name, state: "open", url: `fake://milestone/${id}` };
        this.milestones.set(id, m);
        return { ...m };
    }
    async listMilestones() {
        return [...this.milestones.values()].map((m) => ({ ...m }));
    }
    async completeMilestone(id) {
        const m = this.milestones.get(id);
        if (!m)
            throw new CairnError("NOT_FOUND", `not found: ${id}`);
        const next = { ...m, state: "released" };
        this.milestones.set(id, next);
        return { ...next };
    }
    async commentIssue(id, text) {
        await this.getIssue(id); // NOT_FOUND on unknown
        const list = this.issueComments.get(id) ?? [];
        const comment = { id: `FC-${++this.seq}`, text, at: this.now().toISOString() };
        list.push(comment);
        this.issueComments.set(id, list);
        return { id: comment.id, url: `fake://comment/${comment.id}` };
    }
    async resolveSelf() {
        return "fake-user";
    }
    async probe() {
        return { verdict: "ok" };
    }
    links = [];
    wouldCycle(from, type, to) {
        if (type !== "blocks" && type !== "parent-of")
            return false;
        // walk from `to` along same-type edges; hitting `from` closes a cycle
        const seen = new Set();
        const stack = [to];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === from)
                return true;
            if (seen.has(cur))
                continue;
            seen.add(cur);
            for (const l of this.links)
                if (l.from === cur && l.type === type)
                    stack.push(l.to);
        }
        return false;
    }
    async linkIssues(from, type, to) {
        await this.getIssue(from);
        await this.getIssue(to);
        if (this.wouldCycle(from, type, to)) {
            throw new CairnError("CONFIG_INVALID", `link ${from} ${type} ${to} would create a cycle`);
        }
        if (!this.links.some((l) => l.from === from && l.type === type && l.to === to)) {
            this.links.push({ from, type, to });
        }
    }
    async unlinkIssues(from, type, to) {
        this.links = this.links.filter((l) => !(l.from === from && l.type === type && l.to === to));
    }
    async listLinks(id) {
        return id === undefined ? [...this.links]
            : this.links.filter((l) => l.from === id || l.to === id);
    }
    async listComments(id) {
        return (this.issueComments.get(id) ?? []).map((c) => ({ text: c.text, at: c.at }));
    }
    /** Test accessor: comments posted to an issue, in order. */
    comments(id) {
        return [...(this.issueComments.get(id) ?? [])];
    }
}
