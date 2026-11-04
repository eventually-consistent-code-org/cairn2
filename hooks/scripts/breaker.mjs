#!/usr/bin/env node

/**
 * Purpose: the circuit breaker (#358) -- every PreToolUse guard refusal (run
 *   guard, harness guard, leak guard) appends one audit row, and a headless
 *   batch run whose guards keep refusing it is frozen. A run that keeps
 *   reaching past the ship gate, or for its own hooks, is a run whose plan
 *   went wrong; the guards could only refuse the one call in front of them.
 *
 * The row, one JSON line per refusal in <cairn home>/refusals/<project>.jsonl:
 *   { ts, guard, tool, effect, reason, session_id, run_id?, input_sha256 }
 *   `effect` is what was refused -- the run guard's git effect (#359:
 *   discards-work, moves-shared-ref, touches-owner-checkout), or the other
 *   guards' own (changes-harness-config, leaks-internal-refs); `reason` is
 *   fixed text chosen at the refusal site. Never the raw command or path:
 *   a command line can carry a credential and this log outlives the
 *   session, so the input is kept only as its sha256 (the mcp-bouncer audit
 *   row's shape, Prince Jain, dev.to, read 2026-10-14). The refusal text the
 *   owner sees is unchanged.
 *
 * The freeze: while a run manifest reads `running`, each refusal from the
 *   run's own session -- the manifest's `sessionId` (#431) -- carries its
 *   run_id and the breaker counts those rows; a refusal from any other
 *   session is logged with no run id and counts nothing, and so is every
 *   refusal while the manifest has no id yet. At `auto.breaker` of them
 *   (cairn.json, default 3, 0 off) it writes the manifest itself: status
 *   `stopped`, stop.reason `breaker`, the last three rows, and the sessions
 *   they came from. The counter is per run id, so a new run starts at zero.
 *
 * Seams -- hooks import only node: and relative files, never server/:
 *   - a live run is read straight from the manifests the server writes
 *     (server/src/planning/run-manifest.ts): <cairn home>/runs/<project>-
 *     <hash>-<runId>.json, status `running`. The cairn home is CAIRN_HOME,
 *     else ~/.cairn -- the run guard's rule.
 *   - `auto.breaker` is read raw from cairn.json; anything but a whole
 *     number >= 0 reads as the default.
 *   - the run's session is the manifest's `sessionId` (#431): written at
 *     staging from the auto verb's $CLAUDE_CODE_SESSION_ID or, when the verb
 *     had none, stamped here (stampRunSession, which the run guard calls
 *     before judging any call) from the first hook event of a session whose
 *     working directory is the manifest's `checkout` -- exactly that folder,
 *     never one under it, so a session in a sibling worktree never becomes
 *     the run's. A workflow's subagents share the dispatching session's id
 *     (observed in this repo's observation log on 2026-10-22, a claim about
 *     the harness that can expire), so the one id covers the whole run.
 *   - hooks have no tracker access, so the one plain-language comment on a
 *     freeze is the server's: posted by the next claim or close the frozen
 *     run makes -- the call that returns RUN_FROZEN -- once, flagged in the
 *     manifest (stop.commentedAt).
 *   - what a frozen run may no longer do is enforced elsewhere: the run
 *     guard refuses a push from the frozen run's session (the manifest's
 *     sessionId, never another), and the server refuses claim and close
 *     with RUN_FROZEN.
 *
 * Fail-open, both ways: a breaker that breaks never blocks a call, and never
 *   un-blocks one. recordRefusal is written never to throw, but the guards
 *   do not rely on that (#432): each one loads this module with a dynamic
 *   import that falls back to no breaker, calls recordRefusal inside its
 *   own try, and prints its result only when it is an array -- so a
 *   breaker.mjs that is missing, fails to parse, exports no recordRefusal,
 *   throws, or returns anything else leaves the guard refusing exactly as
 *   before (asserted: hooks.test.ts, "missing, broken or misbehaving"). A
 *   refusal log that can't be written or read means no breaker for that
 *   run, said once per run (a marker under <cairn home>/state).
 *
 * Concurrency, at the two handoffs:
 *   the refusal log -- many writers (three guards run in parallel per call,
 *     in every session), no rewriter.
 *     Atomicity: one appendFileSync of one short line per refusal, O_APPEND.
 *     Visibility: a reader may see a torn last row; it skips any line that
 *       doesn't parse.
 *     Ordering: file order is append order; nothing depends on it but "the
 *       last three", which is append order by definition.
 *   the manifest -- read-modify-write, never atomic: the server mutates it
 *     too (set_phase, set_status), and so does the session stamp (#431).
 *     The write is tmp (pid + random suffix) then rename, so a reader never
 *     sees half a file. A freeze landing between a server read and its
 *     write could be lost; the server re-reads before it renames and
 *     refuses to clobber a freeze, and a freeze that is still lost is
 *     re-made by the next refusal, whose count is still past the limit. A
 *     stamp a server write lands over is re-made by the next hook event,
 *     since the id is null again; a server write the stamp lands over sits
 *     in the same read-to-rename instant the freeze accepts, once per run.
 *
 * removeWhen: the platform halts an unattended session on repeated
 *   permission denials itself, with the denials recorded where the owner
 *   reads them -- a native denial budget for headless runs.
 * derives: axiom 4 (recorded-run); axiom 5 (owner-ground)
 * Author(s): John Reed
 */

