/**
 * Purpose: the server's own copy of the leak-pattern set, so peer_run can
 *   screen the exact bytes it is about to send to an external CLI (#268).
 *   Until now that gate was verb prose -- the agent was told to scan, and
 *   the server took its word for it.
 *
 *   This is a PORT, not an import: the canonical set lives in
 *   hooks/scripts/leak-patterns.mjs, and the published server package ships
 *   dist only, so it cannot reach the hook module at runtime. A parity test
 *   (server/test/leak-patterns.test.ts) imports both and compares pattern
 *   names and sources across configs -- change one side without the other
 *   and the suite goes red.
 *
 *   One deliberate difference: the hook's cairn-path pattern carries a
 *   path-scoped exemption for server source files (#140). Outbound peer
 *   input is text, not a file in this repo, so no exemption applies here --
 *   every pattern runs at full strength.
 *
 *   Scope note: these patterns catch planning paths, phase refs, cairn
 *   labels and Jira-style tracker ids, plus whatever the user adds in
 *   leakGuard.extraPatterns. They are not a secret scanner.
 * Author(s): John Reed
 */

// Constants

// Same anchoring rule as the hook -- a project key that is not a plain
// identifier never becomes a regex.
const PROJECT_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/;

// The slice of cairn.json the scan reads. Structural on purpose: a parsed
// CairnConfig fits, and so does the raw object the parity test feeds the hook.
export interface LeakScanConfig {
  tracker?: { type?: string; config?: Record<string, unknown> };
  leakGuard?: { enabled?: boolean; extraPatterns?: readonly string[] };
}

export interface LeakPattern {
  name: string;
  re: RegExp;
}

export interface LeakHit {
  line: number;
  name: string;
}

/**
 * Builds the pattern list, mirroring buildPatterns in the hook module:
 * three built-ins, a tracker-id pattern for a Jira project key, then the
 * user's extraPatterns. An invalid user regex is skipped silently -- the
 * guard must never crash the flow it guards.
 *
 * :param config: cairn.json (parsed or raw); null/undefined = built-ins only
 * :returns the patterns, in the hook's order
 */
export function buildLeakPatterns(config?: LeakScanConfig | null): LeakPattern[] {
  const patterns: LeakPattern[] = [
    { name: "cairn-path", re: /\.cairn\// },
    { name: "phase-ref", re: /\b(?:phases\/\d{2}(?:\.\d+)?-[a-z0-9-]+|milestones\/v\d+)\b/ },
    { name: "cairn-label", re: /cairn:(?:seed|backlog)/ },
  ];

  const projectKey = config?.tracker?.type === "jira"
    ? config.tracker.config?.projectKey : undefined;
  if (typeof projectKey === "string" && PROJECT_KEY_SHAPE.test(projectKey)) {
    patterns.push({ name: "tracker-id", re: new RegExp(`\\b${projectKey}-\\d+\\b`) });
  }

  for (const p of config?.leakGuard?.extraPatterns ?? []) {
    try {
      patterns.push({ name: "extra", re: new RegExp(p) });
    } catch {
      // invalid user regex: skip silently, same as the hook
    }
  }
  return patterns;
}

/**
 * Scans text line by line (the hook's unit, so a user pattern's ^ and $
 * mean the same thing in both places). Returns every hit as a line number
 * and pattern name -- deliberately NOT the matched text, so a caller can
 * report a hit without repeating the leak. leakGuard.enabled === false
 * turns the scan off, the same switch the commit-time guard honours.
 *
 * :param text: the exact content about to leave the machine
 * :param config: cairn.json (parsed or raw)
 * :returns hits in line order; empty when clean or disabled
 */
export function scanForLeaks(text: string, config?: LeakScanConfig | null): LeakHit[] {
  if (config?.leakGuard?.enabled === false) return [];

  const patterns = buildLeakPatterns(config);
  const hits: LeakHit[] = [];

  // Iterate each line against every pattern -- non-global regexes, so
  // test() carries no lastIndex state between calls
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of patterns) {
      if (re.test(line)) hits.push({ line: i + 1, name });
    }
  });
  return hits;
}
