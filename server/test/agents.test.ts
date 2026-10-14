/**
 * Purpose: hold the two plugin agents' `tools:` frontmatter to the shape
 * Claude Code resolves (#376). Since 2.1.299 an agent's tools list takes
 * only the named MCP server's tools, written `mcp__<server>__<tool>`; a
 * bare `plan_status` grants nothing, and a live probe showed both agents
 * running with Read/Bash alone. Every non-builtin entry must be a full id
 * naming a tool server/src/index.ts actually registers, and no bare cairn
 * tool name may remain. Pure file reads -- no server boot.
 * Author(s): John Reed
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const AGENTS = ["agents/cairn-designer.md", "agents/cairn-uat.md"];
// The plugin is named `cairn` and its .mcp.json server is `cairn`, so the
// harness exposes the tools as mcp__plugin_cairn_cairn__<tool>.
const SERVER_PREFIX = "mcp__plugin_cairn_cairn__";
const BUILTINS = new Set(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]);

// Same derivation check-surface uses: every literal registerTool("name")
// call, plus the registerSessionTools("kind") factory that expands to
// <kind>_start / <kind>_log / <kind>_close at runtime (probe/draft/thread).
const serverSrc = read("server/src/index.ts");
const registry = new Set(
  [...serverSrc.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) {
  for (const suffix of ["start", "log", "close"]) registry.add(`${m[1]}_${suffix}`);
}

function toolsOf(agent: string): string[] {
  const front = read(agent).split("\n---")[0];
  const line = front.split("\n").find((l) => l.startsWith("tools:"));
  expect(line, `${agent} declares a tools: line`).toBeTruthy();
  return (line as string).slice("tools:".length).split(",").map((t) => t.trim()).filter(Boolean);
}

describe("plugin agents name cairn's tools by full MCP id (#376)", () => {
  it("the registry derivation sees the server's tool set, templated session tools included", () => {
    expect(registry.size).toBeGreaterThan(80);
    expect(registry.has("plan_status")).toBe(true);
    expect(registry.has("draft_log")).toBe(true);
  });

  for (const agent of AGENTS) {
    it(`${agent}: every non-builtin entry is a full id naming a registered tool`, () => {
      const tools = toolsOf(agent);
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        if (BUILTINS.has(t)) continue;
        expect(t, `${agent}: ${t}`).toMatch(new RegExp(`^${SERVER_PREFIX}[a-z_]+$`));
        expect(registry.has(t.slice(SERVER_PREFIX.length)), `${agent}: ${t} names a registered tool`).toBe(true);
      }
    });

    it(`${agent}: no bare cairn tool name remains (a bare name grants nothing on 2.1.299)`, () => {
      for (const t of toolsOf(agent)) {
        expect(registry.has(t), `${agent}: bare ${t}`).toBe(false);
      }
    });

    it(`${agent}: grants at least one cairn tool -- the agent is not meant to run blind`, () => {
      expect(toolsOf(agent).some((t) => t.startsWith(SERVER_PREFIX))).toBe(true);
    });
  }
});