// Imports

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { migrateRepositoryState, projectKey, repositoryPath, worktreeKey } from "./lib.mjs";

// Constants

/** Refusals that freeze a run when cairn.json says nothing (`auto.breaker`). */
export const DEFAULT_LIMIT = 3;

/** How many of the run's rows the frozen manifest keeps. */
const KEEP_ROWS = 3;

/**
 * How much of the log's tail is read to count. A run's rows are the newest
 * ones in the file, and a run trips at a handful, so a megabyte holds
 * thousands of rows past any limit anyone sets.
 */
const TAIL_BYTES = 1024 * 1024;

// Paths

/** The cairn home the run guard reads: CAIRN_HOME, else ~/.cairn. */
export function cairnHome() {
  return process.env.CAIRN_HOME || join(homedir(), ".cairn");
}

/** The repository's refusal log -- per repository (#362), keyed by lib.mjs's
 *  projectKey like every other file a batch run shares across worktrees. */
export function refusalLogPath(projectDir, home = cairnHome()) {
  return repositoryPath(projectDir, "refusals", ".jsonl", home);
}

/** Where the breaker remembers it already said it was off for a run. */
function offMarkerPath(projectDir, home) {
  return repositoryPath(projectDir, "state", "-breaker-off.json", home);
}

// Run manifests

/** True for a manifest the breaker froze. */
export function isFrozen(state) {
  return state?.status === "stopped" && state?.stop?.reason === "breaker";
}

/**
 * The project's run manifests that matter to a guard, as
 * { live, frozen, unreadable }: `live` reads `running`, `frozen` was
 * stopped by the breaker, each [{ runId, state, path }]. `unreadable` names
 * a runs folder or manifest that exists but can't be read (#299) -- the run
 * guard can't say no run is live, so its gates that ask refuse. A corrupt
 * manifest, or one deleted since the listing, is evidence of nothing.
 * The run guard keeps its own copy of this listing on purpose: the guards
 * load this module dynamically, so a broken breaker can't take a guard's
 * own checks down with it -- change one and the other must follow.
 */
export function runManifests(projectDir, home = cairnHome()) {
  migrateRepositoryState(projectDir, home);
  // The project key's manifests, then any the one-shot move left under the
  // worktree key (#362) whose run has no project-key twin.
  const prefixes = [`${projectKey(projectDir)}-`, `${worktreeKey(projectDir)}-`];
  const seen = new Set();
  const dir = join(home, "runs");
  const live = [];
  const frozen = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // no runs dir -- this machine has never staged a batch run
    return { live, frozen, unreadable: e?.code === "ENOENT" ? null : `${dir} (${e?.code ?? e})` };
  }
  const named = [];
  for (const prefix of prefixes) {
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const run = name.slice(prefix.length);
      if (seen.has(run)) continue;
      seen.add(run);
      named.push({ name, prefix });
    }
  }
  for (const { name, prefix } of named) {
    const path = join(dir, name);
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      const run = { runId: state?.runId ?? name.slice(prefix.length, -5), state, path };
      if (state?.status === "running") live.push(run);
      else if (isFrozen(state)) frozen.push(run);
    } catch (e) {
      if (e instanceof SyntaxError || e?.code === "ENOENT") continue;
      return { live, frozen, unreadable: `${path} (${e?.code ?? e})` };
    }
  }
  return { live, frozen, unreadable: null };
}

/** The live run a refusal belongs to: the newest one staged, when two are ever live at once. */
function currentRun(live) {
  return [...live].sort((a, b) => String(b.state?.created ?? "").localeCompare(String(a.state?.created ?? "")))[0];
}

