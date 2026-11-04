import { ReadCache } from "../core/cache.js";
import type { Capability, Issue, IssueComment, IssueCreate, IssueLink, IssuePatch, IssueState, LinkType, Milestone, Phase, ProbeResult, StateCategory, Tracker, WorklogEntry } from "./types.js";
/**
 * Caches read operations (getIssue, listIssues, listPhases) for 60s.
 * Any write invalidates the entire cache (whole-cache write-through invalidation).
 * All cached values are deep-cloned on read to prevent caller mutation poisoning.
 */
export declare class CachedTracker implements Tracker {
    private inner;
    readonly capabilities: Capability;
    private cache;
    logWork?: (id: string, minutes: number) => Promise<void>;
    resolveSelf?: () => Promise<string | undefined>;
    probe?: () => Promise<ProbeResult>;
    stateCategory?: (state: IssueState) => StateCategory | undefined;
    linkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
    unlinkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
    listLinks?: (id?: string) => Promise<IssueLink[]>;
    listComments?: (id: string) => Promise<IssueComment[]>;
    listWorklogs?: (id: string) => Promise<WorklogEntry[]>;
    attachFile?: (id: string, filename: string, data: Buffer, mediaType?: string) => Promise<{
        id?: string;
        url?: string;
    }>;
    constructor(inner: Tracker, cache?: ReadCache);
    private clone;
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
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
