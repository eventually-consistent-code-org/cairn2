# Context Economy Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what a session's context actually costs, then move the auto-compact threshold from window-safety (~900k) to cost-optimal (~200k) with the artifact contract and boundary measurement that prove it safe.

**Architecture:** The Stop hook already makes one forward pass over the session transcript every 30s; residency accounting rides that pass and needs no second read. Pure analysis functions live in a new `server/src/context/` module and take parsed data as parameters, so they unit-test without a tracker or a git repo. The threshold itself is a harness environment variable — cairn records the desired value, reports drift between desired and live, and never silently edits the user's settings.

**Tech Stack:** TypeScript (server, vitest), dependency-free Node ESM (hook scripts), `better-sqlite3` + `zod` + `@modelcontextprotocol/*` only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-context-economy-layer-design.md`

**Scope:** Phases A and B of the spec's five. Phases C, D and E are each gated on a measurement this plan produces; they get their own plans once those gates report.

## Global Constraints

- **Hook scripts may never import server code.** Node builtins and `hooks/scripts/lib.mjs` only. Duplication across the hook/server boundary is deliberate and already practised (`metricsSegments` exists on both sides).
- **Hooks are fire-and-forget.** Wrap `main()` in try/catch that swallows, and always `process.exit(0)`. A hook must never be why a session stops.
- **`server/dist` is committed.** Any commit touching `server/src` must run `cd server && npm run build` and commit `server/dist` in the same logical unit. `node scripts/check-dist.mjs` enforces it.
- **Tool-count pins move together.** Registering one MCP tool changes `server/test/mcp.test.ts:175` and `server/test/standalone.test.ts:18,41` from 86 to 87. `check-surface` self-computes and needs no edit.
- **Guards run from the repo root, tests from `server/`.** Root `package.json` has no scripts field; every root tool is `node scripts/<name>.mjs`.
- **Never write a planning-directory path literal** (the dot-cairn directory name followed by a slash) in files outside `server/src/` and `server/dist/`. The PreToolUse leak guard blocks that pattern in staged changes, and this plan is itself written around it. Build paths from separate segments — `join(home, ".cairn", "state")` — which never match.
- **Architecture rules are enforced by `server/test/architecture.test.ts`:** no import cycles, `index.ts` is the composition root and nothing imports it back. Keep `server/src/context/` free of imports from `index.ts`.
- **The layer pays its own rent.** Total new resident footprint must stay under 500 estimated tokens — one MCP tool, terse description.
- **Conventional commits.** The repo-local git identity (`eventually-consistent-code`) is already configured; never override it.
- **Estimated tokens are `chars / 4`** everywhere in this codebase, matching `scripts/check-footprint.mjs`. Do not introduce a tokenizer dependency.

---

### Task 1: Residency accounting in the Stop hook

The meter's arithmetic. Residency is `tokens x turns_remaining`, which naively needs every item held in memory until the turn count is known. It does not: `Σ tok_i x (N - turn_i)` expands to `N x Σtok_i - Σ(tok_i x turn_i)`, so two running sums per producer give exact residency in one pass with constant memory.

**Files:**
- Modify: `hooks/scripts/stop-costtracker.mjs` (the `scanTranscript` totals object, its assistant branch, and the `row` literal in `main`)
- Test: `server/test/hooks.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: new metrics-row field `context`, shape:
  ```js
  context: {
    turns: number,              // assistant entries carrying usage
    turns_sidechain: number,    // of those, isSidechain === true
    ctx_sum: number,            // Σ per-turn (input + cache_read + cache_write)
    prefix_tokens: number,      // first turn's cache_creation_input_tokens
    bands: { under150k: number, to300k: number, to500k: number, over500k: number },
    residency: { tool_result: number, tool_call: number, user_text: number,
                 assistant_text: number, thinking: number },
  }
  ```
  Task 4 reads these fields. Task 3 reads `ctx_sum` as a session's rent.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` block that covers the cost tracker in `server/test/hooks.test.ts` (search for `COSTTRACKER` to find it; if no such constant exists, add `const COSTTRACKER = join(SCRIPTS, "stop-costtracker.mjs");` beside the other script constants at the top of the file).

```typescript
it("records residency, bands and prefix alongside the cost totals", () => {
  const proj = freshDir("cairn-resid-");
  const home = freshDir("cairn-resid-home-");
  const transcript = join(proj, "t.jsonl");

  // Three assistant turns. Contexts: 100k, 200k, 400k -> one turn in each of
  // the first three bands. A 40k tool_result lands on turn 1, so it is
  // resident for the two turns that follow: residency 40000 * 2 = 80000.
  const turn = (cacheRead: number, cacheWrite: number, extra: object = {}) => JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      usage: { input_tokens: 0, output_tokens: 10,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
      content: [{ type: "text", text: "ok" }],
    },
    ...extra,
  });
  const result = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(160_000) }] },
  });

  writeFileSync(transcript, [
    turn(0, 100_000),        // turn 1, ctx 100k
    result,                  // 160k chars / 4 = 40k tokens, entering at turn 1
    turn(200_000, 0),        // turn 2, ctx 200k
    turn(400_000, 0),        // turn 3, ctx 400k
  ].join("\n") + "\n");

  runHook(COSTTRACKER, proj, home, {
    CLAUDE_PROJECT_DIR: proj,
  }, JSON.stringify({ transcript_path: transcript, session_id: "s-resid" }));

  const metricsDir = join(home, ".cairn", "metrics");
  const file = join(metricsDir, readdirSync(metricsDir)[0]);
  const row = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!);

  expect(row.context.turns).toBe(3);
  expect(row.context.turns_sidechain).toBe(0);
  expect(row.context.ctx_sum).toBe(700_000);
  expect(row.context.prefix_tokens).toBe(100_000);
  expect(row.context.bands).toEqual({ under150k: 1, to300k: 1, to500k: 1, over500k: 0 });
  expect(row.context.residency.tool_result).toBe(80_000);
});
```

`runHook` in this file takes `(script, projectDir, home, extraEnv)` and does not pass stdin. Add a fifth parameter for it — find the `execFileSync` call inside `runHook` and add `input: stdin,` to its options object, with the signature gaining `stdin = ""`. Existing callers are unaffected by a defaulted trailing parameter.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/hooks.test.ts -t "records residency, bands and prefix"
```

Expected: FAIL — `row.context` is `undefined`.

- [ ] **Step 3: Extend the totals object**

In `hooks/scripts/stop-costtracker.mjs`, replace the `totals` initialiser at the top of `scanTranscript`:

```js
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: new Set(),
    reportBytes: 0, reports: 0, reportTasks: 0, contextPeak: 0,
    // Context economy (#TBD-issue): the same forward pass, two extra running
    // sums per producer. Residency is tokens x turns-remaining, and
    //   Σ tok_i x (N - turn_i)  ==  N x Σtok_i - Σ(tok_i x turn_i)
    // so exact residency needs no per-item memory -- only the turn count N,
    // which is known once the pass ends.
    turns: 0, turnsSidechain: 0, ctxSum: 0, prefixTokens: 0,
    bands: { under150k: 0, to300k: 0, to500k: 0, over500k: 0 },
    residTok: Object.create(null),      // producer -> Σ tokens
    residTokTurn: Object.create(null),  // producer -> Σ (tokens x entry turn)
  };
```

- [ ] **Step 4: Accumulate per turn and per producer**

Still in `scanTranscript`, inside the `if (entry?.type === "assistant")` branch, immediately after the existing `totals.contextPeak = Math.max(...)` line, add:

```js
        totals.turns += 1;
        if (entry.isSidechain) totals.turnsSidechain += 1;
        const ctx = inTok + cacheW + cacheR;
        totals.ctxSum += ctx;
        if (totals.turns === 1) totals.prefixTokens = cacheW;
        if (ctx < 150_000) totals.bands.under150k += 1;
        else if (ctx < 300_000) totals.bands.to300k += 1;
        else if (ctx < 500_000) totals.bands.to500k += 1;
        else totals.bands.over500k += 1;
```

Then, still inside the `for (const line of raw.split("\n"))` loop but **after** the assistant branch closes, add the producer accounting. Place it just before the loop's closing brace:

```js
    // Producer accounting. `totals.turns` is the turn index this content
    // entered at -- content is always attributed to the turn in flight.
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const b of blocks) {
      let kind = null;
      let chars = 0;
      if (b?.type === "tool_result") {
        kind = "tool_result";
        chars = contentText(b.content).length;
      } else if (b?.type === "tool_use") {
        kind = "tool_call";
        chars = JSON.stringify(b.input ?? {}).length;
      } else if (b?.type === "text") {
        kind = entry.type === "user" ? "user_text" : "assistant_text";
        chars = (b.text ?? "").length;
      } else if (b?.type === "thinking") {
        kind = "thinking";
        chars = (b.thinking ?? "").length;
      }
      if (!kind || !chars) continue;
      const tok = Math.round(chars / 4);
      totals.residTok[kind] = (totals.residTok[kind] ?? 0) + tok;
      totals.residTokTurn[kind] = (totals.residTokTurn[kind] ?? 0) + tok * totals.turns;
    }
```

The existing cheap prefilter at the top of the loop skips lines without `"usage"`, `tool_result`, `tool_use`, or `task-notification`. A plain assistant text turn always carries `"usage"`, and a plain user text turn carries none of them — so user prose is invisible to this accounting. Widen the prefilter by adding `&& !line.includes('"type":"user"')` to the skip condition:

```js
    if (!hasUsage && !line.includes("tool_result") && !line.includes("tool_use")
      && !line.includes("task-notification") && !line.includes('"type":"user"')) continue;
