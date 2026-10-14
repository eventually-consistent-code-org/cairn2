import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { peerList, peerRun, peerChildEnv, peerModel, peerLab, labOfModel, PEER_ENV_DROP, PROVIDERS } from "../src/peers/run.js";
import { parseFindings } from "../src/peers/findings.js";
import { runStart, runStatus, recordPeerOutput } from "../src/peers/state.js";

// Stub CLIs are shell scripts prepended onto PATH per test, so no real
// codex/opencode/agy/grok binary is ever assumed. Restore PATH after
// each test so stubs never leak into the next one.
const ORIGINAL_PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function projectDir(config: Record<string, unknown> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-peers-"));
  writeFileSync(join(d, "cairn.json"), JSON.stringify({
    tracker: { type: "github", config: { repo: "o/r" } },
    ...config,
  }));
  return d;
}

function stubBinDir(scripts: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-stub-"));
  for (const [name, script] of Object.entries(scripts)) {
    const p = join(d, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  }
  return d;
}

// For tests that actually spawn the stub (as opposed to just PATH-probing
// it): prepend the stub dir so it wins provider-name lookups, but keep the
// real PATH behind it so the stub's own #!/bin/sh shebang and its `cat` /
// `wc` / `tr` / `sleep` / `echo` calls still resolve.
function runnableStubPath(scripts: Record<string, string>): void {
  const d = stubBinDir(scripts);
  process.env.PATH = `${d}${delimiter}${ORIGINAL_PATH}`;
}

const OK_ECHO = "#!/bin/sh\ncat > /dev/null\necho \"stub:$0 ok\"\n";
const STDIN_LENGTH = "#!/bin/sh\nlen=$(cat | wc -c | tr -d ' ')\necho \"len:$len\"\n";
const SLEEPER = "#!/bin/sh\ncat > /dev/null\nsleep 5\necho done\n";
const EXIT_3 = "#!/bin/sh\ncat > /dev/null\nexit 3\n";
const STDERR_AND_STDOUT = "#!/bin/sh\ncat > /dev/null\necho err 1>&2\necho out\n";

describe("peerList", () => {
  it("reports onPath: false for every provider when none are on PATH", () => {
    process.env.PATH = stubBinDir({}); // empty stub dir, no real CLIs reachable
    const d = projectDir();
    for (const entry of peerList(d).peers) expect(entry.onPath).toBe(false);
  });

  it("reports onPath: true only for the provider whose stub is present", () => {
    process.env.PATH = stubBinDir({ codex: OK_ECHO });
    const d = projectDir();
    const list = peerList(d).peers;
    expect(list.find((p) => p.provider === "codex")?.onPath).toBe(true);
    expect(list.find((p) => p.provider === "opencode")?.onPath).toBe(false);
    expect(list.find((p) => p.provider === "antigravity")?.onPath).toBe(false);
    expect(list.find((p) => p.provider === "grok")?.onPath).toBe(false);
  });

  // The antigravity provider's binary is `agy`, not `antigravity` — the
  // PATH probe has to look for what's actually installed.
  it("antigravity: probes PATH for the agy binary, not the provider name", () => {
    process.env.PATH = stubBinDir({ agy: OK_ECHO });
    const d = projectDir();
    expect(peerList(d).peers.find((p) => p.provider === "antigravity")?.onPath).toBe(true);
  });

  it("defaults enabled: true and maxInputChars: 200000 when unconfigured", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir();
    const codex = peerList(d).peers.find((p) => p.provider === "codex");
    expect(codex?.enabled).toBe(true);
    expect(codex?.maxInputChars).toBe(200_000);
  });

  it("reflects a configured override for enabled and maxInputChars", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir({ peers: { antigravity: { enabled: false, maxInputChars: 900_000 } } });
    const antigravity = peerList(d).peers.find((p) => p.provider === "antigravity");
    expect(antigravity?.enabled).toBe(false);
    expect(antigravity?.maxInputChars).toBe(900_000);
  });

  // execCapable is a config-declared trust flag (#67): the user explicitly
  // marks which peer may execute the product under review. Default is
  // untrusted (false) — never inferred at runtime.
  it("defaults execCapable: false when unconfigured", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir();
    for (const entry of peerList(d).peers) expect(entry.execCapable).toBe(false);
  });

  it("reflects a configured execCapable: true", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir({ peers: { codex: { execCapable: true } } });
    const list = peerList(d).peers;
    expect(list.find((p) => p.provider === "codex")?.execCapable).toBe(true);
    expect(list.find((p) => p.provider === "grok")?.execCapable).toBe(false);
  });

  it("reflects an explicit execCapable: false", () => {
    process.env.PATH = stubBinDir({});
    const d = projectDir({ peers: { opencode: { execCapable: false } } });
    expect(peerList(d).peers.find((p) => p.provider === "opencode")?.execCapable).toBe(false);
  });
});

