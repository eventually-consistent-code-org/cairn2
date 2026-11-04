import { z } from "zod";
import { CairnError } from "../../errors.js";
import { fetchJson, type FetchLike } from "../http.js";
import { runProbe } from "../probe.js";
import type {
  Capability,
  Issue,
  IssueCreate,
  IssueEstimate,
  IssuePatch,
  IssueState,
  Milestone,
  Phase,
  ProbeResult,
  StateCategory,
  Tracker,
} from "../types.js";
import { matchesState } from "../types.js";

// Issue keys look like PROJ-123 (letters + digits, dash, digits).
const ID_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const MAX_RESULTS = 100;

const STATUS_CATEGORY_MAP: Record<string, StateCategory> = {
  new: "open",
  indeterminate: "in_progress",
  done: "closed",
};

export const configSchema = z.object({
  baseUrl: z.string().url(),
  projectKey: z.string().min(1),
  issueType: z.string().default("Task"),
  emailEnv: z.string().default("JIRA_EMAIL"),
  tokenEnv: z.string().default("JIRA_API_TOKEN"),
  // Arbitrary extra keys are custom cairn states ("review": "In Review") —
  // resolved through the same transition-by-name machinery (CRN-26).
  // Deliberate .default under zod 4 (#95): a provided map replaces wholesale
  // (no merge with defaults) and the refine below still guards partial maps.
  transitions: z
    .record(z.string(), z.string())
    .default({ in_progress: "In Progress", closed: "Done" })
    .refine(
      (t) => typeof t.in_progress === "string" && typeof t.closed === "string",
      "transitions must include in_progress and closed",
    ),
  // Board auto-discovers from the project; set this only when the project
  // has several boards and the first one is the wrong one.
  boardId: z.number().int().positive().optional(),
  // Atlassian's scoped tokens (ATCTT-prefixed) only authenticate through the
  // api.atlassian.com/ex/jira/{cloudId} gateway, never the site URL directly.
  // Detected automatically from the token shape; set this to force one mode
  // or the other (e.g. a non-standard token that still needs gateway routing).
  authMode: z.enum(["site", "gateway"]).optional(),
});

type JiraConfig = z.infer<typeof configSchema>;

export function make(config: JiraConfig, fetchImpl?: FetchLike): Tracker {
  return new JiraTracker(config, fetchImpl);
}

export function resolveJiraAuth(cfg: JiraConfig): {
  email: string;
  token: string;
} {
  const email = process.env[cfg.emailEnv];
  const token = process.env[cfg.tokenEnv];
  if (!email || !token) {
    throw new CairnError(
      "AUTH_MISSING",
      "no Jira credentials",
      `export ${cfg.emailEnv} and ${cfg.tokenEnv} (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)`,
    );
  }
  return { email, token };
}

interface AdfNode {
  type?: string;
  version?: number;
  text?: string;
  content?: AdfNode[];
}

interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

interface JiraIssueFields {
  summary: string;
  description?: AdfNode | null;
  status: { name?: string; statusCategory: { key: string } };
  updated: string;
  labels?: string[];
  parent?: { key: string };
  assignee?: { accountId?: string } | null;
  timetracking?: { originalEstimateSeconds?: number } | null;
}

interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

/** Wraps plain text in the minimal Atlassian Document Format Jira expects on write. */
function adf(text: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: text || " " }] },
    ],
  };
}

/** Recursively walks an ADF document, concatenating all text node contents. */
function adfToText(node: AdfNode | null | undefined): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(adfToText).join("");
}

/**
 * Jira emits timestamps like `2026-07-12T10:30:00.000+0000` — a numeric
 * offset with no colon, which breaks strict ISO-8601 parsers. Insert the
 * colon (same trick as 1.x gbsync.py's parse_ts) so it's valid ISO-8601.
 */
function normalizeTimestamp(raw: string): string {
  const s = raw.trim();
  if (
    s.length >= 5 &&
    (s[s.length - 5] === "+" || s[s.length - 5] === "-") &&
    s[s.length - 3] !== ":"
  ) {
    return `${s.slice(0, -2)}:${s.slice(-2)}`;
  }
  return s;
}

/** A write result that could not store part of the estimate it was given.
 *  Structurally an `Issue` — the extra note rides back with the call and is
 *  read (and stripped off) by the tool layer, which re-publishes it as
 *  `estimateSkipped`. Nothing else reads it, and it never reaches a
 *  plan snapshot. */
