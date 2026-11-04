// Local tracker — zero-dependency, repo-resident backend (CRN-50 phase 1).
// Issues live as directories under <projectDir>/<dir> (default .tracker/):
// issue.md carries spaced frontmatter (a blank line between fields — that
// spacing is the git merge-safety mechanism, validated by probe CRN-51),
// and comments/worklogs/edges are one file per record so concurrent
// branches merge cleanly by construction. No database, no credentials.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import { CairnError } from "../../errors.js";
import type {
  Capability,
  Issue,
  IssueComment,
  IssueCreate,
  IssueLink,
  IssuePatch,
  IssueState,
  LinkType,
  Milestone,
  Phase,
  ProbeResult,
  Tracker,
  StateCategory,
  WorklogEntry,
} from "../types.js";

export const configSchema = z.object({
  /** Store directory, relative to the project. Commit it — that's the point. */
  dir: z.string().min(1).default(".tracker"),
  /** Issue-id prefix, e.g. "crn" → crn-x7k2m. */
  prefix: z
    .string()
    .regex(/^[a-z0-9]{2,10}$/)
    .default("lt"),
  /** Custom state vocabulary: name → semantic category (CRN-26).
   *  e.g. { "review": "in_progress", "blocked": "open" } */
  // Deliberate .default({}) — NOT a missed .prefault (#95): a record carries
  // no inner defaults, so zod 4's short-circuit and parse-through both yield {}.
  states: z
    .record(z.string(), z.enum(["open", "in_progress", "closed"]))
    .default({}),
});

export type LocalConfig = z.infer<typeof configSchema>;

export function make(config: LocalConfig, projectDir: string): Tracker {
  return new LocalTracker(config, projectDir);
}

const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random 5-char base36 suffix, retried against the visible id set. */
export function newId(prefix: string, taken: Set<string>): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 5; i++) s += B36[Math.floor(Math.random() * 36)];
    const id = `${prefix}-${s}`;
    if (!taken.has(id)) return id;
  }
}

interface Fields {
  id: string;
  title: string;
  state: IssueState;
  labels: string[];
  assignee?: string;
  phase?: string;
  priority?: string;
  points?: number;
  minutes?: number;
  body: string;
}

const PRIORITY_RE = /^priority:(.+)$/;
const FRONT_RE = /^---\n([\s\S]*?)\n---\n?/;

/** One blank line between fields — merge safety, not styling. */
function renderIssue(f: Fields): string {
  const lines = [
    `id: ${f.id}`,
    `title: ${JSON.stringify(f.title)}`,
    `state: ${f.state}`,
    `labels: ${JSON.stringify(f.labels)}`,
    `assignee: ${f.assignee ?? ""}`,
    `phase: ${f.phase ?? ""}`,
    `priority: ${f.priority ?? ""}`,
    `points: ${f.points ?? ""}`,
    `minutes: ${f.minutes ?? ""}`,
  ];
  // updatedAt is deliberately NOT stored — a stored timestamp would make
  // every concurrent update-pair a same-field merge conflict. It derives
  // from the file's mtime instead.
  const body = f.body === "" || f.body.endsWith("\n") ? f.body : `${f.body}\n`;
  return `---\n${lines.join("\n\n")}\n---\n\n${body}`;
}

function parseIssueFile(raw: string): Fields {
  const m = FRONT_RE.exec(raw);
  if (!m)
    throw new CairnError(
      "CONFIG_INVALID",
      "[local] malformed issue file (no frontmatter)",
    );
  const get = (k: string) =>
    new RegExp(`^${k}: (.*)$`, "m").exec(m[1])?.[1]?.trim() ?? "";
  return {
    id: get("id"),
    title: JSON.parse(get("title") || '""') as string,
    state: (get("state") || "open") as IssueState,
    labels: JSON.parse(get("labels") || "[]") as string[],
    assignee: get("assignee") || undefined,
    phase: get("phase") || undefined,
    priority: get("priority") || undefined,
    points: get("points") ? Number(get("points")) : undefined,
    minutes: get("minutes") ? Number(get("minutes")) : undefined,
    body: raw.slice(m[0].length).replace(/^\n/, "").replace(/\n$/, ""),
  };
}

/** Split a priority:<value> label out of an SPI label list. */
function splitPriority(labels: string[]): {
  labels: string[];
  priority?: string;
} {
  const hit = labels.find((l) => PRIORITY_RE.test(l));
  return {
    labels: labels.filter((l) => !PRIORITY_RE.test(l)),
    priority: hit ? PRIORITY_RE.exec(hit)![1] : undefined,
  };
}

