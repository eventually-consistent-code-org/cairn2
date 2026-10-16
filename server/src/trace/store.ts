import { readFileSync } from "node:fs";
import {
  appendSession, closeSession, lastSessionEntry, listSessions,
  sessionId, startSession, type SessionInfo,
} from "../sessions/store.js";
import { parseFrontmatter } from "../planning/frontmatter.js";

export type TraceKind = "evidence" | "hypothesis" | "test" | "verdict";
export interface TraceInfo {
  id: string; status: "open" | "resolved"; issue: string;
  created: string; resolved?: string;
  entryCounts: Record<TraceKind, number>;
  description: string;
}

const toTraceInfo = (s: SessionInfo): TraceInfo => ({
  id: s.id, status: s.status, issue: s.issue, created: s.created,
  ...(s.resolved !== undefined ? { resolved: s.resolved } : {}),
  entryCounts: s.entryCounts as Record<TraceKind, number>,
  description: s.description,
});

export const traceId = (description: string) => sessionId("trace", description);
/**
 * Open a trace. `evidence`, when given, lands as the first entry in the same
 * motion (#367): the failed-verification route is one call, not two.
 */
export function startTrace(projectDir: string, description: string, issueId: string,
  evidence?: string): { id: string; path: string } {
  const out = startSession(projectDir, "trace", description, issueId);
  if (evidence !== undefined && evidence.trim().length > 0) {
    appendSession(projectDir, "trace", out.id, "evidence", evidence);
  }
  return out;
}
export const appendTrace = (projectDir: string, id: string, kind: TraceKind, text: string) =>
  appendSession(projectDir, "trace", id, kind, text);
export const lastEntryKind = (projectDir: string, id: string) =>
  lastSessionEntry(projectDir, "trace", id) as TraceKind | null;
export const listTraces = (projectDir: string, status?: "open" | "resolved") =>
  listSessions(projectDir, "trace", status).map(toTraceInfo);
/** The tracker issue an open trace is mirrored to, or null when no such trace is open. */
export const traceIssue = (projectDir: string, id: string): string | null =>
  listTraces(projectDir, "open").find((t) => t.id === id)?.issue ?? null;

export interface TraceProvenance { file: string; commit: string }

// A repo-relative path: at least one directory segment and a dotted extension
// (server/src/index.ts, hooks/scripts/x.mjs). A trailing :line is dropped.
const FILE_RE = /(?<![\w./-])((?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z]\w*)(?::\d+)?(?![\w/])/g;
// A git sha: 7-40 hex with at least one letter, so a plain number (a port, a
// byte count, a date) never reads as a commit. trace-xxxxxxxx ids are excluded
// by the leading [\w-] lookbehind.
const SHA_RE = /(?<![\w-])(?=[0-9]*[a-f])[0-9a-f]{7,40}(?![\w-])/g;

/**
 * Derive card provenance from a trace's own evidence/test/verdict entries
 * (#367): every file named in those entries, paired with the commit named in
 * the same entry when there is one, else the last commit the trace named
 * anywhere (the verdict's fix sha, in the common shape). A file with no
 * commit to pair against is dropped — the card schema wants pairs, and a
 * guessed commit is worse than none.
 */
export function traceProvenance(entries: Array<{ kind: TraceKind; text: string }>): TraceProvenance[] {
  const sourced = entries.filter((e) => e.kind !== "hypothesis");
  const allCommits = sourced.flatMap((e) => [...e.text.matchAll(SHA_RE)].map((m) => m[0]));
  const lastCommit = allCommits.length ? allCommits[allCommits.length - 1] : null;
  const seen = new Set<string>();
  const out: TraceProvenance[] = [];
  for (const e of sourced) {
    const commits = [...e.text.matchAll(SHA_RE)].map((m) => m[0]);
    const commit = commits.length ? commits[commits.length - 1] : lastCommit;
    if (!commit) continue;
    for (const m of e.text.matchAll(FILE_RE)) {
      const key = `${m[1]}@${commit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: m[1], commit });
    }
  }
  return out;
}

/** Typed entries of a trace file (live or archived), in file order; empty texts dropped. */
export function traceEntries(path: string): Array<{ kind: TraceKind; text: string }> {
  const { body } = parseFrontmatter(readFileSync(path, "utf8"));
  const out: Array<{ kind: TraceKind; text: string }> = [];
  for (const block of body.split(/^## /m).slice(1)) {
    const sep = block.indexOf(" — ");
    if (sep === -1) continue;
    const kind = block.slice(0, sep);
    if (!["evidence", "hypothesis", "test", "verdict"].includes(kind)) continue;
    const text = block.split("\n").slice(1).join("\n").trim();
    if (text.length > 0) out.push({ kind: kind as TraceKind, text });
  }
  return out;
}

export function closeTrace(projectDir: string, id: string, resolution: string): {
  id: string; issue: string; description: string; verdicts: string[]; archivePath: string;
  /** The first `test` entry — the reproduction (command + observed failing output). */
  repro: string;
  /** Files + commits the trace's own evidence/test/verdict entries named (#367). */
  provenance: TraceProvenance[];
} {
  const { gateTexts, firstRequired, ...rest } = closeSession(projectDir, "trace", id, resolution);
  return {
    ...rest, verdicts: gateTexts, repro: firstRequired.test ?? "",
    provenance: traceProvenance(traceEntries(rest.archivePath)),
  };
}
