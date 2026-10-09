// cairn-setup installer (CRN-71): additive, idempotent wiring of cairn into
// non-Claude harness configs. Runs the real script against temp project dirs
// with a fake HOME so no real harness config is touched.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "setup", "cairn-setup.mjs");

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(harness: string, project: string, home: string, ...extra: string[]): string {
  return execFileSync(process.execPath, [SETUP, harness, "--project", project, ...extra], {
    // CAIRN_SETUP_OFFLINE keeps --check's advisory npm lookup out of unit
    // tests (it fails soft to "unknown" anyway; this skips the wait).
    encoding: "utf8", env: { ...process.env, HOME: home, CAIRN_SETUP_OFFLINE: "1" },
  });
}

/** Runs `--check` expecting a non-zero exit; returns its stdout for asserting. */
function runCheckFail(harness: string, project: string, home: string): string {
  try {
    run(harness, project, home, "--check");
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
  throw new Error("expected --check to exit non-zero");
}

const ROOT_VERSION: string = JSON.parse(readFileSync(
  join(dirname(SETUP), "..", "package.json"), "utf8")).version;

describe("cairn-setup", () => {
  it("grok: merges .mcp.json, installs AGENTS fragment + verb subroutines", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("grok", proj, home);

    // Default is the PORTABLE form — these configs get committed and shared;
    // an absolute clone path breaks for every other machine (CRN-75).
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn.command).toBe("npx");
    expect(mcp.mcpServers.cairn.args).toContain("@eventually-consistent/cairn-server");

    const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
    expect(agents).toContain("cairn:begin");
    expect(agents).toContain("| status | One view");

    expect(existsSync(join(proj, ".cairn", "harness", "verbs", "status.md"))).toBe(true);
    expect(existsSync(join(proj, ".cairn", "harness", "SKILL.md"))).toBe(true);
  });

  it("--local opts into this clone's built server (cairn development only)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("grok", proj, home, "--local");
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn.command).toBe("node");
    expect(mcp.mcpServers.cairn.args[0]).toContain("dist/index.js");
  });

  it("never clobbers existing config or unrelated AGENTS content; idempotent re-run", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, custom: 1 }));
    writeFileSync(join(proj, "AGENTS.md"), "# My project\n\nHouse rules here.\n");

    run("grok", proj, home);
    const first = {
      mcp: readFileSync(join(proj, ".mcp.json"), "utf8"),
      agents: readFileSync(join(proj, "AGENTS.md"), "utf8"),
    };
    const mcp = JSON.parse(first.mcp);
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.custom).toBe(1);
    expect(mcp.mcpServers.cairn).toBeTruthy();
    expect(first.agents).toContain("House rules here.");
    expect(first.agents).toContain("cairn:begin");

    run("grok", proj, home); // idempotent
    expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(first.mcp);
    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toBe(first.agents);
  });

  it("copilot: wires ~/.copilot/mcp-config.json, instructions, and prompt files", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(join(home, ".copilot", "mcp-config.json"),
      JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));

    run("copilot", proj, home);

    const cfg = JSON.parse(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8"));
    expect(cfg.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(cfg.mcpServers.cairn).toBeTruthy();
    expect(readFileSync(join(proj, ".github", "copilot-instructions.md"), "utf8"))
      .toContain("cairn:begin");
    for (const v of ["plan", "work", "status", "verify", "ship"]) {
      expect(existsSync(join(proj, ".github", "prompts", `cairn-${v}.prompt.md`))).toBe(true);
    }
  });

  it("codex: installs ~/.codex/prompts + merges config.toml between markers", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"),
      `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n`);

    run("codex", proj, home);

    for (const v of ["plan", "work", "status", "verify", "ship"]) {
      expect(existsSync(join(home, ".codex", "prompts", `cairn-${v}.md`))).toBe(true);
    }
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain(`model = "gpt-5"`);
    expect(toml).toContain("[mcp_servers.other]");
    expect(toml).toContain("# cairn:begin");
    expect(toml).toContain("[mcp_servers.cairn]");
    expect(toml).toContain("# cairn:end");

    run("codex", proj, home); // idempotent
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(toml);
  });

  it("codex: an existing cairn block outside the markers is left untouched", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const before = `[mcp_servers.cairn]\ncommand = "custom"\n`;
    writeFileSync(join(home, ".codex", "config.toml"), before);
    const out = run("codex", proj, home);
    expect(out).toContain("left untouched");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before);
  });

  it("gemini: merges settings.json, installs GEMINI.md + namespaced TOML commands", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));

    run("gemini", proj, home);

    const cfg = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.cairn).toBeTruthy();
    expect(readFileSync(join(proj, "GEMINI.md"), "utf8")).toContain("cairn:begin");
    for (const v of ["plan", "work", "status", "verify", "ship"]) {
      const p = join(proj, ".gemini", "commands", "cairn", `${v}.toml`);
      expect(existsSync(p)).toBe(true);
      const body = readFileSync(p, "utf8");
      expect(body).toContain("description =");
      expect(body).toContain("{{args}}");
    }
  });

  it("cursor: wires .cursor/mcp.json + hooks.json + adapter and hook scripts", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("cursor", proj, home);

    const mcp = JSON.parse(readFileSync(join(proj, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn).toBeTruthy();

    const hooks = JSON.parse(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.version).toBe(1);
    for (const ev of ["sessionStart", "preToolUse", "beforeShellExecution", "afterShellExecution", "afterFileEdit", "preCompact"]) {
      expect(JSON.stringify(hooks.hooks[ev])).toContain("cursor-adapter.mjs");
    }
    expect(hooks.hooks.stop).toBeUndefined(); // cost tracker is Claude-only

    expect(existsSync(join(proj, ".cursor", "hooks", "cairn", "cursor-adapter.mjs"))).toBe(true);
    expect(existsSync(join(proj, ".cursor", "hooks", "cairn", "pretooluse-leakguard.mjs"))).toBe(true);
    expect(existsSync(join(proj, ".cursor", "hooks", "cairn", "lib.mjs"))).toBe(true);

    const first = readFileSync(join(proj, ".cursor", "hooks.json"), "utf8");
    run("cursor", proj, home); // idempotent
    expect(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8")).toBe(first);
  });

  // #269: Cursor's blocking preToolUse runs the run guard and the harness
  // guard, set to fail closed, with every script they load installed beside
  // the adapter -- and the installed copy actually refuses.
  it("cursor: wires preToolUse, fail-closed, to the run guard and harness guard", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    execFileSync("git", ["init", "-q"], { cwd: proj });
    run("cursor", proj, home);

    const hooks = JSON.parse(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.preToolUse).toHaveLength(1);
    expect(hooks.hooks.preToolUse[0].command).toContain("cursor-adapter.mjs");
    expect(hooks.hooks.preToolUse[0].failClosed).toBe(true);
    for (const f of ["pretooluse-runguard.mjs", "pretooluse-harnessguard.mjs", "shell-words.mjs"]) {
      expect(existsSync(join(proj, ".cursor", "hooks", "cairn", f)), f).toBe(true);
    }

    const adapter = join(proj, ".cursor", "hooks", "cairn", "cursor-adapter.mjs");
    const pre = (tool: string, input: Record<string, unknown>) => JSON.parse(execFileSync(process.execPath, [adapter], {
      cwd: proj,
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "preToolUse", tool_name: tool, tool_input: input, cwd: proj, workspace_roots: [proj],
      }),
      env: { ...process.env, HOME: home },
    }));
    expect(pre("Write", { file_path: join(proj, ".cursor", "hooks.json") }).permission).toBe("deny");
    expect(pre("Write", { file_path: adapter }).permission).toBe("deny");
    expect(pre("Shell", { command: "git push --force origin main", working_directory: proj }).permission)
      .toBe("deny");
    expect(pre("Shell", { command: "rm -rf .cursor/hooks", working_directory: proj }).permission).toBe("deny");
    expect(pre("Write", { file_path: join(proj, "src", "a.ts") })).toEqual({ permission: "allow" });
    expect(pre("Shell", { command: "ls -la", working_directory: proj })).toEqual({ permission: "allow" });
  });

  it("cursor: merges into an existing hooks.json without clobbering foreign entries", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(proj, ".cursor"), { recursive: true });
    writeFileSync(join(proj, ".cursor", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: { beforeShellExecution: [{ command: "./my-audit.sh" }] },
    }));
    run("cursor", proj, home);
    const hooks = JSON.parse(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks.hooks.beforeShellExecution)).toContain("my-audit.sh");
    expect(JSON.stringify(hooks.hooks.beforeShellExecution)).toContain("cursor-adapter.mjs");
    expect(JSON.stringify(hooks.hooks.sessionStart)).toContain("cursor-adapter.mjs");
  });

  it("opencode: merges opencode.json mcp block + installs command files", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, "opencode.json"),
      JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } }, theme: "dark" }));

    run("opencode", proj, home);

    const cfg = JSON.parse(readFileSync(join(proj, "opencode.json"), "utf8"));
    expect(cfg.mcp.other).toEqual({ type: "local", command: ["x"] });
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcp.cairn.type).toBe("local");
    expect(cfg.mcp.cairn.command[0]).toBe("npx");
    for (const v of ["plan", "work", "status", "verify", "ship"]) {
      const p = join(proj, ".opencode", "commands", `cairn-${v}.md`);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf8")).toContain("$ARGUMENTS");
    }

    const first = readFileSync(join(proj, "opencode.json"), "utf8");
    run("opencode", proj, home); // idempotent
    expect(readFileSync(join(proj, "opencode.json"), "utf8")).toBe(first);
  });

  it("zed: merges context_servers into .zed/settings.json", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    mkdirSync(join(proj, ".zed"), { recursive: true });
    writeFileSync(join(proj, ".zed", "settings.json"),
      JSON.stringify({ context_servers: { other: { command: "x", args: [] } }, tab_size: 2 }));

    run("zed", proj, home);

    const cfg = JSON.parse(readFileSync(join(proj, ".zed", "settings.json"), "utf8"));
    expect(cfg.context_servers.other).toEqual({ command: "x", args: [] });
    expect(cfg.tab_size).toBe(2);
    expect(cfg.context_servers.cairn.command).toBe("npx");

    const first = readFileSync(join(proj, ".zed", "settings.json"), "utf8");
    run("zed", proj, home); // idempotent
    expect(readFileSync(join(proj, ".zed", "settings.json"), "utf8")).toBe(first);
  });

  it("refuses to touch an existing config that doesn't parse (never wipes user MCP servers)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    const corrupt = `{ "mcpServers": { /* jsonc comment */ "other": { "command": "x" } } }`;
    writeFileSync(join(proj, ".mcp.json"), corrupt);
    expect(() => run("grok", proj, home)).toThrow();
    expect(readFileSync(join(proj, ".mcp.json"), "utf8")).toBe(corrupt);
  });

  it("refuses an orphaned cairn:begin marker instead of appending a duplicate fragment", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    const truncated = "# My project\n\n<!-- cairn:begin\ntruncated, no end marker\n";
    writeFileSync(join(proj, "AGENTS.md"), truncated);
    expect(() => run("grok", proj, home)).toThrow();
    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toBe(truncated);
  });

  it("--project without a directory prints usage instead of crashing", () => {
    let err = "";
    try {
      execFileSync(process.execPath, [SETUP, "grok", "--project"], { encoding: "utf8" });
    } catch (e) {
      err = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(err).toContain("--project needs a directory");
    expect(err).not.toContain("TypeError");
  });

  it("stamps every copied surface with a version manifest at install time (#82)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("copilot", proj, home);

    for (const dir of [join(proj, ".cairn", "harness"), join(proj, ".github", "prompts")]) {
      const m = JSON.parse(readFileSync(join(dir, ".cairn-manifest.json"), "utf8"));
      expect(m.version).toBe(ROOT_VERSION);
      expect(m.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(m.installedBy).toBe("cairn-setup");
    }
  });

  it("--check exits 0 and reports every surface current after a fresh install (#82)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("copilot", proj, home);
    const out = run("copilot", proj, home, "--check");
    expect(out).toContain(`.cairn/harness (verb subroutines): v${ROOT_VERSION} (current`);
    expect(out).toContain(`.github/prompts (copilot prompts): v${ROOT_VERSION} (current`);
    expect(out).toContain("all installed surfaces current.");
  });

  it("--check exits non-zero on a lagging stamp, prints installed-vs-available, writes nothing (#82)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("grok", proj, home);
    const manifestPath = join(proj, ".cairn", "harness", ".cairn-manifest.json");
    const stale = JSON.parse(readFileSync(manifestPath, "utf8"));
    stale.version = "2.0.0";
    writeFileSync(manifestPath, JSON.stringify(stale, null, 2) + "\n");

    const out = runCheckFail("grok", proj, home);
    expect(out).toContain(`installed v2.0.0, available v${ROOT_VERSION}`);
    expect(out).toContain("surface(s) lag");
    // --check is read-only: the lagging stamp is reported, never repaired.
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).version).toBe("2.0.0");
  });

  it("--check flags an unstamped install as predating stamping (#82)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("grok", proj, home);
    rmSync(join(proj, ".cairn", "harness", ".cairn-manifest.json"));
    const out = runCheckFail("grok", proj, home);
    expect(out).toContain("no stamp — predates stamping, reinstall to adopt");
    // Still read-only: no stamp materializes from a check.
    expect(existsSync(join(proj, ".cairn", "harness", ".cairn-manifest.json"))).toBe(false);
  });

  it("--check on a project with nothing installed reports 'not installed' and exits 0 (#82)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    const out = run("grok", proj, home, "--check");
    expect(out).toContain(".cairn/harness (verb subroutines): not installed");
    // Read-only by construction — an empty project stays empty.
    expect(existsSync(join(proj, ".cairn"))).toBe(false);
    expect(existsSync(join(proj, "AGENTS.md"))).toBe(false);
  });

  it("an existing different cairn MCP entry is left untouched", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, ".mcp.json"),
      JSON.stringify({ mcpServers: { cairn: { command: "custom", args: ["mine.js"] } } }));
    const out = run("grok", proj, home);
    expect(out).toContain("left untouched");
    const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.cairn.command).toBe("custom");
  });
});