export class LocalTracker implements Tracker {
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

  private readonly root: string;
  private initialized = false;
  private self: string | undefined;

  constructor(
    private readonly cfg: LocalConfig,
    private readonly projectDir: string,
  ) {
    this.root = resolve(projectDir, cfg.dir);
  }

  /** Lazy scaffold: directories + config.json on first use. */
  private init(): void {
    if (this.initialized) return;
    for (const d of ["issues", "phases", "milestones"]) {
      mkdirSync(join(this.root, d), { recursive: true });
    }
    const cfgPath = join(this.root, "config.json");
    if (!existsSync(cfgPath)) {
      writeFileSync(
        cfgPath,
        `${JSON.stringify({ prefix: this.cfg.prefix, version: 1 }, null, 2)}\n`,
      );
    }
    this.initialized = true;
  }

  private issueDir(id: string): string {
    return join(this.root, "issues", id);
  }
  private issuePath(id: string): string {
    return join(this.issueDir(id), "issue.md");
  }

  private ids(): Set<string> {
    this.init();
    return new Set(
      readdirSync(join(this.root, "issues")).filter((e) => !e.startsWith(".")),
    );
  }

  private readFields(id: string): Fields {
    if (!existsSync(this.issuePath(id))) {
      throw new CairnError(
        "NOT_FOUND",
        `[local] no issue ${id}`,
        `check the id against ${this.cfg.dir}/issues/`,
      );
    }
    return parseIssueFile(readFileSync(this.issuePath(id), "utf8"));
  }

  private warnedMigrated = false;

  /** Soft guard: a store already promoted to a hosted backend still works,
   *  but writes are probably landing in the wrong place — say so once. */
  private warnIfMigrated(): void {
    if (this.warnedMigrated) return;
    this.warnedMigrated = true;
    try {
      const cfg = JSON.parse(
        readFileSync(join(this.root, "config.json"), "utf8"),
      ) as { migratedTo?: string };
      if (cfg.migratedTo) {
        console.error(
          `[cairn local] warning: this store was migrated to ` +
            `'${cfg.migratedTo}' — new writes here won't reach it`,
        );
      }
    } catch {
      /* unscaffolded store — nothing to warn about */
    }
  }

  private writeFields(f: Fields): Issue {
    this.init();
    this.warnIfMigrated();
    mkdirSync(this.issueDir(f.id), { recursive: true });
    writeFileSync(this.issuePath(f.id), renderIssue(f));
    return this.toIssue(f);
  }

  private toIssue(f: Fields): Issue {
    let updatedAt: string;
    try {
      updatedAt = statSync(this.issuePath(f.id)).mtime.toISOString();
    } catch {
      updatedAt = new Date().toISOString();
    }
    return {
      id: f.id,
      title: f.title,
      body: f.body,
      state: f.state,
      category: this.categoryOf(f.state),
      labels: f.priority ? [...f.labels, `priority:${f.priority}`] : f.labels,
      phase: f.phase,
      assignee: f.assignee,
      estimate:
        f.points !== undefined || f.minutes !== undefined
          ? {
              ...(f.points !== undefined ? { points: f.points } : {}),
              ...(f.minutes !== undefined ? { minutes: f.minutes } : {}),
            }
          : undefined,
      updatedAt,
      url: `file://${this.issuePath(f.id)}`,
    };
  }

  async createIssue(input: IssueCreate): Promise<Issue> {
    const { labels, priority } = splitPriority(input.labels ?? []);
    return this.writeFields({
      id: newId(this.cfg.prefix, this.ids()),
      title: input.title,
      state: "open",
      labels,
      priority,
      phase: input.phase,
      points: input.estimate?.points,
      minutes: input.estimate?.minutes,
      body: input.body ?? "",
    });
  }

  async getIssue(id: string): Promise<Issue> {
    return this.toIssue(this.readFields(id));
  }

