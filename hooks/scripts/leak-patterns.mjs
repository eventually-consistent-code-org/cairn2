#!/usr/bin/env node

/**
 * Purpose: THE single source for cairn leak patterns (#2221) -- consumed by
 *   the pretooluse-leakguard hook and, via the CLI mode, by the distill and
 *   ship verbs for output scrubbing. node: builtins only (lib.mjs rule).
 *
 *   Path-scoped exemption (#140): files under server/src/ and server/dist/
 *   are exempt from the `cairn-path` pattern ONLY. The server MANAGES the
 *   .cairn planning dirs -- ledger.ts, milestones.ts, distill-manifest.ts
 *   and friends must spell out .cairn paths to do their job. The guard
 *   protects OUTBOUND text (docs, tracker-bound prose, misc source) from
 *   internal refs; it is not meant to forbid the implementation from naming
 *   the dirs it manages. Every OTHER pattern (phase refs, seed/backlog
 *   labels, tracker ids, extras) still applies to server source at full
 *   strength. This lives in code rather than cairn.json `leakGuard.allow`
 *   because allow is all-or-nothing per path: allowlisting server/src/**
 *   would silently drop tracker-id and label scanning there too.
 *
 *   Secrets (#280): five key-shaped patterns -- a cloud access key, a
 *   GitHub or Slack token, a private-key header, and a key|secret|token
 *   assignment whose value is long, opaque and carries both a letter and
 *   a digit -- ride beside the planning patterns, so the commit guard and
 *   the server's outbound screen (leak-scan.ts, held equal by the parity
 *   test) carry them together. A secret hit withholds its match: the
 *   listing names the file and line, never the value (asserted:
 *   leak-patterns.test.ts "a secret hit withholds the value"). Precision
 *   over recall on purpose -- an unknown vendor prefix is a
 *   leakGuard.extraPatterns line, and a repository's history is a job for
 *   a real secret scanner; the hook's header lists what is not seen.
 *
 * removeWhen: never for the scan itself; the hook that calls it can
 *   retire if the platform offers a pre-commit content policy cairn can
 *   register patterns with.
 * Author(s): John Reed
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

// Constants
const CAIRN_PATH_EXEMPT_PREFIXES = ["server/src/", "server/dist/"];

// Secret shapes (#280). `withhold` tells scanLines to report the kind and
// the line but never the matched text -- the listing travels back through
// the agent and can land in a tracker comment. No exemptPrefixes: the
// server-source exemption is cairn-path only (#140). Change one here and
// the server's copy in leak-scan.ts in the same commit -- the parity test
// compares them source for source.
const SECRET_PATTERNS = [
  // an AWS access key id, long-lived (AKIA) or temporary (ASIA)
  { name: "secret-aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, withhold: true },
  // a GitHub classic token (ghp/gho/ghu/ghs/ghr) or a fine-grained PAT
  { name: "secret-github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/, withhold: true },
  // a Slack bot, user, app, refresh or session token
  { name: "secret-slack-token", re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/, withhold: true },
  // any PEM private-key header: RSA, EC, OPENSSH, DSA, encrypted, PGP block
  { name: "secret-private-key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/, withhold: true },
  // key|secret|token|password = <twenty-plus opaque chars with a letter and a digit>;
  // `process.env.X`, `$(...)` and `${...}` start outside the value class, so
  // a reference to a secret never reads as one
  { name: "secret-assignment", re: /\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|password|passwd)["']?\s*[:=]{1,3}\s*["']?(?=[^\s"'`]*[A-Za-z])(?=[^\s"'`]*\d)[A-Za-z0-9_\-/+=]{20,}/i, withhold: true },
];

export function buildPatterns(config) {
  const patterns = [
    { name: "cairn-path", re: /\.cairn\//, exemptPrefixes: CAIRN_PATH_EXEMPT_PREFIXES },
    { name: "phase-ref", re: /\b(?:phases\/\d{2}(?:\.\d+)?-[a-z0-9-]+|milestones\/v\d+)\b/ },
    { name: "cairn-label", re: /cairn:(?:seed|backlog)/ },
    ...SECRET_PATTERNS,
  ];
  const projectKey = config?.tracker?.type === "jira"
    ? config?.tracker?.config?.projectKey : undefined;
  if (typeof projectKey === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(projectKey)) {
    patterns.push({ name: "tracker-id", re: new RegExp(`\\b${projectKey}-\\d+\\b`) });
  }
  for (const p of config?.leakGuard?.extraPatterns ?? []) {
    try {
      patterns.push({ name: "extra", re: new RegExp(p) });
    } catch {
      // invalid user regex: skip silently -- guard must never crash the flow
    }
  }
  return patterns;
}

// Filters the pattern list down to what applies to one file -- drops any
// pattern whose exemptPrefixes match the path (repo-relative from the hook's
// diff headers; the `/`-infix check also catches absolute paths from CLI use).
export function patternsForFile(path, patterns) {
  return patterns.filter(({ exemptPrefixes }) => {
    if (!exemptPrefixes) return true;
    return !exemptPrefixes.some((p) => path.startsWith(p) || path.includes(`/${p}`));
  });
}

export function scanLines(lines, patterns) {
  const hits = [];
  lines.forEach((text, i) => {
    for (const { name, re, withhold } of patterns) {
      const m = re.exec(text);
      // a secret's finding is its kind and line; the value stays out of
      // every listing (#280)
      if (m) hits.push({ line: i + 1, name, match: withhold ? "(value withheld)" : m[0] });
    }
  });
  return hits;
}

export function isAllowedPath(path, allow) {
  if (path.startsWith(".cairn/") || path.startsWith("docs/")) return true;
  if (path.endsWith(".md")) return true;
  const base = basename(path);
  if (base === "LEDGER.md" || base === "VERIFICATION.md") return true;
  for (const a of allow) {
    if (a.endsWith("/**") ? path.startsWith(a.slice(0, -2)) : path === a) return true;
  }
  return false;
}

// ---- CLI mode: node leak-patterns.mjs <file...> ----------------------------
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]) === "leak-patterns.mjs";
if (invokedDirectly && process.argv.length > 2) {
  let config = null;
  try {
    if (existsSync(join(process.cwd(), "cairn.json"))) {
      config = JSON.parse(readFileSync(join(process.cwd(), "cairn.json"), "utf8"));
    }
  } catch { /* no config: default patterns only */ }
  const patterns = buildPatterns(config);
  let bad = false;
  for (const file of process.argv.slice(2)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const h of scanLines(text.split("\n"), patternsForFile(file, patterns))) {
      console.log(`${file}:${h.line}: [${h.name}] ${h.match}`);
      bad = true;
    }
  }
  process.exit(bad ? 1 : 0);
}
