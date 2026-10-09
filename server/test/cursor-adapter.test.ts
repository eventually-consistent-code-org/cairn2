// Cursor hooks adapter (CRN-71 wave 3): translates Cursor hook payloads to
// the Claude-hook shape cairn's hook scripts consume, and translates their
// exit codes back to Cursor's response contract. Runs the real adapter with
// a fake HOME so no real handoff/metrics state is touched.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "cursor", "cursor-adapter.mjs");

const dirs: string[] = [];
function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runAdapter(payload: object, home: string): string {
  return execFileSync(process.execPath, [ADAPTER], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
}

describe("cursor-adapter", () => {
  it("beforeShellExecution: allows a harmless command", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "ls -la",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
  });

  it("beforeShellExecution: denies a git commit whose staged diff leaks internal refs", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: proj, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(proj, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      leakGuard: { enabled: true },
    }));
    writeFileSync(join(proj, "src.ts"), "// see .cairn/plans/PROJECT.md for details\n");
    git("add", "src.ts");

    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "git commit -m 'leaky'",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    const resp = JSON.parse(out);
    expect(resp.permission).toBe("deny");
    expect(resp.agent_message).toContain("leak");
  });

  it("sessionStart: returns additional_context when a handoff banner exists", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    // The banner path scheme is basename + sha256(abs)[0:16] under ~/.cairn/banner.
    const hash = createHash("sha256").update(proj).digest("hex").slice(0, 16);
    const bannerDir = join(home, ".cairn", "banner");
    mkdirSync(bannerDir, { recursive: true });
    writeFileSync(join(bannerDir, `${basename(proj)}-${hash}.md`), "## cairn banner test\n");

    const out = runAdapter({
      hook_event_name: "sessionStart",
      session_id: "s1",
      workspace_roots: [proj],
    }, home);
    const resp = JSON.parse(out);
    expect(resp.additional_context).toContain("cairn banner test");
  });

  // Documented posture, now pinned by a test: when the leak guard ITSELF
  // breaks (corrupt cairn.json here), the answer is allow — the guard must
  // never block work because it broke. Same fail-open rule as the Claude
  // Code hook it wraps.
  it("beforeShellExecution fails OPEN when the guard itself errors", () => {
    const proj = fresh("cairn-cursor-");
    const home = fresh("cairn-home-");
    writeFileSync(join(proj, "cairn.json"), "{ not json");
    const out = runAdapter({
      hook_event_name: "beforeShellExecution",
      command: "git commit -m 'x'",
      cwd: proj,
      workspace_roots: [proj],
    }, home);
    expect(JSON.parse(out)).toEqual({ permission: "allow" });
  });

  it("unknown events and adapter-internal errors never fail the hook", () => {
    const home = fresh("cairn-home-");
    const out = runAdapter({ hook_event_name: "someFutureEvent" }, home);
    expect(JSON.parse(out)).toEqual({});
  });
});

