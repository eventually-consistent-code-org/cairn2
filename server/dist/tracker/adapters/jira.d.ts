import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, StateCategory, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    baseUrl: z.ZodString;
    projectKey: z.ZodString;
    issueType: z.ZodDefault<z.ZodString>;
    emailEnv: z.ZodDefault<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    transitions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    boardId: z.ZodOptional<z.ZodNumber>;
    authMode: z.ZodOptional<z.ZodEnum<{
        site: "site";
        gateway: "gateway";
    }>>;
}, z.core.$strip>;
type JiraConfig = z.infer<typeof configSchema>;
export declare function make(config: JiraConfig, fetchImpl?: FetchLike): Tracker;
export declare function resolveJiraAuth(cfg: JiraConfig): {
    email: string;
    token: string;
};
/** A write result that could not store part of the estimate it was given.
 *  Structurally an `Issue` — the extra note rides back with the call and is
 *  read (and stripped off) by the tool layer, which re-publishes it as
 *  `estimateSkipped`. Nothing else reads it, and it never reaches a
 *  plan snapshot. */
export type JiraWriteResult = Issue & {
    estimateSkipped?: string;
};
export declare class JiraTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly authProvider;
    readonly capabilities: Capability;
    private storyPointField;
    private storyPointFieldId;
    /** SPI estimate → Jira write fields (timetracking + discovered points field).
     *
     *  `skipped` is the honest half of the answer (#231). `hasEstimates` is a
     *  backend-wide claim and stays true — minutes ride the standard
     *  timetracking field and always land — but story points live in a custom
     *  field that a given site may simply not have. That loss is per call, so
     *  it travels back with the call instead of only to stderr; the tool layer
     *  turns it into `estimateSkipped` so the caller can fall back to writing
     *  the points into the issue body. */
    private estimateFields;
    /** Read-field list: timetracking always; the points field once discovered. */
    private readFields;
    private projectId;
    constructor(cfg: JiraConfig, fetchImpl?: FetchLike, authProvider?: () => {
        email: string;
        token: string;
    });
    private headers;
    private siteOrigin;
    private cloudId;
    private gatewayActive;
    private resolveCloudId;
    /** Resolves the base URL for an API call — site origin, or the scoped-token
     *  gateway once cloudId is known. The single site every API call (including
     *  attachFile's multipart upload) routes through, so a third URL site can't
     *  quietly diverge from this decision again. */
    private apiBase;
    private api;
    private assertId;
    private readonly seenStatuses;
    private learnStatus;
    /** The SPI's pre-write question (#427, #471): the category a requested
     *  state name would land in. The canonical three by name; the two
     *  required transitions-map targets by the category they stand for; any
     *  other name -- or the target a transitions-map alias points at -- only
     *  once Jira has shown it with its statusCategory. undefined otherwise:
     *  the freeze gate then falls closed rather than letting the name
     *  through. Case-insensitive, as transitionByName matches. Asserted by
     *  jira.unit.test.ts and tracker-contract.test.ts. */
    stateCategory(state: IssueState): StateCategory | undefined;
    private normalize;
    /** GET transitions for `key`, find one whose `to.name` or transition `name` matches (case-insensitive), POST it. */
    private transitionByName;
    /** A transition list names each target status with its category; both the
     *  status name and the transition name reach it through transitionByName,
     *  so both are learned (#471). */
    private learnTransitions;
    /** in_progress -> open has no fixed target name; find any transition whose target category is 'new'. */
    private transitionToOpenCategory;
    private boardCache;
    private sprintCache;
    private board;
    private activeSprintId;
    /** Scrum boards: new work belongs in the running sprint. Best-effort —
     *  an Agile-API hiccup must never turn a successful create into a failure. */
    private assignToActiveSprint;
    createIssue(input: IssueCreate): Promise<JiraWriteResult>;
    getIssue(id: string): Promise<Issue>;
    private self;
    resolveSelf(): Promise<string | undefined>;
    /** Preflight: /project/{projectKey} over resolveSelf's /myself -- /myself
     *  only proves the token is valid, not that the configured project exists.
     *  A typo'd projectKey now 404s instead of reading "ok". */
    probe(): Promise<ProbeResult>;
    /** Assignee values may arrive as an email (user.handle) — Jira wants accountId. */
    private toAccountId;
    updateIssue(id: string, patch: IssuePatch): Promise<JiraWriteResult>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    private resolveProjectId;
    private normalizeVersion;
    closePhase(id: string): Promise<Phase>;
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
    logWork(id: string, minutes: number): Promise<void>;
    attachFile(id: string, filename: string, data: Buffer, mediaType?: string): Promise<{
        id?: string;
        url?: string;
    }>;
}
export {};
