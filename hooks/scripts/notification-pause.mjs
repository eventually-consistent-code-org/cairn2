#!/usr/bin/env node

/**
 * Purpose: StopFailure + Notification hook -- the usage-limit pause recorder
 *   (#379). The platform narrates a usage limit to the terminal: StopFailure
 *   `rate_limit` when the turn stops on one, Notification
 *   `quota_auto_resume_fired` when the wait ends and the session continues
 *   by itself, `quota_auto_resume_stale` when the machine slept across the
 *   reset and the session now sits waiting for Enter,
 *   `quota_auto_resume_disabled` when the wait re-armed too often and
 *   automatic continue stopped, plus `agent_needs_input` and
 *   `elicitation_url_dialog` when the agent stopped for a human. A headless
 *   batch run that hits one of these goes silent, and its umbrella issue
 *   said nothing about why -- so this hook writes each event where the
 *   run's readers look:
 *     1. one row in the machine's pauses log (pauses/<projectKey>.jsonl under
 *        the cairn home folder, append-only, #351): kind, observedAt from this
 *        clock, the raw type,
 *        the session id, the reset time when the platform's message named
 *        one, and where any comment landed;
 *     2. while a batch manifest reads `running`, one plain-language comment
 *        on the run's umbrella tracker issue -- the issue labelled batch-run
 *        whose title names the runId, the same search the auto verb's resume
 *        path makes;
 *     3. stale, disabled and rate_limit mark the handoff `paused` so the next
 *        SessionStart says "waiting since HH:MM" instead of the ordinary
 *        nudge; fired clears it.
 *   An interactive session (no running manifest) gets the row only: no
 *   comment, no banner.
 *
 *   What the payloads carry (the Claude Code hooks reference, as of 2026-10;
 *   a claim about the platform, re-checked when it moves): StopFailure has
 *   error, error_details and last_assistant_message; Notification has
 *   message, title and the type (matched by the hooks.json matcher). No
 *   payload carries the reset time as a field, so the comment parses a wall
 *   clock out of the message text when one is there and otherwise posts
 *   "paused on usage limit" with the observed time and says the message
 *   named none (ADR 0021, absence stated). When `stale` is dispatched --
 *   at the reset, or at wake -- is undocumented, so a stale row stamps
 *   observedAt from this clock and never calls it the reset. Whether any of
 *   these fire under `claude -p` is undocumented too: this hook assumes
 *   nothing and records whatever arrives (asserted: hooks.test.ts, the
 *   payload matrix -- an unknown type appends nothing).
 *
 *   Tracker access from a hook is new with this file. The breaker (#358)
 *   predates it and still leaves its one comment to the server, because
 *   that comment goes on the issue in hand, which only a tool call names.
 *   Here the stalled run makes no tool call -- that is the whole problem --
 *   so the hook posts itself, dependency-free (global fetch, node >= 18),
 *   and only for the tracker it can reach without an adapter: GitHub, with
 *   GITHUB_TOKEN or `gh auth token`, the server's own resolution order. Any
 *   other tracker, no credentials, no umbrella issue, or a tracker that is
 *   down: the row lands with `commentSkipped` saying which, and the hook
 *   exits 0. Fire-and-forget, fail-open, invisible on failure.
 * derives: axiom 1 (tracker-truth), axiom 4 (recorded-run)
 * Author(s): John Reed
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  atomicWriteJson, handoffPath, hhmmUtc, mtimeMs, pausesPath, readCairnConfig, readJson,
} from "./lib.mjs";
import { cairnHome, runManifests } from "./breaker.mjs";

// Constants

/** Notification type / StopFailure error -> the pause kind the row carries. */
const KINDS = {
  rate_limit: "paused",
  quota_auto_resume_fired: "resumed",
  quota_auto_resume_stale: "stale",
  quota_auto_resume_disabled: "stopped",
  agent_needs_input: "needs_input",
  elicitation_url_dialog: "needs_input",
};

/** The kinds that mark the handoff; `resumed` clears it, `needs_input` leaves it alone. */
const HANDOFF_KINDS = new Set(["paused", "stale", "stopped"]);

/** A wall-clock time as the platform's prose writes one: 2:30pm, 14:30, 2 pm, 14:30 UTC. */
const CLOCK_RE = /\b(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?|\d{1,2}\s*[ap]\.?m\.?)(?=[\s.,;)]|$)/i;

/** The GitHub label and API the auto verb stages a run's umbrella issue under. */
const UMBRELLA_LABEL = "batch-run";
const API_DEFAULT = "https://api.github.com";
const HTTP_TIMEOUT_MS = 8000;

// The payload

/** The hook payload, or null when stdin is empty or not JSON. */
function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** The raw type the matcher saw: StopFailure's error, Notification's type. */
function typeOf(payload) {
  if (payload.hook_event_name === "StopFailure") return typeof payload.error === "string" ? payload.error : null;
  const t = payload.notification_type ?? payload.type;
  return typeof t === "string" ? t : null;
}

/** The first wall-clock time in the platform's own text (message, error_details --
 *  never the assistant's prose), or null; only a rate_limit row gets one. */
function resetTimeIn(payload) {
  const text = [payload.message, payload.error_details]
    .filter((s) => typeof s === "string").join(" ");
  const m = CLOCK_RE.exec(text);
  return m ? m[1].replace(/\s+/g, "") : null;
}

// The comment

