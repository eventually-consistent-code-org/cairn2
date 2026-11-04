import { execFileSync } from "node:child_process";
import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginate } from "../http.js";
import { runProbe } from "../probe.js";
import { assertCanonicalState, matchesState } from "../types.js";
import { milestonesUnsupported } from "../unsupported.js";
const API = "https://api.github.com";
const WIP_LABEL = "in-progress";
// Repo must be "owner/name" — the lookahead blocks path-traversal strings
// like "../.." from slipping through as a "valid" repo slug.
export const configSchema = z.object({
    repo: z.string().regex(/^(?!.*\.\.)[\w.-]+\/[\w.-]+$/),
});
export function make(config, fetchImpl) {
    return new GitHubTracker(config, fetchImpl);
}
/** Shells out to `gh auth token`; throws when gh is missing or logged out. */
function ghAuthToken() {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}
// Token resolution order: GITHUB_TOKEN, then `gh auth token`. An empty or
// whitespace-only GITHUB_TOKEN counts as unset — the Claude Code plugin
// manifest substitutes an unfilled `${user_config.github_token}` as "" (not a
// dropped key; verified on v2.1.302, 2026-10-17), so without this the gh
// fallback would never run for plugin users who leave the option blank.
// Both parameters are injectable for tests only; the default keeps the literal
// `process.env.GITHUB_TOKEN` spelling the leak-patterns guard scans for (#340).
export function resolveGithubToken(fromEnv = process.env.GITHUB_TOKEN, gh = ghAuthToken) {
    const token = fromEnv?.trim();
    if (token)
        return token;
    try {
        return gh();
    }
    catch {
        throw new CairnError("AUTH_MISSING", "no GitHub credentials", "export GITHUB_TOKEN or run: gh auth login");
    }
}
/** Folds a review requirement into the rule list: the rule name, then the
 *  count when the service states one. */
function pushReviewRules(rules, count) {
    rules.push("pull_request");
    if (typeof count === "number")
        rules.push(`required_reviews:${count}`);
}
/** Rulesets answer: keep the rule types the gate rests on, drop the rest
 *  (status checks, signatures, naming patterns are not the push gate). */
function rulesFromRuleset(ruleset) {
    const rules = [];
    for (const r of ruleset) {
        if (r.type === "pull_request")
            pushReviewRules(rules, r.parameters?.required_approving_review_count);
        else if (r.type === "non_fast_forward" || r.type === "deletion")
            rules.push(r.type);
    }
    return rules;
}
/** Legacy answer: a protected branch blocks force pushes and deletions
 *  unless the matching allow_* toggle is on, so an absent toggle reads as
 *  the rule being in force. */
