/**
 * Purpose: the convergence memory for a peers run — a per-run store under
 * .cairn/peers/<slug>/ that survives interruption. state.json is the index
 * (meta, which peer answered which round, findings with verdicts); the raw
 * peer outputs live in per-peer files beside it and are never re-read into
 * state. An interrupted run resumes from runStatus's report of what's
 * missing, and runClose is where audit provenance comes from — assembled
 * from the RECORDS, not from whatever the interrupted conversation
 * remembered.
 * Author(s): John Reed
 */

// Imports
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { FindingSchema, type Finding } from "./findings.js";

// Mirrors the divider run.ts stitches between a child's stdout and stderr
// (and findings.ts strips) -- the stderr tail is the reason a failed seat
// reports.
const STDERR_DIVIDER = "\n--- stderr ---\n";


// Constants

// Hard cap on convergence rounds — mirrors the peers verb's two-round rule.
const MAX_ROUND = 2;

export const VERDICTS = ["verified", "dead", "disputed", "open-disagreement"] as const;
export type Verdict = (typeof VERDICTS)[number];

// Peer names become file names (<peer>.round<N>.txt) — keep them boring.
const PEER_NAME = /^[a-z0-9][a-z0-9-]*$/;


// Types

export interface RunMeta {
  mode: "review" | "plan" | "council";
  target: string;
  focus?: string;
  peers: string[];
  startedAt: string;
  closedAt?: string;
  abandonedAt?: string;
}

export interface OutputRecord {
  peer: string;
  round: number;
  file: string;
  recordedAt: string;
  /** The child's exit code as peer_run returned it (#339). Absent on
   *  records written before the field existed, or when the caller had
   *  none to give -- absent never reads as failed. */
  exitCode?: number;
}

/**
 * A seat the run cannot count on (#339): `silent` never answered round 1;
 * `failed` answered with a non-zero exit and raised no findings -- the
 * shape a not-logged-in, rate-limited or credit-capped CLI produces, which
 * parses to empty piles and would otherwise read exactly like a clean
 * pass. `reason` is plain language for the status line; for a failed
 * seat it ends with the stderr tail the child left.
 */
export interface IncompleteSeat {
  peer: string;
  kind: "silent" | "failed";
  exitCode?: number;
  reason: string;
}

export interface FindingRecord {
  id: string;
  peer: string;
  round: number;
  finding: Finding;
  verdict?: Verdict;
  note?: string;
}

interface RunState {
  meta: RunMeta;
  outputs: OutputRecord[];
  findings: FindingRecord[];
}

export interface RunResumable {
  peersMissingRound1: string[];
  /** Silent AND failed seats, each with its reason (#339) -- a superset of
   *  peersMissingRound1, which stays for callers that only knew silence. */
  incompleteSeats: IncompleteSeat[];
  disputedAwaitingRound2: string[];
  unresolved: string[];   // finding ids still disputed or never judged
  complete: boolean;
}

export interface RunStatusReport {
  slug: string;
  meta: RunMeta;
  outputs: OutputRecord[];
  findings: FindingRecord[];
  resumable: RunResumable;
}

export interface CloseSummary {
  slug: string;
  verdict: "pass" | "findings";
  findings: Array<{
    severity: Finding["severity"];
    title: string;
    /** The peer's evidence, carried as the typed failure scenario audit_record requires. */
    failure_scenario: string;
    detail: string;
    /**
     * The peer's own verdict as a panel vote, so the close summary feeds
     * audit_record's quorum unchanged: verified → CONFIRMED, dead →
     * REFUTED (the record keeps it, the tracker never sees it),
     * open-disagreement → PLAUSIBLE.
     */
    panel: Array<{ seat: string; verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED"; evidence: string }>;
  }>;
  peers: string[];
  roundsRun: number;
  closedAt: string;
  /** Rostered peers the run could not count on — never answered round 1,
   *  or exited non-zero with no findings (#339) — present only on a close
   *  that went through with allowIncomplete, so provenance shows the
   *  degradation was deliberate. */
  incompleteSeats?: string[];
  /** One plain line per incomplete seat ("grok exited 1 with no findings
   *  -- see stderr: ..."), same order as incompleteSeats. */
  incompleteDetail?: string[];
}


// Store plumbing

// Same slugging rule as the review verb: lowercase, every run of
// non-[a-z0-9] collapses to one hyphen, edges trimmed.
function slugify(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new CairnError("CONFIG_INVALID",
      `'${raw}' slugs down to nothing`,
      "pass a slug with at least one [a-z0-9] character");
  }
  return slug;
}

