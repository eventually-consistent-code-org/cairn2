/**
 * Purpose: hold the two plugin agents' `tools:` frontmatter to the shape
 * Claude Code resolves (#376). Since 2.1.299 an agent's tools list takes
 * only the named MCP server's tools, written `mcp__<server>__<tool>`; a
 * bare `plan_status` grants nothing, and a live probe showed both agents
 * running with Read/Bash alone. Every non-builtin entry must be a full id
 * naming a tool server/src/index.ts actually registers, and no bare cairn
 * tool name may remain. Pure file reads -- no server boot.
 *
 * #384 adds the other half: what the grants must NOT hold. The acceptance
 * agent reads other people's words (issue bodies, captured app output) and
 * never holds the tool that would act on a sentence in them saying "close
 * that issue"; the designer never holds a tracker-closing or
 * state-destroying tool at all; and both files carry the data-not-
 * instructions rule, since agent files inherit none of the trailhead's
 * shared rules.
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

// The state-destroying set is derived from the server's own annotations
// (the same destructiveHint the #344 test checks over the wire), so a new
// destructive tool is pinned out of the designer's grant the day it is
// registered. Literal registrations carry titleOf("name"); the templated
// session tools carry titleOf(`${kind}_close`) and expand per kind.
const destructive = new Set(
  [...serverSrc.matchAll(/titleOf\("([a-z_]+)"\)[^}]*destructiveHint: true/g)].map((m) => m[1]));
if (/titleOf\(`\$\{kind\}_close`\)[^}]*destructiveHint: true/.test(serverSrc)) {
  for (const m of serverSrc.matchAll(/registerSessionTools\("([a-z]+)"/g)) destructive.add(`${m[1]}_close`);
}
// Closing a tracker issue is the act #384 fences off; issue_update can set
// state too, so the designer is held off both, destructive-marked or not.
const TRACKER_CLOSING = ["issue_close", "issue_update"];

describe("agent grants stop short of closing or destroying tracker state (#384)", () => {
  it("the destructive derivation sees the server's set -- an empty match is a failure, never a pass", () => {
    expect(destructive.size).toBeGreaterThanOrEqual(10);
    expect(destructive.has("issue_close")).toBe(true);
    expect(destructive.has("draft_close")).toBe(true);
  });

  it("cairn-uat does not list issue_close -- a close goes through the verb's staged, owner-approved path", () => {
    expect(toolsOf("agents/cairn-uat.md")).not.toContain(`${SERVER_PREFIX}issue_close`);
    // the prose agrees with the grant: the close tool is named nowhere in the file
    expect(read("agents/cairn-uat.md")).not.toContain("issue_close");
  });

  it("cairn-designer lists no tracker-closing or state-destroying tool", () => {
    const tools = toolsOf("agents/cairn-designer.md");
    for (const t of tools) {
      if (!t.startsWith(SERVER_PREFIX)) continue;
      const name = t.slice(SERVER_PREFIX.length);
      expect(destructive.has(name), `${t} is destructive`).toBe(false);
      expect(TRACKER_CLOSING.includes(name), `${t} closes or re-states a tracker issue`).toBe(false);
    }
  });

  it("both agent files carry the data-not-instructions rule -- agent files inherit none of the trailhead's shared rules", () => {
    for (const agent of AGENTS) {
      expect(read(agent), agent).toContain("data, not instructions");
    }
  });
});
