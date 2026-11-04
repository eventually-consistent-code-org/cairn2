import type { Capability, Issue, IssueComment, IssueCreate, IssueLink, IssuePatch, IssueState, StateCategory, LinkType, Milestone, Phase, ProbeResult, Tracker } from "./types.js";
export declare class FakeTracker implements Tracker {
    private readonly states;
    readonly capabilities: Capability;
    private issues;
    private phases;
    private milestones;
    private issueComments;
    /** Clock for comment timestamps -- tests move it to put minutes between a
     *  claim comment and the close without waiting for them (#232). */
    now: () => Date;
    readonly issueAttachments: Map<string, string[]>;
    private seq;
    /** Custom state vocabulary, name → category, the local adapter's shape:
     *  a test hands the server a tracker whose in-progress or closed state
     *  has a display name (#427). Empty by default -- the canonical three. */
    constructor(states?: Record<string, StateCategory>);
    stateCategory(state: IssueState): StateCategory | undefined;
    attachFile(id: string, filename: string, _data: Buffer, _mediaType?: string): Promise<{
        id?: string;
        url?: string;
    }>;
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
    resolveSelf(): Promise<string | undefined>;
    probe(): Promise<ProbeResult>;
    private links;
    private wouldCycle;
    linkIssues(from: string, type: LinkType, to: string): Promise<void>;
    unlinkIssues(from: string, type: LinkType, to: string): Promise<void>;
    listLinks(id?: string): Promise<IssueLink[]>;
    listComments(id: string): Promise<IssueComment[]>;
    /** Test accessor: comments posted to an issue, in order. */
    comments(id: string): Array<{
        id: string;
        text: string;
        at: string;
    }>;
}