/** The one plain-language line the umbrella issue gets per event. */
function composeComment(row) {
  const at = `${hhmmUtc(row.observedAt)} UTC`;
  switch (row.kind) {
    case "paused":
      return row.resetsAt
        ? `cairn: paused on usage limit, resets at ${row.resetsAt} (observed ${at})`
        : `cairn: paused on usage limit (observed ${at}; the platform's message named no reset time)`;
    case "resumed":
      return `cairn: resumed after the usage limit reset (${at})`;
    case "stale":
      return `cairn: waiting for a human to press Enter -- the usage-limit auto-resume went stale, `
        + `the machine likely slept across the reset (observed ${at})`;
    case "stopped":
      return `cairn: stopped after repeated usage-limit hits, restart by hand (${at})`;
    default: {
      const what = typeof row.title === "string" && row.title ? row.title : row.type;
      return `cairn: needs input -- ${what} (${at})`;
    }
  }
}

/** The live run this event belongs to: the newest staged, when two are ever live at once. */
function liveRun(projectDir) {
  const { live } = runManifests(projectDir, cairnHome());
  return [...live].sort((a, b) => String(b.state?.created ?? "").localeCompare(String(a.state?.created ?? "")))[0];
}

/** GITHUB_TOKEN, then `gh auth token` -- the server adapter's order; null when neither answers. */
function githubToken() {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Posts `text` on the run's umbrella issue. Returns { on } where it landed,
 * or { skipped } saying why not -- the row records either, so a silent
 * tracker is never mistaken for one that was told.
 */
async function postUmbrellaComment(projectDir, runId, text) {
  const tracker = readCairnConfig(projectDir)?.tracker;
  if (tracker?.type !== "github") {
    return { skipped: `tracker ${tracker?.type ?? "unset"} has no hook-side poster; the row is the record` };
  }
  const repo = tracker.config?.repo;
  if (typeof repo !== "string" || !/^(?!.*\.\.)[\w.-]+\/[\w.-]+$/.test(repo)) return { skipped: "tracker repo is not owner/name" };
  const token = githubToken();
  if (!token) return { skipped: "no GitHub credentials in this hook's environment" };

  const api = (process.env.GITHUB_API_URL || API_DEFAULT).replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "cairn-hooks",
  };
  const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);

  // The umbrella: open, labelled batch-run, runId in the title (auto.md's own search).
  const list = await fetch(
    `${api}/repos/${repo}/issues?labels=${UMBRELLA_LABEL}&state=open&per_page=100`, { headers, signal });
  if (!list.ok) return { skipped: `tracker answered ${list.status} listing batch-run issues` };
  const issues = await list.json();
  const umbrella = Array.isArray(issues)
    ? issues.find((i) => typeof i?.title === "string" && i.title.includes(runId) && !i.pull_request)
    : undefined;
  if (!umbrella) return { skipped: `no open ${UMBRELLA_LABEL} umbrella issue names run ${runId}` };

  const post = await fetch(`${api}/repos/${repo}/issues/${umbrella.number}/comments`, {
    method: "POST", headers, signal, body: JSON.stringify({ body: text }),
  });
  if (!post.ok) return { skipped: `tracker answered ${post.status} posting the comment` };
  return { on: `#${umbrella.number}` };
}

// The handoff

/**
 * Marks or clears `paused` on an existing handoff. Never scaffolds one
 * (breadcrumb's rule): a session with no task in flight has nothing to
 * resume. Same tmp+rename write as every other handoff writer.
 */
function patchHandoff(projectDir, row) {
  if (!HANDOFF_KINDS.has(row.kind) && row.kind !== "resumed") return;
  const path = handoffPath(projectDir);
  if (mtimeMs(path) === null) return;
  const existing = readJson(path);
  const { paused: _dropped, ...rest } = existing;
  const merged = row.kind === "resumed"
    ? rest
    : { ...rest, paused: { kind: row.kind, since: row.observedAt, ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}) } };
  atomicWriteJson(path, merged);
}

// Main

async function main() {
  const payload = readStdin();
  if (!payload) return;
  const type = typeOf(payload);
  const kind = type ? KINDS[type] : undefined;
  if (!kind) return; // a type this hook has no word for -- not ours to record

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const row = {
    kind,
    type,
    event: payload.hook_event_name,
    observedAt: new Date().toISOString(),
    session_id: payload.session_id,
  };
  if (kind === "paused") {
    const resetsAt = resetTimeIn(payload);
    if (resetsAt) row.resetsAt = resetsAt;
  }
  if (kind === "needs_input" && typeof payload.title === "string" && payload.title) row.title = payload.title;

  // The handoff first: it is local and cheap, and a tracker that hangs
  // must not cost the next SessionStart its "waiting since" line.
  try {
    patchHandoff(projectDir, row);
  } catch {
    // a corrupt or vanished handoff; the row below still lands
  }

  // A running batch run owes its umbrella issue one line per event.
  let run;
  try {
    run = liveRun(projectDir);
  } catch {
    run = undefined; // a runs folder that can't be read freezes nothing here either
  }
  if (run?.runId) {
    row.run = run.runId;
    try {
      const result = await postUmbrellaComment(projectDir, run.runId, composeComment(row));
      if (result.on) row.comment = { on: result.on, at: new Date().toISOString() };
      else row.commentSkipped = result.skipped;
    } catch (e) {
      row.commentSkipped = `tracker unreachable (${e?.name ?? "error"})`;
    }
  }

  // Concurrency -- atomicity: one appendFileSync of one short line under
  // O_APPEND. Visibility: a reader may see a torn last row and skips it.
  // Ordering: rows carry observedAt; two sessions' rows interleave freely.
  const path = pausesPath(projectDir, cairnHome());
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

main().catch(() => {
  // swallowed by design -- hook failures must be invisible.
}).finally(() => process.exit(0));
