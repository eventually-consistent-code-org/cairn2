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
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { CairnError } from "../errors.js";
import { loadConfig } from "../config.js";
import { PROVIDERS, RATE_LIMIT_MARKER, isRateLimited } from "./providers.js";
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
//   copilot     — GitHub Copilot CLI (#338, phase 26.5). `-p <prompt>` runs
//                 one prompt headless, `-s` prints only the reply (the
//                 fence parser reads it; JSONL would escape the fences).
//                 It is a fifth HARNESS, not a fifth vendor: every model it
//                 reaches is OpenAI's, Google's, or Anthropic's, so the
//                 seat is pinned to a non-Claude model (`--model`, default
//                 gpt-6.1-sol, overridable via peers.copilot.model; a
//                 claude-* pin is refused at config load -- the
//                 adjudicator's own family shares its blind spots).
//                 Containment is a flag SET, not one switch: always
//                 --no-ask-user --no-auto-update --no-color
//                 --no-custom-instructions --disable-builtin-mcps
//                 --disable-mcp-server cairn (cairn-setup registers cairn's
//                 own server in ~/.copilot/mcp-config.json -- without this
//                 a project-mode reviewer would see tracker-write tools)
//                 --max-ai-credits 30 (the CLI's floor; 1.0.96 refuses
//                 less); scratch runs add --available-tools=view
//                 --allow-tool=view --disallow-temp-dir (cairn's scratch
//                 dir lives under os.tmpdir(), and without the last flag
//                 `view` reaches every sibling there -- #74 by a side
//                 door). Never --yolo / --allow-all* / --share-gist /
//                 --remote*. An unavailable model, a missing login or a
//                 credit cap exits 1 with stderr only -- a #339 incomplete
//                 seat, never a clean pass.
//
// envDrop is the per-seat ADDITION to PEER_ENV_DROP below -- variables that
// steer one particular CLI's trust or auth and must never reach it from
// the server's environment. Empty for the four seated today; the Copilot
// seat (#338) fills it.
//
// `model` is the one dynamic argv element besides the input: the flag and
// the pinned default, with peers.<provider>.model in cairn.json as the
// owner's override. Only seats whose CLI takes a model flag declare it.
//
// `lab` is who trained the model the seat speaks for (#341). Convergence
// counts LABS, not seats: Copilot on a gpt-* pin plus codex is one lab
// speaking through two harnesses, and the council's value is cross-vendor
// judgement. A fixed lab is declared here; a model-pinned seat derives it
// from the pinned id (peerLab); an unpinned seat is `unknown` and never
// counts toward convergence on its own.
export const LABS = ["openai", "xai", "google", "anthropic", "unknown"];
const TEMPLATES = {
    codex: { argv: ["codex", "exec", "--skip-git-repo-check"], tail: ["-"],
        inputVia: "stdin", scratchSandboxArgs: ["--sandbox", "read-only"], envDrop: [], lab: "openai" },
    // opencode picks its model from its own config (#59) -- the lab is
    // whatever the user pointed it at, which this layer cannot see.
    opencode: { argv: ["opencode", "run"], tail: [],
        inputVia: "argv", scratchSandboxArgs: [], envDrop: [] },
    antigravity: { argv: ["agy"], tail: ["-p"],
        inputVia: "argv", scratchSandboxArgs: ["--sandbox"], envDrop: [], lab: "google" },
    grok: { argv: ["grok", "-p"], tail: [],
        inputVia: "argv", scratchSandboxArgs: [], envDrop: [], lab: "xai" },
    copilot: {
        argv: ["copilot", "-s", "--no-ask-user", "--no-auto-update", "--no-color",
            "--no-custom-instructions", "--disable-builtin-mcps", "--disable-mcp-server", "cairn",
            "--max-ai-credits", "30"],
        tail: ["-p"],
        inputVia: "argv",
        scratchSandboxArgs: ["--available-tools=view", "--allow-tool=view", "--disallow-temp-dir"],
        envDrop: ["COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS"],
        model: { flag: "--model", default: "gpt-6.1-sol" },
    },
};
/**
 * The lab behind a model id, from its family prefix. `claude-*` maps to
 * anthropic so a caller can see WHY config load refuses it; anything the
 * table cannot place is `unknown`, never guessed.
 */
