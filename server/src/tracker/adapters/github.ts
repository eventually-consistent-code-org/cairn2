import { execFileSync } from "node:child_process";
import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, paginate, type FetchLike } from "../http.js";
import { runProbe } from "../probe.js";
import type {
  Capability, StateCategory, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase,
  ProbeResult, Tracker,
} from "../types.js";
import { assertCanonicalState, matchesState } from "../types.js";
import { milestonesUnsupported, phaseCloseUnsupported } from "../unsupported.js";

const API = "https://api.github.com";
const WIP_LABEL = "in-progress";

// Repo must be "owner/name" — the lookahead blocks path-traversal strings
// like "../.." from slipping through as a "valid" repo slug.
export const configSchema = z.object({
  repo: z.string().regex(/^(?!.*\.\.)[\w.-]+\/[\w.-]+$/),
});

export function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker {
  return new GitHubTracker(config, fetchImpl);
}

/** Shells out to `gh auth token`; throws when gh is missing or logged out. */
function ghAuthToken(): string {
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

// Token resolution order: GITHUB_TOKEN, then `gh auth token`. An empty or
// whitespace-only GITHUB_TOKEN counts as unset — the Claude Code plugin
// manifest substitutes an unfilled `${user_config.github_token}` as "" (not a
// dropped key; verified on v2.1.302, 2026-10-17), so without this the gh
// fallback would never run for plugin users who leave the option blank.
// Both parameters are injectable for tests only; the default keeps the literal
// `process.env.GITHUB_TOKEN` spelling the leak-patterns guard scans for (#340).
export function resolveGithubToken(
  fromEnv: string | undefined = process.env.GITHUB_TOKEN,
  gh: () => string = ghAuthToken,
): string {
  const token = fromEnv?.trim();
  if (token) return token;
  try {
    return gh();
  } catch {
    throw new CairnError("AUTH_MISSING", "no GitHub credentials",
      "export GITHUB_TOKEN or run: gh auth login");
  }
}

interface GhIssue {
  number: number; title: string; body: string | null; state: string;
  labels: Array<{ name: string }>; milestone: { number: number } | null;
  assignee: { login: string } | null; updated_at: string; html_url: string;
  pull_request?: unknown;
}

export class GitHubTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, // via label convention
    hasPhases: true, hasPhaseReassign: true, hasDependencies: false, hasLabels: true,
    hasMilestones: false, hasPhaseClose: true, hasComments: true, hasWorklog: false,
    hasEstimates: false,
    hasIssueAttachments: false,
  };

  constructor(
    private readonly cfg: { repo: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenProvider: () => string = resolveGithubToken,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.tokenProvider()}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    };
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    return fetchJson(this.fetchImpl, `${API}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private assertId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new CairnError("NOT_FOUND", `invalid issue id: ${id}`,
        "issue id must be a numeric string");
    }
  }

  private self: string | undefined;

  async resolveSelf(): Promise<string | undefined> {
    if (this.self) return this.self;
    const me = await this.api("GET", "/user") as { login?: string };
    this.self = me.login;
    return this.self;
  }

  /** Preflight: /repos/{repo} over resolveSelf's /user -- /user only proves
   *  the token is valid, not that the configured repo exists. One cheap
   *  call, same cost, but a typo'd repo now 404s instead of reading "ok". */
  async probe(): Promise<ProbeResult> {
    return runProbe(() => this.api("GET", `/repos/${this.cfg.repo}`));
  }

  private normalize(raw: GhIssue): Issue {
    const labels = raw.labels.map((l) => l.name);
    let category: StateCategory = raw.state === "closed" ? "closed" : "open";
    if (category === "open" && labels.includes(WIP_LABEL)) category = "in_progress";
    return {
      id: String(raw.number), title: raw.title, body: raw.body ?? "",
      state: category, category, labels: labels.filter((l) => l !== WIP_LABEL),
      phase: raw.milestone ? String(raw.milestone.number) : undefined,
      assignee: raw.assignee?.login,
      updatedAt: raw.updated_at, url: raw.html_url,
    };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    if (input.phase && !/^\d+$/.test(input.phase)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid phase: ${input.phase}`,
        "phase must be a numeric string");
    }
    const body: Record<string, unknown> = {
      title: input.title, body: input.body ?? "", labels: input.labels ?? [],
    };
    if (input.phase) body.milestone = Number(input.phase);
    const raw = await this.api("POST", `/repos/${this.cfg.repo}/issues`, body);
    return this.normalize(raw as GhIssue);
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api("GET", `/repos/${this.cfg.repo}/issues/${id}`);
    return this.normalize(raw as GhIssue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    this.assertId(id);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    // Re-phase: same mapping as createIssue — milestone number.
    if (patch.phase && !/^\d+$/.test(patch.phase)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid phase: ${patch.phase}`,
        "phase must be a numeric string");
    }
    if (patch.phase) body.milestone = Number(patch.phase);
    assertCanonicalState(patch.state, "github");
    if (patch.body !== undefined) body.body = patch.body;
    if (patch.labels !== undefined) body.labels = patch.labels;
    if (patch.assignee !== undefined) body.assignees = [patch.assignee];
    if (patch.state === "closed") body.state = "closed";
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
    return this.normalize(raw as GhIssue);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const params = new URLSearchParams({ state: "all", per_page: "100" });
    if (filter?.phase) params.set("milestone", filter.phase);
    const raw = (await paginate(
      this.fetchImpl, `${API}/repos/${this.cfg.repo}/issues?${params}`,
      { method: "GET", headers: this.headers() },
      { context: "github issue_list" },
    )) as GhIssue[];
    let issues = raw.filter((r) => !("pull_request" in r)).map((r) => this.normalize(r));
    if (filter?.state) issues = issues.filter((i) => matchesState(i, filter.state!));
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const raw = (await this.api("POST", `/repos/${this.cfg.repo}/milestones`,
      { title: name })) as { number: number; title: string; state: string };
    return { id: String(raw.number), name: raw.title,
      state: raw.state === "closed" ? "closed" : "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await paginate(
      this.fetchImpl, `${API}/repos/${this.cfg.repo}/milestones?state=all`,
      { method: "GET", headers: this.headers() },
      { context: "github phase_list" },
    )) as Array<{ number: number; title: string; state: string }>;
    return raw.map((m) => ({ id: String(m.number), name: m.title,
      state: m.state === "closed" ? "closed" : "open" }));
  }

  async closePhase(id: string): Promise<Phase> {
    this.assertId(id);
    const raw = (await this.api("PATCH", `/repos/${this.cfg.repo}/milestones/${id}`,
      { state: "closed" })) as { number: number; title: string; state: string };
    return { id: String(raw.number), name: raw.title,
      state: raw.state === "closed" ? "closed" : "open" };
  }
  async createMilestone(_name: string): Promise<Milestone> { return milestonesUnsupported("github"); }
  async listMilestones(): Promise<Milestone[]> { return milestonesUnsupported("github"); }
  async completeMilestone(_id: string): Promise<Milestone> { return milestonesUnsupported("github"); }
  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    this.assertId(id);
    const raw = (await this.api("POST", `/repos/${this.cfg.repo}/issues/${id}/comments`,
      { body: text })) as { id: number; html_url?: string };
    return { id: String(raw.id), url: raw.html_url };
  }
}
