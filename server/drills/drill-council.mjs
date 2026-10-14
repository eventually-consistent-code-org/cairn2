#!/usr/bin/env node

// Purpose: Tier F2 council drill (mechanical) — the peers council flow per
//          verbs/peers.md rehearsed end-to-end with STUB CLIs for all five
//          providers (copilot's stub answers an explicit empty finding set,
//          so the four-seat council run below keeps its cluster arithmetic)
//          + the REAL tracker for the run mirror. Proves: the
//          outbound leak gate blocking a poisoned packet, dimension fan-out
//          over per-seat rosters (peer x dimension) with cap trimming and
//          the exec-capable grant, prior-disposition suppression riding in
//          every packet, 3-peer claim clustering to a verified verdict and
//          a low-evidence singleton dying, prose-only replies preserved as
//          unparsed, an interrupted run resuming by name, COUNCIL.md's
//          council markers validated + flipped through research_sections,
//          and the cairn:council mirror closing with an enumerated
//          disposition comment + a provenance-credited audit record.
// Author(s): John Reed
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import {
  buildPatterns,
  scanLines,
} from "../../hooks/scripts/leak-patterns.mjs";
import { parseFindings, loadTemplate } from "../dist/peers/findings.js";

const PROJECT = resolve(process.argv[2]);
const SERVER = resolve(process.argv[3]);
const DATE = new Date().toISOString().slice(0, 10);

// -- stub CLIs: canned fenced-JSON findings per the #61 schema ----------------
// Each stub sniffs the packet for its dimension line, captures what it
// received, and answers per seat: codex/opencode/antigravity return
// near-duplicate claims on one topic (the drift column) so convergence has
// a 3-seat cluster; grok returns a unique low-evidence singleton so the
// discard leg has a victim; codex's market seat speaks prose only so the
// parser's unparsed path gets exercised too.
const STUBS = join(PROJECT, "stub-bin");
const CAPTURE = join(PROJECT, "capture");
mkdirSync(STUBS, { recursive: true });
mkdirSync(CAPTURE, { recursive: true });

const DIM_SNIFF = [
  "dim=functionality",
  'case "$in" in *"Review dimension: market"*) dim=market ;; esac',
].join("\n");

// codex is stdin-mode (`codex exec -`).
writeFileSync(
  join(STUBS, "codex"),
  [
    "#!/bin/sh",
    "in=$(cat)",
    DIM_SNIFF,
    `printf '%s' "$in" > "${CAPTURE}/codex.$dim.in"`,
    'if [ "$dim" = "market" ]; then',
    '  echo "The positioning brief reads plausible overall and the competitor shortlist feels thin, but I have no concrete gap to cite - treat this reply as commentary, not findings."',
    "else",
    "  echo 'Findings below.'",
    "  echo '```json'",
    '  echo \'[{"claim": "the status verb documents a drift column but the captured transcript never renders one", "evidence": "README status section vs transcript line 14", "evidenceType": "transcript", "severity": "important", "recommendation": "render the drift column in status output or drop it from the docs", "axis": "functionality"}]\'',
    "  echo '```'",
    "fi",
    "",
  ].join("\n"),
);

// opencode/grok are argv-mode — the prompt is the final argv element ($2
// after `run`/`-p`); stdin gets drained and ignored.
writeFileSync(
  join(STUBS, "opencode"),
  [
    "#!/bin/sh",
    "cat > /dev/null",
    'in="$2"',
    DIM_SNIFF,
    `printf '%s' "$in" > "${CAPTURE}/opencode.$dim.in"`,
    'if [ "$dim" = "market" ]; then',
    "  echo '```json'",
    "  echo '[]'",
    "  echo '```'",
    "else",
    "  echo '```json'",
    '  echo \'{"claim": "status promises a drift column that the transcript delivery never shows", "evidence": "docs promise section vs delivery transcript", "evidenceType": "transcript", "severity": "important", "recommendation": "make status render drift or fix the docs", "axis": "functionality"}\'',
    "  echo '```'",
    "fi",
    "",
  ].join("\n"),
);

