/**
 * Purpose: the run manifest for headless batch runs (#132) — the staging
 *   interview's output and the executor's SOLE source of authority. One
 *   manifest per run, written when the user approves the staging gate:
 *   which phases run, their estimate ranges, the budget ceiling, and the
 *   push pre-authorization (REC-5 moved to run start, scope-limited to
 *   the manifest's phases — a phase outside the manifest never pushes).
 *
 *   Lives under ~/.cairn (never the repo) with the same path/injection
 *   conventions as budget-ledger.ts: per-machine project hash, filename-
 *   safe runId, raw run_id verified on load so a sanitize collision can't
 *   silently merge two runs. Versioned state file — z.literal(1) +
 *   safeParse + atomic tmp-then-rename write, continuity.ts precedent.
 *
 *   pushAuth starts FALSE and only grantPushAuth() flips it — creation can
 *   never smuggle authority in. Status walks a one-way lifecycle:
 *   staged → running → complete|stopped (staged may also go straight to
 *   stopped when a run is abandoned before it starts). currentPhase walks
 *   forward through the manifest's own phases while running (#260), so
 *   the run guard can tie a push to a phase the owner authorized.
 *
 * removeWhen: never — push authority is an owner-decided policy gate, not
 *   a workaround for a model limit; a stronger agent does not change who
 *   decides what leaves the machine (ADR 0007).
 * Author(s): John Reed
 */

// Imports
import { z } from "zod";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CairnError } from "../errors.js";

// Constants

/** The only legal status moves — anything else is a lifecycle bug. */
const STATUS_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  staged: ["running", "stopped"],
  running: ["complete", "stopped"],
  complete: [],
  stopped: [],
};

// Paths

/** Same per-machine hashing scheme as continuity.ts / budget-ledger.ts --
 * exported so the ship-gate stamp keys the same way the manifests do. */
export function pathHash(projectDir: string): { base: string; hash: string } {
  const abs = resolve(projectDir);
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 16);
  return { base: basename(abs), hash };
}

/** Filename-safe runId — exotic characters collapse to '-'; the raw run_id
 * stays inside the file and is verified on load. */
function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** ~/.cairn/runs/<project>-<hash>-<runId>.json — one manifest per run,
 * outside the repo. baseDir injectable for tests (budget-ledger convention). */
export function runManifestPath(
  projectDir: string, runId: string, baseDir: string = join(homedir(), ".cairn"),
): string {
  const { base, hash } = pathHash(projectDir);
  return join(baseDir, "runs", `${base}-${hash}-${safeRunId(runId)}.json`);
}

// Schema — versioned state file, z.literal(1) + safeParse like continuity's
// Handoff and the budget ledger.

export type RunStatus = "staged" | "running" | "complete" | "stopped";

export interface ManifestPhase {
  number: number;
  name: string;
  estimate: {
    low: number; // tokens, range floor
    high: number; // tokens, range ceiling — budget fitting uses THIS end
    estUsd: { low: number; high: number };
  };
  waves?: number;
}

export interface StagedAnswer {
  phase?: number | string; // owning phase(s) when the question was scoped
  question: string;
  answer: string;
}

export interface RunManifestState {
  version: 1;
  runId: string;
  project: string;
  created: string;
  phases: ManifestPhase[];
  /** Budget ceiling the run was staged under; null = explicitly uncapped. */
  ceiling: { tokens?: number; usd?: number } | null;
  /** Push pre-authorization (REC-5 at run start). granted=false means the
   * run is verify-stop: phases run headless but NOTHING pushes. Scope is
   * always the manifest's own phases — never wider. */
  pushAuth: {
    granted: boolean;
    scope: "manifest-phases";
    grantedAt?: string; // present only once actually granted
  };
  /** Staging question-round answers (scout batch form) that travel with
   * the run so the executor never has to ask mid-flight. */
  answers?: StagedAnswer[];
  status: RunStatus;
  /** The Agent `effort` dial the run was staged under (#332), so
   * estimate-vs-actual can tell a cheap run from a thorough one. Absent on
   * manifests written before the dial existed. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** The manifest phase in flight (#260), set by setCurrentPhase at each
   * phase start. Absent until the first phase starts — and on manifests
   * written before it existed, which the run guard reads as "no push". */
  currentPhase?: number;
}

