import { ReadCache } from "../core/cache.js";
import type {
  Capability, Issue, IssueComment, IssueCreate, IssueLink, IssuePatch, IssueState,
  LinkType, Milestone, Phase, ProbeResult, StateCategory, Tracker, WorklogEntry,
} from "./types.js";

/**
 * Caches read operations (getIssue, listIssues, listPhases) for 60s.
 * Any write invalidates the entire cache (whole-cache write-through invalidation).
 * All cached values are deep-cloned on read to prevent caller mutation poisoning.
 */
export class CachedTracker implements Tracker {
  readonly capabilities: Capability;
  private cache: ReadCache;

  // Optional on Tracker — present only when the inner adapter has it, so the
  // caller's "capabilities.hasWorklog && tracker.logWork" gate keeps working.
  logWork?: (id: string, minutes: number) => Promise<void>;
  resolveSelf?: () => Promise<string | undefined>;
  probe?: () => Promise<ProbeResult>;
  stateCategory?: (state: IssueState) => StateCategory | undefined;
  linkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
  unlinkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
  listLinks?: (id?: string) => Promise<IssueLink[]>;
  listComments?: (id: string) => Promise<IssueComment[]>;
  listWorklogs?: (id: string) => Promise<WorklogEntry[]>;
  attachFile?: (id: string, filename: string, data: Buffer,
    mediaType?: string) => Promise<{ id?: string; url?: string }>;

  constructor(
    private inner: Tracker,
    cache?: ReadCache,
  ) {
    this.capabilities = inner.capabilities;
    this.cache = cache ?? new ReadCache(60_000);
    if (inner.logWork) {
      this.logWork = async (id, minutes) => {
        await this.inner.logWork!(id, minutes);
        this.cache.clear();
      };
    }
    if (inner.resolveSelf) {
      this.resolveSelf = () => this.inner.resolveSelf!();
    }
    if (inner.probe) {
      this.probe = () => this.inner.probe!();
    }
    if (inner.stateCategory) {
      // a pure lookup: nothing to cache, nothing to invalidate
      this.stateCategory = (state) => this.inner.stateCategory!(state);
    }
    if (inner.linkIssues) {
      this.linkIssues = async (f, ty, to) => {
        await this.inner.linkIssues!(f, ty, to);
        this.cache.clear();
      };
    }
    if (inner.unlinkIssues) {
      this.unlinkIssues = async (f, ty, to) => {
        await this.inner.unlinkIssues!(f, ty, to);
        this.cache.clear();
      };
    }
    if (inner.listLinks) {
      this.listLinks = (id) => this.inner.listLinks!(id);
    }
    if (inner.listComments) {
      this.listComments = (id) => this.inner.listComments!(id);
    }
    if (inner.listWorklogs) {
      this.listWorklogs = (id) => this.inner.listWorklogs!(id);
    }
    if (inner.attachFile) {
      // Write, not a read — no cache entry to clear (attachments aren't cached).
      this.attachFile = (id, filename, data, mediaType) =>
        this.inner.attachFile!(id, filename, data, mediaType);
    }
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const result = await this.inner.createIssue(input);
    this.cache.clear();
    return result;
  }

  async getIssue(id: string): Promise<Issue> {
    const key = `issue:${id}`;
    const cached = this.cache.get<Issue>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.getIssue(id);
    this.cache.set(key, this.clone(result));
    return result;
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    const result = await this.inner.updateIssue(id, patch);
    this.cache.clear();
    return result;
  }

  async closeIssue(id: string): Promise<Issue> {
    const result = await this.inner.closeIssue(id);
    this.cache.clear();
    return result;
  }

  async listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]> {
    const key = `list:${JSON.stringify(filter ?? {})}`;
    const cached = this.cache.get<Issue[]>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.listIssues(filter);
    this.cache.set(key, this.clone(result));
    return result;
  }

  async createPhase(name: string): Promise<Phase> {
    const result = await this.inner.createPhase(name);
    this.cache.clear();
    return result;
  }

  async listPhases(): Promise<Phase[]> {
    const key = "phases";
    const cached = this.cache.get<Phase[]>(key);
    if (cached) return this.clone(cached);

    const result = await this.inner.listPhases();
    this.cache.set(key, this.clone(result));
    return result;
  }

  async closePhase(id: string): Promise<Phase> {
    const result = await this.inner.closePhase(id);
    this.cache.clear();
    return result;
  }

  async createMilestone(name: string): Promise<Milestone> {
    const result = await this.inner.createMilestone(name);
    this.cache.clear();
    return result;
  }

  async listMilestones(): Promise<Milestone[]> {
    const key = "milestones";
    const cached = this.cache.get<Milestone[]>(key);
    if (cached) return this.clone(cached);
    const result = await this.inner.listMilestones();
    this.cache.set(key, this.clone(result));
    return result;
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const result = await this.inner.completeMilestone(id);
    this.cache.clear();
    return result;
  }

  async commentIssue(id: string, text: string): Promise<{ id: string; url?: string }> {
    const result = await this.inner.commentIssue(id, text);
    this.cache.clear();
    return result;
  }
}
