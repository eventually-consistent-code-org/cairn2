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
 *   Scope: these patterns catch planning paths, phase refs, cairn labels,
 *   Jira-style tracker ids, and the key-shaped secrets of #280 -- a cloud
 *   access key, a GitHub or Slack token, a private-key header, and a
 *   key|secret|token assignment with a long opaque value -- plus whatever
 *   the user adds in leakGuard.extraPatterns. A hit never carries the
 *   text, so a secret's line is reported and its value is not; what the
 *   secret shapes do not read is the hook's Not seen block.
 * Author(s): John Reed
 */
export interface LeakScanConfig {
    tracker?: {
        type?: string;
        config?: Record<string, unknown>;
    };
    leakGuard?: {
        enabled?: boolean;
        extraPatterns?: readonly string[];
    };
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
/**
 * Builds the pattern list, mirroring buildPatterns in the hook module:
 * three built-ins, the five secret shapes (#280, same regex source as the
 * hook's -- change one side and the parity test goes red), a tracker-id
 * pattern for a Jira project key, then the user's extraPatterns. An
 * invalid user regex is skipped silently -- the guard must never crash
 * the flow it guards.
 *
 * :param config: cairn.json (parsed or raw); null/undefined = built-ins only
 * :returns the patterns, in the hook's order
 */
export declare function buildLeakPatterns(config?: LeakScanConfig | null): LeakPattern[];
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
export declare function scanForLeaks(text: string, config?: LeakScanConfig | null): LeakHit[];
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
export declare function redactLeaks(text: string, config?: LeakScanConfig | null): Redaction;