```

- [ ] **Step 5: Emit the row field**

In `main`, add to the `row` literal immediately after `context_peak_tokens`:

```js
    // Context economy: residency is token-turns, the unit cache_read
    // actually bills in. See the residency note in scanTranscript.
    context: {
      turns: totals.turns,
      turns_sidechain: totals.turnsSidechain,
      ctx_sum: totals.ctxSum,
      prefix_tokens: totals.prefixTokens,
      bands: totals.bands,
      residency: Object.fromEntries(
        Object.keys(totals.residTok).map((k) => [
          k, totals.turns * totals.residTok[k] - totals.residTokTurn[k],
        ]),
      ),
    },
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd server && npx vitest run test/hooks.test.ts -t "records residency, bands and prefix"
```

Expected: PASS.

- [ ] **Step 7: Run the whole hook suite for regressions**

```bash
cd server && npx vitest run test/hooks.test.ts
```

Expected: all pass. The widened prefilter makes the pass see more lines; confirm the existing `report_bytes` assertions still hold.

- [ ] **Step 8: Commit**

```bash
git add hooks/scripts/stop-costtracker.mjs server/test/hooks.test.ts
git commit -m "feat(metrics): residency, bands and prefix on the cost row

Residency is tokens x turns-remaining -- the unit cache_read bills in.
Expanding the sum to N x Σtok - Σ(tok x turn) makes it exact from two
running sums per producer, so it rides the Stop hook's existing forward
pass with no per-item memory and no second read."
```

---

### Task 2: Live meter state file

The row is written at most every 30s and is append-only history. A band signal and the boundary analysis in Task 8 both need the *current* session's position, addressable without parsing a metrics log. This writes it.

**Files:**
- Modify: `hooks/scripts/lib.mjs` (add `meterPath`)
- Modify: `hooks/scripts/stop-costtracker.mjs` (write the state file in `main`)
- Test: `server/test/hooks.test.ts`

**Interfaces:**
- Consumes: `totals` from Task 1's `scanTranscript`.
- Produces: `meterPath(projectDir)` exported from `lib.mjs`, and a JSON file with shape:
  ```js
  { session_id: string, ts: string, transcript_path: string,
    turns: number, ctx_last: number, band: "under150k"|"to300k"|"to500k"|"over500k",
    prefix_tokens: number }
  ```
  Task 8 reads `transcript_path` from it.

- [ ] **Step 1: Write the failing test**

```typescript
it("writes a live meter state file naming the current band", () => {
  const proj = freshDir("cairn-meter-");
  const home = freshDir("cairn-meter-home-");
  const transcript = join(proj, "t.jsonl");
  const turn = (cacheRead: number, cacheWrite: number) => JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      usage: { input_tokens: 0, output_tokens: 5,
        cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
      content: [{ type: "text", text: "ok" }],
    },
  });
  writeFileSync(transcript, [turn(0, 80_000), turn(420_000, 0)].join("\n") + "\n");

  runHook(COSTTRACKER, proj, home, { CLAUDE_PROJECT_DIR: proj },
    JSON.stringify({ transcript_path: transcript, session_id: "s-meter" }));

  const { base, hash } = hashAndBase(proj);
  const meter = JSON.parse(readFileSync(
    join(home, ".cairn", "state", `${base}-${hash}-meter.json`), "utf8"));

  expect(meter.session_id).toBe("s-meter");
  expect(meter.turns).toBe(2);
  expect(meter.ctx_last).toBe(420_000);
  expect(meter.band).toBe("to500k");
  expect(meter.prefix_tokens).toBe(80_000);
  expect(meter.transcript_path).toBe(transcript);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/hooks.test.ts -t "writes a live meter state file"
```

Expected: FAIL — ENOENT on the meter path.

- [ ] **Step 3: Add `meterPath` to lib.mjs**

In `hooks/scripts/lib.mjs`, beside the other path helpers (each follows the same `pathHash` convention — copy the shape of `loopStatePath`):

```js
/** Live context-meter state for one project: current band and turn count. */
export function meterPath(projectDir) {
  const base = basename(resolve(projectDir));
  return join(homedir(), ".cairn", "state", `${base}-${pathHash(projectDir)}-meter.json`);
}
```

If `resolve`, `basename` or `homedir` are not already imported in this file, extend the existing import lines rather than adding new ones — match what the neighbouring helpers use.

- [ ] **Step 4: Track the last context and write the file**

In `stop-costtracker.mjs`, add `ctxLast: 0,` to the `totals` initialiser, and set it in the assistant branch right after `totals.ctxSum += ctx;`:

```js
        totals.ctxLast = ctx;
```

Change the `lib.mjs` import at the top of the file to bring in the new helper:

```js
import { atomicWriteJson, meterPath, metricsPath } from "./lib.mjs";
```

Then in `main`, after the `appendFileSync(path, ...)` line, add:

```js
  // Live position, addressable without parsing the append-only log. The row
  // is history; this is where the session is standing right now.
  const band = totals.ctxLast < 150_000 ? "under150k"
    : totals.ctxLast < 300_000 ? "to300k"
      : totals.ctxLast < 500_000 ? "to500k" : "over500k";
  atomicWriteJson(meterPath(projectDir), {
    session_id: payload.session_id,
    ts: row.ts,
    transcript_path: payload.transcript_path,
    turns: totals.turns,
    ctx_last: totals.ctxLast,
    band,
    prefix_tokens: totals.prefixTokens,
  });
```

`atomicWriteJson` already creates parent directories; confirm by reading its body in `lib.mjs` and add `mkdirSync(dirname(...), { recursive: true })` before the call only if it does not.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd server && npx vitest run test/hooks.test.ts -t "writes a live meter state file"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add hooks/scripts/lib.mjs hooks/scripts/stop-costtracker.mjs server/test/hooks.test.ts
git commit -m "feat(metrics): live context-meter state file

The metrics row is append-only history written at most every 30s. The
band signal and boundary analysis both need where the session is
standing now, addressable without parsing a log."
```

---

### Task 3: Rent attribution

Rent per unit of delivered work, computed from timestamps rather than the active-context tag — which covers 7 of 33 recorded sessions and names 4 distinct issues in total. Pure functions taking already-fetched data, so they test without a tracker or a git repo.

**Files:**
- Create: `server/src/context/attribution.ts`
- Create: `server/test/attribution.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (callers supply the data).
- Produces:
  ```ts
  export interface SessionSpan { sessionId: string; startedAt: string; endedAt: string; rent: number }
  export interface WorkItem { id: string; closedAt: string; kind: "issue" | "commit" }
  export interface ItemRent { id: string; kind: "issue" | "commit"; rent: number; sessions: string[] }
  export interface RentAttribution {
    items: ItemRent[];
    unclaimedRent: number;       // rent from sessions that closed nothing
    orphanItems: string[];       // items closed inside no session span
    rentPerItem: number;         // attributed rent / item count, 0 when none
  }
  export function attributeRent(spans: SessionSpan[], items: WorkItem[]): RentAttribution;
  ```
  Task 4 calls `attributeRent`.

- [ ] **Step 1: Write the failing test**

Create `server/test/attribution.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { attributeRent } from "../src/context/attribution.js";

const span = (sessionId: string, startedAt: string, endedAt: string, rent: number) =>
  ({ sessionId, startedAt, endedAt, rent });
const item = (id: string, closedAt: string, kind: "issue" | "commit" = "issue") =>
  ({ id, closedAt, kind });