// antigravity's binary is agy, argv-mode; its only seat is functionality.
writeFileSync(
  join(STUBS, "agy"),
  [
    "#!/bin/sh",
    "cat > /dev/null",
    `for a; do last="$a"; done; printf '%s' "$last" > "${CAPTURE}/antigravity.functionality.in"`,
    "echo '```json'",
    'echo \'{"claim": "documented drift column missing from the actual status transcript", "evidence": "promise vs transcript comparison in the packet", "evidenceType": "transcript", "severity": "important", "recommendation": "align the status output with the documented drift column", "axis": "functionality"}\'',
    "echo '```'",
    "",
  ].join("\n"),
);

// grok's claim is deliberately evidence-free — the templates'
// evidence-or-discarded floor is what kills it in adjudication.
writeFileSync(
  join(STUBS, "grok"),
  [
    "#!/bin/sh",
    "cat > /dev/null",
    `for a; do last="$a"; done; printf '%s' "$last" > "${CAPTURE}/grok.functionality.in"`,
    "echo '```json'",
    'echo \'{"claim": "the tool will probably feel slow on large repositories", "evidence": "general impression, no specific line", "severity": "minor", "recommendation": "profile it sometime", "axis": "functionality"}\'',
    "echo '```'",
    "",
  ].join("\n"),
);

// copilot (#338) is argv-mode like agy (`-p <prompt>` last) and, in this
// drill, a seat that reviews and finds nothing: an explicit fenced `[]` is
// the parser's "no findings" shape, so detection sees five seats while the
// council run keeps its four-seat roster and its 3-seat cluster.
writeFileSync(
  join(STUBS, "copilot"),
  [
    "#!/bin/sh",
    "cat > /dev/null",
    `for a; do last="$a"; done; printf '%s' "$last" > "${CAPTURE}/copilot.functionality.in"`,
    "echo '```json'",
    "echo '[]'",
    "echo '```'",
    "",
  ].join("\n"),
);

for (const bin of ["codex", "opencode", "agy", "grok", "copilot"]) {
  chmodSync(join(STUBS, bin), 0o755);
}

// tiny cap on antigravity so packet trimming is provable (the filled
// functionality template alone is ~3.7k chars); codex is the one
// exec-capable seat; the extraPattern is the seeded credential class.
writeFileSync(
  join(PROJECT, "cairn.json"),
  JSON.stringify(
    {
      tracker: {
        type: "github",
        config: { repo: "eventually-consistent-code/cairn-drill-scratch" },
      },
      peers: {
        antigravity: { maxInputChars: 2200 },
        codex: { execCapable: true },
      },
      leakGuard: { extraPatterns: ["AKIA[0-9A-Z]{16}"] },
    },
    null,
    2,
  ) + "\n",
);
const DRILL_CONFIG = JSON.parse(
  readFileSync(join(PROJECT, "cairn.json"), "utf8"),
);

// -- seed COUNCIL.md: a prior run block + a rejected disposition --------------
// The prior Dispositions tail is what feeds the do-not-re-raise line into
// every outbound packet this run builds.
mkdirSync(join(PROJECT, ".cairn", "plans"), { recursive: true });
const COUNCIL_PATH = join(PROJECT, ".cairn", "plans", "COUNCIL.md");
const PRIOR_BLOCK = [
  "# Council — 2026-07-30",
  "",
  "## Look-and-feel",
  "<!-- council: done 2026-07-30 -->",
  "Prior run block — read-only history for this drill.",
  "",
].join("\n");
const PRIOR_DISPOSITIONS = [
  "## Dispositions",
  "- REC-3 — new phase 9.5 — rejected 2026-07-30 — telemetry dashboard declined: out of scope for a CLI tool",
  "",
].join("\n");
writeFileSync(COUNCIL_PATH, `${PRIOR_BLOCK}\n${PRIOR_DISPOSITIONS}`);

