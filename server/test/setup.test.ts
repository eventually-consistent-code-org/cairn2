// cairn-setup installer (CRN-71): additive, idempotent wiring of cairn into
// non-Claude harness configs. Runs the real script against temp project dirs
// with a fake HOME so no real harness config is touched.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectKey } from "../src/planning/run-manifest.js";

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

type Attempt = { status: number | null; stdout: string; stderr: string; out: string };

/** Setup through spawnSync, so a refusal's exit and both streams can be read:
 *  `project` passes --project, `cwd` runs bare from that folder (the nested-cwd
 *  variant), `env` adds to the fake home's environment. */
function attempt(harness: string, home: string, at: { project?: string; cwd?: string; env?: Record<string, string> }, ...extra: string[]): Attempt {
  const flags = at.project ? ["--project", at.project] : [];
  const r = spawnSync(process.execPath, [SETUP, harness, ...flags, ...extra], {
    cwd: at.cwd, encoding: "utf8", env: { ...process.env, HOME: home, CAIRN_SETUP_OFFLINE: "1", ...at.env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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

  it("claude: CLAUDE.md as a symlink to AGENTS.md keeps the spine; re-run is byte-identical (#429)", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, "AGENTS.md"), "# My project\n\nHouse rules here.\n");
    symlinkSync("AGENTS.md", join(proj, "CLAUDE.md"));

    run("claude", proj, home);
    const agents = readFileSync(join(proj, "AGENTS.md"), "utf8");
    expect(agents).toContain("House rules here.");
    expect(agents).toContain("cairn:begin — generated by scripts/gen-agents.mjs");
    expect(agents).not.toContain("@AGENTS.md");

    const again = run("claude", proj, home); // idempotent
    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toBe(agents);
    expect(again).toContain("cairn section already current");
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
    for (const ev of ["sessionStart", "preToolUse", "beforeShellExecution", "afterShellExecution", "afterFileEdit"]) {
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

// #473: #429 gated the import refusal on CLAUDE.md itself being the symlink.
// With the link the other way (AGENTS.md -> CLAUDE.md), or the two names one
// hard-linked inode, setup wrote the spine through the AGENTS.md name, then
// opened a regular-looking CLAUDE.md, found the spine's own markers and
// replaced 180-odd lines of installed rules with the three-line import block
// -- and printed the success line. Every layout below reads the same one
// line, writes no import, keeps the spine, and is byte-identical on re-run.
describe("one file by two names, every way round (#473)", () => {
  const FRAGMENT = readFileSync(join(dirname(SETUP), "..", "harness", "AGENTS-cairn.md"), "utf8");
  const OWNER = "# My project\n\nHouse rules here.\n";
  const claudeLines = (out: string) => out.split("\n").filter((l) => l.includes("CLAUDE.md"));

  // Each layout writes the owner's text under one name and links the other
  // name to it. The ../ climb is the hostile spelling: a relative link that
  // leaves the project and comes straight back, which a prefix check on the
  // link text would misread as outside.
  const layouts: Record<string, (proj: string) => void> = {
    "AGENTS.md is a symlink to CLAUDE.md": (proj) => {
      writeFileSync(join(proj, "CLAUDE.md"), OWNER);
      symlinkSync("CLAUDE.md", join(proj, "AGENTS.md"));
    },
    "AGENTS.md reaches CLAUDE.md through a ../ climb": (proj) => {
      writeFileSync(join(proj, "CLAUDE.md"), OWNER);
      symlinkSync(join("..", basename(proj), "CLAUDE.md"), join(proj, "AGENTS.md"));
    },
    "the two names are one hard link": (proj) => {
      writeFileSync(join(proj, "CLAUDE.md"), OWNER);
      linkSync(join(proj, "CLAUDE.md"), join(proj, "AGENTS.md"));
    },
    "CLAUDE.md is a symlink to AGENTS.md (the #429 control)": (proj) => {
      writeFileSync(join(proj, "AGENTS.md"), OWNER);
      symlinkSync("AGENTS.md", join(proj, "CLAUDE.md"));
    },
  };

  for (const [name, lay] of Object.entries(layouts)) {
    it(`${name}: setup for claude keeps the spine, writes no import, re-runs byte-identical`, () => {
      const proj = fresh("cairn-setup-");
      const home = fresh("cairn-home-");
      lay(proj);

      const first = run("claude", proj, home);
      const claude = readFileSync(join(proj, "CLAUDE.md"), "utf8");
      expect(claude).toContain("House rules here.");
      expect(claude).toContain(FRAGMENT.trimEnd());
      expect(claude).not.toContain("@AGENTS.md");
      expect(claude).toBe(readFileSync(join(proj, "AGENTS.md"), "utf8"));
      expect(claudeLines(first).join("\n")).toContain("is AGENTS.md by another name");
      expect(first).toContain("CLAUDE.md is AGENTS.md here");
      expect(first).not.toContain("CLAUDE.md imports AGENTS.md");

      const again = run("claude", proj, home);
      expect(readFileSync(join(proj, "CLAUDE.md"), "utf8")).toBe(claude);
      expect(again).toContain("cairn section already current");
      expect(claudeLines(again)).toEqual(claudeLines(first));

      const check = run("claude", proj, home, "--check");
      expect(check).toContain("CLAUDE.md is AGENTS.md by another name, which carries the fragment");
    });
  }

  it("the harmless twin: two separate files with the same bytes are two files, so CLAUDE.md gets the import", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, "CLAUDE.md"), OWNER);
    writeFileSync(join(proj, "AGENTS.md"), OWNER);

    const out = run("claude", proj, home);
    expect(out).toContain("CLAUDE.md imports AGENTS.md");
    const claude = readFileSync(join(proj, "CLAUDE.md"), "utf8");
    expect(claude.split("\n").slice(0, 3)).toContain("@AGENTS.md");
    expect(claude).toContain("House rules here.");
    expect(claude).not.toContain(FRAGMENT.trimEnd());
    expect(readFileSync(join(proj, "AGENTS.md"), "utf8")).toContain(FRAGMENT.trimEnd());
  });
});

// #474: the work, ship and status verbs tell the agent to run a helper
// through $CLAUDE_PLUGIN_ROOT, a variable only Claude Code sets, and setup
// copied the hook scripts folder for Cursor alone. On the other six
// harnesses the copied verb's command resolved to a path at the filesystem
// root, module not found, and the file was not on the machine either. Setup
// now copies the helpers the verbs name (with their relative imports) into a
// scripts folder beside the copied verbs, for every harness, and rewrites
// the plugin-root path in the copied verbs to it; Claude Code keeps the
// plugin root, which it does set.
describe("the helpers the verbs name reach every harness (#474)", () => {
  const PLUGINLESS = ["grok", "copilot", "codex", "gemini", "cursor", "opencode", "zed"];
  const SCRIPTS = join(".cairn", "harness", "scripts");
  const VERBS = join(".cairn", "harness", "verbs");
  /** Every `node "<path>"` a verb body tells the agent to run. */
  const commands = (body: string) => [...body.matchAll(/node "([^"]+\.mjs)"/g)].map((m) => m[1]);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" });

  it("codex: the copied work verb's merge-overlap command runs from the project root and prints the lead; re-run is byte-identical", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    // a scratch repo with two branches that both touch one file
    git(proj, "init", "-q", "-b", "main");
    git(proj, "config", "user.email", "t@example.com");
    git(proj, "config", "user.name", "t");
    writeFileSync(join(proj, "shared.ts"), "base\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-qm", "base");
    for (const b of ["a", "b"]) {
      git(proj, "checkout", "-q", "-b", b, "main");
      writeFileSync(join(proj, "shared.ts"), `${b}\n`);
      git(proj, "commit", "-qam", b);
    }

    run("codex", proj, home);
    const work = readFileSync(join(proj, VERBS, "work.md"), "utf8");
    expect(work).not.toContain("$CLAUDE_PLUGIN_ROOT");
    const cmd = commands(work).find((c) => c.endsWith("merge-overlap.mjs"));
    expect(cmd, "work.md names the merge-overlap helper").toBeDefined();
    const r = spawnSync(process.execPath, [cmd!, "a", "b"], { cwd: proj, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("overlap: 1 file — shared.ts");

    const helper = readFileSync(join(proj, cmd!), "utf8");
    run("codex", proj, home);
    expect(readFileSync(join(proj, VERBS, "work.md"), "utf8")).toBe(work);
    expect(readFileSync(join(proj, cmd!), "utf8")).toBe(helper);
  });

  for (const h of PLUGINLESS) {
    it(`${h}: every command the copied verbs name sits in the install, none goes through the plugin root, and the copies import each other`, () => {
      const proj = fresh("cairn-setup-");
      const home = fresh("cairn-home-");
      run(h, proj, home);
      let named = 0;
      for (const f of readdirSync(join(proj, VERBS))) {
        const body = readFileSync(join(proj, VERBS, f), "utf8");
        expect(body, `${f} still names the plugin root`).not.toContain("$CLAUDE_PLUGIN_ROOT");
        for (const c of commands(body)) {
          named++;
          expect(c.startsWith(`${SCRIPTS}/`), `${f} names ${c} outside the copied scripts folder`).toBe(true);
          expect(existsSync(join(proj, c)), `${f} names ${c}, which setup did not copy`).toBe(true);
        }
      }
      expect(named, "no copied verb names a helper at all -- an empty match is a failure").toBeGreaterThan(0);
      // cost-report imports ./lib.mjs beside it: the copy must carry the import, not just the entry file.
      const cost = spawnSync(process.execPath, [join(SCRIPTS, "cost-report.mjs")], {
        cwd: proj, encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj },
      });
      expect(cost.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(cost.status).toBe(0);
    });
  }

  it("claude keeps the plugin root in the copied verbs, and the helpers still land beside them", () => {
    const proj = fresh("cairn-setup-");
    const home = fresh("cairn-home-");
    run("claude", proj, home);
    const work = readFileSync(join(proj, VERBS, "work.md"), "utf8");
    expect(work).toContain('"$CLAUDE_PLUGIN_ROOT/hooks/scripts/merge-overlap.mjs"');
    expect(existsSync(join(proj, SCRIPTS, "merge-overlap.mjs"))).toBe(true);
    expect(existsSync(join(proj, SCRIPTS, "cost-report.mjs"))).toBe(true);
    expect(existsSync(join(proj, SCRIPTS, "lib.mjs"))).toBe(true);
  });
});