describe("rent attribution", () => {
  it("splits a session's rent evenly across the items it closed", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 1000)],
      [item("#1", "2026-09-01T10:30:00Z"), item("#2", "2026-09-01T11:30:00Z")],
    );
    expect(out.items).toEqual([
      { id: "#1", kind: "issue", rent: 500, sessions: ["s1"] },
      { id: "#2", kind: "issue", rent: 500, sessions: ["s1"] },
    ]);
    expect(out.rentPerItem).toBe(500);
    expect(out.unclaimedRent).toBe(0);
  });

  it("shares an item across every session whose span contains it", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 1000),
       span("s2", "2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z", 400)],
      [item("#1", "2026-09-01T11:30:00Z")],
    );
    expect(out.items).toEqual([
      { id: "#1", kind: "issue", rent: 1400, sessions: ["s1", "s2"] },
    ]);
  });

  it("counts rent from a session that closed nothing as unclaimed", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 900)],
      [],
    );
    expect(out.unclaimedRent).toBe(900);
    expect(out.items).toEqual([]);
    expect(out.rentPerItem).toBe(0);
  });

  it("reports an item closed inside no span as an orphan, not as free work", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z", 100)],
      [item("#9", "2026-09-05T10:00:00Z")],
    );
    expect(out.orphanItems).toEqual(["#9"]);
    expect(out.items).toEqual([]);
    expect(out.unclaimedRent).toBe(100);
  });

  it("dedupes a commit and an issue that name the same work", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 600)],
      [item("#4", "2026-09-01T10:30:00Z", "issue"),
       item("#4", "2026-09-01T10:31:00Z", "commit")],
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toEqual({ id: "#4", kind: "issue", rent: 600, sessions: ["s1"] });
  });

  it("tolerates an unparseable timestamp by treating the item as an orphan", () => {
    const out = attributeRent(
      [span("s1", "2026-09-01T10:00:00Z", "2026-09-01T12:00:00Z", 300)],
      [item("#7", "not-a-date")],
    );
    expect(out.orphanItems).toEqual(["#7"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/attribution.test.ts
```

Expected: FAIL — cannot resolve `../src/context/attribution.js`.

- [ ] **Step 3: Write the implementation**

Create `server/src/context/attribution.ts`:

```typescript
/**
 * Rent per unit of delivered work.
 *
 * The obvious denominator -- whatever issue the active-context tag named when
 * a session stopped -- covers 7 of 33 recorded sessions and 4 distinct issues
 * in total. So work is counted from durable timestamped facts instead: issues
 * the tracker closed and commits the repo landed, joined to the session spans
 * they fall inside. Nothing here fetches; callers supply both lists, which is
 * what makes it testable without a tracker or a git repo.
 */

export interface SessionSpan {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  /** cache_read tokens this session paid -- the `ctx_sum` metrics field. */
  rent: number;
}

export interface WorkItem {
  id: string;
  closedAt: string;
  kind: "issue" | "commit";
}

export interface ItemRent {
  id: string;
  kind: "issue" | "commit";
  rent: number;
  sessions: string[];
}

export interface RentAttribution {
  items: ItemRent[];
  /** Rent from sessions that closed nothing -- overhead, not free. */
  unclaimedRent: number;
  /** Items closed inside no session span; reported, never silently dropped. */
  orphanItems: string[];
  rentPerItem: number;
}

/** Epoch ms, or null when the stamp cannot be trusted. */
function stamp(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * An item is attributed to every session whose span contains its close, and a
 * session's rent divides evenly among the items it closed. A session spanning
 * two closes therefore contributes half its rent to each; an item closed
 * during two overlapping sessions carries rent from both. Double-counting
 * across overlapping sessions is deliberate -- both sessions really did pay.
 *
 * :param spans: session spans with their rent
 * :param items: work items with close timestamps
 * :returns attribution with unclaimed rent and orphans reported separately
 */
export function attributeRent(spans: SessionSpan[], items: WorkItem[]): RentAttribution {
  // An issue and the commit that closed it are one delivery, not two. Issue
  // wins: it is the unit the tracker -- and the human -- counts in.
  const byId = new Map<string, WorkItem>();
  for (const it of items) {
    const prior = byId.get(it.id);
    if (!prior || (prior.kind === "commit" && it.kind === "issue")) byId.set(it.id, it);
  }

  const claimed = new Map<string, { item: WorkItem; sessions: string[] }>();
  const orphanItems: string[] = [];

  for (const it of byId.values()) {
    const at = stamp(it.closedAt);
    const sessions = at === null ? [] : spans
      .filter((s) => {
        const from = stamp(s.startedAt);
        const to = stamp(s.endedAt);
        return from !== null && to !== null && at >= from && at <= to;
      })
      .map((s) => s.sessionId);
    if (sessions.length === 0) orphanItems.push(it.id);
    else claimed.set(it.id, { item: it, sessions });
  }

  const countBySession = new Map<string, number>();
  for (const { sessions } of claimed.values()) {
    for (const s of sessions) countBySession.set(s, (countBySession.get(s) ?? 0) + 1);
  }

  const rentBySession = new Map(spans.map((s) => [s.sessionId, s.rent]));
  const items_: ItemRent[] = [...claimed.values()].map(({ item, sessions }) => ({
    id: item.id,
    kind: item.kind,
    rent: sessions.reduce(
      (sum, s) => sum + (rentBySession.get(s) ?? 0) / (countBySession.get(s) ?? 1), 0),
    sessions,
  }));

  const unclaimedRent = spans
    .filter((s) => !countBySession.has(s.sessionId))
    .reduce((sum, s) => sum + s.rent, 0);

  const totalAttributed = items_.reduce((sum, i) => sum + i.rent, 0);
  return {
    items: items_,
    unclaimedRent,
    orphanItems,
    rentPerItem: items_.length === 0 ? 0 : totalAttributed / items_.length,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npx vitest run test/attribution.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Verify the architecture rules still hold**

```bash
cd server && npx vitest run test/architecture.test.ts
```

Expected: PASS. The new module imports nothing, so no cycle is possible.

- [ ] **Step 6: Build and commit with dist**

```bash
cd server && npm run build && cd ..
node scripts/check-dist.mjs
git add server/src/context/attribution.ts server/test/attribution.test.ts server/dist
git commit -m "feat(context): attribute rent to work items by timestamp

The active-context tag covers 7 of 33 recorded sessions and names 4
distinct issues, so it cannot be the denominator. Closes and commits
are timestamped and durable; joining them to session spans gives a
per-work-item figure derivable retroactively over the whole history.

Overlapping sessions both carry the item deliberately -- both paid."
```

---

### Task 4: The `context_meter` MCP tool

One tool, the layer's entire resident cost. It reads metrics rows and reports the rollup; it computes no residency of its own, because the hook already did that in a pass it was making anyway.

**Files:**
- Create: `server/src/context/meter.ts`
- Modify: `server/src/index.ts` (register the tool)
- Modify: `server/test/mcp.test.ts:175` and `server/test/standalone.test.ts:18,41` (pin 86 → 87)
- Create: `server/test/context-meter.test.ts`

**Interfaces:**
- Consumes: the `context` row field from Task 1; `attributeRent` from Task 3.
- Produces:
  ```ts
  export interface MetricsRow {
    ts: string; session_id: string; cache_read_tokens?: number;
    context?: { turns: number; turns_sidechain: number; ctx_sum: number;
      prefix_tokens: number;
      bands: { under150k: number; to300k: number; to500k: number; over500k: number };
      residency: Record<string, number> };
  }
  export interface MeterReport {
    sessions: number; turns: number; rent: number;
    avgContextPerTurn: number;
    sidechainTurnShare: number;      // 0..1
    bandRentShare: Record<string, number>;
    residency: Record<string, number>;
    prefixTokens: { p50: number; max: number };
  }
  export function summarise(rows: MetricsRow[]): MeterReport;
  export function sessionSpans(rows: MetricsRow[]): SessionSpan[];
  ```

- [ ] **Step 1: Write the failing test**

Create `server/test/context-meter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { summarise, sessionSpans } from "../src/context/meter.js";

const row = (sessionId: string, ts: string, over: Partial<{
  turns: number; sidechain: number; ctxSum: number; prefix: number;
}> = {}) => ({
  ts,
  session_id: sessionId,
  cache_read_tokens: over.ctxSum ?? 0,
  context: {
    turns: over.turns ?? 10,
    turns_sidechain: over.sidechain ?? 0,
    ctx_sum: over.ctxSum ?? 1_000_000,
    prefix_tokens: over.prefix ?? 40_000,
    bands: { under150k: 5, to300k: 3, to500k: 2, over500k: 0 },
    residency: { tool_result: 800, tool_call: 200 },
  },
});

describe("context meter", () => {
  it("takes the latest row per session — rows are cumulative", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z", { turns: 5, ctxSum: 500_000 }),
      row("s1", "2026-09-01T11:00:00Z", { turns: 20, ctxSum: 4_000_000 }),
    ]);
    expect(out.sessions).toBe(1);
    expect(out.turns).toBe(20);
    expect(out.rent).toBe(4_000_000);
  });

  it("reports average context per turn and the sidechain turn share", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z", { turns: 10, sidechain: 6, ctxSum: 2_000_000 }),
    ]);
    expect(out.avgContextPerTurn).toBe(200_000);
    expect(out.sidechainTurnShare).toBeCloseTo(0.6);
  });

  it("aggregates residency across sessions", () => {
    const out = summarise([
      row("s1", "2026-09-01T10:00:00Z"),
      row("s2", "2026-09-01T10:00:00Z"),
    ]);
    expect(out.residency).toEqual({ tool_result: 1600, tool_call: 400 });
  });

  it("survives rows written before the context field existed", () => {
    const out = summarise([
      { ts: "2026-08-01T10:00:00Z", session_id: "old", cache_read_tokens: 5_000 },
    ]);
    expect(out.sessions).toBe(1);
    expect(out.turns).toBe(0);
    expect(out.avgContextPerTurn).toBe(0);
  });

  it("derives session spans from first and last row timestamps", () => {
    const spans = sessionSpans([
      row("s1", "2026-09-01T10:00:00Z", { ctxSum: 100 }),
      row("s1", "2026-09-01T12:00:00Z", { ctxSum: 900 }),
    ]);
    expect(spans).toEqual([
      { sessionId: "s1", startedAt: "2026-09-01T10:00:00Z",
        endedAt: "2026-09-01T12:00:00Z", rent: 900 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/context-meter.test.ts
```

Expected: FAIL — cannot resolve `../src/context/meter.js`.

- [ ] **Step 3: Write the implementation**

Create `server/src/context/meter.ts`:

```typescript
/**
 * Rollup over the metrics rows the Stop hook writes.
 *
 * Computes nothing the hook already computed: residency rides the hook's
 * existing forward pass, and re-deriving it here would read every transcript
 * a second time to learn what a row already says.
 *
 * Rows are CUMULATIVE per session -- the latest row for a session_id is that
 * session's whole record, and summing rows would multiply-count every one.
 */
import type { SessionSpan } from "./attribution.js";

export interface MetricsRow {
  ts: string;
  session_id: string;
  cache_read_tokens?: number;
  context?: {
    turns: number;
    turns_sidechain: number;
    ctx_sum: number;
    prefix_tokens: number;
    bands: { under150k: number; to300k: number; to500k: number; over500k: number };
    residency: Record<string, number>;
  };
}

export interface MeterReport {
  sessions: number;
  turns: number;
  rent: number;
  avgContextPerTurn: number;
  sidechainTurnShare: number;
  bandRentShare: Record<string, number>;
  residency: Record<string, number>;
  prefixTokens: { p50: number; max: number };
}

/** Latest row per session id; a row with an unparseable ts loses to any other. */
function latestPerSession(rows: MetricsRow[]): MetricsRow[] {
  const best = new Map<string, MetricsRow>();
  for (const r of rows) {
    const prior = best.get(r.session_id);
    if (!prior) { best.set(r.session_id, r); continue; }
    const a = Date.parse(r.ts);
    const b = Date.parse(prior.ts);
    if (!Number.isNaN(a) && (Number.isNaN(b) || a >= b)) best.set(r.session_id, r);
  }
  return [...best.values()];
}

/**
 * :param rows: metrics rows, any number per session
 * :returns the rollup across the latest row of each session
 */
export function summarise(rows: MetricsRow[]): MeterReport {
  const latest = latestPerSession(rows);
  let turns = 0;
  let sidechain = 0;
  let rent = 0;
  const residency: Record<string, number> = {};
  const bandTurns: Record<string, number> = {
    under150k: 0, to300k: 0, to500k: 0, over500k: 0,
  };
  const prefixes: number[] = [];

  for (const r of latest) {
    rent += r.context?.ctx_sum ?? r.cache_read_tokens ?? 0;
    const c = r.context;
    if (!c) continue;
    turns += c.turns;
    sidechain += c.turns_sidechain;
    if (c.prefix_tokens > 0) prefixes.push(c.prefix_tokens);
    for (const [k, v] of Object.entries(c.bands)) bandTurns[k] = (bandTurns[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.residency)) residency[k] = (residency[k] ?? 0) + v;
  }

  const totalBandTurns = Object.values(bandTurns).reduce((a, b) => a + b, 0);
  const bandRentShare = Object.fromEntries(
    Object.entries(bandTurns).map(([k, v]) => [k, totalBandTurns === 0 ? 0 : v / totalBandTurns]),
  );
  prefixes.sort((a, b) => a - b);

  return {
    sessions: latest.length,
    turns,
    rent,
    avgContextPerTurn: turns === 0 ? 0 : Math.round(rent / turns),
    sidechainTurnShare: turns === 0 ? 0 : sidechain / turns,
    bandRentShare,
    residency,
    prefixTokens: {
      p50: prefixes.length === 0 ? 0 : prefixes[Math.floor(prefixes.length / 2)],
      max: prefixes.length === 0 ? 0 : prefixes[prefixes.length - 1],
    },
  };
}

/**
 * Session spans for attribution: first and last row timestamp, and the rent
 * from the latest row (rows being cumulative, the latest one is the total).
 *
 * :param rows: metrics rows, any number per session
 * :returns one span per session id
 */
export function sessionSpans(rows: MetricsRow[]): SessionSpan[] {
  const byId = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    const list = byId.get(r.session_id);
    if (list) list.push(r); else byId.set(r.session_id, [r]);
  }
  const spans: SessionSpan[] = [];
  for (const [sessionId, list] of byId) {
    const sorted = [...list].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const last = sorted[sorted.length - 1];
    spans.push({
      sessionId,
      startedAt: sorted[0].ts,
      endedAt: last.ts,
      rent: last.context?.ctx_sum ?? last.cache_read_tokens ?? 0,
    });
  }
  return spans;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npx vitest run test/context-meter.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Register the tool**

In `server/src/index.ts`, beside the other read-only registrations (place it after the `context_set` registration so the two context tools sit together), add:

```typescript
  server.registerTool(
    "context_meter",
    {
      description: "Context rent rollup: per-turn average, bands, residency, prefix",
      inputSchema: z.object({}),
    },
    wrap(() => contextMeterReport(dir())),
  );
```

Add a `contextMeterReport` helper near the other file-reading helpers in `index.ts`. It reads the project's metrics segments, parses rows, and returns the rollup plus attribution inputs:

```typescript
  /**
   * Rent rollup for this project. Reads the metrics log the Stop hook writes;
   * returns zeros rather than throwing when no session has been recorded yet,
   * because an empty meter is a true answer, not an error.
   */
  const contextMeterReport = (projectDir: string) => {
    const rows = readMetricsRows(projectDir);
    return { ...summarise(rows), spans: sessionSpans(rows).length };
  };
```

Implement `readMetricsRows(projectDir)` alongside it, resolving the metrics path the same way `hooks/scripts/lib.mjs` does (`homedir()`, then the metrics directory, then `<basename>-<sha256(realpath).slice(0,16)>.jsonl` plus any dated segments), reading each file and JSON-parsing each non-empty line, skipping unparseable lines. Import `summarise` and `sessionSpans` from `./context/meter.js` at the top of `index.ts`.

- [ ] **Step 6: Move the tool-count pins**

`server/test/mcp.test.ts:174-175`:

```typescript
  it("pins the tool count at 87", async () => {
    expect((await listToolNames()).length).toBe(87);
  });
```

`server/test/standalone.test.ts:18` and `:41`:

```typescript
  it("node dist/index.js serves all 87 tools to a plain MCP client", async () => {
```
```typescript
      expect(tools.tools.length).toBe(87);
```

- [ ] **Step 7: Run the full suite and the surface guard**

```bash
cd server && npm run build && npm test && cd ..
node scripts/check-surface.mjs && node scripts/check-dist.mjs && node scripts/check-pins.mjs
```

Expected: all pass. If `check-footprint` now fails, that is Task 5's subject — note the number and continue.

- [ ] **Step 8: Commit**

```bash
git add server/src/context/meter.ts server/src/index.ts server/test/context-meter.test.ts \
  server/test/mcp.test.ts server/test/standalone.test.ts server/dist
git commit -m "feat(context): context_meter tool — one tool, the layer's whole rent

Reads the rollup the Stop hook already computed rather than re-deriving
residency, which would mean reading every transcript a second time to
learn what a row already says.

Rows are cumulative per session, so the latest row per session_id wins;
summing rows would multiply-count every one."
```

---

### Task 5: Count MCP tool schemas in the footprint guard

The guard reports 2,264 tokens resident and passes with 36 to spare. The 86 tool schemas it does not count are 11,396. It is watching 17% of cairn's real rent.

**Files:**
- Modify: `scripts/check-footprint.mjs`
- Test: manual run (this script is a guard, not a vitest subject; the repo tests it by running it)

**Interfaces:**
- Consumes: `server/dist/index.js` must be built — the guard asks the real server for its real schemas rather than estimating from source.
- Produces: a fourth line in the guard's breakdown, and a re-pinned `BUDGET_TOKENS`.

- [ ] **Step 1: Confirm the current number before changing anything**

```bash
cd ~/repos/cairn2 && node scripts/check-footprint.mjs
```

Expected: `check-footprint: clean — 2264 tokens (est.) resident of a 2300 budget`.

- [ ] **Step 2: Add schema counting**

In `scripts/check-footprint.mjs`, extend the header comment's "NOT counted, deliberately" paragraph — it currently justifies excluding on-demand bodies, and must now say why schemas are different:

```js
// COUNTED as of #TBD-issue: MCP tool schemas. They are neither a slash
// listing entry nor an on-demand body -- they are resident on every turn of
// every session, and they are 83% of what cairn actually costs. The guard
// watching only the descriptions was watching the small half.
```

Then add a fourth part, after the SessionStart injection block and before the report:

```js
// --- 4. MCP tool schemas ------------------------------------------------------
// Asked of the real server over stdio rather than estimated from source: the
// client sees zod lowered to JSON Schema, which is not the shape src/index.ts
// spells. Requires a built dist -- check-dist already demands one.
import { spawnSync } from "node:child_process";

const toolProbe = `
const { spawn } = require("node:child_process");
const p = spawn(process.execPath, ["server/dist/index.js"], {
  env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
  stdio: ["pipe", "pipe", "ignore"],
});
let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n")) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2 && m.result && m.result.tools) {
      let chars = 0;
      for (const t of m.result.tools) chars += JSON.stringify(t).length;
      process.stdout.write("CHARS:" + chars + ":" + m.result.tools.length);
      p.kill(); process.exit(0);
    }
  }
});
p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
  protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"footprint",version:"1"}}}) + "\\n");
setTimeout(() => {
  p.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}) + "\\n");
  p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"}) + "\\n");
}, 400);
setTimeout(() => { p.kill(); process.exit(1); }, 15000);
`;

const probe = spawnSync(process.execPath, ["-e", toolProbe], {
  cwd: root, encoding: "utf8", timeout: 20000,
});
const match = /CHARS:(\d+):(\d+)/.exec(probe.stdout ?? "");
if (!match) {
  console.error("check-footprint: could not list tools from server/dist/index.js.");
  console.error("  Run `cd server && npm run build` first — the guard measures the");
  console.error("  schemas the client really sees, not an estimate from source.");
  process.exit(1);
}
parts.push({ what: `${match[2]} MCP tool schemas`, chars: Number(match[1]) });
```

Move the `import { spawnSync }` line up to join the existing imports at the top of the file rather than leaving it mid-script.

- [ ] **Step 3: Run it and read the true number**

```bash
cd ~/repos/cairn2 && cd server && npm run build && cd .. && node scripts/check-footprint.mjs
```

Expected: FAIL, reporting roughly 13,700 tokens against the 2,300 budget. Record the exact figure it prints.

- [ ] **Step 4: Re-pin the budget at the true shape**

Replace the `BUDGET_TOKENS` constant and its comment, substituting the exact number from Step 3 for `<measured>`:

```js
// The pinned budget, in estimated tokens. Pinned AT today's shape, not at an
// aspiration -- raising it to silence a failure is still the failure.
//
// It jumped from 2300 to <measured> when tool schemas came inside the fence
// (#TBD-issue). Nothing got worse that day; the guard simply stopped
// excluding 83% of what it was built to watch. The way this number comes
// down is progressive disclosure for schemas -- deferring rarely-used tools
// so they load on call instead of on every turn, the way skill bodies
// already do -- not by moving the pin.
const BUDGET_TOKENS = <measured>;
```

- [ ] **Step 5: Verify it passes at the new pin**

```bash
node scripts/check-footprint.mjs
```

Expected: `clean` with a four-line breakdown ending in the tool-schema line.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-footprint.mjs
git commit -m "fix(guard): count MCP tool schemas in the context footprint

The guard reported 2,264 tokens resident and passed with 36 to spare
while 11,396 tokens of tool schema sat outside the fence. Schemas are
neither a slash-listing entry nor an on-demand body: they are resident
on every turn of every session, and they are 83% of cairn's real rent.

Asked of the running server over stdio, not estimated from source --
the client sees zod lowered to JSON Schema, which src/index.ts does not
spell. The pin moves to the true shape; it comes down by deferring
rarely-used tools, not by moving the pin again."
```

---

### Task 6: Machine-wide footprint report

Cairn's ~13.7k is one plugin against an observed 79.7k prefix. This ranks every installed plugin so the number is actionable. Report-only — never a CI gate, because cairn does not get to fail another plugin's build.

**Files:**
- Create: `scripts/footprint-machine.mjs`
- Test: manual run

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a CLI report. No exports.

- [ ] **Step 1: Write the script**

Create `scripts/footprint-machine.mjs`:

```js
#!/usr/bin/env node

// Machine-wide context footprint (#TBD-issue).
//
// check-footprint pins what CAIRN costs. This ranks every installed plugin,
// because cairn's ~13.7k tokens sit inside an observed 79.7k prefix and the
// other 66k is not cairn's to fix -- only to show.
//
// REPORT ONLY. Never exits non-zero on someone else's surface. Cairn does not
// get to fail another plugin's build.
//
// Counts, per plugin: command descriptions, skill frontmatter descriptions,
// and agent descriptions -- the text a harness puts in front of the model
// before anything is asked of it. Does NOT count MCP tool schemas, which
// require starting each plugin's server; run check-footprint for cairn's own.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const estimateTokens = (chars) => Math.ceil(chars / 4);

/** The `description:` value from a markdown file's YAML frontmatter. */
function frontmatterField(text, field) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(text.slice(3, end));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** Every *.md under dir, one level deep and in immediate subdirectories. */
function markdownFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isFile() && entry.endsWith(".md")) out.push(p);
    else if (s.isDirectory()) {
      for (const inner of ["SKILL.md", "AGENT.md", `${entry}.md`]) {
        const q = join(p, inner);
        if (existsSync(q)) out.push(q);
      }
    }
  }
  return out;
}

function pluginCost(dir) {
  let chars = 0;
  let items = 0;
  for (const sub of ["commands", "skills", "agents"]) {
    for (const file of markdownFiles(join(dir, sub))) {
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const name = frontmatterField(text, "name") ?? "";
      const description = frontmatterField(text, "description") ?? "";
      if (!description) continue;
      chars += `${name} ${description}`.length;
      items += 1;
    }
  }
  return { chars, items };
}

const marketplaces = join(homedir(), ".claude", "plugins", "marketplaces");
const rows = [];
if (existsSync(marketplaces)) {
  for (const market of readdirSync(marketplaces)) {
    const marketDir = join(marketplaces, market);
    let entries;
    try { entries = readdirSync(marketDir); } catch { continue; }
    for (const name of entries) {
      const dir = join(marketDir, name);
      let s;
      try { s = statSync(dir); } catch { continue; }
      if (!s.isDirectory()) continue;
      const { chars, items } = pluginCost(dir);
      if (items > 0) rows.push({ plugin: `${market}/${name}`, tokens: estimateTokens(chars), items });
    }
  }
}

rows.sort((a, b) => b.tokens - a.tokens);
const total = rows.reduce((n, r) => n + r.tokens, 0);

if (rows.length === 0) {
  console.log("footprint-machine: no installed plugins found under ~/.claude/plugins/marketplaces");
  process.exit(0);
}

const width = Math.max(...rows.map((r) => r.plugin.length));
for (const r of rows) {
  console.log(`  ${r.plugin.padEnd(width)}  ${String(r.tokens).padStart(6)} tokens (est.)  ${r.items} entries`);
}
console.log(`\n  ${"TOTAL".padEnd(width)}  ${String(total).padStart(6)} tokens (est.) of listing text`);
console.log("\n  Listing text only -- MCP tool schemas are resident too and are not");
console.log("  counted here (they need each plugin's server started). For cairn's");
console.log("  own full figure including schemas, run scripts/check-footprint.mjs.");
console.log("  Report only: this script never fails a build.");
```

- [ ] **Step 2: Run it**

```bash
cd ~/repos/cairn2 && node scripts/footprint-machine.mjs
```

Expected: a ranked table of installed plugins with a total, and exit code 0.

- [ ] **Step 3: Verify it exits 0 even with nothing installed**

```bash
HOME=$(mktemp -d) node scripts/footprint-machine.mjs; echo "exit=$?"
```

Expected: the "no installed plugins found" line and `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/footprint-machine.mjs
git commit -m "feat(guard): machine-wide plugin footprint report

Cairn's resident cost is one plugin inside an observed 79.7k prefix.
Ranking every installed plugin is what makes the other 66k actionable.

Report only, never a gate: cairn does not get to fail another plugin's
build over its own budget."
```

---

### Task 7: Threshold configuration and drift reporting

Cairn records the threshold it wants and reports whether the live environment matches. It does not silently edit the user's settings — per ADR 0017, it reports the mismatch rather than refusing or fixing it.

**Files:**
- Modify: `server/src/config.ts` (schema)
- Modify: `server/src/index.ts` (report drift inside `config_probe`)
- Create: `server/test/context-threshold.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface ContextEconomyConfig { autocompactPct: number | null }
  export function thresholdDrift(
    desiredPct: number | null, liveEnv: string | undefined,
  ): { status: "unset" | "match" | "drift" | "invalid"; desired: number | null; live: number | null };
  ```
  Lives in `server/src/context/threshold.ts`.

- [ ] **Step 1: Write the failing test**

Create `server/test/context-threshold.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { thresholdDrift } from "../src/context/threshold.js";

describe("autocompact threshold drift", () => {
  it("is unset when the project has expressed no preference", () => {
    expect(thresholdDrift(null, undefined))
      .toEqual({ status: "unset", desired: null, live: null });
  });

  it("matches when the live env equals the desired value", () => {
    expect(thresholdDrift(0.2, "0.2"))
      .toEqual({ status: "match", desired: 0.2, live: 0.2 });
  });

  it("reports drift when the env is absent but a value is desired", () => {
    expect(thresholdDrift(0.2, undefined))
      .toEqual({ status: "drift", desired: 0.2, live: null });
  });

  it("reports drift when the env disagrees with the desired value", () => {
    expect(thresholdDrift(0.2, "0.85"))
      .toEqual({ status: "drift", desired: 0.2, live: 0.85 });
  });

  it("calls an unparseable env value invalid rather than guessing", () => {
    expect(thresholdDrift(0.2, "aggressive"))
      .toEqual({ status: "invalid", desired: 0.2, live: null });
  });

  it("tolerates float noise — 0.2 and 0.200 are the same setting", () => {
    expect(thresholdDrift(0.2, "0.200").status).toBe("match");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/context-threshold.test.ts
```

Expected: FAIL — cannot resolve `../src/context/threshold.js`.

- [ ] **Step 3: Write the implementation**

Create `server/src/context/threshold.ts`:

```typescript
/**
 * The auto-compact threshold cairn wants, against the one the harness has.
 *
 * Cairn cannot set an environment variable for a session that is already
 * running, and it will not edit a user's settings behind their back. So it
 * records a desired value and REPORTS the mismatch (ADR 0017) -- the fix is
 * the user's to apply, and probe output is where they learn it is needed.
 */

export interface ContextEconomyConfig {
  /**
   * Desired value of CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: the fraction of the
   * context window at which the harness compacts. Simulation over the
   * recorded corpus puts 0.2 at a ~50% rent reduction. null means no
   * preference -- the harness default stands.
   */
  autocompactPct: number | null;
}

export interface ThresholdDrift {
  status: "unset" | "match" | "drift" | "invalid";
  desired: number | null;
  live: number | null;
}

/**
 * :param desiredPct: the project's configured preference, or null
 * :param liveEnv: the raw CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value, or undefined
 * :returns the comparison, never throwing on bad input
 */
export function thresholdDrift(
  desiredPct: number | null,
  liveEnv: string | undefined,
): ThresholdDrift {
  if (desiredPct === null) return { status: "unset", desired: null, live: null };

  if (liveEnv === undefined || liveEnv.trim() === "") {
    return { status: "drift", desired: desiredPct, live: null };
  }

  const live = Number(liveEnv);
  if (!Number.isFinite(live)) return { status: "invalid", desired: desiredPct, live: null };

  // Float noise, not disagreement: 0.2 and 0.200 are one setting.
  const same = Math.abs(live - desiredPct) < 1e-9;
  return { status: same ? "match" : "drift", desired: desiredPct, live };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npx vitest run test/context-threshold.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Add the config key**

In `server/src/config.ts`, find the top-level zod object describing `cairn.json` and add an optional block alongside the existing ones (`leakGuard` is a sibling to copy the shape from):

```typescript
  contextEconomy: z.object({
    /** Desired CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; null leaves the harness default. */
    autocompactPct: z.number().min(0.05).max(1).nullable().default(null),
  }).optional(),
```

The `.min(0.05)` floor is deliberate: a threshold below 5% would compact almost every turn, and a typo of `0.02` for `0.2` should be rejected at the config boundary rather than discovered as a wrecked session.

- [ ] **Step 6: Report drift in `config_probe`**

In `server/src/index.ts`, import `thresholdDrift` from `./context/threshold.js`, then add to the object `config_probe` returns:

```typescript
      contextEconomy: thresholdDrift(
        cfg.contextEconomy?.autocompactPct ?? null,
        process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
      ),
```

Use whatever local name `config_probe` already has for the loaded config in place of `cfg`.

- [ ] **Step 7: Run the full suite**

```bash
cd server && npm run build && npm test
```

Expected: all pass. `config_probe`'s existing test asserts on specific keys; if it uses an exact-object match, extend it with the new `contextEconomy` key rather than loosening the assertion.

- [ ] **Step 8: Commit**

```bash
cd ~/repos/cairn2
node scripts/check-dist.mjs
git add server/src/context/threshold.ts server/src/config.ts server/src/index.ts \
  server/test/context-threshold.test.ts server/test/mcp.test.ts server/dist
git commit -m "feat(context): record the desired autocompact threshold, report drift

Cairn cannot set an env var for a session already running and will not
edit a user's settings behind their back, so it records the value it
wants and reports the mismatch (ADR 0017). Simulation over the recorded
corpus puts 0.2 at a ~50% rent reduction.

The 0.05 floor rejects a 0.02-for-0.2 typo at the config boundary
rather than letting it be discovered as a wrecked session."
```

---

### Task 8: Compaction boundary detection and symptoms

The measurement that makes the threshold change safe. It looks in **both** directions: riding a 900k context degrades recall too, so the question is not "did compaction hurt" but "which side of the boundary was worse".

**Files:**
- Create: `server/src/context/boundary.ts`
- Create: `server/test/boundary.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (callers supply parsed transcript entries).
- Produces:
  ```ts
  export interface TranscriptEntry {
    type?: string;
    subtype?: string;
    isSidechain?: boolean;
    message?: { role?: string; content?: unknown };
  }
  export interface Boundary { index: number; kind: "microcompact" | "compact" }
  export interface Symptom { kind: "reread" | "repeat_question"; boundaryIndex: number; evidence: string }
  export function findBoundaries(entries: TranscriptEntry[]): Boundary[];
  export function detectSymptoms(entries: TranscriptEntry[], boundaries: Boundary[]): Symptom[];
  ```

- [ ] **Step 1: Write the failing test**

Create `server/test/boundary.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findBoundaries, detectSymptoms } from "../src/context/boundary.js";

const read = (path: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path } }] },
});
const cleared = () => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: "[Old tool result content cleared]" }] },
});
const boundaryEntry = () => ({ type: "system", subtype: "compact_boundary" });
const userSays = (text: string) => ({ type: "user", message: { content: [{ type: "text", text }] } });
const assistantSays = (text: string) => ({
  type: "assistant", message: { content: [{ type: "text", text }] },
});

describe("compaction boundaries", () => {
  it("finds a microcompact from the cleared-result marker", () => {
    expect(findBoundaries([read("/a.ts"), cleared(), read("/b.ts")]))
      .toEqual([{ index: 1, kind: "microcompact" }]);
  });

  it("finds a full compaction from the boundary entry", () => {
    expect(findBoundaries([read("/a.ts"), boundaryEntry()]))
      .toEqual([{ index: 1, kind: "compact" }]);
  });

  it("collapses a run of cleared markers into one boundary", () => {
    expect(findBoundaries([cleared(), cleared(), read("/a.ts")]))
      .toEqual([{ index: 0, kind: "microcompact" }]);
  });

  it("finds nothing in a session that never compacted", () => {
    expect(findBoundaries([read("/a.ts"), read("/b.ts")])).toEqual([]);
  });
});

describe("boundary symptoms", () => {
  it("flags a file re-read after the boundary that was read before it", () => {
    const entries = [read("/src/a.ts"), boundaryEntry(), read("/src/a.ts")];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "reread", boundaryIndex: 1, evidence: "/src/a.ts" },
    ]);
  });

  it("does not flag a file first read after the boundary", () => {
    const entries = [read("/src/a.ts"), boundaryEntry(), read("/src/b.ts")];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });

  it("flags a question whose subject the user already supplied pre-boundary", () => {
    const entries = [
      userSays("The deploy target is the staging cluster in us-east-1."),
      boundaryEntry(),
      assistantSays("Which deploy target should I use?"),
    ];
    const out = detectSymptoms(entries, findBoundaries(entries));
    expect(out).toEqual([
      { kind: "repeat_question", boundaryIndex: 1, evidence: "deploy target" },
    ]);
  });

  it("does not flag an assistant question about something never discussed", () => {
    const entries = [
      userSays("The deploy target is the staging cluster."),
      boundaryEntry(),
      assistantSays("Should I bump the minor version?"),
    ];
    expect(detectSymptoms(entries, findBoundaries(entries))).toEqual([]);
  });

  it("returns nothing when there are no boundaries", () => {
    const entries = [read("/src/a.ts"), read("/src/a.ts")];
    expect(detectSymptoms(entries, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/boundary.test.ts
```

Expected: FAIL — cannot resolve `../src/context/boundary.js`.

- [ ] **Step 3: Write the implementation**

Create `server/src/context/boundary.ts`:

```typescript
/**
 * Compaction boundaries, and whether crossing one cost anything.
 *
 * The harness compacts on its own -- a microcompact clears old tool results
 * in place, a full compaction summarises and restarts. Moving the threshold
 * from window-safety to cost-optimal makes boundaries far more frequent, so
 * the question "did that hurt" stops being academic.
 *
 * It cuts BOTH ways. Context-rot research finds recall degrading as context
 * grows, so a session riding 900k is also losing information -- just without
 * a marker in the transcript to blame. These detectors say what a boundary
 * cost; they do not assume the pre-boundary state was healthy.
 *
 * Deliberately crude, and deliberately only two. A third symptom -- a
 * decision reversed without new evidence -- needs semantic judgement this
 * cannot honestly fake, so boundary reports surface the surrounding turns
 * for a human to label rather than guessing.
 */

export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

export interface Boundary {
  index: number;
  kind: "microcompact" | "compact";
}

export interface Symptom {
  kind: "reread" | "repeat_question";
  boundaryIndex: number;
  evidence: string;
}

const CLEARED_MARKER = "[Old tool result content cleared]";

/** Content blocks of an entry, or an empty list for any other shape. */
function blocks(entry: TranscriptEntry): Array<Record<string, unknown>> {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
}

function textOf(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * :param entries: transcript entries in order
 * :returns one boundary per compaction event; a run of cleared markers is one
 */
export function findBoundaries(entries: TranscriptEntry[]): Boundary[] {
  const out: Boundary[] = [];
  let lastWasCleared = false;

  entries.forEach((entry, index) => {
    if (entry?.subtype === "compact_boundary") {
      out.push({ index, kind: "compact" });
      lastWasCleared = false;
      return;
    }
    const isCleared = blocks(entry).some((b) =>
      b.type === "tool_result" && typeof b.content === "string" &&
      b.content.includes(CLEARED_MARKER));
    if (isCleared && !lastWasCleared) out.push({ index, kind: "microcompact" });
    lastWasCleared = isCleared;
  });

  return out;
}

/** Every file path a Read tool_use targeted, by entry index. */
function readsByIndex(entries: TranscriptEntry[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  entries.forEach((entry, index) => {
    const paths: string[] = [];
    for (const b of blocks(entry)) {
      if (b.type !== "tool_use" || b.name !== "Read") continue;
      const input = b.input as { file_path?: unknown } | undefined;
      if (typeof input?.file_path === "string") paths.push(input.file_path);
    }
    if (paths.length) out.set(index, paths);
  });
  return out;
}

/**
 * Noun phrases worth matching: runs of 2-3 lowercase words, which is where
 * "deploy target" and "database url" live. Crude on purpose -- a real parser
 * would be a dependency and a false sense of precision.
 */
function phrases(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  const stop = new Set(["the", "a", "an", "is", "are", "was", "to", "of", "in", "on",
    "for", "and", "or", "it", "this", "that", "which", "what", "should", "i", "you",
    "use", "be", "do", "does", "with", "at", "by", "from", "as"]);
  for (let i = 0; i < words.length - 1; i++) {
    if (stop.has(words[i]) || stop.has(words[i + 1])) continue;
    out.add(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

/**
 * :param entries: transcript entries in order
 * :param boundaries: output of findBoundaries over the same entries
 * :returns symptoms attributed to the nearest preceding boundary
 */
export function detectSymptoms(
  entries: TranscriptEntry[],
  boundaries: Boundary[],
): Symptom[] {
  if (boundaries.length === 0) return [];
  const out: Symptom[] = [];
  const reads = readsByIndex(entries);

  for (const boundary of boundaries) {
    const before = new Set<string>();
    for (const [index, paths] of reads) {
      if (index < boundary.index) for (const p of paths) before.add(p);
    }
    const seen = new Set<string>();
    for (const [index, paths] of reads) {
      if (index <= boundary.index) continue;
      for (const p of paths) {
        if (before.has(p) && !seen.has(p)) {
          seen.add(p);
          out.push({ kind: "reread", boundaryIndex: boundary.index, evidence: p });
        }
      }
    }

    // A question after the boundary about something the user already stated
    // before it. Only the user's own words count as "already supplied" --
    // the assistant restating a fact is not the user having given it.
    const supplied = new Set<string>();
    entries.slice(0, boundary.index).forEach((entry) => {
      if (entry?.type !== "user") return;
      for (const b of blocks(entry)) for (const p of phrases(textOf(b))) supplied.add(p);
    });
    const asked = new Set<string>();
    entries.slice(boundary.index + 1).forEach((entry) => {
      if (entry?.type !== "assistant") return;
      for (const b of blocks(entry)) {
        const text = textOf(b);
        if (!text.includes("?")) continue;
        for (const p of phrases(text)) {
          if (supplied.has(p) && !asked.has(p)) {
            asked.add(p);
            out.push({ kind: "repeat_question", boundaryIndex: boundary.index, evidence: p });
          }
        }
      }
    });
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npx vitest run test/boundary.test.ts
```

Expected: PASS, 10 tests. If `repeat_question` yields extra phrases beyond `"deploy target"`, tighten the stop-word list until the fixture matches exactly — extra matches here mean the detector will be noisy in production too.

- [ ] **Step 5: Verify against a real transcript**

The detector is worthless if it only works on fixtures. Run it over a genuine session:

```bash
cd server && npx tsx -e '
import { readFileSync } from "node:fs";
import { findBoundaries, detectSymptoms } from "./src/context/boundary.js";
const file = process.argv[1];
const entries = readFileSync(file, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return {}; } });
const b = findBoundaries(entries);
console.log("entries", entries.length, "boundaries", b.length);
console.log(JSON.stringify(detectSymptoms(entries, b).slice(0, 20), null, 2));
' "$(ls -S ~/.claude/projects/*/*.jsonl | head -1)"
```

Expected: it completes without throwing and prints a plausible count. A large transcript reporting hundreds of `repeat_question` symptoms means the phrase matcher is too loose — tighten it before moving on. Record the counts in the commit message.

- [ ] **Step 6: Commit**

```bash
cd ~/repos/cairn2 && cd server && npm run build && cd ..
node scripts/check-dist.mjs
git add server/src/context/boundary.ts server/test/boundary.test.ts server/dist
git commit -m "feat(context): detect compaction boundaries and what crossing cost

Moving the threshold from window-safety to cost-optimal makes
boundaries frequent, so 'did that hurt' stops being academic.

It cuts both ways: context-rot research finds recall degrading as
context grows, so a session riding 900k is also losing information --
just with no marker in the transcript to blame. These detectors say
what a boundary cost; they do not assume the state before it was
healthy.

Two detectors, crude on purpose. A third -- a decision reversed without
new evidence -- needs judgement this cannot honestly fake, so reports
surface the turns for a human to label instead of guessing."
```

---

### Task 9: The compaction artifact contract

A threshold without a contract for what a compaction *contains* is half a design. And the abort rule matters more than it looks: a bad checkpoint is worse than none, because by the time it is written the context it replaced is already gone.

**Files:**
- Modify: `server/src/core/continuity.ts`
- Modify: `server/src/index.ts` (the `continuity_checkpoint` input schema)
- Create: `server/test/continuity-artifact.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface CheckpointArtifacts {
    decisions: string[];        // durable memory: what was decided
    constraints: string[];      // what must hold
    rejected: string[];         // approaches ruled out, and why
    state: string;              // resumability: where the work stands
    filesTouched: string[];
    nextSteps: string[];
    requirements: string;       // the user's own words, verbatim
    skills: string[];
  }
  export class DegradedCheckpointError extends Error { readonly missing: string[] }
  export function validateArtifacts(a: Partial<CheckpointArtifacts>): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `server/test/continuity-artifact.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateArtifacts, DegradedCheckpointError } from "../src/core/continuity.js";

const good = () => ({
  decisions: ["Threshold set to 0.2 after simulation over the recorded corpus"],
  constraints: ["No new runtime dependencies"],
  rejected: ["Local MoE digest — median read is 878 tokens, nothing to compress"],
  state: "Task 8 landed; boundary detectors verified against a real transcript.",
  filesTouched: ["server/src/context/boundary.ts"],
  nextSteps: ["Wire the artifact contract into continuity_checkpoint"],
  requirements: "Cut agent spend without degrading output quality.",
  skills: ["cairn:cairn-memory"],
});

describe("compaction artifact contract", () => {
  it("accepts a complete checkpoint", () => {
    expect(() => validateArtifacts(good())).not.toThrow();
  });

  it("refuses a checkpoint with no decisions", () => {
    expect(() => validateArtifacts({ ...good(), decisions: [] }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a checkpoint with an empty state summary", () => {
    expect(() => validateArtifacts({ ...good(), state: "   " }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a state summary too short to resume from", () => {
    expect(() => validateArtifacts({ ...good(), state: "ok" }))
      .toThrow(DegradedCheckpointError);
  });

  it("refuses a checkpoint that dropped the user's requirements", () => {
    expect(() => validateArtifacts({ ...good(), requirements: "" }))
      .toThrow(DegradedCheckpointError);
  });

  it("names every missing artifact at once, not just the first", () => {
    try {
      validateArtifacts({ ...good(), decisions: [], state: "", requirements: "" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DegradedCheckpointError);
      expect((e as DegradedCheckpointError).missing.sort())
        .toEqual(["decisions", "requirements", "state"]);
    }
  });

  it("allows empty rejected and skills — a session may genuinely have neither", () => {
    expect(() => validateArtifacts({ ...good(), rejected: [], skills: [] })).not.toThrow();
  });

  it("allows empty nextSteps on a checkpoint at the end of the work", () => {
    expect(() => validateArtifacts({ ...good(), nextSteps: [] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npx vitest run test/continuity-artifact.test.ts
```

Expected: FAIL — `validateArtifacts` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `server/src/core/continuity.ts`:

```typescript
/**
 * What a compaction checkpoint must carry to be worth keeping.
 *
 * Four typed artifacts: durable memory (decisions, constraints, and the
 * approaches already rejected -- the most commonly lost and the most
 * expensive to rediscover), a summary written for resumability, the user's
 * requirements preserved verbatim, and the skills in play.
 */
export interface CheckpointArtifacts {
  decisions: string[];
  constraints: string[];
  rejected: string[];
  state: string;
  filesTouched: string[];
  nextSteps: string[];
  requirements: string;
  skills: string[];
}

/** Thrown instead of persisting a checkpoint that would not survive a resume. */
export class DegradedCheckpointError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `checkpoint is degraded and was NOT written -- missing: ${missing.join(", ")}. ` +
      "A bad checkpoint is worse than none: by the time it is written the " +
      "context it replaced is already gone. Fill these in and retry.",
    );
    this.name = "DegradedCheckpointError";
    this.missing = missing;
  }
}

/** A state summary shorter than this cannot carry enough to resume from. */
const MIN_STATE_CHARS = 20;

/**
 * The abort rule. Required: at least one decision, a usable state summary,
 * and the user's requirements verbatim. Not required: rejected approaches,
 * skills, next steps, files touched -- a session may genuinely have none of
 * those, and demanding them would teach the caller to invent them.
 *
 * :param a: the artifacts a caller proposes to persist
 * :throws DegradedCheckpointError naming every missing artifact at once
 */
export function validateArtifacts(a: Partial<CheckpointArtifacts>): void {
  const missing: string[] = [];
  if (!a.decisions || a.decisions.filter((d) => d.trim()).length === 0) missing.push("decisions");
  if (!a.state || a.state.trim().length < MIN_STATE_CHARS) missing.push("state");
  if (!a.requirements || a.requirements.trim() === "") missing.push("requirements");
  if (missing.length > 0) throw new DegradedCheckpointError(missing);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npx vitest run test/continuity-artifact.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Accept artifacts on the checkpoint tool**

In `server/src/index.ts`, find the `continuity_checkpoint` registration and extend its `inputSchema` with an optional artifacts block:

```typescript
      artifacts: z.object({
        decisions: z.array(z.string()).default([]),
        constraints: z.array(z.string()).default([]),
        rejected: z.array(z.string()).default([]),
        state: z.string().default(""),
        filesTouched: z.array(z.string()).default([]),
        nextSteps: z.array(z.string()).default([]),
        requirements: z.string().default(""),
        skills: z.array(z.string()).default([]),
      }).optional(),
```

In the handler body, before anything is persisted:

```typescript
      // The abort rule: refuse a degraded checkpoint rather than persist it.
      // Optional overall -- a caller that passes no artifacts gets the old
      // behaviour -- but a caller that passes some must pass enough.
      if (args.artifacts) validateArtifacts(args.artifacts);
```

Import `validateArtifacts` from `./core/continuity.js` alongside the existing continuity imports.

- [ ] **Step 6: Run the full suite and every guard**

```bash
cd server && npm run build && npm test && npx tsc --noEmit && cd ..
node scripts/check-surface.mjs && node scripts/check-dist.mjs && \
  node scripts/check-pins.mjs && node scripts/check-versions.mjs && \
  node scripts/check-footprint.mjs && node scripts/check-diagrams.mjs
```

Expected: tests pass, `tsc --noEmit` clean, every guard clean. `tsc --noEmit` is not covered by `npm test` and is a CI gate — do not skip it.

- [ ] **Step 7: Commit**

```bash
git add server/src/core/continuity.ts server/src/index.ts \
  server/test/continuity-artifact.test.ts server/dist
git commit -m "feat(continuity): compaction artifact contract with an abort rule

A threshold without a contract for what a compaction contains is half a
design. Four typed artifacts, with rejected approaches named explicitly
-- the most commonly lost and the most expensive to rediscover.

The abort rule matters more than it looks: a degraded checkpoint is
worse than none, because by the time it is written the context it
replaced is already gone. Refuse and say what is missing, all of it at
once, rather than persisting something that cannot be resumed from.

Artifacts are optional overall; a caller that passes some must pass
enough."
```

---

### Task 10: Baseline report and the phase-A gate

Phase A's whole purpose is a real per-work-item baseline. This produces it and writes it down, so phase B's 50% claim has something to be measured against.

**Files:**
- Create: `docs/notes/context-economy-baseline.md`
- Test: manual — the artifact is the number

**Interfaces:**
- Consumes: `summarise` and `sessionSpans` (Task 4), `attributeRent` (Task 3).
- Produces: a committed baseline document. No code.

- [ ] **Step 1: Generate the rollup from real metrics**

```bash
cd ~/repos/cairn2/server && npx tsx -e '
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { summarise, sessionSpans } from "./src/context/meter.js";
const dir = join(homedir(), ".cairn", "metrics");
const rows = [];
for (const f of readdirSync(dir)) {
  for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { rows.push(JSON.parse(l)); } catch { /* skip */ }
  }
}
console.log(JSON.stringify(summarise(rows), null, 2));
console.log("spans:", sessionSpans(rows).length);
'
```

Record the output. Rows written before Task 1 have no `context` field, so `turns` will undercount until sessions accumulate — that is expected and must be stated in the document.

- [ ] **Step 2: Gather closed work items for the same window**

```bash
cd ~/repos/cairn2 && git log --since="90 days ago" --format="%H %cI %s" | head -50
gh issue list --state closed --limit 50 --json number,closedAt \
  --jq '.[] | "\(.number) \(.closedAt)"'
```

If `gh` is not authenticated, use the commit list alone and say so in the document.

- [ ] **Step 3: Write the baseline document**

Create `docs/notes/context-economy-baseline.md` with: the date; the rollup from Step 1 verbatim; the work items from Step 2; the computed rent-per-item; and an explicit **Caveats** section naming the undercount from pre-Task-1 rows, whether `gh` was available, and the chars/4 estimate. Close with the leading indicators from the spec's Section 1 table and the value each one actually measured, so phase B has a per-indicator before-and-after.

- [ ] **Step 4: Commit**

```bash
git add docs/notes/context-economy-baseline.md
git commit -m "docs(context): phase A baseline

The number every later claim is measured against. Rows written before
residency accounting landed carry no context field, so turn counts
undercount until sessions accumulate -- stated in the document rather
than smoothed over."
```

- [ ] **Step 5: Phase A gate**

Phase A is complete when: `npm test` passes, `npx tsc --noEmit` is clean, all six guards pass, and the baseline document exists with real numbers. **Stop here and report to the user.** Phase B changes how sessions behave and should start from a reviewed baseline, not from momentum.

---

### Task 11: Apply the threshold and measure the boundary — KILLED

**Status: killed 2026-09-29, not attempted as written. Do not run this task.
Do not set `autocompactPct` to 0.2 anywhere.**

Phase B proposed dropping the autocompact threshold to 0.2 and measuring
whether crossing boundaries that much more often actually hurt. It was always
the riskiest task in the plan — the spec said so, and the amended gate below
said so twice more.

**Why it died.** The operator ran a session at the low threshold and reported
that it caused massive problems doing ordinary work. That is a field report,
not an instrumented measurement — no boundary analysis was run, no symptom
count was taken, no rent comparison exists. It is recorded here as exactly
what it is. The plan anticipated this outcome and named it the deciding one:

> **Your own judgement outranks all three.** You ran the session. If the work
> felt degraded — repeating yourself, re-establishing context, the model
> losing the thread — that is evidence the detectors cannot see, and it counts.

So the gate fired on its strongest rung. The 50% saving was a simulation over
recorded sessions; the one attempt to live at that threshold was unworkable,
and a saving nobody can work under is not a saving. Killed rather than tuned
upward, because nothing downstream is waiting on it — see the phase gates note
below.

Nothing was left applied. Verified at kill time: `autocompactPct` is unset in
`cairn.json`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is absent from the session
environment and from both settings files, and `config.ts` defaults the value
to `null`, which leaves the harness default alone. cairn reports drift against
this setting; it has never set it.

The result write-up lives at `docs/notes/context-economy-phase-b.md`.

#### What survives the kill

**The threshold machinery stays.** Task 7's `thresholdDrift`, the
`contextEconomy.autocompactPct` config key, and the `config_probe` drift
report are all still correct and still shipped. They describe a desired
threshold and report honestly when the live one disagrees. Killing one
particular *value* is not a reason to tear out the reporting that would have
caught it drifting back.

**Two findings about the symptom detector, which outlive this task.** They
came out of the Phase A whole-branch review and apply to any future use of
`detectSymptoms`, threshold work or not:

1. **The symptom detector is not a standalone gate.** Its first version could
   not fire at all: it only read `message.content` when that field was an
   array, and 94-100% of user prose in real transcripts is a bare string. The
   "0 symptoms" it reported was blindness. That is fixed and proven — a
   spliced repeat question now fires exactly once where the old code fired
   zero times — but the measured transcripts contained only 6 and 4
   post-boundary questions in total. **Zero symptoms against a denominator
   that small is weak evidence of no harm.** Any future report must state the
   denominator (post-boundary questions asked at all, and files re-read at
   all) beside the symptom count, and judge the ratio. Never gate on
   `symptoms.length === 0`.

2. **The detector matches repeated wording, not repeated meaning.** Phrase
   matching is bigram-literal by design, so a paraphrased re-ask will not
   fire. Treat a symptom as strong evidence of harm, and its absence as weak
   evidence of safety. The asymmetry is the point.

#### What this does to the later phases

Phase B was written as the gate for phases C, D and E. That gate is now
resolved as **stop, do not lower the threshold** — it is not left hanging, and
the later phases do not inherit a blocked precondition. C (band signal in the
statusline and `additionalContext`, subagent report cap), D (bounded loops)
and E (the context guard) all reduce what goes *into* the window rather than
changing when the window gets cut, so none of them depend on this task having
succeeded. Anyone picking them up should read the phase-B write-up first: the
one thing Phase B established is that buying context economy by compacting
harder is off the table for this operator, which raises the value of every
approach that does not.

---

## Self-Review

**Spec coverage.** Section 1's metric: Tasks 1, 3, 4, 10. Section 2's components: meter (1, 2), attribution (3), band signal — *partial*, the state file in Task 2 carries the band but the statusline and `additionalContext` emission belong to phase C and are deliberately absent; threshold management (7, 9, 11); context guard — phase E, absent by scope; footprint audit (5, 6); subagent report cap — phase C, absent by scope; bounded loops — phase D, absent by scope. Section 3's guard rules: phase E, out of scope. Section 4's phases A and B: Tasks 1-11, with explicit gates at Task 10 Step 5 and Task 11 Step 6. *Amended 2026-09-29:* Task 11 is killed, so threshold management is covered by Tasks 7 and 9 only — the machinery ships, the 0.2 value does not. Phase B's gate is resolved as stop rather than left open.

**Deviation from the spec, recorded deliberately.** The spec lists three boundary symptoms; Task 8 implements two. A decision reversed without new evidence needs semantic judgement the detector cannot honestly fake, so boundary reports surface the turns for human labelling instead. This is written into the module docstring, not just here.

**Placeholder scan.** `#TBD-issue` appears in four comments and two commit-adjacent strings — these are tracker issue numbers to be filled from the issues cairn creates when the work is claimed, not unspecified design. Every code block is complete. `<measured>` in Task 5 Step 4 is filled from the guard's own output in Step 3, which is the only way to get the true figure.

**Type consistency.** `SessionSpan` is defined in `attribution.ts` and imported by `meter.ts`; `sessionSpans` returns exactly that type. `MetricsRow.context` matches the row literal emitted in Task 1 Step 5 field for field. `validateArtifacts` takes `Partial<CheckpointArtifacts>` in both the test and the implementation. `findBoundaries` output feeds `detectSymptoms` as its second parameter in every call site including the verification scripts.
