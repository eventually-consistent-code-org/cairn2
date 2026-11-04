import { z } from "zod";
import { type FetchLike } from "../http.js";
import type { Capability, StateCategory, Issue, IssueCreate, IssuePatch, IssueState, Milestone, Phase, ProbeResult, Tracker } from "../types.js";
export declare const configSchema: z.ZodObject<{
    orgUrl: z.ZodString;
    project: z.ZodString;
    workItemType: z.ZodDefault<z.ZodString>;
    patEnv: z.ZodDefault<z.ZodString>;
    apiVersion: z.ZodDefault<z.ZodString>;
    states: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
type Config = z.infer<typeof configSchema>;
export declare function make(config: Config, fetchImpl?: FetchLike): Tracker;
export declare function resolveAzurePat(patEnv: string): string;
export declare class AzureBoardsTracker implements Tracker {
    private readonly cfg;
    private readonly fetchImpl;
    private readonly tokenProvider;
    readonly capabilities: Capability;
    /** id (GUID) -> full iteration path, refreshed from listPhases() when an unknown id shows up. */
    private phasePaths;
    /** Tracks whether we've called listPhases() once on this instance (guards against infinite refresh loops). */
    private phasesLoaded;
    constructor(cfg: Config, fetchImpl?: FetchLike, tokenProvider?: () => string);
    private headers;
    private url;
    private api;
    private assertId;
    private self;
    resolveSelf(): Promise<string | undefined>;
    /** Preflight: /_apis/projects/{project} over resolveSelf's connectionData
     *  -- connectionData only proves the PAT is valid, not that the configured
     *  project exists. A typo'd project now 404s instead of reading "ok". */
    probe(): Promise<ProbeResult>;
    private get projectPath();
    private normalizeState;
    private readonly seenStates;
    /** The SPI's pre-write question (#427, #471): the canonical three by
     *  name; a states-map key by the native state it writes, and a native
     *  state by itself -- the three required entries carry their category,
     *  any other only once Azure has shown it on a work item read. undefined
     *  otherwise: the freeze gate then falls closed rather than letting the
     *  name through. Exact-case, as normalizeState compares. Asserted by
     *  azure-boards.unit.test.ts and tracker-contract.test.ts. */
    stateCategory(state: IssueState): StateCategory | undefined;
    private normalize;
    /** Escapes single quotes in a WIQL string literal by doubling them. */
    private escapeWiql;
    /**
     * Normalizes a classificationnodes iteration path to the System.IterationPath
     * format: strips a leading backslash and the literal "Iteration\" segment
     * classificationnodes includes but System.IterationPath doesn't, e.g.
     * `\Proj\Iteration\Sprint 1` -> `Proj\Sprint 1`.
     */
    private normalizeIterationPath;
    /** Flattens a classificationnodes response into a flat list of leaf-ish iteration nodes, tolerating both response shapes. */
    private flattenIterationNodes;
    /** Resolves a phase id (GUID) to its iteration path, refreshing the map from listPhases() if unknown. */
    private resolvePhasePath;
    /** Resolves an iteration path to a phase id (GUID), self-healing the map on miss if not yet loaded. */
    private phaseIdForPath;
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
    closePhase(_id: string): Promise<Phase>;
    /** Maps an Epic work item to a Milestone; "released" once it hits the configured closed state. */
    private normalizeEpic;
    createMilestone(name: string): Promise<Milestone>;
    listMilestones(): Promise<Milestone[]>;
    completeMilestone(id: string): Promise<Milestone>;
    commentIssue(id: string, text: string): Promise<{
        id: string;
        url?: string;
    }>;
}
export {};
