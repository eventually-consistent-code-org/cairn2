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
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { PROVIDERS } from "./providers.js";
import { concurrencyBudget } from "./throttle.js";
import { scanForLeaks } from "./leak-scan.js";
export { PROVIDERS };
// Fixed argv templates — first element is the binary name, resolved via
// PATH by execFile itself. These are constants, never built from user
// input. Assembly order is argv + (scratch mode only) scratchSandboxArgs
// + tail + (argv-mode peers) the capped input. Input reaches each CLI per
// its REAL convention (verified against the live CLIs, CRN-76 and #56 —
// the old all-stdin assumption sent grok/opencode a literal "-" as their
// prompt):
//   codex       — `codex exec -` reads instructions from stdin
//                 (documented). `--skip-git-repo-check` rides along because
//                 codex otherwise refuses to run in any directory the host
//                 hasn't marked trusted — reviews died with "Not inside a
//                 trusted directory" depending on where the server sat.
//                 Now load-bearing in scratch mode too: the scratch dir is
//                 no git repo, and the flag covers that case (verified
//                 live in a non-git dir, 2026-08-09). Scratch runs add
//                 `--sandbox read-only` (verified codex-cli 0.146.0,
//                 `codex exec --help`).
//   antigravity — binary is `agy`; `-p <prompt>` runs one prompt headless
//                 and prints the response. Ignores piped stdin — input
//                 rides as the final argv element, same rules as grok.
//                 Scratch runs add the boolean `--sandbox` ("terminal
//                 restrictions enabled", verified agy 1.1.12, `agy
//                 --help`) — before `-p` so the prompt stays the flag's
//                 value.
//   grok        — `-p <prompt>` takes the prompt as the flag's value; its
//                 headless mode does not consume piped stdin. Input rides
//                 as the final argv element — still execFile with an argv
//                 array, so there is no shell and no interpolation; the
//                 200k default cap keeps well under ARG_MAX on macOS/Linux.
//                 No documented sandbox flag as of 2026-08 — containment
//                 rests on the scratch cwd alone.
//   opencode    — `run [message..]` takes the prompt positionally; same
//                 argv-mode rules as grok. No documented sandbox flag as
//                 of 2026-08 — scratch cwd only, same as grok.
const TEMPLATES = {
    codex: { argv: ["codex", "exec", "--skip-git-repo-check"], tail: ["-"],
        inputVia: "stdin", scratchSandboxArgs: ["--sandbox", "read-only"] },
    opencode: { argv: ["opencode", "run"], tail: [],
        inputVia: "argv", scratchSandboxArgs: [] },
    antigravity: { argv: ["agy"], tail: ["-p"],
        inputVia: "argv", scratchSandboxArgs: ["--sandbox"] },
    grok: { argv: ["grok", "-p"], tail: [],
        inputVia: "argv", scratchSandboxArgs: [] },
};
const INSTALL_HINTS = {
    codex: "install the Codex CLI and put it on PATH (npm i -g @openai/codex)",
    opencode: "install the opencode CLI and put it on PATH (see https://opencode.ai)",
    antigravity: "install the Antigravity CLI ('agy') and put it on PATH (see antigravity docs)",
    grok: "install the Grok CLI and put it on PATH (see xAI's grok-cli docs)",
};
// What to tell the user when a peer blows the timeout. opencode gets a
// specific hint because the cause was verified live (#59, opencode 1.18.10):
// headless `opencode run` never blocks on a TTY — with no credentials in
// auth.json and no opencode.json it silently auto-selects the free-tier
// model ("build · deepseek-v4-flash-free" observed) and that endpoint's
// latency is wildly variable — 5s vs 31s for a one-word reply on back-to-
// back runs, 100s+ in the original report. So an opencode timeout almost
// always means "no default model configured", not a wedged CLI.
const TIMEOUT_HINTS = {
    codex: "raise timeoutMs, or check that the codex CLI responds on stdin",
    opencode: "raise timeoutMs, or configure a default model for opencode — with none " +
        "configured, headless runs auto-pick a free-tier model with unpredictable " +
        "latency (verified 5-31s+ for a one-word reply, #59); check `opencode auth list` " +
        "and pin a model in opencode.json",
    antigravity: "raise timeoutMs, or check that the antigravity CLI responds on stdin",
    grok: "raise timeoutMs, or check that the grok CLI responds on stdin",
};
const DEFAULT_MAX_INPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;
// How many hit line numbers a leak refusal lists before it summarizes —
// a 200k-char packet can trip hundreds of lines, and the message only
// needs enough to point the caller at what to redact.
const MAX_HIT_LINES_LISTED = 10;
// Probes PATH entries for a binary of this name. POSIX-only — no PATHEXT /
// .exe suffix handling. Windows support for peer adapters is a non-goal.
function onPath(bin) {
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    return dirs.some((dir) => existsSync(join(dir, bin)));
}
// Head-truncates input to maxChars and appends the truncation marker line
// verbatim. Marker text is part of the security contract — don't reword it.
function capInput(input, maxChars) {
    if (input.length <= maxChars)
        return { text: input, truncated: false };
    const marker = `[cairn: input truncated at ${maxChars} chars]`;
    return { text: `${input.slice(0, maxChars)}\n${marker}`, truncated: true };
}
// Turns leak hits into a refusal that names the KINDS and the line numbers
// and never the matched text — the error travels back through the agent
// and can land in a tracker comment, so repeating the leak there would be
// the leak.
function leakRefusal(provider, hits) {
    const kinds = [...new Set(hits.map((h) => h.name))].sort().join(", ");
    const lines = [...new Set(hits.map((h) => h.line))];
    const listed = lines.slice(0, MAX_HIT_LINES_LISTED).join(", ");
    const more = lines.length > MAX_HIT_LINES_LISTED
        ? ` (+${lines.length - MAX_HIT_LINES_LISTED} more)` : "";
    return new CairnError("PRECONDITION_FAILED", `peer '${provider}' input hit the leak guard (${kinds}) on line(s) ${listed}${more} — nothing was sent`, "redact and retry, or skip this peer");
}
/**
 * Reports detection/config state for every allow-listed provider — never
 * throws for an absent CLI. A missing peer is a DETECTED state, not an
 * error. Wire shape is {peers, maxConcurrent} (#75): the fan-out budget
 * rides along with the roster so a dispatching caller (council mode)
 * reads both in one call — a live 16-seat all-at-once dispatch exhausted
 * the host's memory on 2026-08-12, so batching is not optional.
 */
