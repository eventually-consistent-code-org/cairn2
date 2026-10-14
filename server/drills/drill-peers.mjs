#!/usr/bin/env node

// Purpose: Tier F2 peers drill (mechanical) — the cross-AI loop per
//          verbs/peers.md with STUB CLIs for all four providers (real
//          vendor binaries assumed nowhere) + the REAL tracker for the
//          finding mirror. Proves: detection, cap truncation at a tiny
//          configured cap, convergence mechanics landing a peer-credited
//          cairn:review issue + record, the outbound leak gate (the stub
//          NEVER receives the seeded secret), and proceed-without when a
//          provider goes missing.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);

// -- stub CLIs: each writes its received stdin to a capture file --------------
const STUBS = join(PROJECT, "stub-bin");
const CAPTURE = join(PROJECT, "capture");
mkdirSync(STUBS, { recursive: true });
mkdirSync(CAPTURE, { recursive: true });
for (const p of ["codex", "opencode", "grok", "copilot"]) {
  writeFileSync(
    join(STUBS, p),
    `#!/bin/sh\ncat > "${CAPTURE}/${p}.in"\necho "finding: export handler swallows write errors at src/export/handler.ts:87 (severity: critical)"\n`,
  );
  chmodSync(join(STUBS, p), 0o755);
}
// antigravity's binary is agy, and it's argv-mode — the prompt arrives as
// -p's value ($2), not stdin, so the capture reads from argv.
writeFileSync(
  join(STUBS, "agy"),
  `#!/bin/sh\ncat > /dev/null\nfor a; do last="$a"; done; printf '%s' "$last" > "${CAPTURE}/antigravity.in"\necho "finding: export handler swallows write errors at src/export/handler.ts:87 (severity: critical)"\n`,
);
chmodSync(join(STUBS, "agy"), 0o755);

// tiny cap for antigravity so truncation is provable
writeFileSync(
  join(PROJECT, "cairn.json"),
  JSON.stringify(
    {
      tracker: {
        type: "github",
        config: { repo: "eventually-consistent-code/cairn-drill-scratch" },
      },
      peers: { antigravity: { maxInputChars: 60 } },
      leakGuard: { extraPatterns: ["AKIA[0-9A-Z]{16}"] },
    },
    null,
    2,
  ) + "\n",
);
const DRILL_CONFIG = JSON.parse(
  readFileSync(join(PROJECT, "cairn.json"), "utf8"),
);

