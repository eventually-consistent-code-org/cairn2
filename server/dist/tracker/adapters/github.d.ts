import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { BranchProtection, Capability, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    repo: z.ZodString;
}, z.core.$strip>;
export declare function make(config: z.infer<typeof configSchema>, fetchImpl?: FetchLike): Tracker;
export declare function resolveGithubToken(fromEnv?: string | undefined, gh?: () => string): string;
export declare class GitHubTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    constructor(cfg: {
        repo: string;
    }, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private api;
    private assertId;
    private self;
    resolveSelf(): Promise<string | undefined>;
    /** Preflight: /repos/{repo} over resolveSelf's /user -- /user only proves
     *  the token is valid, not that the configured repo exists. One cheap
     *  call, same cost, but a typo'd repo now 404s instead of reading "ok". */
    probe(): Promise<ProbeResult>;
    private defaultBranch;
    private resolveDefaultBranch;
    /** What the service enforces on the default branch (#485): the rulesets
     *  endpoint first, legacy branch protection when rulesets come back
     *  empty. A read that fails is `source: "unreadable: <reason>"` with no
     *  rules -- never an empty list dressed as a measurement (claims rule 2).
     *  Endpoint shapes (rule `type` names, `required_approving_review_count`,
     *  the legacy `allow_*` toggles, the 404 "Branch not protected" answer for
     *  an unprotected branch) are a dated claim: as of 2026-11, per the GitHub
     *  REST reference. Asserted against fixtures by github.unit.test.ts. */
    branchProtection(): Promise<BranchProtection>;
    private normalize;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    closePhase(id: string): Promise<Phase>;
    createMilestone(_name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(_id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
