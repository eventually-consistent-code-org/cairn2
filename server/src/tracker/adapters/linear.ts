import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import { runProbe } from "../probe.js";
import type {
  Capability, StateCategory, Issue, IssueCreate, IssueLink, IssuePatch, IssueState, LinkType,
  Milestone, Phase, ProbeResult, Tracker,
} from "../types.js";
import { matchesState } from "../types.js";
import { milestonesUnsupported } from "../unsupported.js";

const API = "https://api.linear.app/graphql";
const LIST_CAP = 100;

export const configSchema = z.object({
  teamId: z.string().min(1),
  apiKeyEnv: z.string().default("LINEAR_API_KEY"),
});

export function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker {
  return new LinearTracker(config, fetchImpl);
}

// Every issue read goes through this one shape — queries share the fragment.
const ISSUE_FIELDS = `fragment IssueFields on Issue {
  id identifier title description url updatedAt
  state { name type }
  labels { nodes { name } }
  project { id }
  assignee { displayName }
}`;

interface LinearIssueNode {
  id: string; identifier: string; title: string; description: string | null;
  url: string; updatedAt: string;
  state: { name?: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  project: { id: string } | null;
  assignee: { displayName: string } | null;
}

interface LinearStateNode { id: string; name: string; type: string; position: number }

interface LinearProjectNode { id: string; name: string; state: string }

export class LinearTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true, hasPhases: true, hasPhaseReassign: true, hasDependencies: true, hasLabels: true,
    hasMilestones: false, hasPhaseClose: true, hasComments: true, hasWorklog: false,
    hasEstimates: false,
    hasIssueAttachments: false,
  };

  // Lazy per-instance caches — a team's workflow states and label ids are
  // stable for the life of a server process; one query each, then reuse.
  private statesCache: LinearStateNode[] | undefined;
  private labelCache = new Map<string, string>();

  constructor(
    private readonly cfg: { teamId: string; apiKeyEnv: string },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly keyProvider: () => string = () => resolveLinearKey(cfg.apiKeyEnv),
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>, context: string): Promise<T> {
    const raw = await fetchJson(this.fetchImpl, API, {
      method: "POST",
      // Linear personal API keys go in raw — Bearer prefix is OAuth-only.
      headers: { authorization: this.keyProvider(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    }, { context: `linear ${context}` });
    const { data, errors } = raw as {
      data?: T; errors?: Array<{ message: string }>;
    };
    if (errors?.length) {
      const msg = errors[0].message;
      if (/not found|could not find/i.test(msg)) {
        throw new CairnError("NOT_FOUND", `linear ${context}: ${msg}`);
      }
      throw new CairnError("TRACKER_DOWN", `linear ${context}: ${msg}`);
    }
    return data as T;
  }

  /** Preflight: team(id) over a bare {viewer{id}} -- viewer only proves the
   *  API key is valid, not that the configured teamId exists. A typo'd
   *  teamId now comes back as a GraphQL not-found error (-> bad_host)
   *  instead of reading "ok". */
  async probe(): Promise<ProbeResult> {
    return runProbe(() => this.gql<{ team: { id: string } }>(
      `query Team($teamId: String!) { team(id: $teamId) { id } }`,
      { teamId: this.cfg.teamId }, "probe"));
  }

  // Workflow state names Linear has shown this instance, lowercased, with
  // the category their type buckets to -- filled by every issue read and by
  // the team states fetch, so the pre-write question below answers from
  // data already fetched and never fetches for itself (#471).
  private readonly seenStates = new Map<string, StateCategory>();

  /** Linear's state.type → the semantic bucket: completed and canceled are
   *  closed, started is in progress, unstarted/backlog/triage are open. */
  private static categoryOfType(type: string): StateCategory {
    return type === "completed" || type === "canceled" ? "closed"
      : type === "started" ? "in_progress" : "open";
  }

  private learnState(name: string | undefined, type: string): void {
    if (name) this.seenStates.set(name.toLowerCase(), LinearTracker.categoryOfType(type));
  }

  /** The SPI's pre-write question (#427, #471): the canonical three by name;
   *  any other name only once Linear has shown it with its type, on an
   *  issue read or the team states fetch. undefined otherwise: the freeze
   *  gate then falls closed rather than letting the name through. Case-
   *  insensitive, as stateId matches. Asserted by linear.unit.test.ts and
   *  tracker-contract.test.ts. */
  stateCategory(state: IssueState): StateCategory | undefined {
    if (state === "open" || state === "in_progress" || state === "closed") return state;
    return this.seenStates.get(state.toLowerCase());
  }

  private normalize(raw: LinearIssueNode): Issue {
    const type = raw.state.type;
    const category = LinearTracker.categoryOfType(type);
    this.learnState(raw.state.name, type);
    return {
      id: raw.identifier, title: raw.title, body: raw.description ?? "",
      state: raw.state.name ?? category,
      category,
      labels: raw.labels.nodes.map((l) => l.name),
      phase: raw.project?.id,
      assignee: raw.assignee?.displayName,
      updatedAt: raw.updatedAt,
      url: raw.url,
    };
  }

  /** Team workflow states, fetched once. */
  private async states(): Promise<LinearStateNode[]> {
    if (!this.statesCache) {
      const data = await this.gql<{ team: { states: { nodes: LinearStateNode[] } } }>(
        `query States($teamId: String!) { team(id: $teamId) { states { nodes { id name type position } } } }`,
        { teamId: this.cfg.teamId }, "states");
      this.statesCache = data.team.states.nodes;
      for (const s of this.statesCache) this.learnState(s.name, s.type);
    }
    return this.statesCache;
  }

  /** SPI state → a team stateId: canonical three by bucket, anything else
   *  matched against the team's workflow state names (CRN-26). */
  private async stateId(state: IssueState): Promise<string> {
    const all = await this.states();
    const byType = (t: string) =>
      all.filter((s) => s.type === t).sort((a, b) => a.position - b.position)[0];
    const hit = state === "closed" ? byType("completed")
      : state === "in_progress" ? byType("started")
        : state === "open" ? byType("unstarted") ?? byType("backlog")
          : all.find((s) => s.name.toLowerCase() === state.toLowerCase());
    if (!hit) {
      throw new CairnError("CONFIG_INVALID",
        `linear team ${this.cfg.teamId} has no workflow state '${state}'`,
        `team states: ${all.map((s) => s.name).join(", ") || "none"} — or use open/in_progress/closed`);
    }
    return hit.id;
  }

  /** Label names → ids, find-or-create against the team. */
  private async labelIds(names: string[]): Promise<string[]> {
    const missing = names.filter((n) => !this.labelCache.has(n));
    if (missing.length) {
      const data = await this.gql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query Labels($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`,
        { teamId: this.cfg.teamId }, "labels");
      for (const l of data.team.labels.nodes) this.labelCache.set(l.name, l.id);
      for (const name of names.filter((n) => !this.labelCache.has(n))) {
        const created = await this.gql<{ issueLabelCreate: { issueLabel: { id: string; name: string } } }>(
          `mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }`,
          { input: { name, teamId: this.cfg.teamId } }, "label_create");
        this.labelCache.set(created.issueLabelCreate.issueLabel.name, created.issueLabelCreate.issueLabel.id);
      }
    }
    return names.map((n) => this.labelCache.get(n)!);
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const gqlInput: Record<string, unknown> = {
      teamId: this.cfg.teamId, title: input.title, description: input.body ?? "",
    };
    if (input.labels?.length) gqlInput.labelIds = await this.labelIds(input.labels);
    if (input.phase) gqlInput.projectId = input.phase;
    const data = await this.gql<{ issueCreate: { issue: LinearIssueNode } }>(
      `${ISSUE_FIELDS} mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ...IssueFields } } }`,
      { input: gqlInput }, "issue_create");
    return this.normalize(data.issueCreate.issue);
  }

  async getIssue(id: string): Promise<Issue> {
    const data = await this.gql<{ issue: LinearIssueNode }>(
      `${ISSUE_FIELDS} query Issue($id: String!) { issue(id: $id) { ...IssueFields } }`,
      { id }, "issue_get");
    return this.normalize(data.issue);
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    const input: Record<string, unknown> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.body !== undefined) input.description = patch.body;
    if (patch.state !== undefined) input.stateId = await this.stateId(patch.state);
    if (patch.labels !== undefined) input.labelIds = await this.labelIds(patch.labels);
    // Re-phase: same mapping as createIssue — projectId.
    if (patch.phase) input.projectId = patch.phase;
    const data = await this.gql<{ issueUpdate: { issue: LinearIssueNode } }>(
      `${ISSUE_FIELDS} mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ...IssueFields } } }`,
      { id, input }, "issue_update");
    return this.normalize(data.issueUpdate.issue);
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const gqlFilter: Record<string, unknown> = { team: { id: { eq: this.cfg.teamId } } };
    if (filter?.phase) gqlFilter.project = { id: { eq: filter.phase } };
    const data = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
      `${ISSUE_FIELDS} query Issues($filter: IssueFilter, $first: Int!) { issues(filter: $filter, first: $first) { nodes { ...IssueFields } } }`,
      { filter: gqlFilter, first: LIST_CAP }, "issue_list");
    if (data.issues.nodes.length === LIST_CAP) {
      console.error(`[cairn] linear issue_list truncated at ${LIST_CAP} items for team ${this.cfg.teamId}`);
    }
    let issues = data.issues.nodes.map((n) => this.normalize(n));
    if (filter?.state) issues = issues.filter((i) => matchesState(i, filter.state!));
    return issues;
  }

  // A cairn phase is a Linear Project — named container, native close state.
  private normalizePhase(raw: LinearProjectNode): Phase {
    return {
      id: raw.id, name: raw.name,
      state: raw.state === "completed" || raw.state === "canceled" ? "closed" : "open",
    };
  }

  async createPhase(name: string): Promise<Phase> {
    const data = await this.gql<{ projectCreate: { project: LinearProjectNode } }>(
      `mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id name state } } }`,
      { input: { name, teamIds: [this.cfg.teamId] } }, "phase_create");
    return this.normalizePhase(data.projectCreate.project);
  }

  async listPhases(): Promise<Phase[]> {
    const data = await this.gql<{ team: { projects: { nodes: LinearProjectNode[] } } }>(
      `query Projects($teamId: String!) { team(id: $teamId) { projects { nodes { id name state } } } }`,
      { teamId: this.cfg.teamId }, "phase_list");
    return data.team.projects.nodes.map((p) => this.normalizePhase(p));
  }

  /** Org project statuses, fetched once — close writes the 'completed' one. */
  private completedStatusCache: string | undefined;
  private async completedStatusId(): Promise<string> {
    if (!this.completedStatusCache) {
      const data = await this.gql<{ organization: { projectStatuses: { nodes: Array<{ id: string; type: string }> } } }>(
        `query ProjectStatuses { organization { projectStatuses { nodes { id type } } } }`,
        {}, "project_statuses");
      const hit = data.organization.projectStatuses.nodes.find((s) => s.type === "completed");
      if (!hit) {
        throw new CairnError("CONFIG_INVALID",
          "linear organization has no 'completed' project status",
          "check project statuses in Linear workspace settings");
      }
      this.completedStatusCache = hit.id;
    }
    return this.completedStatusCache;
  }

  async closePhase(id: string): Promise<Phase> {
    const statusId = await this.completedStatusId();
    const data = await this.gql<{ projectUpdate: { project: LinearProjectNode } }>(
      `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { project { id name state } } }`,
      { id, input: { statusId } }, "phase_close");
    return this.normalizePhase(data.projectUpdate.project);
  }

  async createMilestone(_name: string): Promise<Milestone> { return milestonesUnsupported("linear"); }
  async listMilestones(): Promise<Milestone[]> { return milestonesUnsupported("linear"); }
  async completeMilestone(_id: string): Promise<Milestone> { return milestonesUnsupported("linear"); }

  /** Identifier (ENG-123) → internal UUID; free NOT_FOUND on missing issues. */
  private async uuid(id: string): Promise<string> {
    const data = await this.gql<{ issue: { id: string } }>(
      `query IssueId($id: String!) { issue(id: $id) { id } }`, { id }, "issue_resolve");
    return data.issue.id;
  }

  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    const issueId = await this.uuid(id);
    const data = await this.gql<{ commentCreate: { comment: { id: string; url?: string } } }>(
      `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id url } } }`,
      { input: { issueId, body: text } }, "issue_comment");
    return { id: data.commentCreate.comment.id, url: data.commentCreate.comment.url };
  }

  // Links — blocks/related are native issue relations, parent-of is Linear's
  // sub-issue parent. supersedes has no Linear equivalent and stays honest
  // about it. Relation ownership: each relation lives on its `from` issue;
  // inverse direction is derived at read time, never stored twice.

  private static readonly RELATION_TYPE: Partial<Record<LinkType, string>> = {
    blocks: "blocks", "relates-to": "related",
  };
  private static readonly FROM_RELATION_TYPE: Record<string, LinkType | undefined> = {
    blocks: "blocks", related: "relates-to",
  };

  async linkIssues(from: string, type: LinkType, to: string): Promise<void> {
    if (type === "supersedes") {
      throw new CairnError("UNSUPPORTED", "linear has no supersedes relation",
        "migration and verbs fall back to a text backlink for this link type");
    }
    if (type === "parent-of") {
      const parentId = await this.uuid(from);
      await this.gql(
        `mutation SetParent($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: to, input: { parentId } }, "issue_link");
      return;
    }
    const issueId = await this.uuid(from);
    const relatedIssueId = await this.uuid(to);
    if (type === "blocks") {
      // Linear happily stores circular blocks — the cairn contract doesn't.
      const blocks = (await this.listLinks()).filter((l) => l.type === "blocks");
      const stack = [to];
      const seen = new Set<string>();
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === from) {
          throw new CairnError("CONFIG_INVALID",
            `link ${from} blocks ${to} would create a dependency cycle`,
            "break the existing chain first");
        }
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const l of blocks) if (l.from === cur) stack.push(l.to);
      }
    }
    await this.gql(
      `mutation RelationCreate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { issueRelation { id } } }`,
      { input: { issueId, relatedIssueId, type: LinearTracker.RELATION_TYPE[type] } },
      "issue_link");
  }

  async unlinkIssues(from: string, type: LinkType, to: string): Promise<void> {
    if (type === "parent-of") {
      await this.gql(
        `mutation ClearParent($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: to, input: { parentId: null } }, "issue_unlink");
      return;
    }
    const links = await this.issueLinksRaw(from);
    const hit = links.relations.nodes.find((r) =>
      LinearTracker.FROM_RELATION_TYPE[r.type] === type && r.relatedIssue.identifier === to);
    if (!hit) {
      throw new CairnError("NOT_FOUND", `no ${type} link from ${from} to ${to}`);
    }
    await this.gql(
      `mutation RelationDelete($id: String!) { issueRelationDelete(id: $id) { success } }`,
      { id: hit.id }, "issue_unlink");
  }

  private async issueLinksRaw(id: string): Promise<{
    identifier: string;
    parent: { identifier: string } | null;
    children: { nodes: Array<{ identifier: string }> };
    relations: { nodes: Array<{ id: string; type: string; relatedIssue: { identifier: string } }> };
    inverseRelations: { nodes: Array<{ id: string; type: string; issue: { identifier: string } }> };
  }> {
    const data = await this.gql<{ issue: Awaited<ReturnType<LinearTracker["issueLinksRaw"]>> }>(
      `query IssueLinks($id: String!) { issue(id: $id) {
        identifier
        parent { identifier }
        children { nodes { identifier } }
        relations { nodes { id type relatedIssue { identifier } } }
        inverseRelations { nodes { id type issue { identifier } } }
      } }`, { id }, "issue_links");
    return data.issue;
  }

  async listLinks(id?: string): Promise<IssueLink[]> {
    const out: IssueLink[] = [];
    if (id !== undefined) {
      const raw = await this.issueLinksRaw(id);
      const self = raw.identifier;
      for (const r of raw.relations.nodes) {
        const type = LinearTracker.FROM_RELATION_TYPE[r.type];
        if (type) out.push({ from: self, type, to: r.relatedIssue.identifier });
      }
      for (const r of raw.inverseRelations.nodes) {
        const type = LinearTracker.FROM_RELATION_TYPE[r.type];
        if (type) out.push({ from: r.issue.identifier, type, to: self });
      }
      if (raw.parent) out.push({ from: raw.parent.identifier, type: "parent-of", to: self });
      for (const c of raw.children.nodes) out.push({ from: self, type: "parent-of", to: c.identifier });
      return out;
    }
    const data = await this.gql<{ issues: { nodes: Array<{
      identifier: string;
      parent: { identifier: string } | null;
      relations: { nodes: Array<{ id: string; type: string; relatedIssue: { identifier: string } }> };
    }> } }>(
      `query TeamLinks($filter: IssueFilter, $first: Int!) { issues(filter: $filter, first: $first) { nodes {
        identifier
        parent { identifier }
        relations { nodes { id type relatedIssue { identifier } } }
      } } }`,
      { filter: { team: { id: { eq: this.cfg.teamId } } }, first: LIST_CAP }, "issue_links");
    if (data.issues.nodes.length === LIST_CAP) {
      console.error(`[cairn] linear issue_links truncated at ${LIST_CAP} issues for team ${this.cfg.teamId}`);
    }
    for (const n of data.issues.nodes) {
      for (const r of n.relations.nodes) {
        const type = LinearTracker.FROM_RELATION_TYPE[r.type];
        if (type) out.push({ from: n.identifier, type, to: r.relatedIssue.identifier });
      }
      if (n.parent) out.push({ from: n.parent.identifier, type: "parent-of", to: n.identifier });
    }
    return out;
  }
}

export function resolveLinearKey(apiKeyEnv: string): string {
  const env = process.env[apiKeyEnv];
  if (env) return env;
  throw new CairnError("AUTH_MISSING", `no Linear credentials (${apiKeyEnv})`,
    `export ${apiKeyEnv} (create a personal API key at linear.app/settings/api)`);
}
