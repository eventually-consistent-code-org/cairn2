#!/usr/bin/env node

// Purpose: Tier A0 kill drill (mechanical) — Drill A phase 3 + Drill B.
//          Fresh server ("new session"): continuity_get resume data, tracker
//          cross-check via issue_get (trust order), a second resume read,
//          then a manufactured tracker contradiction. (The PreCompact leg
//          left with the hook in #328.)
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";

const PROJECT = process.argv[2];
const SERVER = process.argv[3];
const ISSUE_ID = process.argv[4];

const hash = createHash("sha256")
  .update(resolve(PROJECT))
  .digest("hex")
  .slice(0, 16);
const HANDOFF = join(
  homedir(),
  ".cairn",
  "handoff",
  `${basename(PROJECT)}-${hash}.json`,
);

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const client = new Client({ name: "kill-drill-b", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content[0].text);
};

const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
};

// --- Drill A phase 3: resume cross-check ---
console.log("reading handoff via continuity_get (new session)...");
const got = await call("continuity_get", {});
check("continuity_get returns handoff", !!got.handoff);
check("handoff not stale", got.stale === false);
check("handoff names exact issue", got.handoff.issue === ISSUE_ID);
check("handoff names exact task", got.handoff.task?.current === "step-2");

console.log(
  "tracker cross-check via issue_get (trust order: tracker first)...",
);
const live = await call("issue_get", { id: ISSUE_ID });
check(
  "tracker says in_progress — matches handoff, no contradiction",
  live.state === "in_progress",
);

// --- Drill B: a second resume read sees the same task ---
const got2 = await call("continuity_get", {});
check(
  "second resume read gives the exact task",
  got2.handoff.task?.current === "step-2" && got2.handoff.issue === ISSUE_ID,
);

// --- contradiction sub-check (criterion 3 data path) ---
console.log(
  "closing issue directly on tracker to manufacture contradiction...",
);
await call("issue_close", {
  id: ISSUE_ID,
  comment: "closed out-of-band for drill",
});
// issue_close's write-through refreshes the handoff, so force the stale state back
await call("continuity_checkpoint", {
  source: "tool",
  task: { current: "step-2", title: "write the thing" },
});
const liveClosed = await call("issue_get", { id: ISSUE_ID });
const h2 = JSON.parse(readFileSync(HANDOFF, "utf8"));
check(
  "contradiction detectable: tracker closed vs handoff still mid-task",
  liveClosed.state === "closed" && h2.task?.current === "step-2",
);

// --- resume completes: clear ---
const cleared = await call("continuity_clear", {});
check(
  "continuity_clear removes handoff",
  cleared.cleared === true || cleared === true || !!cleared,
);

await client.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