describe("peerRun", () => {
  it("throws PRECONDITION_FAILED when the provider is disabled in config", async () => {
    process.env.PATH = stubBinDir({ codex: OK_ECHO });
    const d = projectDir({ peers: { codex: { enabled: false } } });
    await expect(peerRun(d, "codex", "hello")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("codex"),
    });
  });

  it("throws PRECONDITION_FAILED with an install hint when the binary is missing", async () => {
    process.env.PATH = stubBinDir({}); // no grok stub present
    const d = projectDir();
    let caught: unknown;
    try {
      await peerRun(d, "grok", "hello");
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as { nextAction?: string }).nextAction).toMatch(/install/i);
  });

  // #72 message nit: name the binary once. When the binary IS the provider
  // name (grok), no parenthetical dupe; when it differs (antigravity → agy),
  // the parenthetical names the real binary, once, at the end.
  it("not-found message names the binary once — grok gets no parenthetical dupe (#72)", async () => {
    process.env.PATH = stubBinDir({}); // no grok stub present
    const d = projectDir();
    await expect(peerRun(d, "grok", "hello")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "peer 'grok' not found on PATH",
    });
  });

  it("not-found message names a differing binary parenthetically — antigravity/agy (#72)", async () => {
    process.env.PATH = stubBinDir({}); // no agy stub present
    const d = projectDir();
    await expect(peerRun(d, "antigravity", "hello")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "peer 'antigravity' not found on PATH ('agy')",
    });
  });

  it("truncates input at the configured cap and appends the exact marker", async () => {
    runnableStubPath({ codex: STDIN_LENGTH });
    const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
    const input = "x".repeat(100);
    const result = await peerRun(d, "codex", input);
    const marker = "[cairn: input truncated at 40 chars]";
    const expectedLen = 40 + 1 + marker.length; // cap + "\n" + marker, verbatim
    expect(result.truncatedInput).toBe(true);
    expect(result.output.trim()).toBe(`len:${expectedLen}`);
    expect(result.exitCode).toBe(0);
  });

  it("does not truncate when input is within the cap", async () => {
    runnableStubPath({ codex: STDIN_LENGTH });
    const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
    const input = "x".repeat(10);
    const result = await peerRun(d, "codex", input);
    expect(result.truncatedInput).toBe(false);
    expect(result.output.trim()).toBe(`len:${input.length}`);
  });

  it("kills a hung peer at the timeout and reports PRECONDITION_FAILED naming the provider", async () => {
    runnableStubPath({ agy: SLEEPER });
    const d = projectDir();
    let caught: unknown;
    try {
      await peerRun(d, "antigravity", "hello", 200);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as Error).message).toMatch(/antigravity/);
    expect((caught as Error).message).toMatch(/timed out/i);
  });

  // #59: live probing showed headless `opencode run` never prompts a TTY —
  // with 0 credentials in auth.json and no opencode.json it auto-selects a
  // free-tier model (observed "build · deepseek-v4-flash-free"), and that
  // free endpoint's latency swings wildly (5s vs 31s for a one-word reply;
  // the original report was 100s+). A timeout on opencode is almost always
  // that missing-model config, so the error must say so instead of the
  // generic "responds on stdin" hint.
  it("opencode: timeout nextAction points at model/auth config, the verified hang cause", async () => {
    runnableStubPath({ opencode: SLEEPER });
    const d = projectDir();
    let caught: unknown;
    try {
      await peerRun(d, "opencode", "hello", 200);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as Error).message).toMatch(/opencode/);
    expect((caught as Error).message).toMatch(/timed out/i);
    const next = (caught as { nextAction?: string }).nextAction ?? "";
    expect(next).toContain("opencode auth list");
    expect(next).toMatch(/default model/i);
  });

  it("passes through a non-zero exit code as a result, never a throw", async () => {
    runnableStubPath({ opencode: EXIT_3 });
    const d = projectDir();
    const result = await peerRun(d, "opencode", "hello");
    expect(result.exitCode).toBe(3);
  });

  it("appends the stderr divider only when stderr is non-empty", async () => {
    runnableStubPath({ codex: STDERR_AND_STDOUT });
    const d = projectDir();
    const result = await peerRun(d, "codex", "hello");
    expect(result.output).toBe("out\n\n--- stderr ---\nerr\n");
  });

  it("omits the stderr divider when stderr is empty", async () => {
    runnableStubPath({ codex: OK_ECHO });
    const d = projectDir();
    const result = await peerRun(d, "codex", "hello");
    expect(result.output).not.toContain("--- stderr ---");
  });

  // A peer that exits without ever reading stdin leaves the write-side pipe
  // with nowhere to drain. Push enough bytes past the OS pipe buffer and
  // Node's child.stdin emits an uncaught 'error' (EPIPE) unless something
  // is listening for it. This must resolve cleanly, not crash the process.
  it("survives EPIPE when a peer exits without draining a large stdin write", async () => {
    runnableStubPath({ codex: "#!/bin/sh\nexit 0\n" });
    const d = projectDir();
    const bigInput = "x".repeat(140_000); // > 128KB, past typical pipe buffer
    const result = await peerRun(d, "codex", bigInput);
    expect(result.exitCode).toBe(0);
  });

  // CRN-76: grok's headless mode takes the prompt as `-p`'s value and does
  // NOT read piped stdin — input must arrive as the final argv element.
  it("grok: delivers input via argv, not stdin", async () => {
    runnableStubPath({ grok: "#!/bin/sh\nstdin=$(cat)\necho \"argv2:$2\"\necho \"stdinlen:${#stdin}\"\n" });
    const d = projectDir();
    const result = await peerRun(d, "grok", "hello grok");
    expect(result.output).toContain("argv2:hello grok");
    expect(result.output).toContain("stdinlen:0");
  });

  // CRN-76: opencode's `run [message..]` takes the prompt positionally.
  it("opencode: delivers input via argv, not stdin", async () => {
    runnableStubPath({ opencode: "#!/bin/sh\necho \"argv2:$2\"\n" });
    const d = projectDir();
    const result = await peerRun(d, "opencode", "hello oc");
    expect(result.output).toContain("argv2:hello oc");
  });

  // antigravity's headless mode takes the prompt as `-p`'s value (verified
  // against the live agy CLI) and ignores piped stdin — argv-mode, same
  // rules as grok. Checks the full arg string, not a fixed position, so
  // mode-dependent flags (#74's --sandbox) don't shift it out from under us.
  it("antigravity: delivers input via argv to the agy binary, not stdin", async () => {
    runnableStubPath({ agy: "#!/bin/sh\nstdin=$(cat)\necho \"args:$*\"\necho \"stdinlen:${#stdin}\"\n" });
    const d = projectDir();
    const result = await peerRun(d, "antigravity", "hello agy");
    expect(result.output).toContain("-p hello agy");
    expect(result.output).toContain("stdinlen:0");
  });

  // Codex refuses to run outside a trusted directory unless told otherwise
  // ("Not inside a trusted directory and --skip-git-repo-check was not
  // specified", verified against the live CLI) — the flag rides in the
  // template so a run never depends on the host's trust list.
  it("codex: passes --skip-git-repo-check so runs never depend on directory trust", async () => {
    runnableStubPath({ codex: "#!/bin/sh\ncat > /dev/null\necho \"args:$*\"\n" });
    const d = projectDir();
    const result = await peerRun(d, "codex", "hello");
    expect(result.output).toContain("--skip-git-repo-check");
  });

  // #74: a live council run proved a peer CLI with cwd pinned to the
  // project dir can read repo internals its screened packet never carried —
  // one reviewer quoted project-internal research. The leak gate screens
  // the outbound packet only; cwd access read straight around it. Default
  // flips to CONTAINED: the child runs from a fresh scratch dir under the
  // OS tmpdir, with the capped input staged as packet.txt beside it. The
  // #56 determinism survives — cwd is still always the same KIND of place —
  // but the repo exposure dies.
  const PWD_ECHO = "#!/bin/sh\necho \"cwd:$(pwd)\"\n";
  const ARGS_ECHO = "#!/bin/sh\ncat > /dev/null\necho \"args:$*\"\n";
  function reportedCwd(output: string): string {
    return output.trim().replace(/^cwd:/, "");
  }

  it("runs the peer child from a fresh scratch dir by default, never the project dir", async () => {
    runnableStubPath({ grok: PWD_ECHO });
    const d = projectDir();
    const result = await peerRun(d, "grok", "hello");
    const cwd = reportedCwd(result.output);
    expect(cwd).not.toBe(realpathSync(d));
    expect(cwd.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(cwd).toContain("cairn-peer-");
  });

  it("stages the capped input as packet.txt in the scratch cwd", async () => {
    runnableStubPath({ grok: "#!/bin/sh\ncat packet.txt\n" });
    const d = projectDir({ peers: { grok: { maxInputChars: 40 } } });
    const input = "x".repeat(100);
    const result = await peerRun(d, "grok", input);
    const marker = "[cairn: input truncated at 40 chars]";
    expect(result.output).toBe(`${"x".repeat(40)}\n${marker}`);
  });

  it("cleans up the scratch dir after the child exits (best-effort, post-run)", async () => {
    runnableStubPath({ grok: PWD_ECHO });
    const d = projectDir();
    const result = await peerRun(d, "grok", "hello");
    const cwd = reportedCwd(result.output);
    expect(cwd).toContain("cairn-peer-"); // sanity: we really saw the scratch dir
    expect(existsSync(cwd)).toBe(false);
  });

  // cwdMode "project" is the explicit escape hatch — the #56 behavior,
  // granted by the peers verb ONLY to execCapable seats on the
  // functionality dimension (and, since #268, refused by the server for
  // any peer cairn.json doesn't mark execCapable — so every project-mode
  // test below carries the flag). No packet.txt gets staged into the repo.
  it("cwdMode 'project' restores the project-dir cwd and stages no packet.txt", async () => {
    runnableStubPath({ grok: PWD_ECHO });
    const d = projectDir({ peers: { grok: { execCapable: true } } });
    const result = await peerRun(d, "grok", "hello", undefined, { cwdMode: "project" });
    expect(result.output.trim()).toBe(`cwd:${realpathSync(d)}`);
    expect(existsSync(join(d, "packet.txt"))).toBe(false);
  });

  // --skip-git-repo-check is now load-bearing in scratch mode — the
  // scratch dir is no git repo, and codex refuses untrusted non-repo dirs
  // without it (verified live, codex-cli 0.146.0, 2026-08-09).
  it("codex: --skip-git-repo-check rides in both cwd modes", async () => {
    runnableStubPath({ codex: ARGS_ECHO });
    const d = projectDir({ peers: { codex: { execCapable: true } } });
    const scratch = await peerRun(d, "codex", "hello");
    expect(scratch.output).toContain("--skip-git-repo-check");
    const project = await peerRun(d, "codex", "hello", undefined, { cwdMode: "project" });
    expect(project.output).toContain("--skip-git-repo-check");
  });

  // Sandbox flags ride in scratch mode ONLY — project mode is the explicit
  // repo-access grant, so kneecapping it makes no sense. codex's
  // `--sandbox read-only` verified against codex-cli 0.146.0
  // (`codex exec --help`); agy's boolean `--sandbox` verified against
  // agy 1.1.12 (`agy --help`). grok/opencode document no sandbox flag.
  it("codex: adds --sandbox read-only in scratch mode only", async () => {
    runnableStubPath({ codex: ARGS_ECHO });
    const d = projectDir({ peers: { codex: { execCapable: true } } });
    const scratch = await peerRun(d, "codex", "hello");
    expect(scratch.output).toContain("--sandbox read-only");
    const project = await peerRun(d, "codex", "hello", undefined, { cwdMode: "project" });
    expect(project.output).not.toContain("--sandbox");
  });

  it("antigravity: adds --sandbox in scratch mode only", async () => {
    runnableStubPath({ agy: ARGS_ECHO });
    const d = projectDir({ peers: { antigravity: { execCapable: true } } });
    const scratch = await peerRun(d, "antigravity", "hello");
    expect(scratch.output).toContain("--sandbox");
    const project = await peerRun(d, "antigravity", "hello", undefined, { cwdMode: "project" });
    expect(project.output).not.toContain("--sandbox");
  });

  it("grok/opencode: no sandbox flag in either mode — none documented", async () => {
    runnableStubPath({ grok: ARGS_ECHO, opencode: ARGS_ECHO });
    const d = projectDir();
    for (const provider of ["grok", "opencode"] as const) {
      const scratch = await peerRun(d, provider, "hello");
      expect(scratch.output).not.toContain("--sandbox");
    }
  });

  // A staged binary that exists on PATH but isn't executable fails at
  // exec-time with a string errno (EACCES), not a numeric exit code. That's
  // not a genuine peer exit, so it must throw PRECONDITION_FAILED naming
  // the provider — never fall back to an advisory { exitCode: 1 } result.
  it("throws PRECONDITION_FAILED naming the provider on EACCES (non-executable staged binary)", async () => {
    const d = projectDir();
    const stubDir = mkdtempSync(join(tmpdir(), "cairn-stub-noexec-"));
    const p = join(stubDir, "grok");
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o644); // no execute bit
    // Isolated PATH, not a prepend: execvp skips non-executable entries and
    // keeps searching, so a real grok later on PATH (any machine wired for
    // multi-harness work) would get executed and hang the test. /usr/bin:/bin
    // stay so exec resolution behaves normally; neither ever holds grok.
    process.env.PATH = `${stubDir}${delimiter}/usr/bin${delimiter}/bin`;

    let caught: unknown;
    try {
      await peerRun(d, "grok", "hello");
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((caught as Error).message).toMatch(/grok/);
    expect(caught).not.toMatchObject({ exitCode: expect.anything() });
  });
});