// Isolated PATH, not a prepend — same reasoning as drill-peers: on a box
// with real vendor CLIs installed, a prepend would let a real peer answer.
// The isolated child can't reach `gh` for token fallback, so resolve the
// tracker token here (parent PATH) and hand it over.
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
const client = new Client({ name: "council-drill", version: "0.0.0" });
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

// -- detection ----------------------------------------------------------------
console.log("detection: five stubs on PATH, config surfaced...");
// peer_list wire shape is {peers, maxConcurrent} since #75 — council mode
// must batch its fan-out by the budget instead of dispatching every seat
// at once (the 2026-08-12 16-seat dispatch exhausted the host's memory).
const listOut = await call("peer_list", {});
const list = listOut.peers;
check(
  "all five providers detected on PATH, copilot reporting its pinned model",
  Array.isArray(list) && list.length === 5 && list.every((p) => p.onPath)
    && list.find((p) => p.provider === "copilot")?.model === "gpt-6.1-sol",
  JSON.stringify(list).slice(0, 120),
);
check(
  "fan-out budget rides along and is a sane positive integer",
  Number.isInteger(listOut.maxConcurrent) &&
    listOut.maxConcurrent >= 1 &&
    listOut.maxConcurrent <= 8,
);
check(
  "config surfaced: antigravity carries its tiny cap, codex is the exec-capable seat",
  list.find((p) => p.provider === "antigravity")?.maxInputChars === 2200 &&
    list.find((p) => p.provider === "codex")?.execCapable === true &&
    list.find((p) => p.provider === "grok")?.execCapable === false,
);

// -- prior dispositions -> the do-not-re-raise line ---------------------------
// Read the seeded Dispositions tail mechanically and build the suppression
// line every outbound packet must carry (verb step 2).
const priorDoc = readFileSync(COUNCIL_PATH, "utf8");
const rejected = priorDoc
  .split("\n")
  .map((l) => /^- (REC-\d+) — (.+?) — rejected [\d-]+ — (.+)$/.exec(l))
  .filter(Boolean)
  .map((m) => `${m[1]} (${m[2]} — ${m[3]})`);
const SUPPRESSION =
  "Previously considered and declined — do not re-raise without " +
  `new evidence: ${rejected.join("; ")}`;

// -- leak gate: the poisoned packet never leaves the machine ------------------
console.log("leak gate: seeded credential blocks the packet...");
const POISONED =
  "delivery transcript excerpt:\n$ cairn status\n" +
  "+ const key = 'AKIA" +
  "IOSFODNN7EXAMPLE'\nok.";
const hits = scanLines(POISONED.split("\n"), buildPatterns(DRILL_CONFIG));
check(
  "configured extraPattern catches the seeded credential in the draft packet",
  hits.length > 0,
);
// per the verb's hard rule: a hit blocks that packet's sends, full stop —
// peer_run is never called with it, so no stub captured anything.
check(
  "no peer received the poisoned packet (no capture file exists yet)",
  readdirSync(CAPTURE).length === 0,
);

// -- clean packets, per dimension (redact-and-retry leg) ----------------------
const FOCUS = "full pass — no particular focus";
const FUNC_CONTENT = [
  "docs promise (README, status section): `cairn status` renders one view —",
  "phases, issue states, a drift column, unplanned work.",
  "",
  "delivery transcript (captured verb run):",
  "$ cairn status",
  "phases: 9 planned, 8 verified",
  "issues: 3 open",
  "unplanned: none        <- transcript line 14: no drift column rendered",
  "",
  SUPPRESSION,
].join("\n");
const MARKET_CONTENT = [
  "positioning brief: cairn is a planning-and-memory layer for AI coding",
  "agents — plans, tracker mirror, and peer review councils in one CLI.",
  "competitor shortlist: Cursor, Aider, Devin, Copilot Workspace, OpenHands, Continue.",
  "",
  SUPPRESSION,
].join("\n");
// the exec-capable grant goes ONLY to the seat peer_list marked execCapable.
const EXEC_GRANT =
  "You are exec-capable for this seat: you may run the product " +
  "yourself to check the promise against the delivery.";
