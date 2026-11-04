import { CairnError } from "../errors.js";

/** The semantic bucket every cairn mechanism reasons about — drift math,
 *  ship gates, ready frontier, filters. Never compare `Issue.state` to a
 *  literal; compare `Issue.category`. */
export type StateCategory = "open" | "in_progress" | "closed";

/** Widened (CRN-26): an issue's state is its REAL workflow state name —
 *  "In Review", "Blocked", whatever the board says. The canonical three are
 *  always valid values and always writable on every backend. */
export type IssueState = string;

export interface Issue {
  id: string;
  title: string;
  body: string;
  /** Display-fidelity state name; falls back to the category string on
   *  backends with no richer name. */
  state: IssueState;
  /** Semantic bucket — the thing to branch on. */
  category: StateCategory;
  labels: string[];
  phase?: string;
  assignee?: string;
  estimate?: IssueEstimate;
  updatedAt: string; // ISO-8601 UTC
  url: string;
}

/** Story points and/or an original time estimate — hasEstimates backends only. */
export interface IssueEstimate { points?: number; minutes?: number }

/** List-filter semantics after the widening: a state filter matches by
 *  semantic category OR by exact display name. */
export function matchesState(issue: Issue, state: string): boolean {
  return issue.category === state || issue.state === state;
}

/** Guard for backends with NO custom-state surface — anything beyond the
 *  canonical three is a config error there, never a silent no-op. */
export function assertCanonicalState(state: string | undefined, backend: string): void {
  if (state === undefined) return;
  if (state === "open" || state === "in_progress" || state === "closed") return;
  throw new CairnError("CONFIG_INVALID",
    `${backend} has no custom-state surface — unknown state '${state}'`,
    "use open/in_progress/closed on this backend");
}

/** The category a requested state NAME resolves to on `tracker`, asked
 *  before any write (#427): the adapter's own vocabulary when it has one,
 *  else the canonical three by name (always writable on every backend);
 *  undefined for a name neither knows, which the adapter's own refusal
 *  then speaks to on the write -- and which the freeze check treats as a
 *  close while a run is frozen (#471), never as a reason to skip. The
 *  freeze check keys on this, never on the literal name -- asserted by
 *  run-breaker.test.ts (#427, #471) and tracker-contract.test.ts. */
export function requestedCategory(tracker: Tracker, state: IssueState): StateCategory | undefined {
  const own = tracker.stateCategory?.(state);
  if (own) return own;
  return state === "open" || state === "in_progress" || state === "closed" ? state : undefined;
}

export interface Phase {
  id: string;
  name: string;
  number?: number;
  state: "open" | "closed";
}

export interface Capability {
  hasInProgress: boolean;
  hasPhases: boolean;
  /** Can updateIssue move an existing issue into a different phase?
   *  False where the backend's phase is a creation-time parent with no
   *  move primitive (clickup lists) — the tool layer drops the patch
   *  field there and says so via phaseSkipped, mirroring hasEstimates. */
  hasPhaseReassign: boolean;
  hasDependencies: boolean;
  hasLabels: boolean;
  hasMilestones: boolean;
  hasPhaseClose: boolean;
  hasComments: boolean;
  hasWorklog: boolean;
  hasEstimates: boolean;
  hasIssueAttachments: boolean;
}

export interface Milestone {
  id: string;
  name: string;
  state: "open" | "released";
  url?: string;
}

export interface IssueCreate {
  title: string;
  body?: string;
  labels?: string[];
  phase?: string;
  estimate?: IssueEstimate;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: IssueState;
  labels?: string[];
  assignee?: string;
  estimate?: IssueEstimate;
  /** Tracker phase id — same backend mapping as IssueCreate.phase
   *  (milestone/epic/section/iteration/project). Honored only on
   *  adapters with hasPhaseReassign; the tool layer drops it elsewhere
   *  and reports phaseSkipped. */
  phase?: string;
}

export interface IssueComment { at?: string; author?: string; text: string }

export interface WorklogEntry { at?: string; author?: string; minutes: number }