// #268: both peer_run rules used to be verb prose — the server took
// cwdMode from the caller without reading execCapable, and the "a hit
// blocks that peer_run call" leak gate was something the agent was told
// to do. The server now enforces both. Every refusal must happen BEFORE a
// child exists, so these stubs drop a marker file when they run and the
// tests assert it never appears.
describe("peerRun — server-enforced rules (#268)", () => {
  // Fixture leaks are concatenated so this file's own diff never trips the
  // commit-time leak guard (same trick as leak-patterns.test.ts).
  const PLANNING_PATH = "see .cairn" + "/plans/roadmap.md for the contract";
  const PHASE_REF = "context lives in phases/" + "03-switchback";
  const LABEL = 'label: "cairn' + ':seed"';
  const TRACKER_ID = "tracked as DRILL" + "-42";

  // A stub that proves whether it ran: it touches a marker file when spawned.
  function markingStub(name: string): string {
    const d = mkdtempSync(join(tmpdir(), "cairn-mark-"));
    const mark = join(d, "ran");
    runnableStubPath({ [name]: `#!/bin/sh\ncat > /dev/null\ntouch '${mark}'\necho ran\n` });
    return mark;
  }

  type Refusal = { code?: string; message: string; nextAction?: string };
  async function refusal(p: Promise<unknown>): Promise<Refusal> {
    try {
      await p;
    } catch (e) {
      return e as Refusal;
    }
    throw new Error("expected peerRun to refuse");
  }

  describe("execCapable gate on cwdMode 'project'", () => {
    it("refuses project mode when cairn.json has no execCapable for the peer — nothing spawns", async () => {
      const mark = markingStub("grok");
      const d = projectDir();
      const err = await refusal(peerRun(d, "grok", "hello", undefined, { cwdMode: "project" }));
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(err.message).toContain("grok");
      expect(err.message).toContain("execCapable");
      expect(err.nextAction).toContain("peers.grok.execCapable");
      expect(existsSync(mark)).toBe(false);
    });

    it("refuses project mode on an explicit execCapable: false", async () => {
      const mark = markingStub("codex");
      const d = projectDir({ peers: { codex: { execCapable: false } } });
      const err = await refusal(peerRun(d, "codex", "hello", undefined, { cwdMode: "project" }));
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(existsSync(mark)).toBe(false);
    });

    it("trust is per peer — codex's flag does not open project mode for grok", async () => {
      const mark = markingStub("grok");
      const d = projectDir({ peers: { codex: { execCapable: true } } });
      const err = await refusal(peerRun(d, "grok", "hello", undefined, { cwdMode: "project" }));
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(existsSync(mark)).toBe(false);
    });

    it("allows project mode for a peer marked execCapable: true", async () => {
      const mark = markingStub("grok");
      const d = projectDir({ peers: { grok: { execCapable: true } } });
      const result = await peerRun(d, "grok", "hello", undefined, { cwdMode: "project" });
      expect(result.exitCode).toBe(0);
      expect(existsSync(mark)).toBe(true);
    });

    it("scratch mode (default and explicit) needs no trust flag", async () => {
      const mark = markingStub("grok");
      const d = projectDir();
      expect((await peerRun(d, "grok", "hello")).exitCode).toBe(0);
      expect((await peerRun(d, "grok", "hello", undefined, { cwdMode: "scratch" })).exitCode).toBe(0);
      expect(existsSync(mark)).toBe(true);
    });

    it("a disabled peer still reports disabled first, even in project mode", async () => {
      markingStub("grok");
      const d = projectDir({ peers: { grok: { enabled: false } } });
      const err = await refusal(peerRun(d, "grok", "hello", undefined, { cwdMode: "project" }));
      expect(err.message).toContain("disabled");
    });
  });

  describe("outbound leak scan", () => {
    it("refuses a planning-path leak before anything spawns, naming kind + line, never the text", async () => {
      const mark = markingStub("codex");
      const d = projectDir();
      const input = ["review this diff:", `+ // ${PLANNING_PATH}`, "+ fetch(url)"].join("\n");
      const err = await refusal(peerRun(d, "codex", input));
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(err.message).toContain("codex");
      expect(err.message).toContain("cairn-path");
      expect(err.message).toContain("line(s) 2");
      expect(err.message).toContain("nothing was sent");
      // never echo the leak back — the refusal can land in a tracker comment
      expect(err.message).not.toContain("roadmap");
      expect(err.message).not.toContain(".cairn");
      expect(err.nextAction).toBe("redact and retry, or skip this peer");
      expect(existsSync(mark)).toBe(false);
    });

    it("catches every built-in kind, listing kinds once and sorted", async () => {
      markingStub("grok");
      const d = projectDir({
        tracker: { type: "jira", config: { projectKey: "DRILL" } },
      });
      const input = [PLANNING_PATH, PHASE_REF, LABEL, TRACKER_ID, PLANNING_PATH].join("\n");
      const err = await refusal(peerRun(d, "grok", input));
      expect(err.message).toContain("(cairn-label, cairn-path, phase-ref, tracker-id)");
      expect(err.message).toContain("line(s) 1, 2, 3, 4, 5");
    });

    it("honours leakGuard.extraPatterns, and an invalid one never crashes the scan", async () => {
      const mark = markingStub("opencode");
      const d = projectDir({ leakGuard: { extraPatterns: ["([", "AKIA[0-9A-Z]{16}"] } });
      const err = await refusal(peerRun(d, "opencode", "const key = 'AKIA" + "IOSFODNN7EXAMPLE'"));
      expect(err.message).toContain("(extra)");
      expect(err.message).not.toContain("IOSFODNN7EXAMPLE");
      expect(existsSync(mark)).toBe(false);
    });

    it("leakGuard.enabled: false turns the scan off — the user's switch, same as the commit guard", async () => {
      const mark = markingStub("codex");
      const d = projectDir({ leakGuard: { enabled: false } });
      const result = await peerRun(d, "codex", PLANNING_PATH);
      expect(result.exitCode).toBe(0);
      expect(existsSync(mark)).toBe(true);
    });

    it("clean input passes and runs", async () => {
      const mark = markingStub("codex");
      const d = projectDir();
      const result = await peerRun(d, "codex", "export handler falls through to res.ok on disk full");
      expect(result.exitCode).toBe(0);
      expect(existsSync(mark)).toBe(true);
    });

    // The scan covers the exact bytes sent — after capInput. A leak past
    // the cap never leaves the machine, so it can't block the send; a
    // leak inside the cap always does.
    it("scans the capped input: a leak past the cap is not sent and does not refuse", async () => {
      runnableStubPath({ codex: STDIN_LENGTH });
      const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
      const input = `${"x".repeat(40)}\n${PLANNING_PATH}`;
      const result = await peerRun(d, "codex", input);
      expect(result.truncatedInput).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("scans the capped input: a leak inside the cap refuses", async () => {
      const mark = markingStub("codex");
      const d = projectDir({ peers: { codex: { maxInputChars: 40 } } });
      const err = await refusal(peerRun(d, "codex", `${PLANNING_PATH}\n${"x".repeat(100)}`));
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(existsSync(mark)).toBe(false);
    });

    it("applies in project mode too — trust to read the repo is not a pass to send leaks", async () => {
      const mark = markingStub("grok");
      const d = projectDir({ peers: { grok: { execCapable: true } } });
      const err = await refusal(peerRun(d, "grok", LABEL, undefined, { cwdMode: "project" }));
      expect(err.message).toContain("cairn-label");
      expect(existsSync(mark)).toBe(false);
    });

    it("summarizes past ten hit lines instead of listing hundreds", async () => {
      markingStub("codex");
      const d = projectDir();
      const input = Array.from({ length: 25 }, () => PLANNING_PATH).join("\n");
      const err = await refusal(peerRun(d, "codex", input));
      expect(err.message).toContain("line(s) 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (+15 more)");
    });
  });
});


// #340: a peer child never inherits a tracker credential. grok and opencode
// carry shell tools and no sandbox, and Copilot prefers GH_TOKEN/GITHUB_TOKEN
// over its own stored login -- so the server's env, which legitimately holds
// the tracker token, is NOT the child's env. The stub prints the variables
// by name so the assertion is on what the child actually saw.
describe("peerRun — child environment drops tracker credentials (#340)", () => {
  const ENV_ECHO = "#!/bin/sh\ncat > /dev/null\n"
    + "echo \"GITHUB_TOKEN=${GITHUB_TOKEN-unset}\"\n"
    + "echo \"GH_TOKEN=${GH_TOKEN-unset}\"\n"
    + "echo \"JIRA_API_TOKEN=${JIRA_API_TOKEN-unset}\"\n"
    + "echo \"COPILOT_GITHUB_TOKEN=${COPILOT_GITHUB_TOKEN-unset}\"\n"
    + "echo \"CAIRN_TEST_KEEP=${CAIRN_TEST_KEEP-unset}\"\n";
  const BIN: Record<string, string> = { codex: "codex", opencode: "opencode", antigravity: "agy", grok: "grok", copilot: "copilot" };
  const SET = ["GITHUB_TOKEN", "GH_TOKEN", "JIRA_API_TOKEN", "COPILOT_GITHUB_TOKEN", "CAIRN_TEST_KEEP"];
  const saved: Record<string, string | undefined> = {};

  function plantCredentials(): void {
    for (const k of SET) {
      saved[k] = process.env[k];
      process.env[k] = `secret-${k.toLowerCase()}`;
    }
  }
  afterEach(() => {
    for (const k of SET) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  for (const provider of PROVIDERS) {
    it(`${provider}: every drop-list token is absent in the child; unrelated vars and the seat's own credential survive`, async () => {
      plantCredentials();
      runnableStubPath({ [BIN[provider]]: ENV_ECHO });
      const d = projectDir();
      const result = await peerRun(d, provider, "hello");
      expect(result.output).toContain("GITHUB_TOKEN=unset");
      expect(result.output).toContain("GH_TOKEN=unset");
      expect(result.output).toContain("JIRA_API_TOKEN=unset");
      // Copilot's own credential is the seat's, not cairn's -- kept.
      expect(result.output).toContain("COPILOT_GITHUB_TOKEN=secret-copilot_github_token");
      expect(result.output).toContain("CAIRN_TEST_KEEP=secret-cairn_test_keep");
    });
  }

  it("a custom tokenEnv named in cairn.json is dropped too, not only the defaults", async () => {
    const custom = "MY_RENAMED_JIRA_SECRET";
    process.env[custom] = "shh";
    saved[custom] = undefined; SET.push(custom);
    runnableStubPath({ grok: "#!/bin/sh\ncat > /dev/null\necho \"CUSTOM=${MY_RENAMED_JIRA_SECRET-unset}\"\n" });
    const d = projectDir({ tracker: { type: "jira", config: {
      baseUrl: "https://x.atlassian.net", projectKey: "X", tokenEnv: custom } } });
    const result = await peerRun(d, "grok", "hello");
    expect(result.output).toContain("CUSTOM=unset");
  });

  it("peerChildEnv is pure: fresh object, base untouched, docs connector token dropped as well", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/bin", GITHUB_TOKEN: "t", CONFLUENCE_API_TOKEN: "c", KEEP_ME: "k",
    };
    const env = peerChildEnv(
      { tracker: { config: { repo: "o/r" } }, docs: { config: { tokenEnv: "CONFLUENCE_API_TOKEN" } } },
      "codex", base);
    expect(env).toEqual({ PATH: "/bin", KEEP_ME: "k" });
    expect(base.GITHUB_TOKEN).toBe("t"); // not mutated
    for (const k of PEER_ENV_DROP) expect(k in env).toBe(false);
  });
});


// #339 end to end: the Copilot-shaped failure -- exit 1, stderr only -- is
// the symptom (parses to empty piles, indistinguishable from a clean seat)
// and the fix (recorded with its exit code, status names it incomplete).
describe("peerRun → state: a seat that dies with only stderr is incomplete, never clean (#339)", () => {
  it("exit 1 + stderr-only parses to empty piles, and records as a failed seat with the stderr tail", async () => {
    runnableStubPath({ grok: "#!/bin/sh\ncat > /dev/null\necho 'error: not logged in -- run grok login' 1>&2\nexit 1\n" });
    const d = projectDir();
    const result = await peerRun(d, "grok", "hello");
    expect(result.exitCode).toBe(1);
    // The symptom: nothing in either pile -- exactly what a clean seat looks like.
    expect(parseFindings(result.output)).toEqual({ findings: [], unparsed: [] });
    // The fix: the exit code rides into the run state and the seat is named.
    runStart(d, "run", { mode: "review", target: "t", peers: ["grok"] });
    recordPeerOutput(d, "run", "grok", 1, result.output, result.exitCode);
    const status = runStatus(d, "run");
    expect(status.resumable.incompleteSeats).toHaveLength(1);
    expect(status.resumable.incompleteSeats[0]).toMatchObject({ peer: "grok", kind: "failed", exitCode: 1 });
    expect(status.resumable.incompleteSeats[0].reason).toContain("not logged in");
    expect(status.resumable.complete).toBe(false);
  });
});


// #338: GitHub Copilot CLI as the fifth seat. Containment is a flag SET,
// so the test pins each flag by name; the model is the one dynamic argv
// element besides the input, and it comes from cairn.json or the template,
// never from the call.
describe("copilot seat (#338)", () => {
  const ARGS_ECHO = "#!/bin/sh\ncat > /dev/null\necho \"args:$*\"\n";
  const ALWAYS = ["-s", "--no-ask-user", "--no-auto-update", "--no-color", "--no-custom-instructions",
    "--disable-builtin-mcps", "--disable-mcp-server cairn", "--max-ai-credits 30"];
  const SCRATCH = ["--available-tools=view", "--allow-tool=view", "--disallow-temp-dir"];
  const FORBIDDEN = ["--yolo", "--allow-all", "--share-gist", "--remote"];
  const argsLine = (out: string): string => out.split("\n").find((l) => l.startsWith("args:")) ?? "";

  it("scratch run: every always-flag, the pinned model, every scratch flag, no forbidden flag, and -p <input> last", async () => {
    runnableStubPath({ copilot: ARGS_ECHO });
    const d = projectDir();
    const line = argsLine((await peerRun(d, "copilot", "hello copilot")).output);
    for (const f of ALWAYS) expect(line, f).toContain(f);
    expect(line).toContain("--model gpt-6.1-sol");
    for (const f of SCRATCH) expect(line, f).toContain(f);
    for (const f of FORBIDDEN) expect(line, f).not.toContain(f);
    expect(line.endsWith(" -p hello copilot")).toBe(true);
    expect(line.indexOf("--disallow-temp-dir")).toBeLessThan(line.indexOf(" -p "));
  });

  it("--disallow-temp-dir and --disable-mcp-server cairn each ride a scratch run on their own", async () => {
    runnableStubPath({ copilot: ARGS_ECHO });
    const line = argsLine((await peerRun(projectDir(), "copilot", "x")).output);
    expect(line.split(" ")).toContain("--disallow-temp-dir");
    expect(line).toMatch(/--disable-mcp-server cairn( |$)/);
  });

  it("project mode drops the scratch flags and keeps every always-flag", async () => {
    runnableStubPath({ copilot: ARGS_ECHO });
    const d = projectDir({ peers: { copilot: { execCapable: true } } });
    const line = argsLine((await peerRun(d, "copilot", "x", undefined, { cwdMode: "project" })).output);
    for (const f of SCRATCH) expect(line, f).not.toContain(f);
    for (const f of ALWAYS) expect(line, f).toContain(f);
  });

  it("peers.copilot.model in cairn.json overrides the pinned default, in argv and in peerList", async () => {
    runnableStubPath({ copilot: ARGS_ECHO });
    const d = projectDir({ peers: { copilot: { model: "gpt-5.4" } } });
    const line = argsLine((await peerRun(d, "copilot", "x")).output);
    expect(line).toContain("--model gpt-5.4");
    expect(line).not.toContain("gpt-6.1-sol");
    expect(peerList(d).peers.find((p) => p.provider === "copilot")?.model).toBe("gpt-5.4");
    expect(peerList(projectDir()).peers.find((p) => p.provider === "copilot")?.model).toBe("gpt-6.1-sol");
    expect(peerList(d).peers.find((p) => p.provider === "grok")?.model).toBeUndefined();
    expect(peerModel({ peers: {} }, "copilot")).toBe("gpt-6.1-sol");
  });

  it("a claude-* model pin is refused at config load -- the adjudicator's own family", async () => {
    runnableStubPath({ copilot: ARGS_ECHO });
    const d = projectDir({ peers: { copilot: { model: "claude-sonnet-5.5" } } });
    await expect(peerRun(d, "copilot", "x")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(peerRun(d, "copilot", "x")).rejects.toThrow(/Claude model/);
  });

  it("drops COPILOT_ALLOW_ALL and COPILOT_CUSTOM_INSTRUCTIONS_DIRS from the child, keeps COPILOT_GITHUB_TOKEN", async () => {
    const SET = ["COPILOT_ALLOW_ALL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "COPILOT_GITHUB_TOKEN"];
    const saved: Record<string, string | undefined> = {};
    for (const k of SET) { saved[k] = process.env[k]; process.env[k] = `v-${k}`; }
    try {
      runnableStubPath({ copilot: "#!/bin/sh\ncat > /dev/null\n"
        + "echo \"ALLOW=${COPILOT_ALLOW_ALL-unset}\"\necho \"DIRS=${COPILOT_CUSTOM_INSTRUCTIONS_DIRS-unset}\"\n"
        + "echo \"TOKEN=${COPILOT_GITHUB_TOKEN-unset}\"\n" });
      const out = (await peerRun(projectDir(), "copilot", "x")).output;
      expect(out).toContain("ALLOW=unset");
      expect(out).toContain("DIRS=unset");
      expect(out).toContain("TOKEN=v-COPILOT_GITHUB_TOKEN");
    } finally {
      for (const k of SET) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  it("one fenced finding parses from -s text output; the stderr warning is stripped", async () => {
    runnableStubPath({ copilot: "#!/bin/sh\ncat > /dev/null\n"
      + "echo 'warning: auto-update disabled' 1>&2\n"
      + "echo 'Findings:'\necho '```json'\n"
      + "echo '{\"claim\": \"retry loop has no cap\", \"evidence\": \"src/x.ts:12\", \"severity\": \"important\", \"recommendation\": \"cap at 3\"}'\n"
      + "echo '```'\n" });
    const result = await peerRun(projectDir(), "copilot", "x");
    expect(result.exitCode).toBe(0);
    const parsed = parseFindings(result.output);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].claim).toBe("retry loop has no cap");
    expect(parsed.unparsed).toEqual([]);
  });

  it("exit 1 + stderr only (model not on plan, not logged in, credit cap) records as an incomplete seat (#339)", async () => {
    runnableStubPath({ copilot: "#!/bin/sh\ncat > /dev/null\necho 'Error: Model \"gpt-6.1-sol\" from --model flag is not available.' 1>&2\nexit 1\n" });
    const d = projectDir();
    const result = await peerRun(d, "copilot", "x");
    expect(result.exitCode).toBe(1);
    expect(parseFindings(result.output)).toEqual({ findings: [], unparsed: [] });
    runStart(d, "run", { mode: "review", target: "t", peers: ["copilot"] });
    recordPeerOutput(d, "run", "copilot", 1, result.output, result.exitCode);
    const seat = runStatus(d, "run").resumable.incompleteSeats[0];
    expect(seat).toMatchObject({ peer: "copilot", kind: "failed", exitCode: 1 });
    expect(seat.reason).toContain("not available");
  });
});


// #341: convergence counts labs, not seats. The lab is a template fact for
// fixed-model CLIs and a function of the pinned model for copilot; an
// unpinned seat is `unknown`, which never completes a cluster.
describe("labs, not seats (#341)", () => {
  it("fixed-lab seats report their lab; opencode is unknown", () => {
    const labs = Object.fromEntries(peerList(projectDir()).peers.map((p) => [p.provider, p.lab]));
    expect(labs).toEqual({ codex: "openai", grok: "xai", antigravity: "google", opencode: "unknown", copilot: "openai" });
  });

  it("copilot's lab follows its pinned model: gpt → openai, gemini → google", () => {
    expect(peerLab({ peers: {} }, "copilot")).toBe("openai");
    expect(peerLab({ peers: { copilot: { model: "gemini-3.8-flash" } } }, "copilot")).toBe("google");
    expect(peerLab({ peers: { copilot: { model: "gpt-5.4" } } }, "copilot")).toBe("openai");
    expect(peerList(projectDir({ peers: { copilot: { model: "gemini-3.8-flash" } } }))
      .peers.find((p) => p.provider === "copilot")?.lab).toBe("google");
  });

  it("labOfModel places the families and never guesses", () => {
    expect(labOfModel("gpt-6.1-sol")).toBe("openai");
    expect(labOfModel("o4-mini")).toBe("openai");
    expect(labOfModel("codex-mini")).toBe("openai");
    expect(labOfModel("gemini-3.7-flash")).toBe("google");
    expect(labOfModel("claude-sonnet-5.5")).toBe("anthropic");
    expect(labOfModel("grok-4")).toBe("xai");
    expect(labOfModel("mystery-9")).toBe("unknown");
  });

  it("codex + gpt-pinned copilot + grok = 2 labs, not 3; + antigravity = 3", () => {
    const cfg = { peers: {} };
    const two = new Set(["codex", "copilot", "grok"].map((p) => peerLab(cfg, p as "codex")));
    expect(two.size).toBe(2);
    const three = new Set(["codex", "copilot", "grok", "antigravity"].map((p) => peerLab(cfg, p as "codex")));
    expect(three.size).toBe(3);
  });
});