const ManifestPhaseSchema: z.ZodType<ManifestPhase> = z.object({
  number: z.number(),
  name: z.string(),
  estimate: z.object({
    low: z.number(),
    high: z.number(),
    estUsd: z.object({ low: z.number(), high: z.number() }),
  }),
  waves: z.number().optional(),
});

const StagedAnswerSchema: z.ZodType<StagedAnswer> = z.object({
  phase: z.union([z.number(), z.string()]).optional(),
  question: z.string(),
  answer: z.string(),
});

export const RunManifestSchema: z.ZodType<RunManifestState> = z.object({
  version: z.literal(1),
  runId: z.string(),
  project: z.string(),
  created: z.string(),
  phases: z.array(ManifestPhaseSchema),
  ceiling: z
    .object({ tokens: z.number().optional(), usd: z.number().optional() })
    .nullable(),
  pushAuth: z.object({
    granted: z.boolean(),
    scope: z.literal("manifest-phases"),
    grantedAt: z.string().optional(),
  }),
  answers: z.array(StagedAnswerSchema).optional(),
  status: z.enum(["staged", "running", "complete", "stopped"]),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  currentPhase: z.number().optional(),
});

// Internals

/** Reads and validates the manifest file at `path`; null when absent. */
function readManifestFile(path: string): RunManifestState | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("HANDOFF_INVALID",
      `run manifest at ${path} is not valid JSON: ${e}`,
      "inspect or discard ~/.cairn/runs/…");
  }
  const result = RunManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new CairnError("HANDOFF_INVALID",
      `run manifest at ${path} failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "inspect or discard ~/.cairn/runs/…");
  }
  return result.data;
}

/** Atomic write — tmp then rename, continuity's handoff writer pattern. */
function writeManifestFile(path: string, state: RunManifestState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Loads the manifest for a run, guarding against sanitize collisions the
 * same way the budget ledger does. Throws NOT_FOUND when absent. */
function loadManifest(
  projectDir: string, runId: string, baseDir: string,
): { path: string; state: RunManifestState } {
  const path = runManifestPath(projectDir, runId, baseDir);
  const state = readManifestFile(path);
  if (!state) {
    throw new CairnError("NOT_FOUND",
      `no run manifest for run '${runId}'`,
      "stage the run first (auto --batch writes the manifest at the staging gate)");
  }
  if (state.runId !== runId) {
    throw new CairnError("HANDOFF_INVALID",
      `manifest at ${path} belongs to run '${state.runId}', not '${runId}'`,
      "pick a runId that differs in more than punctuation");
  }
  return { path, state };
}

// API

/**
 * Writes a fresh manifest at staging time. One manifest per run — an
 * existing manifest for this runId throws instead of being overwritten
 * (re-staging a run means a new runId; history never gets clobbered).
 * pushAuth always starts granted:false — only grantPushAuth() can flip it.
 *
 * :param projectDir: the project the run belongs to
 * :returns the manifest state as written
 */
export function createRunManifest(
  projectDir: string,
  opts: {
    runId: string;
    phases: ManifestPhase[];
    ceiling?: { tokens?: number; usd?: number } | null;
    answers?: StagedAnswer[];
    effort?: RunManifestState["effort"];
    createdAt?: string; // injectable for tests; wall clock otherwise
    baseDir?: string;
  },
): RunManifestState {
  if (!opts.runId || !opts.runId.trim()) {
    throw new CairnError("HANDOFF_INVALID", "runId must be a non-empty string");
  }
  if (!opts.phases.length) {
    throw new CairnError("PRECONDITION_FAILED",
      `run '${opts.runId}' has no phases — nothing to stage`,
      "pick at least one phase (--phases) or widen the budget");
  }
  const baseDir = opts.baseDir ?? join(homedir(), ".cairn");
  const path = runManifestPath(projectDir, opts.runId, baseDir);

  const existing = readManifestFile(path);
  if (existing) {
    throw new CairnError("PRECONDITION_FAILED",
      `a manifest for run '${existing.runId}' already exists at ${path}`,
      "one manifest per run — pick a new runId to re-stage");
  }

  const state: RunManifestState = {
    version: 1,
    runId: opts.runId,
    project: basename(resolve(projectDir)),
    created: opts.createdAt ?? new Date().toISOString(),
    phases: opts.phases,
    ceiling: opts.ceiling ?? null,
    pushAuth: { granted: false, scope: "manifest-phases" },
    ...(opts.answers !== undefined ? { answers: opts.answers } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    status: "staged",
  };
  writeManifestFile(path, state);
  return state;
}

/**
 * Reads a run's manifest without mutating anything — the executor's (and
 * status displays') view. Throws NOT_FOUND when the run was never staged.
 */
export function readRunManifest(
  projectDir: string, runId: string, baseDir?: string,
): RunManifestState {
  const base = baseDir ?? join(homedir(), ".cairn");
  return loadManifest(projectDir, runId, base).state;
}

/**
 * Reads the manifest AND says where it lives. The run report (#134) writes
 * beside the manifest file, so the read carries the real resolved path —
 * the agent never re-derives hashed filenames from naming conventions.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to read
 * :returns the manifest state plus its absolute file path
 */
export function readRunManifestWithPath(
  projectDir: string, runId: string, baseDir?: string,
): RunManifestState & { path: string } {
  const base = baseDir ?? join(homedir(), ".cairn");
  const { path, state } = loadManifest(projectDir, runId, base);
  return { ...state, path };
}

/**
 * Records the user's explicit push pre-authorization from the staging gate.
 * Only callable while the run is still 'staged' — authority is granted at
 * the front door or not at all, never mid-run.
 */
export function grantPushAuth(
  projectDir: string,
  runId: string,
  opts?: { grantedAt?: string; baseDir?: string },
): RunManifestState {
  const base = opts?.baseDir ?? join(homedir(), ".cairn");
  const { path, state } = loadManifest(projectDir, runId, base);
  if (state.status !== "staged") {
    throw new CairnError("PRECONDITION_FAILED",
      `run '${runId}' is '${state.status}' — push authorization is granted at staging only`,
      "stage a new run to grant push authority");
  }
  state.pushAuth = {
    granted: true,
    scope: "manifest-phases",
    grantedAt: opts?.grantedAt ?? new Date().toISOString(),
  };
  writeManifestFile(path, state);
  return state;
}

/**
 * Advances the run's status along the legal lifecycle
 * (staged → running → complete|stopped; staged → stopped for a run
 * abandoned before start). Any other move throws.
 */
export function setRunStatus(
  projectDir: string,
  runId: string,
  status: RunStatus,
  baseDir?: string,
): RunManifestState {
  const base = baseDir ?? join(homedir(), ".cairn");
  const { path, state } = loadManifest(projectDir, runId, base);
  if (!STATUS_TRANSITIONS[state.status].includes(status)) {
    throw new CairnError("PRECONDITION_FAILED",
      `run '${runId}' cannot move '${state.status}' → '${status}'`,
      `legal moves from '${state.status}': ${
        STATUS_TRANSITIONS[state.status].join(", ") || "(none — terminal)"}`);
  }
  state.status = status;
  writeManifestFile(path, state);
  return state;
}

/**
 * Marks which manifest phase is in flight (#260) — auto calls it at each
 * phase start, and the run guard honours push authority only while it
 * names one of the manifest's phases. Running runs only, the phase must be
 * in the manifest, and it only moves forward in manifest order: re-marking
 * the current phase (a resumed run) is a no-op, an earlier one throws.
 *
 * :param projectDir: the project the run belongs to
 * :param runId: the run to advance
 * :param phase: a phases[].number from this manifest
 * :returns the manifest state as written
 */
export function setCurrentPhase(
  projectDir: string,
  runId: string,
  phase: number,
  baseDir?: string,
): RunManifestState {
  const base = baseDir ?? join(homedir(), ".cairn");
  const { path, state } = loadManifest(projectDir, runId, base);
  if (state.status !== "running") {
    throw new CairnError("PRECONDITION_FAILED",
      `run '${runId}' is '${state.status}' — only a running run has a phase in flight`,
      "set_status running first; a stopped or complete run starts no phase");
  }
  const order = state.phases.map((p) => p.number);
  const at = order.indexOf(phase);
  if (at < 0) {
    throw new CairnError("PRECONDITION_FAILED",
      `phase ${phase} is not in run '${runId}' — its manifest stages ${order.join(", ")}`,
      "a run only ever works the phases approved at staging");
  }
  if (state.currentPhase !== undefined) {
    const was = order.indexOf(state.currentPhase);
    if (at === was) return state; // a resumed run re-marking where it was
    if (at < was) {
      throw new CairnError("PRECONDITION_FAILED",
        `run '${runId}' is on phase ${state.currentPhase} — phase ${phase} comes before it`,
        "the phase in flight only moves forward in manifest order");
    }
  }
  state.currentPhase = phase;
  writeManifestFile(path, state);
  return state;
}