const runDir = (projectDir: string, slug: string) =>
  join(projectDir, ".cairn", "peers", slug);

// tmp+rename so a crash mid-write never leaves a half-written file — same
// idiom as map/store.ts.
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function writeState(dir: string, state: RunState): void {
  writeAtomic(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function readState(projectDir: string, slug: string): RunState {
  const path = join(runDir(projectDir, slug), "state.json");
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND",
      `no peers run for slug '${slug}'`,
      "start one with runStart (op: start)");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunState;
  } catch {
    throw new CairnError("CONFIG_INVALID",
      `state.json for peers run '${slug}' is not valid JSON`,
      "abandon the run (op: abandon) and start over — raw peer outputs beside it are intact");
  }
}

const isFinished = (meta: RunMeta): boolean =>
  meta.closedAt !== undefined || meta.abandonedAt !== undefined;

function assertOpen(slug: string, state: RunState): void {
  if (isFinished(state.meta)) {
    const how = state.meta.closedAt ? "closed" : "abandoned";
    throw new CairnError("CONFIG_INVALID",
      `peers run '${slug}' is already ${how}`,
      "start a fresh run for this slug (op: start)");
  }
}

function assertRound(round: number): void {
  if (!Number.isInteger(round) || round < 1 || round > MAX_ROUND) {
    throw new CairnError("CONFIG_INVALID",
      `round ${round} is outside the two-round cap`,
      `rounds are 1..${MAX_ROUND} — a peer still disagreeing after round 2 is an open-disagreement verdict, not a round 3`);
  }
}

function assertRosterPeer(slug: string, state: RunState, peer: string): void {
  if (!state.meta.peers.includes(peer)) {
    throw new CairnError("CONFIG_INVALID",
      `peer '${peer}' is not on run '${slug}'s roster (${state.meta.peers.join(", ")})`,
      "record only peers the run started with — check the peer name for typos");
  }
}


// Lifecycle

/**
 * Creates the run dir and state.json for a new convergence run. An
 * UNFINISHED run already sitting on the slug is a hard stop — the caller
 * resumes it (runStatus) or abandons it (runAbandon) explicitly; nothing
 * here silently clobbers in-flight work. A finished (closed/abandoned)
 * run gets wiped, raw outputs and all, and the slug starts fresh.
 *
 * :param projectDir: project root the .cairn tree lives under
 * :param slug: run identity — slugged like review's scopes (lowercase,
 *              non-[a-z0-9] runs collapse to one hyphen)
 * :param meta: mode/target/focus plus the peer roster for the run
 * :returns: { slug, state } with the normalized slug
 * :raises CairnError: CONFIG_INVALID on an unfinished run or bad meta
 */
export function runStart(projectDir: string, slug: string, meta: {
  mode: "review" | "plan" | "council"; target: string; focus?: string; peers: string[];
}): { slug: string; state: RunState } {
  const s = slugify(slug);

  if (!meta.target.trim()) {
    throw new CairnError("CONFIG_INVALID", "meta.target must be non-empty",
      "name what this run reviews/plans, e.g. a branch, diff ref, or phase");
  }
  if (meta.peers.length === 0) {
    throw new CairnError("CONFIG_INVALID", "meta.peers must name at least one peer",
      "pass the roster peer_list reported available — a zero-peer run has nothing to converge");
  }
  for (const peer of meta.peers) {
    if (!PEER_NAME.test(peer)) {
      throw new CairnError("CONFIG_INVALID",
        `peer name '${peer}' is invalid`,
        "peer names are lowercase [a-z0-9-], e.g. codex, opencode, antigravity, grok");
    }
  }

  const dir = runDir(projectDir, s);
  if (existsSync(join(dir, "state.json"))) {
    const prior = readState(projectDir, s);
    if (!isFinished(prior.meta)) {
      throw new CairnError("CONFIG_INVALID",
        `an unfinished peers run already exists for '${s}' (started ${prior.meta.startedAt})`,
        "resume it (op: status shows what's missing) or abandon it (op: abandon) before starting over");
    }
    // Finished run: the slug is free again — clear its raw outputs too so
    // a resumed read never picks up a previous run's peer replies.
    rmSync(dir, { recursive: true, force: true });
  }

  mkdirSync(dir, { recursive: true });
  const state: RunState = {
    meta: {
      mode: meta.mode,
      target: meta.target,
      ...(meta.focus !== undefined ? { focus: meta.focus } : {}),
      peers: [...meta.peers],
      startedAt: new Date().toISOString(),
    },
    outputs: [],
    findings: [],
  };
  writeState(dir, state);
  return { slug: s, state };
}