function rulesFromLegacy(p) {
    const rules = [];
    if (p.required_pull_request_reviews) {
        pushReviewRules(rules, p.required_pull_request_reviews.required_approving_review_count);
    }
    if (p.allow_force_pushes?.enabled !== true)
        rules.push("non_fast_forward");
    if (p.allow_deletions?.enabled !== true)
        rules.push("deletion");
    return rules;
}
export class GitHubTracker {
    cfg;
    fetchImpl;
    tokenProvider;
    capabilities = {
        hasInProgress: true, // via label convention
        hasPhases: true, hasPhaseReassign: true, hasDependencies: false, hasLabels: true,
        hasMilestones: false, hasPhaseClose: true, hasComments: true, hasWorklog: false,
        hasEstimates: false,
        hasIssueAttachments: false,
    };
    constructor(cfg, fetchImpl = fetch, tokenProvider = resolveGithubToken) {
        this.cfg = cfg;
        this.fetchImpl = fetchImpl;
        this.tokenProvider = tokenProvider;
    }
    headers() {
        return {
            authorization: `Bearer ${this.tokenProvider()}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
        };
    }
    async api(method, path, body) {
        return fetchJson(this.fetchImpl, `${API}${path}`, {
            method,
            headers: this.headers(),
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }
    assertId(id) {
        if (!/^\d+$/.test(id)) {
            throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`, "issue id must be a numeric string");
        }
    }
    self;
    async resolveSelf() {
        if (this.self)
            return this.self;
        const me = await this.api("GET", "/user");
        this.self = me.login;
        return this.self;
    }
    /** Preflight: /repos/{repo} over resolveSelf's /user -- /user only proves
     *  the token is valid, not that the configured repo exists. One cheap
     *  call, same cost, but a typo'd repo now 404s instead of reading "ok". */
    async probe() {
        return runProbe(async () => {
            // The same call carries the default branch; remember it so the
            // branch-protection read (#485) does not ask twice.
            const repo = await this.api("GET", `/repos/${this.cfg.repo}`);
            if (typeof repo.default_branch === "string")
                this.defaultBranch = repo.default_branch;
        });
    }
    defaultBranch;
    async resolveDefaultBranch() {
        if (this.defaultBranch)
            return this.defaultBranch;
        const repo = await this.api("GET", `/repos/${this.cfg.repo}`);
        if (typeof repo.default_branch !== "string") {
            throw new CairnError("TRACKER_DOWN", `no default_branch in the /repos/${this.cfg.repo} response`);
        }
        this.defaultBranch = repo.default_branch;
        return this.defaultBranch;
    }
    /** What the service enforces on the default branch (#485): the rulesets
     *  endpoint first, legacy branch protection when rulesets come back
     *  empty. A read that fails is `source: "unreadable: <reason>"` with no
     *  rules -- never an empty list dressed as a measurement (claims rule 2).
     *  Endpoint shapes (rule `type` names, `required_approving_review_count`,
     *  the legacy `allow_*` toggles, the 404 "Branch not protected" answer for
     *  an unprotected branch) are a dated claim: as of 2026-11, per the GitHub
     *  REST reference. Asserted against fixtures by github.unit.test.ts. */
    async branchProtection() {
        let branch = "unknown";
        try {
            branch = await this.resolveDefaultBranch();
            const base = `/repos/${this.cfg.repo}`;
            const seg = encodeURIComponent(branch);
            const ruleset = await this.api("GET", `${base}/rules/branches/${seg}`);
            if (Array.isArray(ruleset) && ruleset.length > 0) {
                return { default: branch, rules: rulesFromRuleset(ruleset), source: "rulesets" };
            }
            try {
                const legacy = await this.api("GET", `${base}/branches/${seg}/protection`);
                return { default: branch, rules: rulesFromLegacy(legacy), source: "legacy" };
            }
            catch (e) {
                // GitHub's own spelling of "no protection here" is a 404 whose body
                // says so -- that one is a measured empty, every other failure is not.
                if (e instanceof CairnError && e.code === "NOT_FOUND" && /branch not protected/i.test(e.message)) {
                    return { default: branch, rules: [], source: "legacy" };
                }
                throw e;
            }
        }
        catch (e) {
            const reason = e instanceof CairnError ? e.message : String(e);
            return { default: branch, rules: [], source: `unreadable: ${reason}` };
        }
    }
    normalize(raw) {
        const labels = raw.labels.map((l) => l.name);
        let category = raw.state === "closed" ? "closed" : "open";
        if (category === "open" && labels.includes(WIP_LABEL))
            category = "in_progress";
        return {
            id: String(raw.number), title: raw.title, body: raw.body ?? "",
            state: category, category, labels: labels.filter((l) => l !== WIP_LABEL),
            phase: raw.milestone ? String(raw.milestone.number) : undefined,
            assignee: raw.assignee?.login,
            updatedAt: raw.updated_at, url: raw.html_url,
        };
    }
    async createIssue(input) {
        if (input.phase && !/^\d+$/.test(input.phase)) {
            throw new CairnError("CONFIG_INVALID", `invalid phase: ${input.phase}`, "phase must be a numeric string");
        }
        const body = {
            title: input.title, body: input.body ?? "", labels: input.labels ?? [],
        };
        if (input.phase)
            body.milestone = Number(input.phase);
        const raw = await this.api("POST", `/repos/${this.cfg.repo}/issues`, body);
        return this.normalize(raw);
    }
    async getIssue(id) {
        this.assertId(id);
        const raw = await this.api("GET", `/repos/${this.cfg.repo}/issues/${id}`);
        return this.normalize(raw);
    }
    async updateIssue(id, patch) {
        this.assertId(id);
        const body = {};
        if (patch.title !== undefined)
            body.title = patch.title;
        // Re-phase: same mapping as createIssue — milestone number.
        if (patch.phase && !/^\d+$/.test(patch.phase)) {
            throw new CairnError("CONFIG_INVALID", `invalid phase: ${patch.phase}`, "phase must be a numeric string");
        }
        if (patch.phase)
            body.milestone = Number(patch.phase);
        assertCanonicalState(patch.state, "github");
        if (patch.body !== undefined)
            body.body = patch.body;
        if (patch.labels !== undefined)
            body.labels = patch.labels;
        if (patch.assignee !== undefined)
            body.assignees = [patch.assignee];
        if (patch.state === "closed")
            body.state = "closed";
        if (patch.state === "open") {
            const current = patch.labels
                ? patch.labels.filter((l) => l !== WIP_LABEL)
                : (await this.getIssue(id)).labels;
            body.state = "open";
            body.labels = current;
        }
        if (patch.state === "in_progress") {
            const current = patch.labels ?? (await this.getIssue(id)).labels;
            body.state = "open";
            body.labels = [...new Set([...current, WIP_LABEL])];
        }
        const raw = await this.api("PATCH", `/repos/${this.cfg.repo}/issues/${id}`, body);
        return this.normalize(raw);
    }
    async closeIssue(id) {
        return this.updateIssue(id, { state: "closed" });
    }
    async listIssues(filter) {
        const params = new URLSearchParams({ state: "all", per_page: "100" });
        if (filter?.phase)
            params.set("milestone", filter.phase);
        const raw = (await paginate(this.fetchImpl, `${API}/repos/${this.cfg.repo}/issues?${params}`, { method: "GET", headers: this.headers() }, { context: "github issue_list" }));
        let issues = raw.filter((r) => !("pull_request" in r)).map((r) => this.normalize(r));
        if (filter?.state)
            issues = issues.filter((i) => matchesState(i, filter.state));
        return issues;
    }
    async createPhase(name) {
        const raw = (await this.api("POST", `/repos/${this.cfg.repo}/milestones`, { title: name }));
        return { id: String(raw.number), name: raw.title,
            state: raw.state === "closed" ? "closed" : "open" };
    }
    async listPhases() {
        const raw = (await paginate(this.fetchImpl, `${API}/repos/${this.cfg.repo}/milestones?state=all`, { method: "GET", headers: this.headers() }, { context: "github phase_list" }));
        return raw.map((m) => ({ id: String(m.number), name: m.title,
            state: m.state === "closed" ? "closed" : "open" }));
    }
    async closePhase(id) {
        this.assertId(id);
        const raw = (await this.api("PATCH", `/repos/${this.cfg.repo}/milestones/${id}`, { state: "closed" }));
        return { id: String(raw.number), name: raw.title,
            state: raw.state === "closed" ? "closed" : "open" };
    }
    async createMilestone(_name) { return milestonesUnsupported("github"); }
    async listMilestones() { return milestonesUnsupported("github"); }
    async completeMilestone(_id) { return milestonesUnsupported("github"); }
    async commentIssue(id, text) {
        this.assertId(id);
        const raw = (await this.api("POST", `/repos/${this.cfg.repo}/issues/${id}/comments`, { body: text }));
        return { id: String(raw.id), url: raw.html_url };
    }
}