export type LinkType = "blocks" | "parent-of" | "relates-to" | "supersedes";

export interface IssueLink { from: string; type: LinkType; to: string }

/** Credential-preflight verdict (CRN-48) — one cheap authenticated call,
 *  mapped onto a specific, actionable bucket instead of a generic failure. */
export type ProbeVerdict =
  | "ok" | "bad_host" | "bad_token" | "missing_scope" | "rate_limited" | "down";

export interface ProbeResult { verdict: ProbeVerdict; detail?: string }

/** What the service enforces on the default branch (#485) -- the four rules
 *  the push gate rests on, as the tracker reports them: `pull_request`,
 *  `required_reviews:<n>`, `non_fast_forward` (no force push), `deletion`.
 *  `rules` is only a measurement when `source` names the endpoint that
 *  answered; a read that failed says `unreadable: <reason>` and is never
 *  passed off as an empty list (claims rule 2, #462). Asserted by
 *  github.unit.test.ts "GitHubTracker branchProtection (#485)". */
export interface BranchProtection {
  default: string;
  rules: string[];
  source: "rulesets" | "legacy" | `unreadable: ${string}`;
}

export interface Tracker {
  readonly capabilities: Capability;
  createIssue(input: IssueCreate): Promise<Issue>;
  getIssue(id: string): Promise<Issue>;
  updateIssue(id: string, patch: IssuePatch): Promise<Issue>;
  closeIssue(id: string): Promise<Issue>;
  listIssues(filter?: { phase?: string; state?: IssueState }): Promise<Issue[]>;
  createPhase(name: string): Promise<Phase>;
  listPhases(): Promise<Phase[]>;
  closePhase(id: string): Promise<Phase>;
  createMilestone(name: string): Promise<Milestone>;
  listMilestones(): Promise<Milestone[]>;
  completeMilestone(id: string): Promise<Milestone>;
  commentIssue(id: string, text: string): Promise<{ id: string; url?: string }>;
  /** Log time against an issue. Present only on adapters with hasWorklog. */
  logWork?(id: string, minutes: number): Promise<void>;
  /** Backend-native identifier for the authenticated user (assignee form).
   *  Present only on adapters that can derive it. Memoized per instance. */
  resolveSelf?(): Promise<string | undefined>;
  /** Cheap credential preflight -- one authenticated call, mapped to a
   *  specific verdict. A probe failure IS the result: this never throws. */
  probe?(): Promise<ProbeResult>;
  /** The default branch's protection as the service reports it (#485).
   *  Present only on adapters whose backend holds the repository (github
   *  today). Never throws: a failed read is `source: "unreadable: …"`. */
  branchProtection?(): Promise<BranchProtection>;
  /** The category a state NAME would resolve to here, with no write and
   *  no network (#427) -- present on adapters with a custom-state
   *  vocabulary: local and the fake from their config, jira, linear,
   *  clickup and azure-boards from their state maps and whatever the
   *  wire has already shown them (#471). undefined: not a name this
   *  backend can place yet -- the freeze gate falls closed on it. The
   *  canonical three resolve by name everywhere; see requestedCategory. */
  stateCategory?(state: IssueState): StateCategory | undefined;
  /** Issue links. Present only on adapters with hasDependencies. */
  linkIssues?(from: string, type: LinkType, to: string): Promise<void>;
  unlinkIssues?(from: string, type: LinkType, to: string): Promise<void>;
  /** id given → links touching that issue (either direction); omitted → all. */
  listLinks?(id?: string): Promise<IssueLink[]>;
  /** History reads — present where the backend can enumerate them
   *  (migration sources). */
  listComments?(id: string): Promise<IssueComment[]>;
  listWorklogs?(id: string): Promise<WorklogEntry[]>;
  /** Binary evidence (screenshots, renders) on an issue. Present only on
   *  adapters with hasIssueAttachments. */
  attachFile?(id: string, filename: string, data: Buffer,
    mediaType?: string): Promise<{ id?: string; url?: string }>;
}
