import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, StateCategory, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    defaultListId: z.ZodString;
    folderId: z.ZodOptional<z.ZodString>;
    spaceId: z.ZodOptional<z.ZodString>;
    tokenEnv: z.ZodDefault<z.ZodString>;
    statuses: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type ClickUpConfig = z.infer<typeof configSchema>;
export declare function make(config: ClickUpConfig, fetchImpl?: FetchLike): Tracker;
export declare function resolveClickUpToken(tokenEnv: string): string;
export declare class ClickUpTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    constructor(cfg: ClickUpConfig, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private api;
    private assertId;
    /** Preflight: /list/{defaultListId} over /team -- /team only proves the
     *  token is valid, not that the configured list exists. A typo'd
     *  defaultListId now 404s instead of reading "ok". */
    probe(): Promise<ProbeResult>;
    /** Validates a caller-supplied phase (list) id before it reaches a URL. defaultListId is trusted config, not user input. */
    private assertPhaseId;
    private normalizeState;
    private readonly seenStatuses;
    /** The SPI's pre-write question (#427, #471): the canonical three by
     *  name; a statuses-map key by the native status it writes, and a native
     *  status by itself -- the three required entries carry their category,
     *  any other only once ClickUp has shown it with its type. undefined
     *  otherwise: the freeze gate then falls closed rather than letting the
     *  name through. Case-insensitive, as normalizeState compares. Asserted
     *  by clickup.unit.test.ts and tracker-contract.test.ts. */
    stateCategory(state: IssueState): StateCategory | undefined;
    private normalize;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    /** Adds/removes tags to match `desired`, given the tags currently on the task (by name). */
    private reconcileTags;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    closePhase(_id: string): Promise<Phase>;
    createMilestone(_name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(_id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