// #456: the run guard refuses an unshipped default-branch push only when the
// push goes through the Bash tool of a harness that runs the hook. A human's
// terminal, a harness wired for skills but not hooks, and any script that
// shells out to git all pushed past it. `--git-hooks` (opt-in: the flag is
// the owner's consent to a git-config write) installs a pre-push hook that
// is a thin caller over the shared stamp reader and effect table, so the
// same refusal holds for every process in the checkout. Every push below
// runs from a plain shell: no CLAUDE_* or CAIRN_* variable reaches it.
describe("cairn-setup --git-hooks: the git layer of the ship gate (#456)", () => {
  const GIT_IDENT = {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...GIT_IDENT } }).trim();
  // Built, never spelled: the leak guard refuses the planning folder's path as a literal.
  const GITHOOKS = join(".cairn", "githooks");

  /** A committed repo on main with a bare remote, plus an empty home for the stamp. */
  function repo(): { proj: string; home: string } {
    const proj = fresh("cairn-githooks-proj-");
    const home = fresh("cairn-githooks-home-");
    const bare = fresh("cairn-githooks-remote-");
    git(bare, "init", "-q", "--bare");
    git(proj, "init", "-q", "-b", "main");
    git(proj, "config", "user.email", "t@t");
    git(proj, "config", "user.name", "t");
    mkdirSync(join(proj, "src"));
    writeFileSync(join(proj, "src", "a.txt"), "a\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "init", "--no-gpg-sign");
    git(proj, "remote", "add", "origin", bare);
    return { proj, home };
  }

  /** `git push` as a plain shell runs it: every harness and cairn variable stripped. */
  function push(cwd: string, home: string, args: string[], extra: Record<string, string> = {}) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith("CLAUDE_") && !k.startsWith("CAIRN_")) env[k] = v;
    }
    const r = spawnSync("git", ["push", ...args], {
      cwd, encoding: "utf8", timeout: 20000, env: { ...env, ...GIT_IDENT, HOME: home, ...extra },
    });
    return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
  }

  /** The stamp plan_drift leaves, in the home the plain shell's hook reads. */
  function stamp(proj: string, home: string, head: string, clean = true): void {
    mkdirSync(join(home, ".cairn", "ship-gate"), { recursive: true });
    writeFileSync(join(home, ".cairn", "ship-gate", `${projectKey(proj)}.json`),
      JSON.stringify({ head, clean, at: "2026-11-04T00:00:00Z" }));
  }

  it("installs the hook, points core.hooksPath at it, copies the script beside the helpers; re-run byte-identical; --check reports it reached", () => {
    const { proj, home } = repo();
    const out = run("codex", proj, home, "--git-hooks");
    expect(out).toContain("pre-push hook installed");
    const hook = readFileSync(join(proj, GITHOOKS, "pre-push"), "utf8");
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(hook).toContain("# cairn:begin");
    expect(hook).toContain("# cairn:end");
    expect(hook).toContain("pre-push.mjs");
    expect(git(proj, "config", "--get", "core.hooksPath")).toBe(join(proj, GITHOOKS));
    expect(git(proj, "rev-parse", "--git-path", "hooks")).toBe(join(proj, GITHOOKS));
    for (const f of ["pre-push.mjs", "lib.mjs", "git-effects.mjs"]) {
      expect(existsSync(join(proj, ".cairn", "harness", "scripts", f)), f).toBe(true);
    }

    const again = run("codex", proj, home, "--git-hooks");
    expect(readFileSync(join(proj, GITHOOKS, "pre-push"), "utf8")).toBe(hook);
    expect(again).toContain("pre-push hook already current");

    const check = run("codex", proj, home, "--check");
    expect(check).toContain("git hooks (pre-push): installed");
    expect(check).toContain("git runs hooks from there");
    expect(check).toContain("all installed surfaces current.");
  });

  it("without the flag nothing touches git config, and --check says the layer is opt-in", () => {
    const { proj, home } = repo();
    run("codex", proj, home);
    expect(existsSync(join(proj, GITHOOKS))).toBe(false);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: proj }).status).not.toBe(0);
    const check = run("codex", proj, home, "--check");
    expect(check).toContain("git hooks (pre-push): not installed");
    expect(check).toContain("all installed surfaces current.");
  });

  it("from a plain shell with no stamp, a push to main is refused with the run guard's lines; from a nested folder too; a feature push passes", () => {
    const { proj, home } = repo();
    run("codex", proj, home, "--git-hooks");

    const r = push(proj, home, ["origin", "main"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cairn run guard: this push lands on the default branch, but no drift check has been recorded for this project.");
    expect(r.stderr).toContain("/cairn:ship");
    expect(r.stderr).toContain("effect: moves-shared-ref");
    expect(r.stderr).toContain("not the owner asking");
    expect(r.stderr).toContain("git pre-push hook");
    // the escape is honoured, never taught (#262)
    expect(r.stderr).not.toMatch(/[A-Z_]+=1/);
    expect(git(proj, "ls-remote", "--heads", "origin")).toBe("");

    const nested = push(join(proj, "src"), home, ["origin", "main"]);
    expect(nested.status).not.toBe(0);
    expect(nested.stderr).toContain("cairn run guard: this push lands on the default branch");

    // the harmless twin: the same commit to a branch nobody ships from
    const twin = push(proj, home, ["origin", "main:feature"]);
    expect(twin.stderr).not.toContain("cairn run guard");
    expect(twin.status).toBe(0);
    expect(git(proj, "ls-remote", "--heads", "origin")).toContain("refs/heads/feature");
  });

  it("the owner's escape lets it through and says so; a clean stamp at HEAD lets it through silently; a stamp for another commit refuses", () => {
    const { proj, home } = repo();
    run("codex", proj, home, "--git-hooks");

    const allowed = push(proj, home, ["origin", "main"], { CAIRN_ALLOW_UNSHIPPED_PUSH: "1" });
    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain("CAIRN_ALLOW_UNSHIPPED_PUSH is set");
    expect(allowed.stderr).not.toContain("refused");

    writeFileSync(join(proj, "src", "b.txt"), "b\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "second", "--no-gpg-sign");
    const head = git(proj, "rev-parse", "HEAD");
    stamp(proj, home, head);
    const clean = push(proj, home, ["origin", "main"]);
    expect(clean.stderr).not.toMatch(/cairn (run guard|pre-push)/);
    expect(clean.status).toBe(0);

    writeFileSync(join(proj, "src", "c.txt"), "c\n");
    git(proj, "add", "-A");
    git(proj, "commit", "-q", "-m", "third", "--no-gpg-sign");
    const stale = push(proj, home, ["origin", "main"]);
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain(`the last drift check was for ${head.slice(0, 7)}, not the commit being pushed`);

    stamp(proj, home, git(proj, "rev-parse", "HEAD"), false);
    const dirty = push(proj, home, ["origin", "main"]);
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("the last drift check flagged drift that ship stops on");
  });

  it("the hostile spellings land on main too: HEAD:main and refs/heads/main are refused; --no-verify walks past, which the runbook says", () => {
    const { proj, home } = repo();
    run("codex", proj, home, "--git-hooks");
    for (const spec of ["HEAD:main", "refs/heads/main", "main:refs/heads/main"]) {
      const r = push(proj, home, ["origin", spec]);
      expect(r.status, spec).not.toBe(0);
      expect(r.stderr, spec).toContain("cairn run guard: this push lands on the default branch");
    }
    expect(git(proj, "ls-remote", "--heads", "origin")).toBe("");
    // the measured limit of the layer: git skips every pre-push hook under --no-verify
    const past = push(proj, home, ["--no-verify", "origin", "main"]);
    expect(past.status).toBe(0);
    expect(past.stderr).not.toMatch(/cairn (run guard|pre-push)/);
    const runbook = readFileSync(join(dirname(SETUP), "..", "docs", "01-runbook.md"), "utf8");
    expect(runbook).toContain("--no-verify");
  });

  it("a project's own pre-push survives under the markers, runs after the gate, and still reads the refs from stdin", () => {
    const { proj, home } = repo();
    mkdirSync(join(proj, GITHOOKS), { recursive: true });
    const owner = '#!/bin/sh\ncat > "$PWD/owner-saw.txt"\n';
    writeFileSync(join(proj, GITHOOKS, "pre-push"), owner);
    chmodSync(join(proj, GITHOOKS, "pre-push"), 0o755);
    // the owner's own pointer: with none, this folder's hook is one setup won't arm (#508)
    git(proj, "config", "core.hooksPath", GITHOOKS);
    run("codex", proj, home, "--git-hooks");
    const hook = readFileSync(join(proj, GITHOOKS, "pre-push"), "utf8");
    expect(hook.startsWith("#!/bin/sh\n# cairn:begin")).toBe(true);
    expect(hook.indexOf("# cairn:end")).toBeLessThan(hook.indexOf("owner-saw.txt"));

    // refused by the gate: the owner's hook never ran
    expect(push(proj, home, ["origin", "main"]).status).not.toBe(0);
    expect(existsSync(join(proj, "owner-saw.txt"))).toBe(false);
    // stamped: the gate passes and the owner's hook reads the refs it was always given
    stamp(proj, home, git(proj, "rev-parse", "HEAD"));
    expect(push(proj, home, ["origin", "main"]).status).toBe(0);
    expect(readFileSync(join(proj, "owner-saw.txt"), "utf8")).toContain("refs/heads/main");

    run("codex", proj, home, "--git-hooks");
    expect(readFileSync(join(proj, GITHOOKS, "pre-push"), "utf8")).toBe(hook);
  });

  // #508: the flag points git at the folder and arms what it holds. A folder
  // holding hooks this install did not write is refused, for the harnesses
  // where no guard stands in front of an agent-run install; the guard's half is
  // hooks.test.ts "(#508)".
  describe("a folder holding hooks setup did not write is never armed (#508)", () => {
    const pointer = (proj: string) => spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: proj, encoding: "utf8" }).stdout.trim();

    /** A commit from a plain shell, and whether a planted hook wrote its marker. */
    function ownerCommits(proj: string, home: string): boolean {
      const marker = join(proj, "armed.txt");
      const r = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "owner", "--no-gpg-sign"], {
        cwd: proj, encoding: "utf8", env: { ...process.env, ...GIT_IDENT, HOME: home },
      });
      expect(r.status, r.stderr).toBe(0);
      return existsSync(marker);
    }

    function plant(proj: string, name: string, body: string): void {
      mkdirSync(join(proj, GITHOOKS), { recursive: true });
      writeFileSync(join(proj, GITHOOKS, name), body);
      chmodSync(join(proj, GITHOOKS, name), 0o755);
    }
    const EVIL = '#!/bin/sh\necho armed > "$PWD/armed.txt"\n';

    it("the issue's scenario: a planted pre-commit is named, nothing is pointed at it, and the owner's commit does not run it", () => {
      const { proj, home } = repo();
      plant(proj, "pre-commit", EVIL);
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("did not write (pre-commit)");
      expect(r.stderr).toContain("would arm them");
      expect(pointer(proj)).toBe("");
      expect(ownerCommits(proj, home)).toBe(false);
    });

    it("hostile: a pre-push with no markers, one with lines around the block, a link, and a folder of several, all named", () => {
      const planted: Array<[string, string]> = [
        ["pre-push", EVIL],
        ["pre-push", `#!/bin/sh\n# cairn:begin -- managed by cairn-setup --git-hooks; do not edit inside markers\n# cairn:end\necho armed > "$PWD/armed.txt"\n`],
        ["pre-push", `#!/bin/sh\necho armed > "$PWD/armed.txt"\n# cairn:begin -- managed by cairn-setup --git-hooks; do not edit inside markers\n# cairn:end\n`],
      ];
      for (const [name, body] of planted) {
        const { proj, home } = repo();
        plant(proj, name, body);
        const r = attempt("codex", home, { project: proj }, "--git-hooks");
        expect(r.status, r.out).toBe(1);
        expect(r.stderr).toContain("did not write (pre-push)");
        expect(pointer(proj)).toBe("");
      }
      const { proj, home } = repo();
      mkdirSync(join(proj, GITHOOKS), { recursive: true });
      symlinkSync("/nowhere", join(proj, GITHOOKS, "post-checkout"));
      plant(proj, "post-commit", EVIL);
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("post-checkout");
      expect(r.stderr).toContain("post-commit");
      expect(pointer(proj)).toBe("");
    });

    it("the harmless twins: a re-run over its own hook, a sample and a dotfile; no flag at all; and a pointer the owner already set", () => {
      const first = repo();
      run("codex", first.proj, first.home, "--git-hooks");
      const hook = readFileSync(join(first.proj, GITHOOKS, "pre-push"), "utf8");
      // the pointer gone, the folder holding only what setup wrote: it arms nothing new
      git(first.proj, "config", "--unset", "core.hooksPath");
      plant(first.proj, "pre-commit.sample", EVIL);
      writeFileSync(join(first.proj, GITHOOKS, ".gitignore"), "*\n");
      const again = attempt("codex", first.home, { project: first.proj }, "--git-hooks");
      expect(again.status, again.out).toBe(0);
      expect(readFileSync(join(first.proj, GITHOOKS, "pre-push"), "utf8")).toBe(hook);
      expect(pointer(first.proj)).toBe(join(first.proj, GITHOOKS));

      const plain = repo();
      plant(plain.proj, "pre-commit", EVIL);
      const noFlag = attempt("codex", plain.home, { project: plain.proj });
      expect(noFlag.status, noFlag.out).toBe(0);
      expect(pointer(plain.proj)).toBe("");

      // the owner's own pointer already runs that folder: the install adds its hook and arms nothing new
      const set = repo();
      plant(set.proj, "pre-commit", "#!/bin/sh\nexit 0\n");
      git(set.proj, "config", "core.hooksPath", GITHOOKS);
      const kept = attempt("codex", set.home, { project: set.proj }, "--git-hooks");
      expect(kept.status, kept.out).toBe(0);
      expect(existsSync(join(set.proj, GITHOOKS, "pre-commit"))).toBe(true);
      expect(readFileSync(join(set.proj, GITHOOKS, "pre-push"), "utf8")).toContain("# cairn:begin");
    });

    it("the nested-cwd variant: run from a folder below the root, the folder it would point at is judged the same", () => {
      const { proj, home } = repo();
      const below = join(proj, "src");
      plant(below, "pre-commit", EVIL);
      const r = attempt("codex", home, { cwd: below }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("did not write (pre-commit)");
      expect(pointer(proj)).toBe("");
    });
  });

  it("live hooks in the folder git runs today are refused in one line, nothing written, core.hooksPath left alone", () => {
    const { proj, home } = repo();
    const current = join(proj, git(proj, "rev-parse", "--git-path", "hooks"));
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "pre-commit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(current, "pre-commit"), 0o755);
    let err = "";
    try {
      run("codex", proj, home, "--git-hooks");
    } catch (e) {
      err = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(err).toContain("pre-commit");
    expect(err).toContain("core.hooksPath");
    expect(existsSync(join(proj, GITHOOKS))).toBe(false);
    expect(spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: proj }).status).not.toBe(0);
  });

  it("a core.hooksPath already set elsewhere is respected: the hook goes into that folder, the setting stays", () => {
    const { proj, home } = repo();
    mkdirSync(join(proj, "scripts", "hooks"), { recursive: true });
    git(proj, "config", "core.hooksPath", "scripts/hooks");
    const out = run("codex", proj, home, "--git-hooks");
    expect(out).toContain("pre-push hook installed");
    expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
    expect(existsSync(join(proj, GITHOOKS))).toBe(false);
    expect(git(proj, "config", "--get", "core.hooksPath")).toBe("scripts/hooks");
    expect(push(proj, home, ["origin", "main"]).stderr).toContain("cairn run guard: this push lands on the default branch");
  });

  // Reproduced 2026-11-06, git 2.56.0, before the fix: from a project below the
  // root the gate landed in the project's scripts/hooks, --check exited 0 saying
  // "not installed", and a real push reached main with nothing judging it.
  describe("a relative core.hooksPath in a project below the repository root (#526)", () => {
    const REFUSED = "cairn run guard: this push lands on the default branch";

    function nestedRepo(): { proj: string; home: string; sub: string } {
      const { proj, home } = repo();
      const sub = join(proj, "packages", "app");
      mkdirSync(sub, { recursive: true });
      return { proj, home, sub };
    }

    it("what the fix rests on: a real commit from the nested folder runs the hook in the root's folder, and never the nested one", () => {
      const { proj, sub } = nestedRepo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      for (const [name, base] of [["ROOT", proj], ["NESTED", sub]]) {
        mkdirSync(join(base, "scripts", "hooks"), { recursive: true });
        writeFileSync(join(base, "scripts", "hooks", "pre-commit"), `#!/bin/sh\necho "RAN ${name}"\n`);
        chmodSync(join(base, "scripts", "hooks", "pre-commit"), 0o755);
      }
      writeFileSync(join(sub, "f.txt"), "f\n");
      git(sub, "add", "f.txt");
      // a hook's stdout reaches the caller on stderr
      const done = spawnSync("git", ["commit", "-m", "two", "--no-gpg-sign"], { cwd: sub, encoding: "utf8", env: { ...process.env, ...GIT_IDENT } });
      expect(done.status, done.stderr).toBe(0);
      expect(done.stderr).toContain("RAN ROOT");
      expect(done.stderr).not.toContain("RAN NESTED");
    });

    it("the gate lands where git looks: a real push from the project, and from the root, is refused; --check says reached; the setting stays", () => {
      const { proj, home, sub } = nestedRepo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      run("codex", sub, home, "--git-hooks");
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(existsSync(join(sub, "scripts", "hooks", "pre-push"))).toBe(false);
      expect(git(proj, "config", "--get", "core.hooksPath")).toBe("scripts/hooks");

      const fromProject = push(sub, home, ["origin", "main"]);
      expect(fromProject.status).not.toBe(0);
      expect(fromProject.stderr).toContain(REFUSED);
      expect(push(proj, home, ["origin", "main"]).stderr).toContain(REFUSED);
      expect(git(proj, "ls-remote", "--heads", "origin")).toBe("");

      const check = run("codex", sub, home, "--check");
      expect(check).toContain("git hooks (pre-push): installed");
      expect(check).toContain("git runs hooks from there");
      expect(check).toContain("all installed surfaces current.");
    });

    it("the nested-cwd variant: bare from the nested folder, with no --project, lands in the same place", () => {
      const { proj, home, sub } = nestedRepo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const r = attempt("codex", home, { cwd: sub }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(existsSync(join(sub, "scripts", "hooks", "pre-push"))).toBe(false);
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
    });

    it("a linked worktree reads it from its own root: the nested project there gates that worktree", () => {
      const { proj, home } = nestedRepo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const linked = join(fresh("cairn-githooks-linked-"), "wt");
      git(proj, "worktree", "add", "-q", "-b", "side", linked);
      const sub = join(linked, "packages", "app");
      mkdirSync(sub, { recursive: true });
      run("codex", sub, home, "--git-hooks");
      expect(existsSync(join(linked, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(existsSync(join(sub, "scripts", "hooks", "pre-push"))).toBe(false);
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(false);
      expect(push(sub, home, ["origin", "side:main"]).stderr).toContain(REFUSED);
    });

    it("--check flags a hook an older install stranded where git never looks, exit non-zero; a re-run arms the right folder", () => {
      const { proj, home, sub } = nestedRepo();
      // what the old resolution left behind: the block in the project's folder, the setting relative
      git(proj, "config", "core.hooksPath", join(sub, "scripts", "hooks"));
      run("codex", sub, home, "--git-hooks");
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      expect(push(sub, home, ["origin", "main:feature"]).stderr).not.toContain(REFUSED);

      const out = runCheckFail("codex", sub, home);
      expect(out).toContain(`installed at ${join(sub, "scripts", "hooks")}`);
      expect(out).toContain(`runs hooks from ${join(realpathSync(proj), "scripts", "hooks")}`);
      expect(out).toContain("not reached");

      run("codex", sub, home, "--git-hooks");
      expect(run("codex", sub, home, "--check")).toContain("git runs hooks from there");
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
    });

    it("the hostile one: a hooks folder at the root that links out of the repository is refused, as it is for a project at the root; nothing lands outside", () => {
      for (const at of [["scripts", "hooks"], ["scripts", "hooks", "pre-push"]]) {
        const { proj, home, sub } = nestedRepo();
        const outside = fresh("cairn-githooks-outside-");
        const victim = join(outside, "victim");
        if (at.length === 2) mkdirSync(victim);
        else writeFileSync(victim, "the owner's\n");
        mkdirSync(join(proj, ...at.slice(0, -1)), { recursive: true });
        symlinkSync(victim, join(proj, ...at));
        git(proj, "config", "core.hooksPath", "scripts/hooks");
        const r = attempt("codex", home, { project: sub }, "--git-hooks");
        expect(r.status, r.out).toBe(1);
        expect(r.stderr).toContain("refusing to write through it");
        if (at.length === 2) expect(readdirSync(victim)).toEqual([]);
        else expect(readFileSync(victim, "utf8")).toBe("the owner's\n");
      }
    });

    it("the harmless twin of the hostile one: a link at the root that stays inside the repository writes", () => {
      const { proj, home, sub } = nestedRepo();
      mkdirSync(join(proj, "tools", "hooks"), { recursive: true });
      mkdirSync(join(proj, "scripts"));
      symlinkSync(join(proj, "tools", "hooks"), join(proj, "scripts", "hooks"));
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const r = attempt("codex", home, { project: sub }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(proj, "tools", "hooks", "pre-push"))).toBe(true);
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
    });

    it("the way out a shared setting's refusal names works from below the root: the command as printed gates the project's own folder", () => {
      const { proj, home, sub } = nestedRepo();
      const shared = join(home, ".githooks");
      mkdirSync(shared);
      writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = ~/.githooks\n");
      const r = attempt("codex", home, { project: sub }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      const printed = /git config --local core\.hooksPath (\S+)`/.exec(r.stderr);
      expect(printed, r.stderr).not.toBeNull();
      git(proj, "config", "--local", "core.hooksPath", (printed as RegExpExecArray)[1]);
      const again = attempt("codex", home, { project: sub }, "--git-hooks");
      expect(again.status, again.out).toBe(0);
      expect(existsSync(join(sub, GITHOOKS, "pre-push"))).toBe(true);
      expect(readdirSync(shared)).toEqual([]);
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
    });

    it("the twin: a project at the root is unchanged, through a link to it too, the paths it prints included", () => {
      const { proj, home } = repo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const alias = join(fresh("cairn-githooks-alias-"), "proj");
      symlinkSync(proj, alias);
      const out = run("codex", alias, home, "--git-hooks");
      expect(out).toContain(`${join(alias, "scripts", "hooks", "pre-push")}: pre-push hook installed`);
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(run("codex", alias, home, "--check")).toContain(`installed at ${join(alias, "scripts", "hooks")}`);

      const plain = repo();
      const shared = join(plain.home, ".githooks");
      mkdirSync(shared);
      writeFileSync(join(plain.home, ".gitconfig"), "[core]\n\thooksPath = ~/.githooks\n");
      const refused = attempt("codex", plain.home, { project: plain.proj }, "--git-hooks");
      expect(refused.stderr).toContain(`git config --local core.hooksPath ${GITHOOKS}\``);
    });

    it("a project reached through a link from elsewhere is read from where git stands, not from the spelling: the gate is reached and --check says so", () => {
      const { proj, home, sub } = nestedRepo();
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const alias = join(fresh("cairn-githooks-alias-"), "app");
      symlinkSync(sub, alias);
      run("codex", alias, home, "--git-hooks");
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
      expect(run("codex", alias, home, "--check")).toContain("git runs hooks from there");
    });

    it("a relative value that climbs out of the worktree is read as git reads it, from the root, and stays a local setting's to name", () => {
      const { proj, home, sub } = nestedRepo();
      const beside = fresh("cairn-githooks-beside-");
      git(proj, "config", "core.hooksPath", `../${basename(beside)}`);
      run("codex", sub, home, "--git-hooks");
      expect(existsSync(join(beside, "pre-push"))).toBe(true);
      expect(existsSync(join(proj, "packages", basename(beside)))).toBe(false);
      expect(push(sub, home, ["origin", "main"]).stderr).toContain(REFUSED);
    });
  });

  it("--check lags when the hook is installed but git no longer runs hooks from there", () => {
    const { proj, home } = repo();
    run("codex", proj, home, "--git-hooks");
    git(proj, "config", "core.hooksPath", ".husky");
    const out = runCheckFail("codex", proj, home);
    expect(out).toContain("git hooks (pre-push): installed");
    expect(out).toContain("not reached");
    // read-only: the check repairs nothing
    expect(git(proj, "config", "--get", "core.hooksPath")).toBe(".husky");
  });

  it("outside a repository the flag is one line and exit 1; the rest of the install still landed", () => {
    const proj = fresh("cairn-githooks-plain-");
    const home = fresh("cairn-githooks-home-");
    let err = "";
    try {
      run("codex", proj, home, "--git-hooks");
    } catch (e) {
      err = String((e as { stderr?: string }).stderr ?? "");
    }
    expect(err).toContain("not a git repository");
    expect(existsSync(join(proj, ".cairn", "harness", "SKILL.md"))).toBe(true);
  });

  // #497: the consent --git-hooks records is for this project's git config.
  // A core.hooksPath at global or system scope names a folder every repository
  // it reaches runs hooks from, so setup never writes there; the cairn block
  // landing in it refused default-branch pushes in unrelated repositories.
  describe("a folder other repositories run hooks from is never written into (#497)", () => {
    const OWNER_HOOK = "#!/bin/sh\necho the owner hook\n";
    const SCRIPT = join(".cairn", "harness", "scripts", "pre-push.mjs");
    const shared = (home: string) => join(home, ".githooks");
    const hooksLine = (value: string) => `[core]\n\thooksPath = ${value}\n`;
    const localHooksPath = (proj: string) => spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: proj }).status;

    /** A shared hooks folder holding the owner's own pre-push. */
    function sharedFolder(home: string): string {
      const dir = shared(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pre-push"), OWNER_HOOK);
      chmodSync(join(dir, "pre-push"), 0o755);
      return dir;
    }

    function expectRefusedUntouched(r: Attempt, proj: string, home: string, scope: string): void {
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain(`at ${scope} scope`);
      expect(r.stderr).toContain(shared(home));
      expect(r.stdout).not.toContain("cairn-setup complete");
      expect(readdirSync(shared(home))).toEqual(["pre-push"]);
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
      expect(localHooksPath(proj)).toBe(1);
      expect(existsSync(join(proj, SCRIPT))).toBe(false);
    }

    it("global scope: one line naming the folder, exit 1, nothing written there or set here; an unrelated repository still pushes main", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      expectRefusedUntouched(attempt("claude", home, { project: proj }, "--git-hooks"), proj, home, "global");
      const other = repo().proj;
      const p = push(other, home, ["origin", "main"]);
      expect(p.status, p.stderr).toBe(0);
      expect(p.stderr).not.toContain("cairn run guard");
      expect(p.stdout + p.stderr).toContain("the owner hook");
    });

    const shapes: Record<string, { scope: string; lay: (home: string, proj: string) => Record<string, string> }> = {
      "the system config": { scope: "system", lay: (home) => {
        writeFileSync(join(home, "system.cfg"), hooksLine(shared(home)));
        return { GIT_CONFIG_SYSTEM: join(home, "system.cfg") };
      } },
      "the XDG config, git's other global file": { scope: "global", lay: (home) => {
        mkdirSync(join(home, "xdg", "git"), { recursive: true });
        writeFileSync(join(home, "xdg", "git", "config"), hooksLine(shared(home)));
        return { XDG_CONFIG_HOME: join(home, "xdg") };
      } },
      "GIT_CONFIG_GLOBAL carrying the global file elsewhere": { scope: "global", lay: (home) => {
        writeFileSync(join(home, "moved.cfg"), hooksLine(shared(home)));
        return { GIT_CONFIG_GLOBAL: join(home, "moved.cfg") };
      } },
      "an include the global config pulls in": { scope: "global", lay: (home) => {
        writeFileSync(join(home, "dotfiles.cfg"), hooksLine(shared(home)));
        writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = ${join(home, "dotfiles.cfg")}\n`);
        return {};
      } },
      "an includeIf the global config pulls in for this folder": { scope: "global", lay: (home, proj) => {
        writeFileSync(join(home, "work.cfg"), hooksLine(shared(home)));
        writeFileSync(join(home, ".gitconfig"), `[includeIf "gitdir:${realpathSync(proj)}/"]\n\tpath = ${join(home, "work.cfg")}\n`);
        return {};
      } },
      "the environment's GIT_CONFIG_COUNT, which is no repository's config": { scope: "command", lay: (home) => (
        { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: shared(home) }
      ) },
    };
    for (const [name, { scope, lay }] of Object.entries(shapes)) {
      it(`${name} is refused the same way, the folder untouched`, () => {
        const { proj, home } = repo();
        sharedFolder(home);
        const env = lay(home, proj);
        expectRefusedUntouched(attempt("codex", home, { project: proj, env }, "--git-hooks"), proj, home, scope);
      });
    }

    it("hostile: GIT_CONFIG in the environment turns the install's own config write into a write on that file; the setting lands in this repository's config instead", () => {
      const { proj, home } = repo();
      const global = join(home, ".gitconfig");
      writeFileSync(global, "[user]\n\tname = owner\n");
      const r = attempt("codex", home, { project: proj, env: { GIT_CONFIG: global } }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(global, "utf8")).toBe("[user]\n\tname = owner\n");
      expect(git(proj, "config", "--local", "--get", "core.hooksPath")).toBe(join(proj, GITHOOKS));
    });

    it("a relative value at global scope is refused too: the decision is the scope, not the path", () => {
      const { proj, home } = repo();
      writeFileSync(join(home, ".gitconfig"), hooksLine(".githooks"));
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("at global scope");
      expect(existsSync(join(proj, ".githooks"))).toBe(false);
    });

    it("the hostile spelling: a local setting naming the very folder the global one names is that folder, and is refused", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      git(proj, "config", "core.hooksPath", shared(home));
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("the folder the global config names");
      expect(r.stderr).toContain(shared(home));
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
    });

    it("a git too old to name the scope (no --show-scope) is refused, never guessed; with nothing set it installs as usual", () => {
      const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const shim = fresh("cairn-oldgit-");
      writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" --show-scope "*) exit 129;; esac\nexec "${real}" "$@"\n`);
      chmodSync(join(shim, "git"), 0o755);
      const env = { PATH: `${shim}:${process.env.PATH ?? ""}` };

      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      const r = attempt("codex", home, { project: proj, env }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("a scope this git cannot name");
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);

      const plain = repo();
      const ok = attempt("codex", plain.home, { project: plain.proj, env }, "--git-hooks");
      expect(ok.status, ok.out).toBe(0);
      expect(existsSync(join(plain.proj, GITHOOKS, "pre-push"))).toBe(true);
    });

    it("the harmless twin: local scope beats the global setting and is respected; the global folder stays untouched", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      mkdirSync(join(proj, "scripts", "hooks"), { recursive: true });
      git(proj, "config", "core.hooksPath", "scripts/hooks");
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(proj, "scripts", "hooks", "pre-push"))).toBe(true);
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
      expect(git(proj, "config", "--get", "core.hooksPath")).toBe("scripts/hooks");
    });

    it("the harmless twin: worktree scope is respected", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      git(proj, "config", "extensions.worktreeConfig", "true");
      git(proj, "config", "--worktree", "core.hooksPath", "wt-hooks");
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(proj, "wt-hooks", "pre-push"))).toBe(true);
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
    });

    it("the way out the line names works: a local core.hooksPath, then a re-run, gates this project alone", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.stderr).toContain("git config --local core.hooksPath");
      git(proj, "config", "--local", "core.hooksPath", GITHOOKS);
      const again = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(again.status, again.out).toBe(0);
      expect(push(proj, home, ["origin", "main"]).stderr).toContain("cairn run guard: this push lands on the default branch");
      expect(push(repo().proj, home, ["origin", "main"]).status).toBe(0);
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
    });

    it("the nested-cwd variant: from a folder below the root the global setting is still refused; a local absolute one is still respected", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      const sub = join(proj, "src");
      const r = attempt("codex", home, { cwd: sub }, "--git-hooks");
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("at global scope");
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);

      const hooks = join(proj, "scripts", "hooks");
      mkdirSync(hooks, { recursive: true });
      git(proj, "config", "core.hooksPath", hooks);
      const ok = attempt("codex", home, { cwd: sub }, "--git-hooks");
      expect(ok.status, ok.out).toBe(0);
      expect(existsSync(join(hooks, "pre-push"))).toBe(true);
    });

    it("without the flag a global setting changes nothing: the install lands, exit 0, the folder untouched", () => {
      const { proj, home } = repo();
      sharedFolder(home);
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      const r = attempt("codex", home, { project: proj });
      expect(r.status, r.out).toBe(0);
      expect(readFileSync(join(shared(home), "pre-push"), "utf8")).toBe(OWNER_HOOK);
    });

    it("--check names a block an older install left in the shared folder, and lags; with no block a global setting is not a lag", () => {
      const { proj, home } = repo();
      run("codex", proj, home, "--git-hooks");
      mkdirSync(shared(home));
      writeFileSync(join(shared(home), "pre-push"), readFileSync(join(proj, GITHOOKS, "pre-push"), "utf8"));
      git(proj, "config", "--unset", "core.hooksPath");
      writeFileSync(join(home, ".gitconfig"), hooksLine("~/.githooks"));
      const out = runCheckFail("codex", proj, home);
      expect(out).toContain("at global scope");
      expect(out).toContain("every repository");

      const clean = repo();
      sharedFolder(clean.home);
      writeFileSync(join(clean.home, ".gitconfig"), hooksLine("~/.githooks"));
      const ok = attempt("codex", clean.home, { project: clean.proj }, "--check");
      expect(ok.status, ok.out).toBe(0);
      expect(ok.stdout).toContain("not installed");
    });

    it("Not seen: a local core.hooksPath naming a folder other repositories name in their own local configs is respected; git keeps no list of them", () => {
      const { proj, home } = repo();
      const folder = fresh("cairn-githooks-elsewhere-");
      git(proj, "config", "core.hooksPath", folder);
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(folder, "pre-push"))).toBe(true);
      expect(readFileSync(SETUP, "utf8")).toContain("a local core.hooksPath naming a folder other");
    });
  });
});