export function labOfModel(model) {
    const m = model.toLowerCase();
    if (/^(gpt|o\d|codex)/.test(m))
        return "openai";
    if (/^gemini/.test(m))
        return "google";
    if (/^claude/.test(m))
        return "anthropic";
    if (/^grok/.test(m))
        return "xai";
    return "unknown";
}
/**
 * The lab a seat speaks for (#341): the template's fixed lab, else the lab
 * of its resolved model pin, else `unknown`.
 */
export function peerLab(cfg, provider) {
    const t = TEMPLATES[provider];
    if (t.lab)
        return t.lab;
    const model = peerModel(cfg, provider);
    return model ? labOfModel(model) : "unknown";
}
/** The model id a seat runs with: the cairn.json pin, else the template default. */
export function peerModel(cfg, provider) {
    const t = TEMPLATES[provider].model;
    if (!t)
        return undefined;
    return cfg.peers?.[provider]?.model ?? t.default;
}
// Credential variables dropped from EVERY seat's child env (#340): the
// default token names each of cairn's tracker adapters reads, GitHub's
// two spellings (Copilot prefers GH_TOKEN/GITHUB_TOKEN over its own
// stored login, so an inherited tracker token would hijack that seat's
// auth), and the two Copilot variables that widen its trust. The list is
// the DEFAULT names; peerChildEnv adds whatever cairn.json actually
// configured (tokenEnv / patEnv / apiKeyEnv, tracker and docs) so a custom
// variable name is covered too. COPILOT_GITHUB_TOKEN is deliberately kept:
// it is the seat's own credential, not cairn's. leak-patterns.test.ts
// holds the parity check -- every default an adapter declares must be here.
export const PEER_ENV_DROP = [
    "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "JIRA_API_TOKEN", "ASANA_TOKEN",
    "AZURE_DEVOPS_PAT", "CLICKUP_TOKEN", "LINEAR_API_KEY",
    "COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
];
// The credential-naming keys a tracker or docs connector config may carry.
// Each adapter's schema defaults one of these to the names above; a user
// who renamed theirs still gets it dropped because we read the configured
// value, not the default.
const CREDENTIAL_ENV_KEYS = ["tokenEnv", "patEnv", "apiKeyEnv"];
/**
 * The environment a peer child is spawned with: `base` (the server's own
 * env by default) minus PEER_ENV_DROP, minus the seat's template envDrop,
 * minus every credential variable cairn.json names for the tracker and
 * the docs connector. Pure -- builds a fresh object, never mutates `base`.
 * Exported so the drop is testable without spawning anything.
 */
