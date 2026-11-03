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

/** What redactLeaks hands back: the screened text and the pattern KINDS it
 *  replaced, once each, sorted. */
export interface Redaction {
  text: string;
  redacted: string[];
}

// The placeholder names the kind, never the text, for the same reason the
// hits do: the result travels back through the agent and into the tracker.
const placeholder = (name: string): string => `[redacted ${name}]`;

// The redaction unit is the whitespace-delimited token (backticks excluded,
// so a quoted command keeps its quotes). The hook's cairn-path pattern only
// matches the ".cairn/" prefix; replacing the prefix alone would leave the
// rest of the path behind for the phase-ref pattern to find.
const tokenAround = (re: RegExp): RegExp =>
  new RegExp(`[^\\s\`]*(?:${re.source})[^\\s\`]*`, re.flags.includes("g") ? re.flags : `${re.flags}g`);

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

/**
 * The redacting form of the scan (#374), for text the SERVER composes and
 * posts to the tracker -- the claim and close comments. peer_run refuses a
 * hit outright because the agent can rewrite its own input and retry; a
 * server-composed comment quotes facts the server settled (the plan's
 * verify line, the evidence command the close was handed), and the ledger
 * under the planning dir keeps them exact, so the public copy swaps each
 * private token for a kind-named placeholder instead. Same line-by-line
 * unit and the same leakGuard.enabled switch as scanForLeaks.
 *
 * This replaces; it does not vouch. The caller scans the result again with
 * scanForLeaks and refuses to post what still hits -- a user pattern that
 * matches the placeholder itself ("redacted") can never be redacted away.
 * Asserted in leak-patterns.test.ts ("a hit that survives redaction is
 * still a hit"). A clean text comes back byte-identical.
 *
 * :param text: the comment about to be posted
 * :param config: cairn.json (parsed or raw)
 * :returns the screened text and the kinds redacted
 */
export function redactLeaks(text: string, config?: LeakScanConfig | null): Redaction {
  if (config?.leakGuard?.enabled === false) return { text, redacted: [] };

  const patterns = buildLeakPatterns(config);
  const redacted = new Set<string>();

  // Each line against every pattern, the whole surrounding token replaced
  const out = text.split("\n").map((line) => {
    let l = line;
    for (const { name, re } of patterns) {
      if (!re.test(l)) continue;
      l = l.replace(tokenAround(re), placeholder(name));
      redacted.add(name);
    }
    return l;
  }).join("\n");

  return { text: out, redacted: [...redacted].sort() };
}