const packet = (template, dimension, content, exec = false) =>
  loadTemplate(template, {
    focus: FOCUS,
    dimension,
    content: exec ? `${EXEC_GRANT}\n\n${content}` : content,
  });
const FUNC_PACKETS = {
  codex: packet("council-functionality", "functionality", FUNC_CONTENT, true),
  opencode: packet("council-functionality", "functionality", FUNC_CONTENT),
  antigravity: packet("council-functionality", "functionality", FUNC_CONTENT),
  grok: packet("council-functionality", "functionality", FUNC_CONTENT),
};
const MARKET_PACKET = packet("council-market", "market", MARKET_CONTENT);
for (const p of [...Object.values(FUNC_PACKETS), MARKET_PACKET]) {
  if (scanLines(p.split("\n"), buildPatterns(DRILL_CONFIG)).length > 0) {
    throw new Error("clean packet failed the leak scan — drill content bug");
  }
}

// -- run start + mirror -------------------------------------------------------
// Roster is per SEAT (peer-dimension) so peer_state's peer+round keying
// tracks each dimension's output separately and resume can name the exact
// missing seat.
console.log("run start: 6-seat roster, cairn:council mirror issue...");
const SEATS = [
  "codex-functionality",
  "opencode-functionality",
  "antigravity-functionality",
  "grok-functionality",
  "codex-market",
  "opencode-market",
];
const started = await call("peer_state", {
  op: "start",
  slug: "council-drill",
  mode: "review",
  target: "product council rehearsal — functionality + market",
  focus: FOCUS,
  peers: SEATS,
});
const issue = await call("issue_create", {
  title: "Product council: functionality, market",
  labels: ["cairn:council"],
  body:
    "Two council seats reviewed the product this run: whether the tool does what " +
    "its documentation promises, and how the pitch stands against the market. " +
    "Reviewers: codex, opencode, antigravity, grok.",
});
check(
  "council run started with the 6-seat roster and a cairn:council run issue",
  started.state?.meta?.peers?.length === 6 &&
    issue.labels?.includes("cairn:council"),
  `issue ${issue.id ?? JSON.stringify(issue.__error ?? "").slice(0, 80)}`,
);

// -- dimension fan-out, round 1 (opencode-market deliberately left out) -------
console.log("fan-out: functionality x4, market x1, one seat left hanging...");
const results = {};
for (const p of ["codex", "opencode", "antigravity", "grok"]) {
  results[`${p}-functionality`] = await call("peer_run", {
    provider: p,
    input: FUNC_PACKETS[p],
  });
  await call("peer_state", {
    op: "record_output",
    slug: "council-drill",
    peer: `${p}-functionality`,
    round: 1,
    output: results[`${p}-functionality`].output ?? "",
  });
}
results["codex-market"] = await call("peer_run", {
  provider: "codex",
  input: MARKET_PACKET,
});
await call("peer_state", {
  op: "record_output",
  slug: "council-drill",
  peer: "codex-market",
  round: 1,
  output: results["codex-market"].output ?? "",
});
check(
  "round-1 fan-out: five seats ran, exit 0, replies recorded",
  Object.values(results).every(
    (r) => r.exitCode === 0 && (r.output ?? "").length > 0,
  ),
  JSON.stringify(
    Object.values(results).find((r) => r.__error)?.__error ?? "",
  ).slice(0, 100),
);
check(
  "antigravity's packet trimmed at the configured cap with the marker",
  results["antigravity-functionality"].truncatedInput === true &&
    readFileSync(
      join(CAPTURE, "antigravity.functionality.in"),
      "utf8",
    ).includes("[cairn: input truncated at 2200 chars]"),
);
const codexGot = readFileSync(join(CAPTURE, "codex.functionality.in"), "utf8");
const opencodeGot = readFileSync(
  join(CAPTURE, "opencode.functionality.in"),
  "utf8",
);
check(
  "packets composed per seat: suppression line everywhere, exec grant only to the exec-capable seat",
  codexGot.includes("do not re-raise without new evidence") &&
    codexGot.includes("telemetry dashboard") &&
    opencodeGot.includes("do not re-raise without new evidence") &&
    codexGot.includes(EXEC_GRANT) &&
    !opencodeGot.includes(EXEC_GRANT),
);