  async updateIssue(id: string, patch: IssuePatch): Promise<Issue> {
    if (
      patch.state !== undefined &&
      !["open", "in_progress", "closed"].includes(patch.state) &&
      this.cfg.states[patch.state] === undefined
    ) {
      throw new CairnError(
        "CONFIG_INVALID",
        `unknown state '${patch.state}'`,
        `add it to tracker.config.states in cairn.json (known: ${["open", "in_progress", "closed", ...Object.keys(this.cfg.states)].join(", ")})`,
      );
    }
    const f = this.readFields(id);
    const patched =
      patch.labels === undefined
        ? { labels: f.labels, priority: f.priority }
        : splitPriority(patch.labels);
    return this.writeFields({
      ...f,
      title: patch.title ?? f.title,
      body: patch.body ?? f.body,
      state: patch.state ?? f.state,
      labels: patched.labels,
      priority: patched.priority,
      assignee: patch.assignee ?? f.assignee,
      phase: patch.phase ?? f.phase,
      points: patch.estimate ? patch.estimate.points : f.points,
      minutes: patch.estimate ? patch.estimate.minutes : f.minutes,
    });
  }

  async closeIssue(id: string): Promise<Issue> {
    return this.updateIssue(id, { state: "closed" });
  }

  /** Stored name → semantic category: canonical passes through, the config
   *  vocab maps custom names, anything unrecognized buckets to in_progress. */
  private categoryOf(state: string): StateCategory {
    if (state === "open" || state === "in_progress" || state === "closed")
      return state;
    return this.cfg.states[state] ?? "in_progress";
  }

  /** The SPI's pre-write question (#427): a known name's category, and
   *  undefined for one the vocab lacks -- that name never buckets here,
   *  because updateIssue refuses it rather than storing it. */
  stateCategory(state: string): StateCategory | undefined {
    if (state === "open" || state === "in_progress" || state === "closed")
      return state;
    return this.cfg.states[state];
  }

  async listIssues(filter?: {
    phase?: string;
    state?: IssueState;
  }): Promise<Issue[]> {
    return [...this.ids()]
      .map((id) => this.readFields(id))
      .filter(
        (f) =>
          (filter?.phase === undefined || f.phase === filter.phase) &&
          (filter?.state === undefined ||
            f.state === filter.state ||
            this.categoryOf(f.state) === filter.state),
      )
      .map((f) => this.toIssue(f));
  }

  private listJson<T>(dir: string): T[] {
    this.init();
    return readdirSync(join(this.root, dir))
      .filter((e) => e.endsWith(".json"))
      .map(
        (e) => JSON.parse(readFileSync(join(this.root, dir, e), "utf8")) as T,
      );
  }