// Config

/** `auto.breaker` from cairn.json, read raw: a whole number >= 0, else the default. */
export function breakerLimit(projectDir) {
  try {
    const v = JSON.parse(readFileSync(join(projectDir, "cairn.json"), "utf8"))?.auto?.breaker;
    return Number.isInteger(v) && v >= 0 ? v : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

// The log

/**
 * One refusal's row. Only fixed text and a digest -- the tool input is
 * hashed, never copied, so no command line or path lands in a log that
 * outlives the session.
 */
export function refusalRow({ guard, payload, effect, reason, runId, ts = new Date().toISOString() }) {
  const input = JSON.stringify(payload?.tool_input ?? null) ?? "null";
  return {
    ts,
    guard: String(guard),
    tool: String(payload?.tool_name ?? ""),
    effect: String(effect ?? "unknown"),
    reason: String(reason ?? ""),
    session_id: typeof payload?.session_id === "string" && payload.session_id ? payload.session_id : null,
    ...(runId ? { run_id: runId } : {}),
    input_sha256: createHash("sha256").update(input).digest("hex"),
  };
}

/** The log's last TAIL_BYTES as rows; a cut first line and a torn last one are skipped. */
function readTail(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const rows = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // a torn row from a writer mid-append -- not a row yet
      }
    }
    return rows;
  } finally {
    closeSync(fd);
  }
}

// The freeze

/** tmp (pid + random suffix, never a fixed name) then rename -- two writers never share a tmp. */
function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}

/**
 * Writes the freeze into the run's manifest, read fresh: status stopped,
 * stop.reason breaker, the last KEEP_ROWS rows, the sessions they came
 * from. A manifest no longer running is left alone -- another guard froze
 * it a moment ago, or the run ended -- and its state comes back as read.
 */
function freeze(run, rows, limit, at) {
  const state = JSON.parse(readFileSync(run.path, "utf8"));
  if (state?.status !== "running") return state;
  const sessions = [...new Set(rows.map((r) => r.session_id).filter((s) => typeof s === "string" && s))];
  state.status = "stopped";
  state.stop = { reason: "breaker", at, limit, count: rows.length, refusals: rows.slice(-KEEP_ROWS), sessions };
  writeJsonAtomic(run.path, state);
  return state;
}

/** The lines a refusal adds once the run is frozen: what happened, and the owner's way back. Never an env var. */
export function frozenLines(runId, count, limit) {
  return [
    `cairn circuit breaker: batch run ${runId} is frozen — its guards refused ${count} action` +
      `${count === 1 ? "" : "s"} since it started (the limit is ${limit}).`,
    "  It stops here: nothing in it pushes, claims or closes, and it ends at its next boundary.",
    "  Owner: read the refusals in the run's report, fix the plan, then re-stage what's left with",
    "  /cairn:auto --batch — a frozen run never resumes under its old id.",
  ];
}

/**
 * The breaker is off for this run -- said once per run, remembered by a
 * marker. A marker that can't be written either means saying it every
 * time, which beats saying nothing.
 */
function offOnce(projectDir, home, runId, why) {
  const path = offMarkerPath(projectDir, home);
  try {
    if (JSON.parse(readFileSync(path, "utf8"))?.runId === runId) return [];
  } catch {
    // no marker yet, or an unreadable one -- say it
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, { runId, why, at: new Date().toISOString() });
  } catch {
    // can't remember it -- it gets said again next time
  }
  return [
    `cairn circuit breaker: can't count refusals for batch run ${runId} (${why}), so the breaker is off for this run.`,
    "  every refusal still blocks its own call; the owner should restore access to the cairn home's refusal log.",
  ];
}

// The run's session (#431)

/** The payload's session id, or null when the harness sent none. */
function sessionOf(payload) {
  return typeof payload?.session_id === "string" && payload.session_id ? payload.session_id : null;
}

/** True when `sessionId` is the session that staged `state`. A manifest with no id owns no refusal. */
export function ownsRun(state, sessionId) {
  return typeof state?.sessionId === "string" && state.sessionId !== "" && sessionId === state.sessionId;
}

/** A running manifest staged from `cwd` -- exactly that folder -- whose session id is still null. */
function unstamped(state, cwd) {
  return state?.sessionId == null && typeof state?.checkout === "string" && resolve(state.checkout) === cwd;
}