// -- resume: the interrupted run names its missing seat -----------------------
console.log("resume: status names the hanging seat, then we complete it...");
const status1 = await call("peer_state", {
  op: "status",
  slug: "council-drill",
});
check(
  "interrupted run's status names the missing seat",
  JSON.stringify(status1.resumable?.peersMissingRound1) ===
    '["opencode-market"]',
  JSON.stringify(status1.resumable?.peersMissingRound1),
);
results["opencode-market"] = await call("peer_run", {
  provider: "opencode",
  input: MARKET_PACKET,
});
await call("peer_state", {
  op: "record_output",
  slug: "council-drill",
  peer: "opencode-market",
  round: 1,
  output: results["opencode-market"].output ?? "",
});
const status2 = await call("peer_state", {
  op: "status",
  slug: "council-drill",
});
check(
  "completing the seat clears the resume gap",
  status2.resumable?.peersMissingRound1?.length === 0,
);

// -- parse + record findings --------------------------------------------------
console.log("parsing replies, recording findings...");
const ids = {};
for (const seat of [
  "codex-functionality",
  "opencode-functionality",
  "antigravity-functionality",
  "grok-functionality",
]) {
  const parsed = parseFindings(results[seat].output);
  const rec = await call("peer_state", {
    op: "record_findings",
    slug: "council-drill",
    peer: seat,
    round: 1,
    findings: parsed.findings,
  });
  ids[seat] = rec.ids;
}
const statusAll = await call("peer_state", {
  op: "status",
  slug: "council-drill",
});
const drifters = statusAll.findings.filter((f) =>
  f.finding.claim.includes("drift"),
);
check(
  "cluster + singleton recorded: 4 findings, 3-seat near-duplicate cluster on one topic",
  statusAll.findings.length === 4 &&
    drifters.length === 3 &&
    new Set(drifters.map((f) => f.peer)).size === 3,
);
const marketParsed = parseFindings(results["codex-market"].output);
check(
  "prose-only market reply lands unparsed-but-preserved",
  marketParsed.findings.length === 0 &&
    marketParsed.unparsed.length === 1 &&
    marketParsed.unparsed[0].includes("commentary, not findings"),
);

// -- verdicts: convergence + the discard leg ----------------------------------
console.log("adjudication: cluster converges, singleton dies...");
const early = await call("peer_state", { op: "close", slug: "council-drill" });
check(
  "runClose refuses while findings sit unjudged",
  Boolean(early.__error) &&
    JSON.stringify(early.__error).includes("unresolved"),
);
const [clusterId, ...clusterRest] = drifters.map((f) => f.id);
const singletonId = statusAll.findings.find(
  (f) => !f.finding.claim.includes("drift"),
).id;
const verified = await call("peer_state", {
  op: "verdict",
  slug: "council-drill",
  findingId: clusterId,
  verdict: "verified",
  note:
    "converged: raised independently by codex, opencode, antigravity (round 1); " +
    "verified against the captured transcript",
});
for (const id of clusterRest) {
  await call("peer_state", {
    op: "verdict",
    slug: "council-drill",
    findingId: id,
    verdict: "dead",
    note: `merged into the ${clusterId} cluster`,
  });
}
const dead = await call("peer_state", {
  op: "verdict",
  slug: "council-drill",
  findingId: singletonId,
  verdict: "dead",
  note: "single seat, no evidence location — discarded under the evidence-or-discarded floor",
});
check(
  "3-seat cluster converges to verified with the peers named in the note",
  verified.verdict === "verified" &&
    ["codex", "opencode", "antigravity"].every((p) =>
      (verified.note ?? "").includes(p),
    ),
);
check(
  "low-evidence singleton dies",
  dead.verdict === "dead" && (dead.note ?? "").includes("discarded"),
);

