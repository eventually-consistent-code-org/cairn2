import { z } from "zod";
import type { Capability, Issue, IssueComment, IssueCreate, IssueLink, IssuePatch, IssueState, LinkType, Milestone, Phase, ProbeResult, Tracker, StateCategory, WorklogEntry } from "../types.js";
export declare const configSchema: z.ZodObject<{
    dir: z.ZodDefault<z.ZodString>;
    prefix: z.ZodDefault<z.ZodString>;
    states: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodEnum<{
        open: "open";
        in_progress: "in_progress";
        closed: "closed";
    }>>>;
}, z.core.$strip>;
export type LocalConfig = z.infer<typeof configSchema>;
export declare function make(config: LocalConfig, projectDir: string): Tracker;
/** Random 5-char base36 suffix, retried against the visible id set. */
export declare function newId(prefix: string, taken: Set<string>): string;
export declare class LocalTracker implements Tracker {
    private readonly cfg;
    private readonly projectDir;
    readonly capabilities: Capability;
    private readonly root;
    private initialized;
    private self;
    constructor(cfg: LocalConfig, projectDir: string);
    /** Lazy scaffold: directories + config.json on first use. */
    private init;
    private issueDir;
    private issuePath;
    private ids;
    private readFields;
    private warnedMigrated;
    /** Soft guard: a store already promoted to a hosted backend still works,
     *  but writes are probably landing in the wrong place — say so once. */
    private warnIfMigrated;
    private writeFields;
    private toIssue;
    createIssue(input: IssueCreate): Promise<Issue>;
    getIssue(id: string): Promise<Issue>;
    updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
    closeIssue(id: string): Promise<Issue>;
    /** Stored name → semantic category: canonical passes through, the config
     *  vocab maps custom names, anything unrecognized buckets to in_progress. */
    private categoryOf;
    /** The SPI's pre-write question (#427): a known name's category, and
     *  undefined for one the vocab lacks -- that name never buckets here,
     *  because updateIssue refuses it rather than storing it. */
    stateCategory(state: string): StateCategory | undefined;
    listIssues(filter?: {
        phase?: string;
        state?: IssueState;
    }): Promise<Issue[]>;
    private listJson;
    private writeJson;
    createPhase(name: string): Promise<Phase>;
    listPhases(): Promise<Phase[]>;
    closePhase(id: string): Promise<Phase>;
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    /** Filename-safe author tag for comment/worklog records. */
    private who;
    private stamp;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
    logWork(id: string, minutes: number): Promise<void>;
    attachFile(id: string, filename: string, data: Buffer, _mediaType?: string): Promise<{
        id?: string;
        url?: string;
    }>;
    /** Parse "<stamp>-<author>.md" record filenames back into metadata. */
    private historyFiles;
    listComments(id: string): Promise<IssueComment[]>;
    listWorklogs(id: string): Promise<WorklogEntry[]>;
    private edgePath;
    /** All stored edges — a directory walk; the graph is always in-memory. */
    private allEdges;
    private wouldCycle;
    linkIssues(from: string, type: LinkType, to: string): Promise<void>;
    unlinkIssues(from: string, type: LinkType, to: string): Promise<void>;
    listLinks(id?: string): Promise<IssueLink[]>;
    resolveSelf(): Promise<string | undefined>;
    /** Repo-resident, zero-network backend — nothing to preflight. Always ok. */
    probe(): Promise<ProbeResult>;
}