describe("one link check on every project-scoped write (#498)", () => {
  const REPO = join(dirname(SETUP), "..");
  const CAIRN = ".cairn";
  const first = (...p: string[]) => readdirSync(join(REPO, ...p)).filter((f) => !f.startsWith(".")).sort()[0];
  const OWNER = "# the owner's file, somewhere else\n";

  /** Every file and its bytes under a folder: what a refusal must leave as it found. */
  function tree(dir: string, at = ""): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of readdirSync(join(dir, at), { withFileTypes: true })) {
      const rel = join(at, f.name);
      if (f.isDirectory()) Object.assign(out, tree(dir, rel));
      else out[rel] = readFileSync(join(dir, rel), "utf8");
    }
    return out;
  }

  /** A project, a home, and a folder outside both holding the owner's file and a folder. */
  function scene() {
    const proj = fresh("cairn-links-proj-");
    const home = fresh("cairn-links-home-");
    const outside = fresh("cairn-links-outside-");
    writeFileSync(join(outside, "victim"), OWNER);
    mkdirSync(join(outside, "folder"));
    writeFileSync(join(outside, "folder", "keep"), OWNER);
    return { proj, home, outside };
  }
  function plant(proj: string, rel: string, target: string): void {
    mkdirSync(dirname(join(proj, rel)), { recursive: true });
    symlinkSync(target, join(proj, rel));
  }

  // Every project-scoped thing setup writes, by harness. A file row is a link
  // where setup writes a file (the copied ones overwrite whole, so a link there
  // erased the owner's file); a folder row is a link anywhere above the file.
  const FILES: Array<[string, string]> = [
    ["grok", "AGENTS.md"],
    ["grok", ".mcp.json"],
    ["grok", join(CAIRN, "harness", "SKILL.md")],
    ["grok", join(CAIRN, "harness", "verbs", "help.md")],
    ["grok", join(CAIRN, "harness", "scripts", "merge-overlap.mjs")],
    ["grok", join(CAIRN, "harness", ".cairn-manifest.json")],
    ["gemini", "GEMINI.md"],
    ["gemini", join(".gemini", "commands", "cairn", first("harness", "gemini", "commands", "cairn"))],
    ["copilot", join(".github", "copilot-instructions.md")],
    ["copilot", join(".github", "prompts", first("harness", "copilot", "prompts"))],
    ["cursor", join(".cursor", "mcp.json")],
    ["cursor", join(".cursor", "hooks.json")],
    ["cursor", join(".cursor", "hooks", "cairn", "cursor-adapter.mjs")],
    ["opencode", "opencode.json"],
    ["opencode", join(".opencode", "commands", first("harness", "opencode", "commands"))],
    ["zed", join(".zed", "settings.json")],
  ];
  const FOLDERS: Array<[string, string]> = [
    ["grok", CAIRN],
    ["grok", join(CAIRN, "harness")],
    ["grok", join(CAIRN, "harness", "verbs")],
    ["grok", join(CAIRN, "harness", "scripts")],
    ["gemini", ".gemini"],
    ["copilot", ".github"],
    ["copilot", join(".github", "prompts")],
    ["cursor", ".cursor"],
    ["cursor", join(".cursor", "hooks", "cairn")],
    ["opencode", ".opencode"],
    ["zed", ".zed"],
  ];

  for (const [harness, rel] of FILES) {
    it(`${harness}: ${rel} as a link out is refused and the owner's file survives; dangling, nothing is created`, () => {
      const { proj, home, outside } = scene();
      const before = tree(outside);
      plant(proj, rel, join(outside, "victim"));
      const r = attempt(harness, home, { project: proj });
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("resolves outside the project");
      expect(r.stderr).toContain("refusing to write through it");
      expect(r.stderr).toContain(join(proj, rel));
      expect(r.stdout).not.toContain("cairn-setup complete");
      expect(tree(outside)).toEqual(before);

      const again = scene();
      plant(again.proj, rel, join(again.outside, "nowhere"));
      const d = attempt(harness, again.home, { project: again.proj });
      expect(d.status, d.out).toBe(1);
      expect(d.stderr).toContain("is a symlink to a file that does not exist");
      expect(d.stderr).toContain("refusing to write through it");
      expect(existsSync(join(again.outside, "nowhere"))).toBe(false);
    });
  }

  for (const [harness, rel] of FOLDERS) {
    it(`${harness}: ${rel} as a folder link out is refused, nothing lands there; dangling, nothing is created`, () => {
      const { proj, home, outside } = scene();
      const before = tree(outside);
      plant(proj, rel, join(outside, "folder"));
      const r = attempt(harness, home, { project: proj });
      expect(r.status, r.out).toBe(1);
      expect(r.stderr).toContain("resolves outside the project");
      expect(tree(outside)).toEqual(before);

      const again = scene();
      plant(again.proj, rel, join(again.outside, "nowhere"));
      const d = attempt(harness, again.home, { project: again.proj });
      expect(d.status, d.out).toBe(1);
      expect(d.stderr).toContain("is a symlink to a file that does not exist");
      expect(existsSync(join(again.outside, "nowhere"))).toBe(false);
    });
  }

  it("AGENTS.md refused: no CLAUDE.md is written importing it and no success line claims the spine", () => {
    const { proj, home, outside } = scene();
    symlinkSync(join(outside, "victim"), join(proj, "AGENTS.md"));
    const r = attempt("claude", home, { project: proj });
    expect(r.status, r.out).toBe(1);
    expect(existsSync(join(proj, "CLAUDE.md"))).toBe(false);
    expect(r.out).not.toContain("reads the spine");
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe(OWNER);
  });

  it("the two spellings the issue reproduced: a relative link to a file beside the project, and a relative dangling one", () => {
    const { proj, home, outside } = scene();
    symlinkSync(join("..", basename(outside), "victim"), join(proj, "AGENTS.md"));
    const r = attempt("grok", home, { project: proj });
    expect(r.status, r.out).toBe(1);
    expect(r.stderr).toContain("resolves outside the project");
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe(OWNER);

    const b = scene();
    symlinkSync("nowhere.md", join(b.proj, "AGENTS.md"));
    const d = attempt("grok", b.home, { project: b.proj });
    expect(d.status, d.out).toBe(1);
    expect(existsSync(join(b.proj, "nowhere.md"))).toBe(false);
  });

  it("hostile: a chain that starts inside and ends outside, a folder link inside holding a link out, and a link to itself", () => {
    const chain = scene();
    symlinkSync(join(chain.outside, "victim"), join(chain.proj, "step.md"));
    symlinkSync("step.md", join(chain.proj, "AGENTS.md"));
    const a = attempt("grok", chain.home, { project: chain.proj });
    expect(a.status, a.out).toBe(1);
    expect(readFileSync(join(chain.outside, "victim"), "utf8")).toBe(OWNER);

    const nest = scene();
    const before = tree(nest.outside);
    mkdirSync(join(nest.proj, "in-here"));
    symlinkSync("in-here", join(nest.proj, CAIRN));
    symlinkSync(join(nest.outside, "folder"), join(nest.proj, "in-here", "harness"));
    const b = attempt("grok", nest.home, { project: nest.proj });
    expect(b.status, b.out).toBe(1);
    expect(b.stderr).toContain("resolves outside the project");
    expect(tree(nest.outside)).toEqual(before);

    const loop = scene();
    symlinkSync("AGENTS.md", join(loop.proj, "AGENTS.md"));
    const c = attempt("grok", loop.home, { project: loop.proj });
    expect(c.status, c.out).toBe(1);
    expect(c.stderr).toContain("refusing to write through it");
  });

  it("the git layer's writes go through it too: the hooks folder, the hook file, the script copy, and a folder a local core.hooksPath names", () => {
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    const shapes: Array<[string, (proj: string, outside: string) => void]> = [
      ["the cairn hooks folder links out", (p, o) => plant(p, join(CAIRN, "githooks"), join(o, "folder"))],
      ["the hook file links out", (p, o) => plant(p, join(CAIRN, "githooks", "pre-push"), join(o, "victim"))],
      ["the copied script links out", (p, o) => plant(p, join(CAIRN, "harness", "scripts", "pre-push.mjs"), join(o, "victim"))],
      ["a local hooks folder links out", (p, o) => { plant(p, join("scripts", "hooks"), join(o, "folder")); git(p, "config", "core.hooksPath", "scripts/hooks"); }],
      ["a hook in a local hooks folder links out", (p, o) => { plant(p, join("scripts", "hooks", "pre-push"), join(o, "victim")); git(p, "config", "core.hooksPath", "scripts/hooks"); }],
    ];
    for (const [name, lay] of shapes) {
      const { proj, home, outside } = scene();
      git(proj, "init", "-q", "-b", "main");
      lay(proj, outside);
      const before = tree(outside);
      const r = attempt("codex", home, { project: proj }, "--git-hooks");
      expect(r.status, `${name}: ${r.out}`).toBe(1);
      expect(r.stderr, name).toContain("refusing to write through it");
      expect(tree(outside), name).toEqual(before);
    }
  });

  it("the harmless twins: a link staying inside, a ../ climb that comes back, and a folder link inside all write as today, byte-identical on re-run", () => {
    const { proj, home } = scene();
    mkdirSync(join(proj, "docs"));
    writeFileSync(join(proj, "docs", "agents.md"), "# house rules\n");
    symlinkSync(join("docs", "agents.md"), join(proj, "AGENTS.md"));
    mkdirSync(join(proj, "local-cairn"));
    symlinkSync("local-cairn", join(proj, CAIRN));
    writeFileSync(join(proj, "real.json"), "{}\n");
    symlinkSync(join("..", basename(proj), "real.json"), join(proj, ".mcp.json"));
    const r = attempt("grok", home, { project: proj });
    expect(r.status, r.out).toBe(0);
    const spine = readFileSync(join(proj, "docs", "agents.md"), "utf8");
    expect(spine).toContain("# house rules");
    expect(spine).toContain("cairn:begin");
    expect(JSON.parse(readFileSync(join(proj, "real.json"), "utf8")).mcpServers.cairn).toBeTruthy();
    expect(existsSync(join(proj, "local-cairn", "harness", "SKILL.md"))).toBe(true);
    const again = attempt("grok", home, { project: proj });
    expect(again.status, again.out).toBe(0);
    expect(readFileSync(join(proj, "docs", "agents.md"), "utf8")).toBe(spine);
  });

  it("the harmless twin: a project named through a link of its own, the way /tmp is on a Mac, is not a link out", () => {
    const { proj, home, outside } = scene();
    const via = join(outside, "via");
    symlinkSync(proj, via);
    writeFileSync(join(proj, "kept.md"), "# kept\n");
    symlinkSync(join(proj, "kept.md"), join(proj, "AGENTS.md"));
    const r = attempt("grok", home, { project: via });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(proj, "kept.md"), "utf8")).toContain("cairn:begin");
  });

  it("the nested-cwd variant: with the folder below the root as the project, a link out and a link climbing to the root refuse; a link inside it writes", () => {
    const { proj, home, outside } = scene();
    const sub = join(proj, "pkg");
    mkdirSync(sub);
    symlinkSync(join(outside, "victim"), join(sub, "AGENTS.md"));
    const a = attempt("grok", home, { cwd: sub });
    expect(a.status, a.out).toBe(1);
    expect(a.stderr).toContain("resolves outside the project");
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe(OWNER);

    const b = scene();
    const bsub = join(b.proj, "pkg");
    mkdirSync(bsub);
    writeFileSync(join(b.proj, "root.md"), OWNER);
    symlinkSync(join("..", "root.md"), join(bsub, "AGENTS.md"));
    const c = attempt("grok", b.home, { cwd: bsub });
    expect(c.status, c.out).toBe(1);
    expect(readFileSync(join(b.proj, "root.md"), "utf8")).toBe(OWNER);

    const d = scene();
    const dsub = join(d.proj, "pkg");
    mkdirSync(dsub);
    writeFileSync(join(dsub, "inner.md"), "# inner\n");
    symlinkSync("inner.md", join(dsub, "AGENTS.md"));
    const e = attempt("grok", d.home, { cwd: dsub });
    expect(e.status, e.out).toBe(0);
    expect(readFileSync(join(dsub, "inner.md"), "utf8")).toContain("cairn:begin");
  });

  it("CLAUDE.md keeps its own wording and its exit 0 (#429), through the same check; a dangling one too", () => {
    const { proj, home, outside } = scene();
    symlinkSync(join(outside, "victim"), join(proj, "CLAUDE.md"));
    const r = attempt("claude", home, { project: proj });
    expect(r.status, r.out).toBe(0);
    expect(r.stdout).toContain("resolves outside the project");
    expect(r.stdout).toContain("add the @AGENTS.md import by hand");
    expect(readFileSync(join(outside, "victim"), "utf8")).toBe(OWNER);

    const d = scene();
    symlinkSync("nowhere.md", join(d.proj, "CLAUDE.md"));
    const dr = attempt("claude", d.home, { project: d.proj });
    expect(dr.status, dr.out).toBe(0);
    expect(dr.stdout).toContain("is a symlink to a file that does not exist");
    expect(existsSync(join(d.proj, "nowhere.md"))).toBe(false);
  });

  it("every write in setup goes through the one check: each fs writer has exactly one call site, and it runs the check", () => {
    const src = readFileSync(SETUP, "utf8");
    for (const writer of ["writeFileSync", "copyFileSync", "mkdirSync", "chmodSync"]) {
      const calls = src.split("\n").filter((l) => l.includes(`${writer}(`));
      expect(calls, writer).toHaveLength(1);
      expect(calls[0], writer).toContain("checkLinks(");
    }
  });

  it("the home-scoped writes keep following a dotfiles link, by decision, as the Not seen block says", () => {
    const { proj, home, outside } = scene();
    writeFileSync(join(outside, "gemini.json"), "{}\n");
    mkdirSync(join(home, ".gemini"));
    symlinkSync(join(outside, "gemini.json"), join(home, ".gemini", "settings.json"));
    const r = attempt("gemini", home, { project: proj });
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(readFileSync(join(outside, "gemini.json"), "utf8")).mcpServers.cairn).toBeTruthy();
    expect(readFileSync(SETUP, "utf8")).toContain("a home-scoped write");
  });

  it("Not seen: a hard link has no direction, so one to a file outside is written through; the block says so", () => {
    const { proj, home, outside } = scene();
    linkSync(join(outside, "victim"), join(proj, "AGENTS.md"));
    const r = attempt("grok", home, { project: proj });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(outside, "victim"), "utf8")).toContain("cairn:begin");
    expect(readFileSync(SETUP, "utf8")).toContain("a hard link has no direction");
  });

  it("Not seen: a link staying inside the project writes as today wherever inside it lands, and the swap race is named", () => {
    const { proj, home } = scene();
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(proj, ".git", "notes.md"), "# notes\n");
    symlinkSync(join(".git", "notes.md"), join(proj, "AGENTS.md"));
    const r = attempt("grok", home, { project: proj });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(proj, ".git", "notes.md"), "utf8")).toContain("cairn:begin");
    const src = readFileSync(SETUP, "utf8");
    expect(src).toContain("a link staying inside the project");
    expect(src).toContain("a link swapped in between the check and the write");
  });
});