export type JiraWriteResult = Issue & { estimateSkipped?: string };

export class JiraTracker implements Tracker {
  readonly capabilities: Capability = {
    hasInProgress: true,
    hasPhases: true,
    hasPhaseReassign: true,
    hasDependencies: true,
    hasLabels: true,
    hasMilestones: true,
    hasPhaseClose: true,
    hasComments: true,
    hasWorklog: true,
    hasEstimates: true,
    hasIssueAttachments: true,
  };

  // Story-point field id varies per site ("Story point estimate" on
  // team-managed projects, "Story Points" on company-managed) — discovered
  // once, `null` = site has none (points skipped with one warning).
  private storyPointField: string | null | undefined;

  private async storyPointFieldId(): Promise<string | null> {
    if (this.storyPointField === undefined) {
      const raw = (await this.api(
        "GET",
        "/rest/api/3/field",
        undefined,
        "jira field_list",
      )) as Array<{ id: string; name: string }>;
      const hit = raw.find((f) => /^story points?( estimate)?$/i.test(f.name));
      if (!hit) {
        console.error(
          "[cairn] jira: no story-point field on this site — points estimates skipped",
        );
      }
      this.storyPointField = hit?.id ?? null;
    }
    return this.storyPointField;
  }

  /** SPI estimate → Jira write fields (timetracking + discovered points field).
   *
   *  `skipped` is the honest half of the answer (#231). `hasEstimates` is a
   *  backend-wide claim and stays true — minutes ride the standard
   *  timetracking field and always land — but story points live in a custom
   *  field that a given site may simply not have. That loss is per call, so
   *  it travels back with the call instead of only to stderr; the tool layer
   *  turns it into `estimateSkipped` so the caller can fall back to writing
   *  the points into the issue body. */
  private async estimateFields(est: IssueEstimate): Promise<{
    fields: Record<string, unknown>;
    skipped?: string;
  }> {
    const fields: Record<string, unknown> = {};
    if (est.minutes !== undefined)
      fields.timetracking = { originalEstimate: `${est.minutes}m` };
    let skipped: string | undefined;
    if (est.points !== undefined) {
      const fld = await this.storyPointFieldId();
      if (fld) fields[fld] = est.points;
      // Minutes are unaffected, so say which half was lost, not just "lost".
      else
        skipped =
          est.minutes !== undefined
            ? "this Jira site has no story-point field: points dropped, minutes landed; fold the points into the issue body"
            : "this Jira site has no story-point field: points dropped; fold the points into the issue body";
    }
    return { fields, skipped };
  }

  /** Read-field list: timetracking always; the points field once discovered. */
  private readFields(): string[] {
    const base = [
      "summary",
      "description",
      "status",
      "updated",
      "labels",
      "parent",
      "assignee",
      "timetracking",
    ];
    return this.storyPointField ? [...base, this.storyPointField] : base;
  }

  private projectId: number | undefined;

  constructor(
    private readonly cfg: JiraConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly authProvider: () => {
      email: string;
      token: string;
    } = () => resolveJiraAuth(cfg),
  ) {}