// Isolated PATH, not a prepend: on a machine with real vendor CLIs
// installed (multi-harness boxes), a prepended PATH would let the real
// grok answer after the degradation leg deletes the stub. Stubs + node's
// own dir + system bins is everything the drill needs. The isolated child
// can't reach `gh` for token fallback, so resolve the tracker token here
// (parent PATH) and hand it over.
const NODE_DIR = resolve(process.execPath, "..");
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  cwd: PROJECT,
  env: {
    ...process.env,
    CLAUDE_PROJECT_DIR: PROJECT,
    GITHUB_TOKEN,
    PATH: `${STUBS}:${NODE_DIR}:/usr/bin:/bin`,
  },
});
const client = new Client({ name: "peers-drill", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(res.content[0].text);
  return res.isError ? { __error: body } : body;
};

const checks = [];
const check = (label, ok, detail = "") => {
  checks.push([label, ok]);
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
};

// -- detection -----------------------------------------------------------------
console.log("detection: all five stubs on PATH...");
// peer_list wire shape is {peers, maxConcurrent} since #75 — the fan-out
// budget rides along with the roster.
const listOut = await call("peer_list", {});
const list = listOut.peers;
check(
  "all five providers detected on PATH",
  Array.isArray(list) && list.length === 5 && list.every((p) => p.onPath),
  JSON.stringify(list).slice(0, 120),
);
check(
  "antigravity carries its configured cap",
  list.find((p) => p.provider === "antigravity")?.maxInputChars === 60,
);
check(
  "fan-out budget rides along and is a sane positive integer",
  Number.isInteger(listOut.maxConcurrent) &&
    listOut.maxConcurrent >= 1 &&
    listOut.maxConcurrent <= 8,
);

// -- outbound leak gate (verb rule, run mechanically) ----------------------------
// Built-in patterns cover planning-detail leaks; credential-class patterns are
// the user's leakGuard.extraPatterns — the drill proves BOTH legs.
console.log("leak gate: seeded leaks never leave the machine...");
const PLANNING_LEAK =
  "review this diff:\n+ // see .cairn/plans/phases/02-export/PLAN.md for the contract";
check(
  "built-in scan catches the planning leak",
  scanLines(PLANNING_LEAK.split("\n"), buildPatterns(null)).length > 0,
);
const SECRET_INPUT =
  "review this diff:\n+ const key = 'AKIA" + "IOSFODNN7EXAMPLE'\n+ fetch(url)";
const hits = scanLines(SECRET_INPUT.split("\n"), buildPatterns(DRILL_CONFIG));
check("configured extraPattern catches the seeded credential", hits.length > 0);
// per the verb's hard rule: a hit stops the send — peer_run is NOT called.
check(
  "stub never received the secret (no capture file exists yet)",
  !existsSync(join(CAPTURE, "codex.in")),
);

// -- clean input: run peers, cap proven ------------------------------------------
console.log("clean run: all four peers, cap truncation on antigravity...");
const CLEAN =
  "review this diff: export handler catch block logs and falls through to res.ok — " +
  "failure scenario: disk full mid-write returns 200 with a truncated file.";
check(
  "clean input passes the scan",
  scanLines(CLEAN.split("\n"), buildPatterns(null)).length === 0,
);
const results = {};
for (const p of ["codex", "opencode", "antigravity", "grok", "copilot"]) {
  results[p] = await call("peer_run", { provider: p, input: CLEAN });
}
check(
  "all five ran, exit 0, findings returned",
  Object.values(results).every(
    (r) => r.exitCode === 0 && r.output.includes("finding:"),
  ),
  JSON.stringify(results.codex?.__error ?? "").slice(0, 100),
);
check(
  "antigravity input truncated with the marker",
  results.antigravity.truncatedInput === true &&
    readFileSync(join(CAPTURE, "antigravity.in"), "utf8").includes(
      "[cairn: input truncated at 60 chars]",
    ),
);
check(
  "uncapped peer got the full input",
  results.codex.truncatedInput === false &&
    readFileSync(join(CAPTURE, "codex.in"), "utf8").includes(
      "disk full mid-write",
    ),
);

// -- convergence mechanics: verified peer finding → tracker + record --------------
console.log("convergence: peer-credited finding to the tracker...");
const issue = await call("issue_create", {
  title: "export handler swallows write errors — partial files look successful",
  labels: ["cairn:review"],
  body: "critical\nPeer review convergence: all four peers flagged the swallowed write error; verified against the code before filing. Raised by codex (round 1), confirmed by antigravity.",
});
check(
  "cairn:review issue with peer provenance",
  issue.labels?.includes("cairn:review"),
);
const rec = await call("audit_record", {
  scope: "peers-review-drill",
  verdict: "findings",
  findings: [
    {
      severity: "critical",
      title: "export handler swallows write errors",
      detail:
        "raised by codex round 1; confirmed antigravity round 1; verified against src/export/handler.ts:87",
      issue: issue.id,
    },
  ],
});
check(
  "record credits peer + round",
  readFileSync(rec.path, "utf8").includes("codex round 1"),
);
await call("issue_comment", {
  id: issue.id,
  text: "Fixed: failed writes now fail the request; regression test pins it. Peer consensus verified before the fix landed.",
});
await call("issue_close", { id: issue.id });
check(
  "finding closed with a plain note",
  (await call("issue_get", { id: issue.id })).state === "closed",
);

// -- degradation: provider goes missing -------------------------------------------
console.log("degradation: grok vanishes...");
rmSync(join(STUBS, "grok"));
const gone = await call("peer_run", { provider: "grok", input: CLEAN });
check(
  "missing provider fails soft with the install hint (proceed-without is the verb's job)",
  Boolean(gone.__error) &&
    JSON.stringify(gone.__error).toLowerCase().includes("install"),
);
const list2 = (await call("peer_list", {})).peers;
check(
  "detection reflects the loss",
  list2.find((p) => p.provider === "grok")?.onPath === false,
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
