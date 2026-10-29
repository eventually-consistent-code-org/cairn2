/**
 * Purpose: allow-listed external-CLI adapters (codex/opencode/antigravity/
 * grok/copilot) — runs each as a fixed-argv child process with a hard cap on input
 * size and a timeout, CONTAINED by default: the child runs from a fresh
 * scratch dir under the OS tmpdir with the capped input staged beside it
 * as packet.txt, so the screened packet is all a peer can see (#74).
 * cwdMode "project" is the explicit escape hatch back to the project-dir
 * cwd (#56), refused unless the peer's cairn.json entry says execCapable;
 * every send is leak-scanned before anything spawns (#268), and the child
 * never inherits a tracker credential: every seat's env is the server's
 * minus the token variables cairn's own adapters read (#340) -- grok and
 * opencode carry shell tools and no sandbox, so an inherited GITHUB_TOKEN
 * is a write-capable tracker token in a reviewer's hands. Never exec,
 * never shell interpolation — argv is always one of the five fixed templates
 * below plus (for argv-mode peers) the capped input as the single final
 * element; stdin-mode peers get input piped instead, per each CLI's
 * verified prompt convention. A peer's non-zero exit is a result, not an
 * error: peers are advisory, and the caller (the `peers` verb) is the one
 * that judges what they say -- with one exception, a non-zero exit in the
 * CLI's own usage-limit shape (#364, shapes in providers.ts), which is a
 * typed RATE_LIMITED: the seat is skipped, the run goes on, and the time
 * lands where peerList can report it. No retry loop lives here; the owner
 * decides when to re-run. Missing binaries and disabled providers
 * degrade to PRECONDITION_FAILED — nothing here assumes a peer CLI is
 * actually installed.
 * Author(s): John Reed
 */
import { PROVIDERS, type Provider } from "./providers.js";
export { PROVIDERS };
export type { Provider };
export interface PeerResult {
    provider: Provider;
    output: string;
    exitCode: number;
    truncatedInput: boolean;
    durationMs: number;
}
export declare const LABS: readonly ["openai", "xai", "google", "anthropic", "unknown"];
export type Lab = (typeof LABS)[number];
/**
 * The lab behind a model id, from its family prefix. `claude-*` maps to
 * anthropic so a caller can see WHY config load refuses it; anything the
 * table cannot place is `unknown`, never guessed.
 */
export declare function labOfModel(model: string): Lab;
/**
 * The lab a seat speaks for (#341): the template's fixed lab, else the lab
 * of its resolved model pin, else `unknown`.
 */
export declare function peerLab(cfg: {
    peers?: Partial<Record<Provider, {
        model?: string;
    }>>;
}, provider: Provider): Lab;
/** The model id a seat runs with: the cairn.json pin, else the template default. */
export declare function peerModel(cfg: {
    peers?: Partial<Record<Provider, {
        model?: string;
    }>>;
}, provider: Provider): string | undefined;
export declare const PEER_ENV_DROP: readonly string[];
/**
 * The environment a peer child is spawned with: `base` (the server's own
 * env by default) minus PEER_ENV_DROP, minus the seat's template envDrop,
 * minus every credential variable cairn.json names for the tracker and
 * the docs connector. Pure -- builds a fresh object, never mutates `base`.
 * Exported so the drop is testable without spawning anything.
 */
export declare function peerChildEnv(cfg: {
    tracker?: {
        config?: unknown;
    };
    docs?: {
        config?: unknown;
    };
}, provider: Provider, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export type PeerCwdMode = "scratch" | "project";
/**
 * Reports detection/config state for every allow-listed provider — never
 * throws for an absent CLI. A missing peer is a DETECTED state, not an
 * error. Wire shape is {peers, maxConcurrent} (#75): the fan-out budget
 * rides along with the roster so a dispatching caller (council mode)
 * reads both in one call — a live 16-seat all-at-once dispatch exhausted
 * the host's memory on 2026-08-12, so batching is not optional.
 */
export declare function peerList(projectDir: string, opts?: {
    home?: string;
    now?: Date;
}): {
    peers: Array<{
        provider: Provider;
        onPath: boolean;
        enabled: boolean;
        maxInputChars: number;
        execCapable: boolean;
        /** Present for seats whose CLI takes a model flag: the id the seat runs with (#338). */
        model?: string;
        /** Who trained the model this seat speaks for (#341); convergence counts distinct labs. */
        lab: Lab;
        /** When this seat's CLI last refused on a usage limit (#364), machine-wide; absent = never seen. */
        lastLimitedAt?: string;
        /** Whole minutes since lastLimitedAt, for "codex: limited 12 min ago" at the focus ask. */
        limitedMinutesAgo?: number;
    }>;
    maxConcurrent: number;
};
/**
 * Runs one peer CLI with `input` on stdin, honoring its configured cap and
 * the given (or default) timeout. Resolves with the child's real exit code
 * on success AND on a non-zero exit — peers are advisory, so a bad exit is
 * data, not a failure. Only genuinely precondition-failed states (disabled
 * provider, project mode for a peer not marked execCapable, missing binary,
 * a leak-pattern hit in the outgoing input, timeout) throw.
 *
 * Contained by default (#74): the child runs from a fresh scratch dir with
 * the capped input staged as packet.txt — a live council run showed a peer
 * with project cwd reading repo internals its screened packet never
 * carried, straight around the leak gate. Pass cwdMode "project" to
 * restore the #56 project-dir cwd — that grant belongs ONLY to
 * execCapable peers on the functionality dimension, and the execCapable
 * half is enforced here, not left to the caller (#268). The functionality
 * half stays the peers verb's call — this layer has no idea what
 * dimension a send belongs to.
 *
 * The outbound leak gate is enforced here too (#268): the capped input —
 * the exact bytes the child would get — is scanned before any scratch
 * dir or child process exists, and a hit refuses the run. The child's
 * environment is the server's minus every tracker credential (#340,
 * peerChildEnv) — containment covers what the peer can READ from its
 * own process, not only what it can see on disk.
 *
 * A non-zero exit in the provider's usage-limit shape (#364) rejects with
 * RATE_LIMITED instead of resolving: the message carries cairn's marker
 * so the recorded refusal files the seat as skipped, and the time is
 * stamped for peerList. Never retried here.
 *
 * :param opts.cwdMode: "scratch" (default) or "project"
 * :param opts.home: where the last-limit store lives (default: the user's home)
 */
export declare function peerRun(projectDir: string, provider: Provider, input: string, timeoutMs?: number, opts?: {
    cwdMode?: PeerCwdMode;
    home?: string;
}): Promise<PeerResult>;