  private headers(): Record<string, string> {
    const { email, token } = this.authProvider();
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    return {
      authorization: `Basic ${basic}`,
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  private siteOrigin(): string {
    return this.cfg.baseUrl.replace(/\/$/, "");
  }

  // Scoped-token gateway support (CRN-49). Classic tokens keep hitting the
  // site URL directly; ATCTT-prefixed scoped tokens only authenticate
  // through api.atlassian.com/ex/jira/{cloudId} — cloudId is resolved once
  // per instance via an *unauthenticated* GET against the site's own
  // /_edge/tenant_info (same trick every Atlassian Connect app uses).
  private cloudId: string | undefined;

  private gatewayActive(token: string): boolean {
    if (this.cfg.authMode === "site") return false;
    if (this.cfg.authMode === "gateway") return true;
    return token.startsWith("ATCTT");
  }

  private async resolveCloudId(): Promise<string> {
    if (this.cloudId === undefined) {
      const info = (await fetchJson(
        this.fetchImpl,
        `${this.siteOrigin()}/_edge/tenant_info`,
        { method: "GET" },
        { context: "jira tenant_info" },
      )) as { cloudId: string };
      this.cloudId = info.cloudId;
    }
    return this.cloudId;
  }

  /** Resolves the base URL for an API call — site origin, or the scoped-token
   *  gateway once cloudId is known. The single site every API call (including
   *  attachFile's multipart upload) routes through, so a third URL site can't
   *  quietly diverge from this decision again. */
  private async apiBase(): Promise<string> {
    const { token } = this.authProvider();
    if (!this.gatewayActive(token)) return this.siteOrigin();
    const cloudId = await this.resolveCloudId();
    return `https://api.atlassian.com/ex/jira/${cloudId}`;
  }

  private async api(
    method: string,
    path: string,
    body?: unknown,
    context = "jira",
  ): Promise<unknown> {
    const base = await this.apiBase();
    return fetchJson(
      this.fetchImpl,
      `${base}${path}`,
      {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { context },
    );
  }

  private assertId(id: string): void {
    if (!ID_RE.test(id)) {
      throw new CairnError(
        "NOT_FOUND",
        `invalid issue id: ${id}`,
        "issue id must look like PROJ-123",
      );
    }
  }

  // Status names Jira has shown this instance, lowercased, with the
  // category Jira itself gave them -- filled by every issue read and every
  // transition list, so the pre-write question below answers from data
  // already fetched and never fetches for itself (#471).
  private readonly seenStatuses = new Map<string, StateCategory>();

  private learnStatus(name: string | undefined, categoryKey: string | undefined): void {
    if (!name) return;
    this.seenStatuses.set(name.toLowerCase(), STATUS_CATEGORY_MAP[categoryKey ?? "new"] ?? "open");
  }

  /** The SPI's pre-write question (#427, #471): the category a requested
   *  state name would land in. The canonical three by name; the two
   *  required transitions-map targets by the category they stand for; any
   *  other name -- or the target a transitions-map alias points at -- only
   *  once Jira has shown it with its statusCategory. undefined otherwise:
   *  the freeze gate then falls closed rather than letting the name
   *  through. Case-insensitive, as transitionByName matches. Asserted by
   *  jira.unit.test.ts and tracker-contract.test.ts. */
  stateCategory(state: IssueState): StateCategory | undefined {
    if (state === "open" || state === "in_progress" || state === "closed") return state;
    const target = (this.cfg.transitions[state] ?? state).toLowerCase();
    if (target === this.cfg.transitions.in_progress!.toLowerCase()) return "in_progress";
    if (target === this.cfg.transitions.closed!.toLowerCase()) return "closed";
    return this.seenStatuses.get(target);
  }

  private normalize(raw: JiraIssue): Issue {
    const f = raw.fields;
    const category =
      STATUS_CATEGORY_MAP[f.status?.statusCategory?.key ?? "new"] ?? "open";
    const state = f.status?.name ?? category;
    this.learnStatus(f.status?.name, f.status?.statusCategory?.key);
    const seconds = f.timetracking?.originalEstimateSeconds;
    const points = this.storyPointField
      ? (f as unknown as Record<string, unknown>)[this.storyPointField]
      : undefined;
    const estimate: IssueEstimate | undefined =
      seconds !== undefined || typeof points === "number"
        ? {
            ...(typeof points === "number" ? { points } : {}),
            ...(seconds !== undefined
              ? { minutes: Math.round(seconds / 60) }
              : {}),
          }
        : undefined;
    return {
      estimate,
      id: raw.key,
      title: f.summary,
      body: f.description ? adfToText(f.description) : "",
      state,
      category,
      labels: f.labels ?? [],
      phase: f.parent?.key,
      assignee: f.assignee?.accountId ?? undefined,
      updatedAt: normalizeTimestamp(f.updated),
      url: `${this.cfg.baseUrl.replace(/\/$/, "")}/browse/${raw.key}`,
    };
  }

  /** GET transitions for `key`, find one whose `to.name` or transition `name` matches (case-insensitive), POST it. */
  private async transitionByName(
    key: string,
    targetName: string,
  ): Promise<void> {
    const resp = (await this.api(
      "GET",
      `/rest/api/3/issue/${key}/transitions`,
      undefined,
      "jira transition_list",
    )) as { transitions: JiraTransition[] };
    this.learnTransitions(resp.transitions);
    const target = targetName.toLowerCase();
    const match = resp.transitions.find(
      (t) =>
        t.to?.name?.toLowerCase() === target ||
        t.name?.toLowerCase() === target,
    );
    if (!match) {
      console.error(
        `[cairn] jira: no transition to "${targetName}" found for issue ${key}; leaving state unchanged`,
      );
      return;
    }
    await this.api(
      "POST",
      `/rest/api/3/issue/${key}/transitions`,
      { transition: { id: match.id } },
      "jira transition",
    );
  }

  /** A transition list names each target status with its category; both the
   *  status name and the transition name reach it through transitionByName,
   *  so both are learned (#471). */
  private learnTransitions(transitions: JiraTransition[]): void {
    for (const t of transitions) {
      this.learnStatus(t.to?.name, t.to?.statusCategory?.key);
      this.learnStatus(t.name, t.to?.statusCategory?.key);
    }
  }

  /** in_progress -> open has no fixed target name; find any transition whose target category is 'new'. */
  private async transitionToOpenCategory(key: string): Promise<void> {
    const resp = (await this.api(
      "GET",
      `/rest/api/3/issue/${key}/transitions`,
      undefined,
      "jira transition_list",
    )) as { transitions: JiraTransition[] };
    this.learnTransitions(resp.transitions);
    const match = resp.transitions.find(
      (t) => t.to?.statusCategory?.key === "new",
    );
    if (!match) {
      console.error(
        `[cairn] jira: no transition to an "open"-category state found for issue ${key}; leaving state unchanged`,
      );
      return;
    }
    await this.api(
      "POST",
      `/rest/api/3/issue/${key}/transitions`,
      { transition: { id: match.id } },
      "jira transition",
    );
  }

  // Board + active sprint, each resolved once per instance. `null` is a real
  // answer ("no board" / "no active sprint"), `undefined` means not asked yet.
  private boardCache: { id: number; type: string } | null | undefined;
  private sprintCache: number | null | undefined;

  private async board(): Promise<{ id: number; type: string } | null> {
    if (this.boardCache === undefined) {
      if (this.cfg.boardId) {
        const raw = (await this.api(
          "GET",
          `/rest/agile/1.0/board/${this.cfg.boardId}`,
          undefined,
          "jira board_get",
        )) as { id: number; type: string };
        this.boardCache = { id: raw.id, type: raw.type };
      } else {
        const raw = (await this.api(
          "GET",
          `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.cfg.projectKey)}`,
          undefined,
          "jira board_list",
        )) as { values: Array<{ id: number; type: string }> };
        this.boardCache = raw.values[0] ?? null;
      }
    }
    return this.boardCache;
  }

  private async activeSprintId(): Promise<number | null> {
    const board = await this.board();
    if (!board || board.type !== "scrum") return null;
    if (this.sprintCache === undefined) {
      const raw = (await this.api(
        "GET",
        `/rest/agile/1.0/board/${board.id}/sprint?state=active`,
        undefined,
        "jira sprint_list",
      )) as { values: Array<{ id: number }> };
      this.sprintCache = raw.values[0]?.id ?? null;
    }
    return this.sprintCache;
  }

  /** Scrum boards: new work belongs in the running sprint. Best-effort —
   *  an Agile-API hiccup must never turn a successful create into a failure. */
  private async assignToActiveSprint(key: string): Promise<void> {
    try {
      const sprint = await this.activeSprintId();
      if (sprint === null) return;
      await this.api(
        "POST",
        `/rest/agile/1.0/sprint/${sprint}/issue`,
        { issues: [key] },
        "jira sprint_assign",
      );
    } catch (e) {
      console.error(`[cairn] jira: sprint assignment for ${key} skipped: ${e}`);
    }
  }

  async createIssue(input: IssueCreate): Promise<JiraWriteResult> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      summary: input.title,
      description: adf(input.body ?? ""),
      issuetype: { name: this.cfg.issueType },
    };
    if (input.labels?.length) fields.labels = input.labels;
    if (input.phase) fields.parent = { key: input.phase };
    let estimateSkipped: string | undefined;
    if (input.estimate) {
      const est = await this.estimateFields(input.estimate);
      Object.assign(fields, est.fields);
      estimateSkipped = est.skipped;
    }
    const created = (await this.api(
      "POST",
      "/rest/api/3/issue",
      { fields },
      "jira issue_create",
    )) as { key: string };
    await this.assignToActiveSprint(created.key);
    const issue = await this.getIssue(created.key);
    return estimateSkipped ? { ...issue, estimateSkipped } : issue;
  }

  async getIssue(id: string): Promise<Issue> {
    this.assertId(id);
    const raw = await this.api(
      "GET",
      `/rest/api/3/issue/${id}?fields=${this.readFields().join(",")}`,
      undefined,
      "jira issue_get",
    );
    return this.normalize(raw as JiraIssue);
  }

  private self: string | undefined;

  async resolveSelf(): Promise<string | undefined> {
    if (this.self) return this.self;
    const me = (await this.api(
      "GET",
      "/rest/api/3/myself",
      undefined,
      "jira myself",
    )) as { accountId?: string };
    this.self = me.accountId;
    return this.self;
  }

  /** Preflight: /project/{projectKey} over resolveSelf's /myself -- /myself
   *  only proves the token is valid, not that the configured project exists.
   *  A typo'd projectKey now 404s instead of reading "ok". */
  async probe(): Promise<ProbeResult> {
    return runProbe(() => this.resolveProjectId());
  }

  /** Assignee values may arrive as an email (user.handle) — Jira wants accountId. */
  private async toAccountId(value: string): Promise<string> {
    if (!value.includes("@")) return value;
    const hits = (await this.api(
      "GET",
      `/rest/api/3/user/search?query=${encodeURIComponent(value)}`,
      undefined,
      "jira user_search",
    )) as Array<{ accountId?: string }>;
    const id = hits[0]?.accountId;
    if (!id) {
      throw new CairnError(
        "NOT_FOUND",
        `no Jira user matches '${value}'`,
        "set user.handle in cairn.json to a Jira accountId or exact email",
      );
    }
    return id;
  }

  async updateIssue(
    id: string,
    patch: IssuePatch,
  ): Promise<JiraWriteResult> {
    this.assertId(id);
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.body !== undefined) fields.description = adf(patch.body);
    if (patch.labels !== undefined) fields.labels = patch.labels;
    if (patch.assignee !== undefined) {
      fields.assignee = { accountId: await this.toAccountId(patch.assignee) };
    }
    // Re-phase: same mapping as createIssue — parent Epic key.
    if (patch.phase) fields.parent = { key: patch.phase };
    let estimateSkipped: string | undefined;
    if (patch.estimate) {
      const est = await this.estimateFields(patch.estimate);
      Object.assign(fields, est.fields);
      estimateSkipped = est.skipped;
    }
    if (Object.keys(fields).length > 0) {
      await this.api(
        "PUT",
        `/rest/api/3/issue/${id}`,
        { fields },
        "jira issue_update",
      );
    }
    if (patch.state === "in_progress") {
      await this.transitionByName(id, this.cfg.transitions.in_progress!);
    } else if (patch.state === "closed") {
      await this.transitionByName(id, this.cfg.transitions.closed!);
    } else if (patch.state === "open") {
      await this.transitionToOpenCategory(id);
    } else if (patch.state !== undefined) {
      // Custom state: transitions-map alias first, else the literal name —
      // Jira's own transition list is the authority either way.
      await this.transitionByName(
        id,
        this.cfg.transitions[patch.state] ?? patch.state,
      );
    }
    const issue = await this.getIssue(id);
    return estimateSkipped ? { ...issue, estimateSkipped } : issue;
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  async listIssues(filter?: {
    phase?: string;
    state?: IssueState;
  }): Promise<Issue[]> {
    if (filter?.phase && !ID_RE.test(filter.phase)) {
      throw new CairnError(
        "NOT_FOUND",
        `invalid phase key: ${filter.phase}`,
        "phase key must look like PROJ-123",
      );
    }
    // Epics model cairn "phases", not issues — exclude them from the unfiltered
    // list. A parent-filtered query can't match an epic anyway (epics have no
    // parent), so no exclusion is needed on that branch.
    const jql = filter?.phase
      ? `parent = ${filter.phase}`
      : `project = ${this.cfg.projectKey} AND issuetype != Epic`;
    const raw = (await this.api(
      "POST",
      "/rest/api/3/search/jql",
      {
        jql,
        maxResults: MAX_RESULTS,
        fields: this.readFields(),
      },
      "jira issue_list",
    )) as { issues: JiraIssue[]; total?: number };
    if (raw.issues.length === MAX_RESULTS) {
      console.error(
        `[cairn] jira issue_list truncated at ${MAX_RESULTS} results (total: ${raw.total ?? "unknown"})`,
      );
    }
    let issues = raw.issues.map((i) => this.normalize(i));
    if (filter?.state)
      issues = issues.filter((i) => matchesState(i, filter.state!));
    return issues;
  }

  async createPhase(name: string): Promise<Phase> {
    const fields: Record<string, unknown> = {
      project: { key: this.cfg.projectKey },
      summary: name,
      issuetype: { name: "Epic" },
    };
    const created = (await this.api(
      "POST",
      "/rest/api/3/issue",
      { fields },
      "jira phase_create",
    )) as { key: string };
    return { id: created.key, name, state: "open" };
  }

  async listPhases(): Promise<Phase[]> {
    const raw = (await this.api(
      "POST",
      "/rest/api/3/search/jql",
      {
        jql: `project = ${this.cfg.projectKey} AND issuetype = Epic`,
        maxResults: MAX_RESULTS,
        fields: ["summary", "status", "updated"],
      },
      "jira phase_list",
    )) as { issues: JiraIssue[]; total?: number };
    if (raw.issues.length === MAX_RESULTS) {
      console.error(
        `[cairn] jira phase_list truncated at ${MAX_RESULTS} results (total: ${raw.total ?? "unknown"})`,
      );
    }
    return raw.issues.map((i) => ({
      id: i.key,
      name: i.fields.summary,
      state:
        STATUS_CATEGORY_MAP[i.fields.status?.statusCategory?.key ?? "new"] ===
        "closed"
          ? "closed"
          : "open",
    }));
  }

  private async resolveProjectId(): Promise<number> {
    if (this.projectId === undefined) {
      const raw = (await this.api(
        "GET",
        `/rest/api/3/project/${this.cfg.projectKey}`,
        undefined,
        "jira project_get",
      )) as { id: string };
      this.projectId = Number(raw.id);
    }
    return this.projectId;
  }

  private normalizeVersion(raw: {
    id: string;
    name: string;
    released?: boolean;
  }): Milestone {
    return {
      id: raw.id,
      name: raw.name,
      state: raw.released ? "released" : "open",
      url: `${this.cfg.baseUrl.replace(/\/$/, "")}/projects/${this.cfg.projectKey}/versions/${raw.id}`,
    };
  }

  async closePhase(id: string): Promise<Phase> {
    // Jira phases are Epics, and Epics are issues — the close transition applies.
    const closed = await this.closeIssue(id);
    return { id: closed.id, name: closed.title, state: "closed" };
  }

  async createMilestone(name: string): Promise<Milestone> {
    const projectId = await this.resolveProjectId();
    const raw = (await this.api(
      "POST",
      "/rest/api/3/version",
      { name, projectId },
      "jira milestone_create",
    )) as { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }

  async listMilestones(): Promise<Milestone[]> {
    const raw = (await this.api(
      "GET",
      `/rest/api/3/project/${this.cfg.projectKey}/versions`,
      undefined,
      "jira milestone_list",
    )) as Array<{ id: string; name: string; released?: boolean }>;
    return raw.map((v) => this.normalizeVersion(v));
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const raw = (await this.api(
      "PUT",
      `/rest/api/3/version/${id}`,
      { released: true },
      "jira milestone_complete",
    )) as { id: string; name: string; released?: boolean };
    return this.normalizeVersion(raw);
  }

  async commentIssue(
    id: string,
    text: string,
  ): Promise<{ id: string; url?: string }> {
    this.assertId(id);
    const raw = (await this.api(
      "POST",
      `/rest/api/3/issue/${id}/comment`,
      { body: adf(text) },
      "jira issue_comment",
    )) as { id: string };
    return { id: raw.id };
  }

  async logWork(id: string, minutes: number): Promise<void> {
    this.assertId(id);
    await this.api(
      "POST",
      `/rest/api/3/issue/${id}/worklog`,
      { timeSpentSeconds: minutes * 60 },
      "jira worklog",
    );
  }

  async attachFile(
    id: string,
    filename: string,
    data: Buffer,
    mediaType?: string,
  ): Promise<{ id?: string; url?: string }> {
    this.assertId(id);
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(data)], {
        type: mediaType ?? "application/octet-stream",
      }),
      filename,
    );
    const { email, token } = this.authProvider();
    const base = await this.apiBase();
    // Multipart — no JSON content-type; fetch sets the boundary itself, and
    // Jira demands the XSRF opt-out header on this endpoint.
    const raw = (await fetchJson(
      this.fetchImpl,
      `${base}/rest/api/3/issue/${id}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          accept: "application/json",
          "X-Atlassian-Token": "no-check",
        },
        body: form,
      },
      { context: "jira issue_attach" },
    )) as Array<{ id?: string; content?: string }>;
    return { id: raw[0]?.id, url: raw[0]?.content };
  }
}
