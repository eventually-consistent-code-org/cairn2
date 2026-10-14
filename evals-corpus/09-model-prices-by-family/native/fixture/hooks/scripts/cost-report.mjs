#!/usr/bin/env node

/**
 * Purpose: summarize the project's agent spend from the metrics log the Stop
 *   hook writes. Rows are cumulative per session, so totals take the LATEST
 *   row per session_id -- summing every row would multiply-count. All numbers
 *   are approximate list-price estimates.
 *
 *   The log is SEGMENTED (#229): one live file plus closed, append-only
 *   segments beside it. A session can pick up another row days later, landing
 *   in the live segment while its older rows sit in a closed one, so the merge
 *   across segments resolves to the LATEST row per session -- concatenating
 *   and summing would inflate every number that session touches.
 *
 * Usage:
 *   node cost-report.mjs              # summary: total, by phase, by issue
 *   node cost-report.mjs --issue X    # one number: est. cost for issue X
 *   node cost-report.mjs --phase N    # one number: est. cost for phase N
 *   node cost-report.mjs --reports    # report bytes per coordinator session
 *   node cost-report.mjs --json      # machine-readable summary
 *
 * removeWhen: the platform exposes per-session cumulative spend through
 *   an API cairn can read.
 * Author(s): John Reed
 */

import { readFileSync } from "node:fs";
import { metricsPath, metricsSegments } from "./lib.mjs";

/** The latest row per session_id across every segment, oldest segment first.
 *  A later row REPLACES an earlier one for the same session rather than adding
 *  to it -- rows are cumulative, so a session whose history straddles a
 *  rotation must resolve to its newest row alone. */
function latestPerSession(current) {
  const bySession = new Map();
  for (const segment of metricsSegments(current)) {
    let raw;
    try {
      raw = readFileSync(segment, "utf8");
    } catch {
      continue; // segment pruned or never written -- not an error
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row?.session_id !== "string") continue; // unattributable -- skip
        bySession.set(row.session_id, row); // later segment / later line wins
      } catch { /* skip corrupt line */ }
    }
  }
  return [...bySession.values()];
}

// Rough chars-per-token for English prose + code. Only ever used to put a
// byte count on the same scale as the token columns -- never to bill anything.
const BYTES_PER_TOKEN = 4;

function sumField(rows, key) {
  return rows.reduce((s, r) => s + (r[key] ?? 0), 0);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * How much of each coordinator's context was subagent reports (#176).
 *
 * The denominator is the PEAK context a session's requests carried, not any
 * token sum: with prompt caching, the sums count the same replayed prefix
 * over and over (one real session totalled 957M cache-read tokens against a
 * window that never exceeded ~200k), so a share against them is meaningless.
 * Peak context answers the question that decides compression -- what fraction
 * of the window the coordinator was actually holding reports in.
 */
function reportStats(rows) {
  const bytes = sumField(rows, "report_bytes");
  const peak = sumField(rows, "context_peak_tokens");
  const estTokens = Math.round(bytes / BYTES_PER_TOKEN);
  return {
    bytes,
    injections: sumField(rows, "report_count"),
    tasks: sumField(rows, "report_tasks"),
    est_tokens: estTokens,
    context_peak_tokens: peak,
    share_pct: peak > 0 ? Number(((estTokens / peak) * 100).toFixed(1)) : 0,
  };
}

function groupCost(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === undefined || k === null) continue;
    out.set(k, (out.get(k) ?? 0) + (r.est_cost_usd ?? 0));
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const args = process.argv.slice(2);
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const rows = latestPerSession(metricsPath(projectDir));

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const issue = flag("--issue");
  const phase = flag("--phase");
  const total = rows.reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);
  // Sessions whose row names a model the tracker could not price (#330):
  // their dollars are missing from every sum below, and the report says so.
  const unpriced = rows.filter((r) => (r.unpriced_models ?? []).length > 0);
  const unpricedIds = [...new Set(unpriced.flatMap((r) => r.unpriced_models))].sort();

  if (issue !== undefined) {
    const cost = rows.filter((r) => r.issue === issue)
      .reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);
    console.log(cost.toFixed(2));
    return;
  }
  if (phase !== undefined) {
    const cost = rows.filter((r) => String(r.phase) === phase)
      .reduce((s, r) => s + (r.est_cost_usd ?? 0), 0);
    console.log(cost.toFixed(2));
    return;
  }
  if (args.includes("--reports")) {
    const fanned = rows.filter((r) => (r.report_bytes ?? 0) > 0)
      .sort((a, b) => (b.report_bytes ?? 0) - (a.report_bytes ?? 0));
    if (!fanned.length) {
      console.log("no task-result injections recorded yet.");
      return;
    }
    console.log(`report bytes by coordinator session (${fanned.length} of ${rows.length} fanned out):`);
    for (const r of fanned) {
      const s = reportStats([r]);
      console.log(`  ${r.session_id.slice(0, 8)} ${r.issue ?? `phase ${r.phase ?? "-"}`}: `
        + `${fmtBytes(s.bytes)} over ${s.injections} injections from ${s.tasks} subagents `
        + `-- ~${s.est_tokens} est. tok, ${s.share_pct}% of a ${s.context_peak_tokens}-tok peak context`);
    }
    return;
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      sessions: rows.length,
      total_est_usd: Number(total.toFixed(2)),
      unpriced_sessions: unpriced.length,
      unpriced_models: unpricedIds,
      by_phase: Object.fromEntries(groupCost(rows, "phase")),
      by_issue: Object.fromEntries(groupCost(rows, "issue")),
      by_kind: Object.fromEntries(groupCost(rows, "kind")),
      reports: reportStats(rows),
    }));
    return;
  }

  console.log(`agent spend (approximate, ${rows.length} sessions): $${total.toFixed(2)}`);
  if (unpriced.length) {
    console.log(`  ${unpriced.length} session(s) carry an unpriced model -- dollars above omit them: ${unpricedIds.join(", ")}`);
  }
  const byPhase = groupCost(rows, "phase");
  if (byPhase.length) {
    console.log("by phase:");
    for (const [k, v] of byPhase.slice(0, 10)) console.log(`  phase ${k}: $${v.toFixed(2)}`);
  }
  const byIssue = groupCost(rows, "issue");
  if (byIssue.length) {
    console.log("by issue:");
    for (const [k, v] of byIssue.slice(0, 10)) console.log(`  ${k}: $${v.toFixed(2)}`);
  }
  const byKind = groupCost(rows, "kind");
  if (byKind.length) {
    console.log("by kind:");
    for (const [k, v] of byKind) console.log(`  ${k}: $${v.toFixed(2)}`);
  }
  const reports = reportStats(rows);
  if (reports.bytes > 0) {
    console.log("task reports:");
    console.log(`  ${fmtBytes(reports.bytes)} over ${reports.injections} injections `
      + `from ${reports.tasks} subagents`);
    console.log(`  ~${reports.est_tokens} est. tokens -- ${reports.share_pct}% of peak `
      + `coordinator context (${reports.context_peak_tokens} tok)`);
    if (reports.tasks > 0) {
      console.log(`  mean ${fmtBytes(Math.round(reports.bytes / reports.tasks))} per subagent `
        + `(--reports for the per-session breakdown)`);
    }
  }
}

main();