/**
 * Stamps a running manifest that has no session id yet with this call's
 * session, when the call's working directory is the manifest's `checkout`:
 * the auto verb staged the run from a shell with no $CLAUDE_CODE_SESSION_ID,
 * so the first session seen working in the run's own checkout is the run's.
 * Exactly that folder -- a folder under it is another worktree, and a
 * session in a sibling worktree never becomes the run's. Read fresh, then
 * tmp-and-rename; a manifest that stopped or got its id in between is left
 * as it is. Never throws; false when nothing was stamped. Asserted:
 * hooks.test.ts, "the run guard stamps the first session".
 *
 * :param payload: the hook's stdin payload (cwd, session_id)
 * :param projectDir: the project the guard judged
 * :returns true when a manifest was stamped
 */
export function stampRunSession({ payload, projectDir }) {
  try {
    const sessionId = sessionOf(payload);
    if (!sessionId || typeof payload?.cwd !== "string" || !payload.cwd) return false;
    const home = cairnHome();
    // no runs folder: this machine never staged a batch run, and the call pays one stat to learn it
    if (!existsSync(join(home, "runs"))) return false;
    const cwd = resolve(payload.cwd);
    let stamped = false;
    for (const run of runManifests(projectDir, home).live) {
      if (!unstamped(run.state, cwd)) continue;
      const fresh = JSON.parse(readFileSync(run.path, "utf8"));
      if (fresh?.status !== "running" || !unstamped(fresh, cwd)) continue;
      fresh.sessionId = sessionId;
      writeJsonAtomic(run.path, fresh);
      stamped = true;
    }
    return stamped;
  } catch {
    return false; // a stamp that can't land is tried again on the next call
  }
}

// Main entry

/**
 * Records one guard refusal and runs the breaker. Returns the lines the
 * guard prints after its own refusal: the count toward the limit, the
 * freeze when this refusal trips it, the breaker being off -- or nothing
 * when no run is live or the refusal is not the run's own session's (#431).
 * Never throws: the guard exits 2 whatever happens here.
 *
 * :param guard: "run" | "harness" | "leak"
 * :param payload: the hook's stdin payload (tool_name, tool_input, session_id)
 * :param effect: what was refused (see the row above)
 * :param reason: fixed text from the refusal site -- never the command
 * :param projectDir: the project the guard judged
 * :returns string[] of lines for stderr
 */
export function recordRefusal({ guard, payload, effect, reason, projectDir }) {
  try {
    const home = cairnHome();
    let live = [];
    try {
      live = runManifests(projectDir, home).live;
    } catch {
      live = []; // a run list the breaker can't read has no live run to count against
    }
    const run = currentRun(live);
    // #431 -- the refusal is the run's only when it comes from the run's own
    // session; any other session's row carries no run id and counts nothing
    const owned = run !== undefined && ownsRun(run.state, sessionOf(payload));
    const row = refusalRow({ guard, payload, effect, reason, runId: owned ? run.runId : undefined });
    const path = refusalLogPath(projectDir, home);

    let appended = true;
    let why = "";
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(row) + "\n");
    } catch (e) {
      appended = false;
      why = e?.code ?? String(e);
    }

    // No live run, or not the run's own session: the row is the audit, and nothing counts
    if (!owned) return [];
    const limit = breakerLimit(projectDir);
    if (limit === 0) return [];
    if (!appended) return offOnce(projectDir, home, run.runId, why);

    let rows;
    try {
      rows = readTail(path).filter((r) => r?.run_id === run.runId);
    } catch (e) {
      return offOnce(projectDir, home, run.runId, e?.code ?? String(e));
    }
    // the row just written isn't there: the log went missing under us
    if (!rows.length) return offOnce(projectDir, home, run.runId, "the log went missing");

    if (rows.length < limit) {
      return [`cairn circuit breaker: refusal ${rows.length} of ${limit} for batch run ${run.runId} — ` +
        `at ${limit} the run freezes.`];
    }
    let state;
    try {
      state = freeze(run, rows, limit, row.ts);
    } catch (e) {
      return [`cairn circuit breaker: batch run ${run.runId} reached ${rows.length} refusals, but its ` +
        `manifest can't be written (${e?.code ?? e}) — the run is NOT frozen.`,
      "  the owner should stop it by hand."];
    }
    if (!isFrozen(state)) return []; // the run ended between the listing and the freeze
    return frozenLines(run.runId, state.stop?.count ?? rows.length, state.stop?.limit ?? limit);
  } catch {
    return []; // a broken breaker never changes what the guard decided
  }
}