export function peerChildEnv(cfg, provider, base = process.env) {
    const drop = new Set([...PEER_ENV_DROP, ...TEMPLATES[provider].envDrop]);
    for (const block of [cfg.tracker?.config, cfg.docs?.config]) {
        if (!block || typeof block !== "object")
            continue;
        for (const key of CREDENTIAL_ENV_KEYS) {
            const name = block[key];
            if (typeof name === "string" && name)
                drop.add(name);
        }
    }
    const env = {};
    for (const [k, v] of Object.entries(base)) {
        if (!drop.has(k))
            env[k] = v;
    }
    return env;
}
const INSTALL_HINTS = {
    codex: "install the Codex CLI and put it on PATH (npm i -g @openai/codex)",
    opencode: "install the opencode CLI and put it on PATH (see https://opencode.ai)",
    antigravity: "install the Antigravity CLI ('agy') and put it on PATH (see antigravity docs)",
    grok: "install the Grok CLI and put it on PATH (see xAI's grok-cli docs)",
    copilot: "install the GitHub Copilot CLI and put it on PATH (brew install --cask copilot-cli), then `copilot login`",
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
    copilot: "raise timeoutMs, or run `copilot login` (an unauthenticated headless run may wait on a "
        + "device code) and confirm the pinned model is on your plan (peers.copilot.model overrides the default)",
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
// Last-limit store (#364). A usage limit belongs to the CLI's login, not to
// this checkout or this run: two worktrees -- or two projects -- driving
// the same codex account hit the same window. So the time lives
// machine-wide, <home>/.cairn/peer-limits/<provider>.json, one file per
// seat, and peerList reads it back as "limited N min ago".
//
// Concurrency, at this handoff (peerRun writes, peerList reads):
//   atomicity  -- one write is a whole file at a tmp name carrying the pid
//                 and a random suffix, then a rename; never edited in place;
//   visibility -- the rename is the publish point, and a reader takes a
//                 missing or unparsable file as "never limited";
//   ordering   -- two seats of one provider limited at once race on the
//                 rename and the last one wins, which is fine: either time
//                 is a true "last limited at". No read-modify-write exists,
//                 so there is no lost update to lose.
const limitsDir = (home) => join(home, ".cairn", "peer-limits");
function recordLimit(home, provider, at) {
    try {
        const dir = limitsDir(home);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${provider}.json`);
        const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ limitedAt: at.toISOString() })}\n`);
        renameSync(tmp, file);
    }
    catch {
        // best-effort: an unwritable home costs peer_list its "limited N min
        // ago" hint, never the RATE_LIMITED answer itself
    }
}
function lastLimit(home, provider) {
    try {
        const raw = JSON.parse(readFileSync(join(limitsDir(home), `${provider}.json`), "utf8"));
        const at = raw.limitedAt;
        return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : undefined;
    }
    catch {
        return undefined;
    }
}
// The refusal a limited seat gets: plain line first, cairn's marker in the
// message (state.ts reads it back off the recorded output to file the seat
// as skipped), and the CLI's own words as a one-line tail.
const LIMIT_TAIL_CHARS = 200;
function rateLimited(provider, exitCode, said) {
    const flat = said.replace(/\s+/g, " ").trim();
    const tail = !flat ? "(no output)"
        : flat.length > LIMIT_TAIL_CHARS ? `...${flat.slice(-LIMIT_TAIL_CHARS)}` : flat;
    return new CairnError("RATE_LIMITED", `peer '${provider}' is rate limited (exit ${exitCode}) ${RATE_LIMIT_MARKER}: ${tail}`, `skip this seat and go on with the remaining seats -- record this message as ${provider}'s `
        + "round-1 output (peer_state record_output) and the run files it as skipped (rate limited), "
        + `never failed. No retry from cairn: re-run ${provider} after its limit window resets, or `
        + "leave it off the next run's roster");
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
export function peerList(projectDir, opts = {}) {
    const cfg = loadConfig(projectDir);
    const home = opts.home ?? homedir();
    const now = (opts.now ?? new Date()).getTime();
    const peers = PROVIDERS.map((provider) => {
        const peerCfg = cfg.peers?.[provider] ?? {};
        const lastLimitedAt = lastLimit(home, provider);
        return {
            provider,
            onPath: onPath(TEMPLATES[provider].argv[0]),
            enabled: peerCfg.enabled ?? true,
            maxInputChars: peerCfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
            // Trust flag from config only (#67) — default untrusted, never probed.
            execCapable: peerCfg.execCapable ?? false,
            ...(TEMPLATES[provider].model ? { model: peerModel(cfg, provider) } : {}),
            lab: peerLab(cfg, provider),
            ...(lastLimitedAt ? {
                lastLimitedAt,
                limitedMinutesAgo: Math.max(0, Math.floor((now - Date.parse(lastLimitedAt)) / 60_000)),
            } : {}),
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
    const { argv, tail, inputVia, scratchSandboxArgs, model } = TEMPLATES[provider];
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
    // The pinned model rides right after the template's constant flags (#338):
    // cairn.json's peers.<provider>.model, else the template default. Never
    // from the call -- a reviewer's model is the owner's choice.
    const modelArgs = model ? [model.flag, peerModel(cfg, provider)] : [];
    const fixedArgs = [...templateArgs, ...modelArgs, ...sandboxArgs, ...tail];
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
        // #340: the child gets the server's env minus every tracker credential
        // -- see peerChildEnv. Built per spawn so a token exported mid-session
        // is still dropped.
        const child = execFile(bin, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: "SIGKILL",
            env: peerChildEnv(cfg, provider) }, (error, stdout, stderr) => {
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
            // #364: a limit refusal is the one non-zero exit that is not a
            // passthrough -- skipped seat, typed code, time stamped, no retry.
            if (isRateLimited(provider, exitCode, stderr, stdout)) {
                recordLimit(opts.home ?? homedir(), provider, new Date());
                reject(rateLimited(provider, exitCode, stderr || stdout));
                return;
            }
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
