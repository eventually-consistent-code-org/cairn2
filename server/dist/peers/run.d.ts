/**
 * Purpose: allow-listed external-CLI adapters (codex/opencode/antigravity/
 * grok) — runs each as a fixed-argv child process with a hard cap on input
 * size and a timeout, CONTAINED by default: the child runs from a fresh
 * scratch dir under the OS tmpdir with the capped input staged beside it
 * as packet.txt, so the screened packet is all a peer can see (#74).
 * cwdMode "project" is the explicit escape hatch back to the project-dir
 * cwd (#56), refused unless the peer's cairn.json entry says execCapable;
 * every send is leak-scanned before anything spawns (#268). Never exec,
 * never shell interpolation — argv is always one of the four fixed templates
 * below plus (for argv-mode peers) the capped input as the single final
 * element; stdin-mode peers get input piped instead, per each CLI's
 * verified prompt convention. A peer's non-zero exit is a result, not an
 * error: peers are advisory, and the caller (the `peers` verb) is the one
 * that judges what they say. Missing binaries and disabled providers
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
export type PeerCwdMode = "scratch" | "project";
/**
 * Reports detection/config state for every allow-listed provider — never
 * throws for an absent CLI. A missing peer is a DETECTED state, not an
 * error. Wire shape is {peers, maxConcurrent} (#75): the fan-out budget
 * rides along with the roster so a dispatching caller (council mode)
 * reads both in one call — a live 16-seat all-at-once dispatch exhausted
 * the host's memory on 2026-08-12, so batching is not optional.
 */
export declare function peerList(projectDir: string): {
    peers: Array<{
        provider: Provider;
        onPath: boolean;
        enabled: boolean;
        maxInputChars: number;
        execCapable: boolean;
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
 * dir or child process exists, and a hit refuses the run.
 *
 * :param opts.cwdMode: "scratch" (default) or "project"
 */
export declare function peerRun(projectDir: string, provider: Provider, input: string, timeoutMs?: number, opts?: {
    cwdMode?: PeerCwdMode;
}): Promise<PeerResult>;