/**
 * Marks an unfinished run abandoned — its slug becomes startable again.
 * Raw outputs stay on disk until the next runStart wipes them.
 */
export function runAbandon(projectDir: string, slug: string): { slug: string; abandonedAt: string } {
  const s = slugify(slug);
  const state = readState(projectDir, s);
  assertOpen(s, state);
  const abandonedAt = new Date().toISOString();
  state.meta.abandonedAt = abandonedAt;
  writeState(runDir(projectDir, s), state);
  return { slug: s, abandonedAt };
}


// Recording

/**
 * Stores one peer's raw reply for a round, verbatim, in
 * <peer>.round<N>.txt beside state.json — big and write-once, never
 * folded into the index. Re-recording the same peer+round overwrites
 * (a retried send supersedes the interrupted one).
 */
export function recordPeerOutput(projectDir: string, slug: string,
  peer: string, round: number, rawOutput: string,
  exitCode?: number | null): OutputRecord {
  const s = slugify(slug);
  const state = readState(projectDir, s);
  assertOpen(s, state);
  assertRosterPeer(s, state, peer);
  assertRound(round);

  const file = `${peer}.round${round}.txt`;
  const dir = runDir(projectDir, s);
  writeAtomic(join(dir, file), rawOutput);

  // #339: the exit code rides on the record when the caller has one. null
  // and undefined both mean "not given" -- old callers and old records
  // stay silent on it rather than reading as a zero.
  const record: OutputRecord = {
    peer, round, file, recordedAt: new Date().toISOString(),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
  };
  const existing = state.outputs.findIndex((o) => o.peer === peer && o.round === round);
  if (existing === -1) {
    state.outputs.push(record);
  } else {
    state.outputs[existing] = record;
  }
  writeState(dir, state);
  return record;
}

/**
 * Enters parsed findings into the run under stable ids (f1, f2, ... —
 * assigned in arrival order, never reused), tagged with the peer and
 * round that raised them. Validation is all-or-nothing per call: one bad
 * finding rejects the batch so ids never end up half-assigned.
 *
 * Idempotent per peer+round: a repeat call REPLACES that peer's prior
 * findings for the round (a retried parse supersedes the interrupted
 * one, mirroring recordPeerOutput). A finding whose claim matches one
 * of the replaced batch keeps its id, verdict, and note; a genuinely
 * new claim gets a fresh id that has never been used on the run. Other
 * peers' and rounds' findings are untouched.
 *
 * :returns: { ids } — the assigned ids, in the order given
 */