// -- COUNCIL.md: run block, markers, typed REC, dispositions tail -------------
console.log("report: COUNCIL.md run block with council markers...");
const NEW_BLOCK = [
  `# Council — ${DATE}`,
  "",
  "## Functionality",
  `<!-- council: done ${DATE} -->`,
  "Seats: codex, opencode, antigravity, grok. Converged finding: the documented",
  "drift column never renders in the captured status transcript (3 seats,",
  "round 1, verified). One evidence-free claim discarded in adjudication.",
  "",
  "## Market",
  "<!-- council: pending -->",
  "codex spoke prose (kept verbatim as research); opencode returned an explicit",
  "empty review. No structured findings this run.",
  "",
  "### REC-1",
  "- dimensions: functionality",
  "- convergence: raised independently by codex, opencode, antigravity, round 1; verified against the captured transcript",
  "- proposal: new issues in phase 9",
  "- effort: ~2 pts",
  "- status: proposed",
  "",
].join("\n");
const NEW_DISPOSITIONS = [
  "## Dispositions",
  `- REC-1 — new issues in phase 9 — approved ${DATE} — ${issue.id}`,
  ...PRIOR_DISPOSITIONS.split("\n").filter((l) => l.startsWith("- ")),
  "",
].join("\n");
writeFileSync(
  COUNCIL_PATH,
  `${NEW_BLOCK}\n${PRIOR_BLOCK}\n${NEW_DISPOSITIONS}`,
);
const parsedDoc = await call("research_sections", {
  path: ".cairn/plans/COUNCIL.md",
  namespace: "council",
});
const sec = (report, heading) =>
  report.sections?.find((s) => s.heading === heading);
check(
  "COUNCIL.md parses through research_sections: functionality done, market pending",
  sec(parsedDoc, "Functionality")?.state === "done" &&
    sec(parsedDoc, "Market")?.state === "pending" &&
    sec(parsedDoc, "REC-1")?.state === "unmarked",
);
const flipped = await call("research_sections", {
  path: ".cairn/plans/COUNCIL.md",
  namespace: "council",
  flip: { heading: "Market", state: "done", date: DATE },
});
check(
  "market's marker flips to done through the server, states correct after",
  flipped.flipped === "Market" &&
    sec(flipped, "Market")?.state === "done" &&
    sec(flipped, "Functionality")?.state === "done",
);

// -- tracker mirror: progress, dispositions, close ----------------------------
console.log("mirror: progress comment, disposition-enumerating close...");
await call("issue_comment", {
  id: issue.id,
  text:
    "Functionality seat has converged: three reviewers independently flagged the " +
    "same documentation gap, verified before recording. Market seat returned " +
    "commentary only — nothing structured survived.",
});
await call("issue_comment", {
  id: issue.id,
  text:
    "Council dispositions, one line each:\n" +
    "REC-1 — new work items in phase 9 — approved; tracked as a follow-up.\n" +
    "REC-3 — new phase 9.5 — remains rejected; no new evidence arrived this run.",
});
await call("issue_close", { id: issue.id });
check(
  "run issue closed after the disposition-enumerating comment",
  (await call("issue_get", { id: issue.id })).state === "closed",
);

// -- teardown: close + provenance-credited record -----------------------------
console.log("teardown: runClose, audit record from the records...");
const closed = await call("peer_state", { op: "close", slug: "council-drill" });
const rec = await call("audit_record", {
  scope: "peers-council-drill",
  verdict: closed.verdict,
  findings: closed.findings,
});
const recText = readFileSync(rec.path, "utf8");
check(
  "record credits seat + round from the run's records, survivors and discards both",
  closed.verdict === "findings" &&
    recText.includes("codex-functionality round 1") &&
    recText.includes("verdict verified") &&
    recText.includes("grok-functionality round 1") &&
    recText.includes("verdict dead"),
);

await client.close();
const failed = checks.filter(([, ok]) => !ok);
console.log(
  `\n${failed.length === 0 ? "DRILL PASS" : "DRILL FAIL"} — ${checks.length - failed.length}/${checks.length} checks`,
);
process.exit(failed.length === 0 ? 0 : 1);