  private writeJson(dir: string, id: string, value: unknown): void {
    writeFileSync(
      join(this.root, dir, `${id}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  async createPhase(name: string): Promise<Phase> {
    const id = newId(
      "ph",
      new Set(this.listJson<Phase>("phases").map((p) => p.id)),
    );
    const phase: Phase = { id, name, state: "open" };
    this.writeJson("phases", id, phase);
    return phase;
  }

  async listPhases(): Promise<Phase[]> {
    return this.listJson<Phase>("phases");
  }

  async closePhase(id: string): Promise<Phase> {
    const p = this.listJson<Phase>("phases").find((x) => x.id === id);
    if (!p) throw new CairnError("NOT_FOUND", `[local] no phase ${id}`);
    const closed: Phase = { ...p, state: "closed" };
    this.writeJson("phases", id, closed);
    return closed;
  }

  async createMilestone(name: string): Promise<Milestone> {
    const id = newId(
      "ms",
      new Set(this.listJson<Milestone>("milestones").map((m) => m.id)),
    );
    const ms: Milestone = { id, name, state: "open" };
    this.writeJson("milestones", id, ms);
    return ms;
  }

  async listMilestones(): Promise<Milestone[]> {
    return this.listJson<Milestone>("milestones");
  }

  async completeMilestone(id: string): Promise<Milestone> {
    const m = this.listJson<Milestone>("milestones").find((x) => x.id === id);
    if (!m) throw new CairnError("NOT_FOUND", `[local] no milestone ${id}`);
    const done: Milestone = { ...m, state: "released" };
    this.writeJson("milestones", id, done);
    return done;
  }

  /** Filename-safe author tag for comment/worklog records. */
  private async who(): Promise<string> {
    const raw = (await this.resolveSelf()) ?? "anon";
    return (
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "anon"
    );
  }

  private stamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
  }

  async commentIssue(
    id: string,
    text: string,
  ): Promise<{ id: string; url?: string }> {
    this.readFields(id); // NOT_FOUND guard
    const dir = join(this.issueDir(id), "comments");
    mkdirSync(dir, { recursive: true });
    const name = `${this.stamp()}-${await this.who()}`;
    const path = join(dir, `${name}.md`);
    writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
    return { id: name, url: `file://${path}` };
  }

  async logWork(id: string, minutes: number): Promise<void> {
    this.readFields(id);
    const dir = join(this.issueDir(id), "worklog");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${this.stamp()}-${await this.who()}.md`),
      `${minutes}m\n`,
    );
  }

  async attachFile(
    id: string,
    filename: string,
    data: Buffer,
    _mediaType?: string,
  ): Promise<{ id?: string; url?: string }> {
    this.readFields(id); // NOT_FOUND guard
    const dir = join(this.issueDir(id), "attachments");
    mkdirSync(dir, { recursive: true });
    let target = join(dir, basename(filename));
    if (existsSync(target)) {
      // Same name twice is a new piece of evidence, not an overwrite.
      const ext = extname(filename);
      target = join(dir, `${basename(filename, ext)}-${this.stamp()}${ext}`);
    }
    writeFileSync(target, data);
    return { url: `file://${target}` };
  }

  /** Parse "<stamp>-<author>.md" record filenames back into metadata. */
  private historyFiles(
    id: string,
    sub: string,
  ): Array<{ at?: string; author?: string; text: string }> {
    this.readFields(id); // NOT_FOUND guard
    const dir = join(this.issueDir(id), sub);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((e) => e.endsWith(".md"))
      .sort()
      .map((e) => {
        const m = /^(.+Z)-(.+)\.md$/.exec(e);
        return {
          at: m?.[1],
          author: m?.[2],
          text: readFileSync(join(dir, e), "utf8").trim(),
        };
      });
  }

  async listComments(id: string): Promise<IssueComment[]> {
    return this.historyFiles(id, "comments");
  }

  async listWorklogs(id: string): Promise<WorklogEntry[]> {
    return this.historyFiles(id, "worklog").map((r) => ({
      at: r.at,
      author: r.author,
      minutes: Number(/^(\d+)m/.exec(r.text)?.[1] ?? 0),
    }));
  }

  private edgePath(from: string, type: LinkType, to: string): string {
    return join(this.issueDir(from), "edges", `${type}--${to}.md`);
  }

  /** All stored edges — a directory walk; the graph is always in-memory. */
  private allEdges(): IssueLink[] {
    const links: IssueLink[] = [];
    for (const from of this.ids()) {
      const dir = join(this.issueDir(from), "edges");
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir)) {
        const m = /^([a-z-]+)--(.+)\.md$/.exec(e);
        if (m) links.push({ from, type: m[1] as LinkType, to: m[2] });
      }
    }
    return links;
  }

  private wouldCycle(from: string, type: LinkType, to: string): boolean {
    if (type !== "blocks" && type !== "parent-of") return false;
    const edges = this.allEdges().filter((l) => l.type === type);
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of edges) if (l.from === cur) stack.push(l.to);
    }
    return false;
  }

  async linkIssues(from: string, type: LinkType, to: string): Promise<void> {
    this.readFields(from);
    this.readFields(to); // NOT_FOUND guard on both ends
    if (this.wouldCycle(from, type, to)) {
      throw new CairnError(
        "CONFIG_INVALID",
        `link ${from} ${type} ${to} would create a cycle`,
        "reverse the direction or drop one edge in the chain",
      );
    }
    mkdirSync(join(this.issueDir(from), "edges"), { recursive: true });
    const path = this.edgePath(from, type, to);
    if (!existsSync(path)) writeFileSync(path, "");
  }

  async unlinkIssues(from: string, type: LinkType, to: string): Promise<void> {
    rmSync(this.edgePath(from, type, to), { force: true });
  }

  async listLinks(id?: string): Promise<IssueLink[]> {
    const all = this.allEdges();
    return id === undefined
      ? all
      : all.filter((l) => l.from === id || l.to === id);
  }

  async resolveSelf(): Promise<string | undefined> {
    if (this.self) return this.self;
    try {
      this.self =
        execFileSync("git", ["config", "user.name"], {
          cwd: this.projectDir,
          stdio: "pipe",
        })
          .toString()
          .trim() || undefined;
    } catch {
      /* not a git repo or no identity configured */
    }
    this.self ??= process.env.USER || undefined;
    return this.self;
  }

  /** Repo-resident, zero-network backend — nothing to preflight. Always ok. */
  async probe(): Promise<ProbeResult> {
    return { verdict: "ok" };
  }
}