export function recordFindings(projectDir: string, slug: string,
  peer: string, round: number, findings: Finding[]): { ids: string[] } {
  const s = slugify(slug);
  const state = readState(projectDir, s);
  assertOpen(s, state);
  assertRosterPeer(s, state, peer);
  assertRound(round);

  const checked: Finding[] = [];
  for (const finding of findings) {
    const parsed = FindingSchema.safeParse(finding);
    if (!parsed.success) {
      throw new CairnError("CONFIG_INVALID",
        `finding does not match the Finding schema: ${
          parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        "run peer output through parseFindings first — only its `findings` pile enters state");
    }
    checked.push(parsed.data);
  }

  // The fresh-id counter looks at EVERY id currently on the run -- including
  // the batch about to be replaced -- so a dropped finding's id is never
  // handed out again.
  let nextId = state.findings
    .reduce((max, f) => Math.max(max, Number.parseInt(f.id.slice(1), 10) || 0), 0) + 1;

  const prior = state.findings.filter((f) => f.peer === peer && f.round === round);
  const others = state.findings.filter((f) => !(f.peer === peer && f.round === round));

  const claimed = new Set<string>();
  const replaced: FindingRecord[] = [];
  const ids: string[] = [];
  for (const finding of checked) {
    const match = prior.find((p) => p.finding.claim === finding.claim && !claimed.has(p.id));
    if (match) {
      // Same claim re-stated: id + verdict + note survive, the body updates.
      claimed.add(match.id);
      replaced.push({ ...match, finding });
      ids.push(match.id);
    } else {
      const id = `f${nextId}`;
      nextId += 1;
      replaced.push({ id, peer, round, finding });
      ids.push(id);
    }
  }

  state.findings = [...others, ...replaced];
  writeState(runDir(projectDir, s), state);
  return { ids };
}

/**
 * Sets a finding's verdict, with the transitions validated: anything can
 * be judged once; `disputed` may move on to verified/dead/
 * open-disagreement (that's convergence working); verified and dead are
 * TERMINAL — changing one is CONFIG_INVALID, re-stating the same verdict
 * is a harmless no-op (the note may still update).
 */
export function recordVerdict(projectDir: string, slug: string,
  findingId: string, verdict: Verdict, note?: string): FindingRecord {
  const s = slugify(slug);
  const state = readState(projectDir, s);
  assertOpen(s, state);

  if (!VERDICTS.includes(verdict)) {
    throw new CairnError("CONFIG_INVALID",
      `unknown verdict '${verdict}'`,
      `use one of: ${VERDICTS.join(", ")}`);
  }

  const record = state.findings.find((f) => f.id === findingId);
  if (!record) {
    throw new CairnError("NOT_FOUND",
      `no finding '${findingId}' on peers run '${s}'`,
      "ids come from recordFindings — check runStatus for the live list");
  }

  const current = record.verdict;
  if ((current === "verified" || current === "dead") && verdict !== current) {
    throw new CairnError("CONFIG_INVALID",
      `finding '${findingId}' verdict '${current}' is terminal — cannot change to '${verdict}'`,
      "verified/dead findings stay decided; a genuinely wrong verdict means a fresh run");
  }

  record.verdict = verdict;
  if (note !== undefined) record.note = note;
  writeState(runDir(projectDir, s), state);
  return record;
}


// Status + close

// One definition of a silent seat, shared by runStatus's resume map and
// runClose's completeness gate: a rostered peer with no round-1 output.
const missingRound1 = (state: RunState): string[] =>
  state.meta.peers.filter((p) =>
    !state.outputs.some((o) => o.peer === p && o.round === 1));

// The last stretch of what the child wrote to stderr, one line, for the
// reason a failed seat reports. Falls back to the whole output when run.ts
// stitched no divider (the child wrote nothing to stderr).
const STDERR_TAIL_CHARS = 200;
function stderrTail(raw: string): string {
  const at = raw.indexOf(STDERR_DIVIDER);
  const text = (at === -1 ? raw : raw.slice(at + STDERR_DIVIDER.length))
    .replace(/\s+/g, " ").trim();
  if (!text) return "(no stderr)";
  return text.length > STDERR_TAIL_CHARS ? `...${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

// Every seat the run cannot count on (#339), silent first, then failed:
// a round-1 record carrying a non-zero exit code for a peer that raised
// no findings in any round. A non-zero exit WITH findings is a seat that
// spoke and then died -- its findings stand, the run goes on. A zero exit
// with no findings is a clean "nothing to report". Absent exit code is
// never read as failed. One definition, shared by runStatus and runClose,
// so the resume map and the close gate cannot disagree.
function incompleteSeats(projectDir: string, slug: string, state: RunState): IncompleteSeat[] {
  const out: IncompleteSeat[] = missingRound1(state).map((peer) => ({
    peer, kind: "silent", reason: `${peer} never answered round 1`,
  }));
  for (const o of state.outputs) {
    if (o.round !== 1 || typeof o.exitCode !== "number" || o.exitCode === 0) continue;
    if (state.findings.some((f) => f.peer === o.peer)) continue;
    let raw = "";
    try {
      raw = readFileSync(join(runDir(projectDir, slug), o.file), "utf8");
    } catch {
      // the verbatim file is gone -- the exit code alone still makes the case
    }
    out.push({
      peer: o.peer, kind: "failed", exitCode: o.exitCode,
      reason: `${o.peer} exited ${o.exitCode} with no findings -- see stderr: ${stderrTail(raw)}`,
    });
  }
  return out;
}

/**
 * The resume map: everything recorded so far, plus what's still missing —
 * peers with no round-1 output, disputed findings whose peer hasn't
 * answered round 2 yet, and findings not yet at a final verdict. An
 * interrupted run picks up exactly here instead of re-running peers that
 * already answered.
 */
export function runStatus(projectDir: string, slug: string): RunStatusReport {
  const s = slugify(slug);
  const state = readState(projectDir, s);

  const answered = (peer: string, round: number): boolean =>
    state.outputs.some((o) => o.peer === peer && o.round === round);

  const peersMissingRound1 = missingRound1(state);
  const incomplete = incompleteSeats(projectDir, s, state);
  const disputedAwaitingRound2 = state.findings
    .filter((f) => f.verdict === "disputed" && !answered(f.peer, 2))
    .map((f) => f.id);
  const unresolved = state.findings
    .filter((f) => f.verdict === undefined || f.verdict === "disputed")
    .map((f) => f.id);

  return {
    slug: s,
    meta: state.meta,
    outputs: state.outputs,
    findings: state.findings,
    resumable: {
      peersMissingRound1,
      incompleteSeats: incomplete,
      disputedAwaitingRound2,
      unresolved,
      complete: !isFinished(state.meta)
        && incomplete.length === 0
        && disputedAwaitingRound2.length === 0
        && unresolved.length === 0,
    },
  };
}

/**
 * Ends the run: every finding must sit at a FINAL verdict (verified,
 * dead, or open-disagreement — disputed and unjudged both block), then
 * closedAt is stamped and the provenance summary comes back shaped for
 * audit_record's findings[] — title from the claim, detail assembled
 * from the records ("raised by <peer> round <n>; verdict <v>"), dead
 * findings included so the record credits what got thrown out. Overall
 * verdict is "findings" iff anything survived (verified or
 * open-disagreement).
 *
 * A rostered peer with no round-1 output is a SILENT SEAT, and one whose
 * round-1 exit was non-zero with no findings raised is a FAILED SEAT (#339)
 * — closing over either hides a reviewer that never actually reviewed, so
 * it refuses (CONFIG_INVALID naming each seat and its reason) unless the
 * caller passes allowIncomplete, which closes anyway and stamps the
 * summary's incompleteSeats (+ incompleteDetail) so provenance shows the
 * degradation was deliberate. allowIncomplete never waives unresolved
 * findings — those always block.
 */
export function runClose(projectDir: string, slug: string,
  opts?: { allowIncomplete?: boolean }): CloseSummary {
  const s = slugify(slug);
  const state = readState(projectDir, s);
  assertOpen(s, state);

  const blocking = state.findings
    .filter((f) => f.verdict === undefined || f.verdict === "disputed");
  if (blocking.length > 0) {
    throw new CairnError("CONFIG_INVALID",
      `cannot close peers run '${s}' — unresolved finding(s): ${
        blocking.map((f) => `${f.id} (${f.verdict ?? "unjudged"})`).join(", ")}`,
      "every finding must end verified, dead, or open-disagreement before close");
  }

  const incomplete = incompleteSeats(projectDir, s, state);
  if (incomplete.length > 0 && opts?.allowIncomplete !== true) {
    throw new CairnError("CONFIG_INVALID",
      `cannot close peers run '${s}' — incomplete seat(s): ${
        incomplete.map((i) => i.reason).join("; ")}`,
      "re-run the seat and record its output again (a failed seat's stderr says why it died), "
        + "or close with allowIncomplete: true to stamp the summary's incompleteSeats and "
        + "accept the degraded coverage");
  }
  const incompleteNames = incomplete.map((i) => i.peer);

  const closedAt = new Date().toISOString();
  state.meta.closedAt = closedAt;
  writeState(runDir(projectDir, s), state);

  const survived = state.findings
    .some((f) => f.verdict === "verified" || f.verdict === "open-disagreement");

  return {
    slug: s,
    verdict: survived ? "findings" : "pass",
    findings: state.findings.map((f) => ({
      severity: f.finding.severity,
      title: f.finding.claim,
      failure_scenario: f.finding.evidence,
      detail: `raised by ${f.peer} round ${f.round}; verdict ${f.verdict}`
        + (f.note ? ` -- ${f.note}` : ""),
      panel: [{
        seat: f.peer,
        verdict: f.verdict === "verified" ? "CONFIRMED"
          : f.verdict === "dead" ? "REFUTED" : "PLAUSIBLE",
        evidence: f.note ? `${f.finding.evidence} -- ${f.note}` : f.finding.evidence,
      }],
    })),
    peers: state.meta.peers,
    roundsRun: state.outputs.reduce((max, o) => Math.max(max, o.round), 0),
    closedAt,
    ...(incomplete.length > 0
      ? { incompleteSeats: incompleteNames, incompleteDetail: incomplete.map((i) => i.reason) }
      : {}),
  };
}
