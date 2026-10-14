/**
 * Purpose: single source of truth for the allow-listed peer CLI providers.
 * Split out from run.ts so config.ts can reference the provider list for
 * its zod schema without creating an import cycle with the peer runner
 * (which itself needs config.ts for loadConfig).
 * Author(s): John Reed
 */
export declare const PROVIDERS: readonly ["codex", "opencode", "antigravity", "grok", "copilot"];
export type Provider = (typeof PROVIDERS)[number];