// #269: outside Claude Code the run guard and the harness guard never ran.
// Cursor's blocking preToolUse now runs them: Shell through both guards as
// a Bash call, the file tools through the harness guard.
describe("cursor-adapter preToolUse runs the run guard and the harness guard (#269)", () => {
  /** A git project for the guards to judge, with an ordinary file in it. */
  function project(): string {
    const proj = fresh("cairn-cursor-");
    execFileSync("git", ["init", "-q"], { cwd: proj });
    mkdirSync(join(proj, "src"));
    return proj;
  }

  function pre(proj: string, home: string, tool: string, input: Record<string, unknown>) {
    return JSON.parse(runAdapter({
      hook_event_name: "preToolUse", tool_name: tool, tool_input: input, cwd: proj, workspace_roots: [proj],
    }, home));
  }

  it("Shell: a destructive git command is refused by the run guard", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    const resp = pre(proj, home, "Shell", { command: "git reset --hard HEAD~1", working_directory: proj });
    expect(resp.permission).toBe("deny");
    expect(resp.user_message).toContain("run guard");
    expect(resp.agent_message).toContain("cairn run guard");
  });

  it("Shell: a write to Cursor's hook config is refused by the harness guard, from its working_directory too", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    for (const [command, wd] of [
      ["echo {} > .cursor/hooks.json", proj],
      ["rm -rf .cursor/hooks", proj],
      ["echo {} > hooks.json", join(proj, ".cursor")],
    ]) {
      const resp = pre(proj, home, "Shell", { command, working_directory: wd });
      expect(resp.permission, command).toBe("deny");
      expect(resp.agent_message, command).toContain("Cursor's hooks");
    }
  });

  it("Shell: ordinary commands and reads pass", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    for (const command of ["ls -la", "cat .cursor/hooks.json", "git status", "echo x > src/notes.txt"]) {
      expect(pre(proj, home, "Shell", { command, working_directory: proj }), command)
        .toEqual({ permission: "allow" });
    }
  });

  it("file tools: the path is read from file_path, path or target_file", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    const target = join(proj, ".cursor", "hooks.json");
    for (const key of ["file_path", "path", "target_file"]) {
      for (const tool of ["Write", "Edit"]) {
        const resp = pre(proj, home, tool, { [key]: target, contents: "{}" });
        expect(resp.permission, `${tool} ${key}`).toBe("deny");
        expect(resp.agent_message, `${tool} ${key}`).toContain("Cursor's hooks");
      }
    }
    expect(pre(proj, home, "Write", { file_path: join(proj, ".cursor", "hooks", "cairn", "cursor-adapter.mjs") })
      .permission).toBe("deny");
    expect(pre(proj, home, "Write", { file_path: join(proj, "src", "a.ts"), contents: "x" }))
      .toEqual({ permission: "allow" });
  });

  it("Delete: removing the hook config or the folder holding it is refused; ordinary files pass", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    for (const p of [join(proj, ".cursor", "hooks.json"), join(proj, ".cursor"), join(proj, "hooks")]) {
      expect(pre(proj, home, "Delete", { path: p }).permission, p).toBe("deny");
    }
    expect(pre(proj, home, "Delete", { path: join(proj, "src", "it's a.ts") })).toEqual({ permission: "allow" });
  });

  it("a file-tool call with no path it can read is denied, not waved through", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    const resp = pre(proj, home, "Write", { destination: join(proj, ".cursor", "hooks.json") });
    expect(resp.permission).toBe("deny");
    expect(resp.agent_message).toContain("destination");
  });

  it("tools that only read are not judged", () => {
    const proj = project();
    const home = fresh("cairn-home-");
    for (const tool of ["Read", "Grep", "Task", "MCP:issue_get"]) {
      expect(pre(proj, home, tool, { path: join(proj, ".cursor", "hooks.json") }), tool)
        .toEqual({ permission: "allow" });
    }
  });

  it("a guard that crashes or is missing fails closed", () => {
    // The installed layout: the adapter with the guard scripts beside it.
    const install = fresh("cairn-cursor-install-");
    copyFileSync(ADAPTER, join(install, "cursor-adapter.mjs"));
    writeFileSync(join(install, "pretooluse-runguard.mjs"), "process.exit(1);\n");
    const proj = project();
    const home = fresh("cairn-home-");
    const run = (tool: string, input: Record<string, unknown>) => JSON.parse(execFileSync(process.execPath,
      [join(install, "cursor-adapter.mjs")], {
        encoding: "utf8",
        input: JSON.stringify({
          hook_event_name: "preToolUse", tool_name: tool, tool_input: input, cwd: proj, workspace_roots: [proj],
        }),
        env: { ...process.env, HOME: home },
      }));
    const crashed = run("Shell", { command: "ls", working_directory: proj });
    expect(crashed.permission).toBe("deny");
    expect(crashed.user_message).toContain("failed to run");
    // no harness guard script beside the adapter and none in a repo two levels up
    expect(run("Write", { file_path: join(proj, "src", "a.ts") }).permission).toBe("deny");
  });
});