export function peerList(projectDir) {
    const cfg = loadConfig(projectDir);
    const peers = PROVIDERS.map((provider) => {
        const peerCfg = cfg.peers?.[provider] ?? {};
        return {
            provider,
            onPath: onPath(TEMPLATES[provider].argv[0]),
            enabled: peerCfg.enabled ?? true,
            maxInputChars: peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
            // Trust flag from config only (#67) — default untrusted, never probed.
            execCapable: peerCfg.execCapable ?? false,
        };
    });
    return {
        peers,
        maxConcurrent: concurrencyBudget({ override: cfg.peerFanout?.maxConcurrent }),
    };
}
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
export async function peerRun(projectDir, provider, input, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
    const cwdMode = opts.cwdMode ?? "scratch";
    const cfg = loadConfig(projectDir);
    const peerCfg = cfg.peers?.[provider] ?? {};
    if (peerCfg.enabled === false) {
        throw new CairnError("PRECONDITION_FAILED", `peer '${provider}' is disabled in cairn.json`, `enable it — set peers.${provider}.enabled to true, or drop the override`);
    }
    // Repo access is a trust grant, and the grant lives in cairn.json —
    // never in the call (#268). Same default as peerList: absent = untrusted.
    if (cwdMode === "project" && peerCfg.execCapable !== true) {
        throw new CairnError("PRECONDITION_FAILED", `peer '${provider}' is not execCapable — cwdMode 'project' refused`, `drop cwdMode to run it contained; repo access needs the user to set ` +
            `peers.${provider}.execCapable to true in cairn.json`);
    }
    const { argv, tail, inputVia, scratchSandboxArgs } = TEMPLATES[provider];
    const [bin, ...templateArgs] = argv;
    // Name the binary once: the parenthetical only earns its place when the
    // binary differs from the provider name (antigravity's CLI is `agy`).
    const notFoundMsg = bin === provider
        ? `peer '${provider}' not found on PATH`
        : `peer '${provider}' not found on PATH ('${bin}')`;
    if (!onPath(bin)) {
        throw new CairnError("PRECONDITION_FAILED", notFoundMsg, INSTALL_HINTS[provider]);
    }
    const maxInputChars = peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    const { text: sendInput, truncated: truncatedInput } = capInput(input, maxInputChars);
    // Outbound leak gate (#268): scan exactly what would leave the machine,
    // before the scratch dir or the child exists — a refused send leaves
    // nothing behind and starts nothing.
    const leakHits = scanForLeaks(sendInput, cfg);
    if (leakHits.length > 0)
        throw leakRefusal(provider, leakHits);
    // argv-mode peers get the capped input as the final argv element (execFile
    // argv array — no shell ever sees it); stdin-mode peers get it piped.
    // Scratch runs also get the CLI's read-only sandbox flags where the CLI
    // has any (see the template notes) — project mode is the explicit
    // repo-access grant, so it stays unsandboxed.
    const sandboxArgs = cwdMode === "scratch" ? scratchSandboxArgs : [];
    const fixedArgs = [...templateArgs, ...sandboxArgs, ...tail];
    const args = inputVia === "argv" ? [...fixedArgs, sendInput] : fixedArgs;
    // Containment (#74): stage the capped input in a fresh scratch dir and
    // run the child from there — packet.txt because some CLIs want a file to
    // chew on (stdin/argv delivery above is unchanged). The #56 determinism
    // survives — cwd is always the same KIND of place — but the repo
    // exposure dies. "project" keeps the old cwd for callers that NEED it.
    let scratchDir;
    if (cwdMode === "scratch") {
        scratchDir = mkdtempSync(join(tmpdir(), "cairn-peer-"));
        writeFileSync(join(scratchDir, "packet.txt"), sendInput);
    }
    const cwd = scratchDir ?? projectDir;
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const child = execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
            const durationMs = Date.now() - start;
            // Scratch dir is done the moment the child is — tear it down
            // best-effort on every path, and never let cleanup failure mask
            // (or outrank) the run's real outcome.
            if (scratchDir) {
                try {
                    rmSync(scratchDir, { recursive: true, force: true });
                }
                catch {
                    // best-effort only — a stale tmpdir entry beats a false error
                }
            }
            if (error && error.code === "ENOENT") {
                reject(new CairnError("PRECONDITION_FAILED", notFoundMsg, INSTALL_HINTS[provider]));
                return;
            }
            if (error && error.killed) {
                reject(new CairnError("PRECONDITION_FAILED", `peer '${provider}' timed out after ${durationMs}ms`, TIMEOUT_HINTS[provider]));
                return;
            }
            // Non-zero exit is a passthrough result, never a throw — the
            // caller (the peers verb) judges peer output, this layer doesn't.
            // But only a genuine child exit code counts as a result: anything
            // else (string errnos like EACCES/EMFILE, maxBuffer overruns) means
            // the process never really ran, so that's a precondition failure,
            // not advisory peer output.
            const rawCode = error ? error.code : 0;
            if (error && typeof rawCode !== "number") {
                reject(new CairnError("PRECONDITION_FAILED", `peer '${provider}' failed to run (${String(rawCode)})`, "check the peer CLI installation/environment"));
                return;
            }
            const exitCode = typeof rawCode === "number" ? rawCode : 0;
            const output = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
            resolve({ provider, output, exitCode, truncatedInput, durationMs });
        });
        // Swallow stdin write errors (EPIPE and friends) — if the peer exits
        // without draining stdin, or the timeout SIGKILLs it mid-write, Node
        // fires an uncaught 'error' event on the stream unless something is
        // listening. The exec callback above already handles the process-level
        // outcome; a broken pipe here isn't a new failure, just a side effect
        // of one we're already reporting.
        child.stdin?.on("error", () => { });
        if (inputVia === "stdin")
            child.stdin?.write(sendInput);
        child.stdin?.end(); // argv-mode children get instant EOF so nothing blocks on a TTY read
    });
}
