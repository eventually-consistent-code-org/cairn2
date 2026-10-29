/**
 * Purpose: single source of truth for the allow-listed peer CLI providers,
 * and for what each one's usage-limit refusal looks like (#364). Split out
 * from run.ts so config.ts can reference the provider list for its zod
 * schema without creating an import cycle with the peer runner (which
 * itself needs config.ts for loadConfig); state.ts reads the limit
 * classifier from here too, so the runner and the run store cannot
 * disagree on what a limited seat is.
 * Author(s): John Reed
 *
 * Usage-limit shapes, per CLI -- what turns a seat's non-zero exit into a
 * typed RATE_LIMITED instead of a #339 failed seat. Every CLI exits
 * non-zero on a limit; the exit code alone is not the signal (a missing
 * login exits 1 too), so each shape is the exit plus a stderr phrase, and
 * a JSON error field any of them may print on either stream.
 *
 *   codex       -- codex-cli 0.163.0. "Usage limit reached. You've reached
 *                  your usage limit", the error kind usage_limit_reached
 *                  (and its workspace_* credits-depleted siblings), "Quota
 *                  exceeded. Check your plan and billing details.", and
 *                  "exceeded retry limit, last status: 429" when the
 *                  backoff gives up.
 *   grok        -- grok 1.0.67. "Rate limited", "rate limit exceeded", the
 *                  rate_limit stop class, and the credit-side refusals
 *                  "usage limit reached", "usage balance exhausted", "out
 *                  of credits", "spending limit".
 *   antigravity -- agy 1.2.0. "You have exhausted your quota on this
 *                  model." and the gRPC status RESOURCE_EXHAUSTED. A bare
 *                  "quota exceeded" is deliberately NOT a match here: the
 *                  same binary prints "disc quota exceeded" for a full
 *                  disk, which is not a usage window.
 *   opencode    -- opencode 2.1.3. Relays whatever its configured model
 *                  provider said; its own retry classifier matches "rate
 *                  limit", "too many requests" and "throttling error", and
 *                  those three are the shape here. The OpenAI-style quota
 *                  refusal it may relay ("You exceeded your current quota",
 *                  insufficient_quota) is the provider's wording, not
 *                  opencode's -- not in the binary, kept as a claim.
 *   copilot     -- GitHub Copilot CLI 1.0.97. "You've been rate limited",
 *                  "rate-limited", "Rate limit exceeded" (per-model, weekly
 *                  or integration limits), "usage limit reached" for the
 *                  premium-request allowance.
 *
 * WHAT THAT LIST IS: a dated claim, as of 2026-10-29. Each phrase was read
 * out of the installed CLI at the version named (its binary strings, or
 * copilot's bundled cli-main.js) unless its line says otherwise; none was
 * reproduced by actually
 * exhausting a live account, and a third party's wording is always a
 * claim, never an assertion. peers-run.test.ts holds every phrase above
 * as a fixture, so a reworded pattern fails there; a reworded CLI fails
 * nowhere until a limited seat lands as a #339 failed seat again, which
 * is the safe direction (counted out, never counted as a pass).
 */
export declare const PROVIDERS: readonly ["codex", "opencode", "antigravity", "grok", "copilot"];
export type Provider = (typeof PROVIDERS)[number];
/**
 * Cairn's own stamp on a RATE_LIMITED refusal message. The peers verb
 * records that message as the seat's round-1 output, and state.ts reads
 * the stamp back to file the seat as skipped -- so the classification
 * survives the hop through the agent without a new tool field. Text is
 * part of that contract; don't reword it.
 */
export declare const RATE_LIMIT_MARKER = "[cairn: rate limited]";
export declare const LIMIT_SHAPES: Record<Provider, readonly RegExp[]>;
/**
 * Whether a seat's run ended on a usage limit. A zero exit never is -- a
 * reviewer that answered may well be TALKING about rate limits. A non-zero
 * exit is when the provider's own stderr phrase matches, or either stream
 * carries a limit code in a JSON error field. `provider` undefined (a run
 * store peer name that is not a provider) checks every provider's shapes.
 *
 * :param provider: the CLI the output came from, or undefined for "any"
 * :param exitCode: the child's exit code; undefined is never a limit here
 * :param stderr: what the child wrote to stderr
 * :param stdout: what it wrote to stdout -- only the JSON field is read
 * :returns: true when the exit was a usage-limit refusal
 */
export declare function isRateLimited(provider: Provider | undefined, exitCode: number | undefined, stderr: string, stdout?: string): boolean;
