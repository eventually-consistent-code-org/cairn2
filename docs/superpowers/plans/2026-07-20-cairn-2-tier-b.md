# Cairn 2.0 — Tier B: Lightweight Subsystems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five new live verbs (`mark retro distill brief tune`), the PreToolUse leak guard (hook #4), and the G6 confidence loop on memory cards. Spec: `docs/superpowers/specs/2026-07-20-cairn-2-tier-b-lightweight-subsystems.md`.

**Architecture:** Mechanism-first, two stages. Stage 1 (Tasks 1–6): card schema gains `note` + optional `confidence`; `mem_card_update` (frontmatter-only confidence patch); `config_get`/`config_set` validated single-writer over `cairn.json` (+ `leakGuard` schema block); `hooks/scripts/leak-patterns.mjs` as the single pattern source with a CLI; `pretooluse-leakguard.mjs` as hook #4. Tools 33 → 36. Stage 2 (Tasks 7–11): the five verb subroutines + `status` seed listing, surface ratchet to 23 live / 5 reserved, docs + drill procedures.

**Tech Stack:** TypeScript 5, Node ≥ 20, zod, vitest — as all prior tiers. Hook scripts stay dependency-free `node:` builtins only. No new dependencies.

## Global Constraints

- Base branch: `main`. Conventional commits, one per task. Green before every commit: `cd server && npx vitest run && npx tsc --noEmit`; from Task 7 on also `node scripts/check-surface.mjs`.
- New tools named EXACTLY: `mem_card_update`, `config_get`, `config_set`. Tool count 33 → 36.
- Card `type` enum gains EXACTLY `"note"`; optional `confidence` EXACTLY `z.enum(["high", "medium", "low"])`. Card ids stay `type-<sha256(body)[:8]>` — `mem_card_update` never changes id or body.
- `config_set` validates the MERGED result against `ConfigSchema` before writing; invalid → `CONFIG_INVALID`, file untouched. `null` in a patch deletes the key. Secret-looking values/keys are refused (exact rules in Task 3).
- `ConfigSchema` gains `leakGuard: { enabled: boolean = true, allow: string[] = [], extraPatterns: string[] = [] }`, all defaulted, block itself defaulted.
- Leak patterns live ONLY in `hooks/scripts/leak-patterns.mjs`. GitHub bare `#N` is deliberately NOT a pattern. Hook budget <100ms, any internal error → exit 0, block = exit 2 with file:line listing on stderr. One-shot override: command contains `CAIRN_LEAK_OK=1`.
- Live verbs after Tier B EXACTLY: previous 18 + `mark retro distill brief tune` (23). Reserved EXACTLY: `probe draft trace`(C) `triage`(D) `basecamp`(F) (5). `SPEC_RESERVED` in check-surface shrinks as each verb goes live (established pattern — remove ONLY the verbs that task flips).
- Subroutine frontmatter exactly three fields (`verb`/`args`/`status: live`). `mark` asks NO questions — verb doc states it explicitly. Batch questions everywhere else (#1010).
- Hook scripts never import server code (`lib.mjs` rule); `leak-patterns.mjs` may be imported by other hook scripts and invoked as a CLI.
- Dist rebuilt + committed at each stage end (Tasks 6 and 11) — A7 policy.

## File Structure (end state)

```
server/src/
  memory/cards.ts        # +note type, +confidence, +updateCardConfidence
  memory/banner.ts       # type cell shows confidence when present
  config.ts              # +leakGuard block, +writeConfigPatch (deep merge + secret refusal)
  index.ts               # +mem_card_update, config_get, config_set (36 tools)
hooks/
  hooks.json             # +PreToolUse leak guard entry
  scripts/leak-patterns.mjs        # new — pattern source + CLI
  scripts/pretooluse-leakguard.mjs # new — hook #4
server/test/
  cards.test.ts banner.test.ts config.test.ts mcp.test.ts   # extended
  leak-patterns.test.ts hooks.test.ts                        # new file / extended
skills/cairn-trailhead/
  SKILL.md               # 5 rows → live
  verbs/{mark,retro,distill,brief,tune}.md   # new
  verbs/status.md        # +seed/backlog listing step
skills/cairn-memory/SKILL.md   # note-type + confidence policy line
scripts/check-surface.mjs      # SPEC_RESERVED shrinks
templates/cairn.json.example   # leakGuard block shown
README.md  server/README.md  VERIFICATION.md
```

---

## Stage 1 — server + hook

### Task 1: Card schema — `note` type + `confidence`

**Files:**
- Modify: `server/src/memory/cards.ts`, `server/src/index.ts` (mem_card_create inputSchema)
- Test: `server/test/cards.test.ts`

**Interfaces:**
- Produces: `CardFrontmatterSchema` with `type: z.enum(["decision", "constraint", "gotcha", "reference", "note"])` and `confidence: z.enum(["high", "medium", "low"]).optional()`; `createCard` input gains `confidence?: "high" | "medium" | "low"`. The `CardType` union used by `index.ts`'s handler type widens to include `"note"`.

- [ ] **Step 1: Failing tests** — append to `server/test/cards.test.ts` (reuse its existing mkdtemp setup helper):

```ts
  it("creates a note card with confidence and round-trips both", () => {
    const card = createCard(dir, { type: "note", body: "jot: waves feel slow on CI", confidence: "low" });
    expect(card.id.startsWith("note-")).toBe(true);
    const read = readCard(dir, card.id);
    expect(read.frontmatter.type).toBe("note");
    expect(read.frontmatter.confidence).toBe("low");
  });

  it("confidence is optional and absent by default", () => {
    const card = createCard(dir, { type: "decision", body: "no confidence set" });
    expect(readCard(dir, card.id).frontmatter.confidence).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure** — `cd server && npx vitest run cards` — Expected: FAIL (`"note"` not assignable / confidence unknown key rejected by schema).
- [ ] **Step 3: Implement** — cards.ts: extend the schema object:

```ts
export const CardFrontmatterSchema = z.object({
  type: z.enum(["decision", "constraint", "gotcha", "reference", "note"]),
  scopePhase: z.string().optional(),
  scopeIssue: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  provenanceFiles: z.array(z.string()).default([]),
  provenanceCommits: z.array(z.string()).default([]),
  created: z.string(),
}).refine(
  (d) => d.provenanceFiles.length === d.provenanceCommits.length,
  { message: "provenanceFiles and provenanceCommits must be the same length" },
);
```

  `createCard` input type gains `type: "decision" | "constraint" | "gotcha" | "reference" | "note"` and `confidence?: "high" | "medium" | "low"`; in the data assembly add:

```ts
  if (input.confidence !== undefined) data.confidence = input.confidence;
```

  index.ts `mem_card_create`: inputSchema `type` enum gains `"note"`, add `confidence: z.enum(["high", "medium", "low"]).optional()`; widen the handler arg type the same way and pass `confidence` through to `createCard` (it's already spreading named fields — add the field explicitly).
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): note card type + optional confidence on memory cards"`

### Task 2: `mem_card_update` + banner confidence

**Files:**
- Modify: `server/src/memory/cards.ts`, `server/src/memory/banner.ts`, `server/src/index.ts`
- Test: `server/test/cards.test.ts`, `server/test/banner.test.ts`, `server/test/mcp.test.ts`

**Interfaces:**
- Produces: `updateCardConfidence(projectDir: string, id: string, confidence: "high" | "medium" | "low"): Card` (throws `NOT_FOUND` on unknown id; body and id unchanged); tool `mem_card_update({ id, confidence })` (34th tool) that calls it then `writeBanner(projectDir)`; banner type cell renders `type (confidence)` when confidence present.

- [ ] **Step 1: Failing tests** — cards.test.ts:

```ts
  it("updateCardConfidence patches frontmatter only — id and body stable", () => {
    const card = createCard(dir, { type: "gotcha", body: "flaky test on arm64", confidence: "medium" });
    const updated = updateCardConfidence(dir, card.id, "high");
    expect(updated.id).toBe(card.id);
    expect(updated.body).toBe(card.body);
    expect(updated.frontmatter.confidence).toBe("high");
    expect(readCard(dir, card.id).frontmatter.confidence).toBe("high");
  });

  it("updateCardConfidence on unknown id throws NOT_FOUND", () => {
    expect(() => updateCardConfidence(dir, "note-deadbeef", "low"))
      .toThrowError(/no card/);
  });
```

  banner.test.ts (reuse its existing setup that creates cards + renders):

```ts
  it("banner shows confidence in the type cell when present", () => {
    createCard(dir, { type: "decision", body: "picked sqlite for the index", confidence: "high" });
    writeBanner(dir);
    const text = readFileSync(bannerFile, "utf8");
    expect(text).toContain("| decision (high) |");
  });
```

  mcp.test.ts: add `"mem_card_update"` to the expected-tools list (the exact-match list AND any count assertions — 33 → 34 at this task).
- [ ] **Step 2: Run to verify failure** — Expected: FAIL (function/tool missing).
- [ ] **Step 3: Implement** — cards.ts:

```ts
export function updateCardConfidence(projectDir: string, id: string,
  confidence: "high" | "medium" | "low"): Card {
  const path = join(cardsDir(projectDir), `${id}.md`);
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND", `no card '${id}'`,
      "list ids with mem_card_list");
  }
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  data.confidence = confidence;
  const frontmatter = validateFrontmatter(data, `card '${id}' frontmatter`);
  writeFileSync(path, serializeFrontmatter(data, body));
  return { id, frontmatter, body };
}
```

  banner.ts — in `computeBannerData`, the row template's type cell becomes:

```ts
  const rows = cards.map((card) => {
    const type = card.frontmatter.confidence
      ? `${card.frontmatter.type} (${card.frontmatter.confidence})`
      : card.frontmatter.type;
    return `| ${card.id} | ${type} | ${titleFor(card.body)} | ~${fetchCost(card.body)} tok |`;
  });
```

  index.ts — register after `mem_card_recall`:

```ts
  server.registerTool("mem_card_update",
    { description: "Adjust a memory card's confidence (frontmatter-only; body and id are immutable)",
      inputSchema: { id: z.string(),
                     confidence: z.enum(["high", "medium", "low"]) } },
    wrap((a: { id: string; confidence: "high" | "medium" | "low" }) => {
      const card = updateCardConfidence(deps.projectDir, a.id, a.confidence);
      writeBanner(deps.projectDir);
      return card;
    }));
```

  (import `updateCardConfidence` alongside the existing cards imports.)
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS, including the pre-existing banner byte-stability tests (fixtures without confidence render identically).
- [ ] **Step 5: Commit** — `git commit -m "feat(server): mem_card_update — confidence patch; banner surfaces confidence"`

### Task 3: Config — `leakGuard` block + `writeConfigPatch`

**Files:**
- Modify: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces: `ConfigSchema` gains
  ```ts
  leakGuard: z.object({
    enabled: z.boolean().default(true),
    allow: z.array(z.string()).default([]),
    extraPatterns: z.array(z.string()).default([]),
  }).default({}),
  ```
  and `writeConfigPatch(projectDir: string, patch: Record<string, unknown>): CairnConfig` — deep-merges the patch onto the RAW `cairn.json` (a `null` value deletes the key), refuses secrets, validates the merged object with `ConfigSchema` BEFORE writing, writes 2-space-indented JSON + trailing newline, returns the parsed result.
- Secret refusal rules (both throw `CONFIG_INVALID` with message containing `secrets do not belong in cairn.json`):
  - any patch KEY (at any depth) matching `/^(token|apiToken|api_key|apikey|password|secret|pat)$/i`
  - any patch string VALUE matching `/^(ATATT|ghp_|github_pat_|glpat-|xoxb-|sk-)/`

- [ ] **Step 1: Failing tests** — append to config.test.ts (reuse its temp-dir + write-cairn.json helper style):

```ts
describe("writeConfigPatch", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("merges nested keys and returns the validated result", () => {
    const dir = writeTmpConfig(base);
    const out = writeConfigPatch(dir, { continuity: { resume: "auto" } });
    expect(out.continuity.resume).toBe("auto");
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.continuity.resume).toBe("auto");
    expect(raw.tracker.config.repo).toBe("o/r"); // untouched siblings survive
  });

  it("null deletes a key", () => {
    const dir = writeTmpConfig({ ...base, user: { handle: "john" } });
    writeConfigPatch(dir, { user: null });
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.user).toBeUndefined();
  });

  it("invalid merged config leaves the file untouched", () => {
    const dir = writeTmpConfig(base);
    const before = readFileSync(join(dir, "cairn.json"), "utf8");
    expect(() => writeConfigPatch(dir, { continuity: { resume: "sometimes" } }))
      .toThrowError(/CONFIG|resume/i);
    expect(readFileSync(join(dir, "cairn.json"), "utf8")).toBe(before);
  });

  it("refuses secret-looking keys and values", () => {
    const dir = writeTmpConfig(base);
    expect(() => writeConfigPatch(dir, { tracker: { config: { token: "x" } } }))
      .toThrowError(/secrets do not belong/);
    expect(() => writeConfigPatch(dir, { user: { handle: "ATATT3xFfGF0abc" } }))
      .toThrowError(/secrets do not belong/);
  });

  it("leakGuard defaults land via loadConfig", () => {
    const dir = writeTmpConfig(base);
    const cfg = loadConfig(dir);
    expect(cfg.leakGuard).toEqual({ enabled: true, allow: [], extraPatterns: [] });
  });
});
```

  (If config.test.ts lacks a `writeTmpConfig` helper, add one: mkdtemp + write `cairn.json` with `JSON.stringify(obj)` and return the dir — mirror the file's existing setup idiom.)
- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** — config.ts additions:

```ts
const SECRET_KEY_RE = /^(token|apiToken|api_key|apikey|password|secret|pat)$/i;
const SECRET_VALUE_RE = /^(ATATT|ghp_|github_pat_|glpat-|xoxb-|sk-)/;

function assertNoSecrets(patch: unknown, path: string[] = []): void {
  if (patch === null || typeof patch !== "object") {
    if (typeof patch === "string" && SECRET_VALUE_RE.test(patch)) {
      throw new CairnError("CONFIG_INVALID",
        `value at ${path.join(".")} looks like a credential — secrets do not belong in cairn.json`,
        "put credentials in env vars (see each adapter's *Env config keys)");
    }
    return;
  }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new CairnError("CONFIG_INVALID",
        `key '${[...path, k].join(".")}' — secrets do not belong in cairn.json`,
        "put credentials in env vars (see each adapter's *Env config keys)");
    }
    assertNoSecrets(v, [...path, k]);
  }
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (typeof v === "object" && !Array.isArray(v)
      && typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function writeConfigPatch(projectDir: string,
  patch: Record<string, unknown>): CairnConfig {
  assertNoSecrets(patch);
  const path = join(projectDir, "cairn.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new CairnError("CONFIG_MISSING", `cannot read cairn.json: ${e}`,
      "create cairn.json — see templates/cairn.json.example");
  }
  const merged = deepMerge(raw, patch);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new CairnError("CONFIG_INVALID", result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return result.data;
}
```

  (add `writeFileSync` to the fs import; add the `leakGuard` block to `ConfigSchema` exactly as in Interfaces.)
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): leakGuard config block + writeConfigPatch — validated single-writer for cairn.json"`

### Task 4: `config_get` / `config_set` tools

**Files:**
- Modify: `server/src/index.ts`
- Test: `server/test/mcp.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `writeConfigPatch` (Task 3).
- Produces tools (36 total after this task): `config_get{}` → the parsed post-defaults config; `config_set{patch: object}` → the new effective config.

- [ ] **Step 1: Failing test** — mcp.test.ts: add `"config_get"`, `"config_set"` to the expected-tools list (count → 36); add a round-trip test using the file's FakeTracker-backed server + temp project (mirror how other tool-call tests invoke):

```ts
  it("config_set merges and config_get reflects it", async () => {
    const set = await callTool("config_set", { patch: { continuity: { resume: "auto" } } });
    expect(set.continuity.resume).toBe("auto");
    const got = await callTool("config_get", {});
    expect(got.continuity.resume).toBe("auto");
    expect(got.leakGuard.enabled).toBe(true); // defaults visible in effective view
  });
```

  (`callTool` = the file's existing invoke helper, whatever its name is there.)
- [ ] **Step 2: Run to verify failure** — Expected: FAIL.
- [ ] **Step 3: Implement** — index.ts, after `plan_meta_set`:

```ts
  server.registerTool("config_get",
    { description: "Read cairn.json as the validated, post-defaults effective config",
      inputSchema: {} },
    wrap(() => loadConfig(deps.projectDir)));

  server.registerTool("config_set",
    { description: "Merge-patch cairn.json (null deletes a key). Validates the merged result before "
        + "writing; refuses secret-looking keys/values — credentials live in env vars",
      inputSchema: { patch: z.record(z.unknown()) } },
    wrap((a: { patch: Record<string, unknown> }) =>
      writeConfigPatch(deps.projectDir, a.patch)));
```

  (import `writeConfigPatch` next to `loadConfig`.)
- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(server): config_get + config_set tools — 36 total"`

### Task 5: `leak-patterns.mjs` — pattern source + CLI

**Files:**
- Create: `hooks/scripts/leak-patterns.mjs`
- Test: `server/test/leak-patterns.test.ts`

**Interfaces:**
- Produces (ESM, `node:` builtins only):
  ```js
  export function buildPatterns(cairnConfig | null): Array<{ name: string, re: RegExp }>
  export function scanLines(lines: string[], patterns): Array<{ line: number, name: string, match: string }>
  export function isAllowedPath(path: string, allow: string[]): boolean
  ```
  CLI mode: `node leak-patterns.mjs <file…>` — reads `cairn.json` from cwd when present (for the tracker-id pattern), scans whole files, prints `file:line: [name] match` per hit, exit 1 on any hit, 0 clean.
- Pattern set EXACTLY:
  - `cairn-path`: `/\.cairn\//`
  - `phase-ref`: `/\b(?:phases\/\d{2}(?:\.\d+)?-[a-z0-9-]+|milestones\/v\d+)\b/`
  - `cairn-label`: `/cairn:(?:seed|backlog)/`
  - `tracker-id` (Jira backends only): `` new RegExp(`\\b${projectKey}-\\d+\\b`) `` where `projectKey = config.tracker.config.projectKey`; NO tracker-id pattern for github/gitlab/asana/azure-boards/clickup (numeric ids and `#N` are too common to match safely).
  - plus one pattern per `leakGuard.extraPatterns` entry (`new RegExp(p)`, name `extra`) — invalid regex entries are skipped silently (hook posture).
- Default allowlist (baked into `isAllowedPath`, merged with the config `allow` globs): path starts with `.cairn/` or `docs/`, path ends with `.md`, basename is `LEDGER.md` or `VERIFICATION.md`. Config `allow` entries support one wildcard form: a trailing `/**` prefix match (`"generated/**"` allows `generated/anything/here.ts`) and exact paths otherwise — no glob library.

- [ ] **Step 1: Failing tests** — `server/test/leak-patterns.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPatterns, scanLines, isAllowedPath } from "../../hooks/scripts/leak-patterns.mjs";

const jiraCfg = { tracker: { type: "jira", config: { projectKey: "DRILL" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };
const ghCfg = { tracker: { type: "github", config: { repo: "o/r" } }, leakGuard: { enabled: true, allow: [], extraPatterns: [] } };

describe("leak patterns", () => {
  it("hits every default class", () => {
    const pats = buildPatterns(jiraCfg);
    const hits = scanLines([
      'const p = ".cairn/plans/roadmap.md";',
      "// see phases/03-switchback for context",
      "// archived in milestones/v1",
      'label: "cairn:seed",',
      "// tracked as DRILL-42",
      "const clean = true;",
    ], pats);
    expect(hits.map((h) => h.name).sort())
      .toEqual(["cairn-label", "cairn-path", "phase-ref", "phase-ref", "tracker-id"].sort());
    expect(hits.some((h) => h.line === 6)).toBe(false);
  });

  it("github config gets NO tracker-id pattern — #N never matches", () => {
    const pats = buildPatterns(ghCfg);
    expect(scanLines(["// fixes #123 properly"], pats)).toEqual([]);
  });

  it("extraPatterns extend; invalid regexes are skipped silently", () => {
    const pats = buildPatterns({ ...ghCfg, leakGuard: { enabled: true, allow: [], extraPatterns: ["SECRET_PLAN", "(["] } });
    expect(scanLines(["// SECRET_PLAN here"], pats).some((h) => h.name === "extra")).toBe(true);
  });

  it("allowlist: defaults + trailing-/** config globs", () => {
    expect(isAllowedPath(".cairn/plans/PLAN.md", [])).toBe(true);
    expect(isAllowedPath("docs/adr/0001-x.md", [])).toBe(true);
    expect(isAllowedPath("notes.md", [])).toBe(true);
    expect(isAllowedPath("src/thing.ts", [])).toBe(false);
    expect(isAllowedPath("generated/deep/file.ts", ["generated/**"])).toBe(true);
    expect(isAllowedPath("src/one.ts", ["src/one.ts"])).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run leak-patterns` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `hooks/scripts/leak-patterns.mjs`:

```js
#!/usr/bin/env node

/**
 * Purpose: THE single source for cairn leak patterns (#2221) -- consumed by
 *   the pretooluse-leakguard hook and, via the CLI mode, by the distill and
 *   ship verbs for output scrubbing. node: builtins only (lib.mjs rule).
 * Author(s): John Reed
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

export function buildPatterns(config) {
  const patterns = [
    { name: "cairn-path", re: /\.cairn\// },
    { name: "phase-ref", re: /\b(?:phases\/\d{2}(?:\.\d+)?-[a-z0-9-]+|milestones\/v\d+)\b/ },
    { name: "cairn-label", re: /cairn:(?:seed|backlog)/ },
  ];
  const projectKey = config?.tracker?.type === "jira"
    ? config?.tracker?.config?.projectKey : undefined;
  if (typeof projectKey === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(projectKey)) {
    patterns.push({ name: "tracker-id", re: new RegExp(`\\b${projectKey}-\\d+\\b`) });
  }
  for (const p of config?.leakGuard?.extraPatterns ?? []) {
    try {
      patterns.push({ name: "extra", re: new RegExp(p) });
    } catch {
      // invalid user regex: skip silently -- guard must never crash the flow
    }
  }
  return patterns;
}

export function scanLines(lines, patterns) {
  const hits = [];
  lines.forEach((text, i) => {
    for (const { name, re } of patterns) {
      const m = re.exec(text);
      if (m) hits.push({ line: i + 1, name, match: m[0] });
    }
  });
  return hits;
}

export function isAllowedPath(path, allow) {
  if (path.startsWith(".cairn/") || path.startsWith("docs/")) return true;
  if (path.endsWith(".md")) return true;
  const base = basename(path);
  if (base === "LEDGER.md" || base === "VERIFICATION.md") return true;
  for (const a of allow) {
    if (a.endsWith("/**") ? path.startsWith(a.slice(0, -2)) : path === a) return true;
  }
  return false;
}

// ---- CLI mode: node leak-patterns.mjs <file...> ----------------------------
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]) === "leak-patterns.mjs";
if (invokedDirectly && process.argv.length > 2) {
  let config = null;
  try {
    if (existsSync(join(process.cwd(), "cairn.json"))) {
      config = JSON.parse(readFileSync(join(process.cwd(), "cairn.json"), "utf8"));
    }
  } catch { /* no config: default patterns only */ }
  const patterns = buildPatterns(config);
  let bad = false;
  for (const file of process.argv.slice(2)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const h of scanLines(text.split("\n"), patterns)) {
      console.log(`${file}:${h.line}: [${h.name}] ${h.match}`);
      bad = true;
    }
  }
  process.exit(bad ? 1 : 0);
}
```

- [ ] **Step 4: Run** — `npx vitest run && npx tsc --noEmit` — Expected: PASS. Also smoke the CLI: `cd .. && echo 'x .cairn/ y' > /tmp/leaksmoke.txt && node hooks/scripts/leak-patterns.mjs /tmp/leaksmoke.txt; echo "exit=$?"` — Expected: one hit line, `exit=1`.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): leak-patterns — single pattern source with CLI scrub mode"`

### Task 6: Leak guard hook + hooks.json + dist

**Files:**
- Create: `hooks/scripts/pretooluse-leakguard.mjs`
- Modify: `hooks/hooks.json`
- Test: `server/test/hooks.test.ts`

**Interfaces:**
- Consumes: `buildPatterns`/`scanLines`/`isAllowedPath` from `./leak-patterns.mjs`.
- Behavior contract: stdin JSON `{ tool_name, tool_input: { command }, cwd }`. Exit 0 instantly unless `tool_name === "Bash"` and the command matches `/\bgit\b[^|;&]*\bcommit\b/`. Exit 0 when the command contains `CAIRN_LEAK_OK=1`, when `cairn.json` is unreadable, or when `leakGuard.enabled === false`. Otherwise scan `git diff --cached -U0 --diff-filter=ACM` in the project dir (`CLAUDE_PROJECT_DIR` env, else stdin `cwd`, else `process.cwd()`): track current file from `+++ b/<path>` lines, collect `+`-prefixed added lines for files failing `isAllowedPath(path, cfg.leakGuard.allow)`, scan them; hits → stderr `path:+line-in-diff: [name] match` listing + exit 2; clean → exit 0. ANY thrown error → exit 0.

- [ ] **Step 1: Failing tests** — append a `describe("leak guard hook")` to `server/test/hooks.test.ts`, reusing its `runHook(script, projectDir, home, extraEnv)` harness — plus a variant that passes stdin and captures exit code/stderr (add a `runHookRaw` helper with `spawnSync` if the existing helper only returns stdout — mirror its env plumbing):

```ts
const LEAKGUARD = join(SCRIPTS, "pretooluse-leakguard.mjs");

const payload = (command: string) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "" });

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function stageFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
  execFileSync("git", ["add", name], { cwd: dir });
}

describe("leak guard hook", () => {
  it("blocks a staged .cairn/ leak in a source file (exit 2, listing on stderr)", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", 'const p = ".cairn/plans/x";\n');
    const r = runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("app.ts");
    expect(r.stderr).toContain("cairn-path");
  });

  it("clean staging passes; markdown files are allowlisted", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "clean.ts", "const ok = true;\n");
    stageFile(proj, "notes.md", "see .cairn/plans/roadmap.md\n");
    expect(runHookRaw(LEAKGUARD, proj, payload("git commit -m x")).status).toBe(0);
  });

  it("non-commit commands exit 0 without scanning", () => {
    const proj = tmpProj();
    expect(runHookRaw(LEAKGUARD, proj, payload("git status")).status).toBe(0);
  });

  it("CAIRN_LEAK_OK=1 and leakGuard.enabled=false both bypass", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "app.ts", 'const p = ".cairn/x";\n');
    expect(runHookRaw(LEAKGUARD, proj,
      payload("CAIRN_LEAK_OK=1 git commit -m x")).status).toBe(0);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } },
        leakGuard: { enabled: false } }));
    expect(runHookRaw(LEAKGUARD, proj, payload("git commit -m x")).status).toBe(0);
  });

  it("wall-clock stays under the 100ms budget", () => {
    const proj = tmpProj(); gitInit(proj);
    writeFileSync(join(proj, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    stageFile(proj, "clean.ts", "const ok = true;\n");
    runHookRaw(LEAKGUARD, proj, payload("git commit -m x")); // warm-up
    const t0 = Date.now();
    runHookRaw(LEAKGUARD, proj, payload("git commit -m x"));
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (script missing).
- [ ] **Step 3: Implement** `hooks/scripts/pretooluse-leakguard.mjs`:

```js
#!/usr/bin/env node

/**
 * Purpose: PreToolUse leak guard (#2221) -- blocks `git commit` tool calls
 *   whose STAGED diff would leak cairn-internal refs (.cairn/ paths, phase
 *   refs, cairn labels, tracker ids) into source files. Exit 2 blocks the
 *   tool call; ANY internal error exits 0 -- never block work by accident.
 * Author(s): John Reed
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildPatterns, scanLines, isAllowedPath } from "./leak-patterns.mjs";

try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  const command = payload?.tool_input?.command ?? "";
  if (payload?.tool_name !== "Bash") process.exit(0);
  if (!/\bgit\b[^|;&]*\bcommit\b/.test(command)) process.exit(0);
  if (command.includes("CAIRN_LEAK_OK=1")) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
  const cfgPath = join(projectDir, "cairn.json");
  if (!existsSync(cfgPath)) process.exit(0);
  const config = JSON.parse(readFileSync(cfgPath, "utf8"));
  if (config?.leakGuard?.enabled === false) process.exit(0);

  const diff = execFileSync("git",
    ["diff", "--cached", "-U0", "--diff-filter=ACM"],
    { cwd: projectDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

  const patterns = buildPatterns(config);
  const allow = config?.leakGuard?.allow ?? [];
  const hits = [];
  let file = null;
  let skipped = true;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      skipped = isAllowedPath(file, allow);
      continue;
    }
    if (skipped || !line.startsWith("+") || line.startsWith("+++")) continue;
    for (const h of scanLines([line.slice(1)], patterns)) {
      hits.push(`${file}: [${h.name}] ${h.match}`);
    }
  }

  if (hits.length > 0) {
    console.error("cairn leak guard: staged changes leak internal refs —");
    for (const h of hits) console.error(`  ${h}`);
    console.error("fix the lines, allowlist the path via `/cairn tune`, or prefix the command with CAIRN_LEAK_OK=1 to override once.");
    process.exit(2);
  }
  process.exit(0);
} catch {
  process.exit(0); // guard must never block work because IT broke
}
```

  hooks.json — add to the `hooks` object (alongside the existing three):

```json
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pretooluse-leakguard.mjs\"",
            "timeout": 3000
          }
        ]
      }
    ],
```

- [ ] **Step 4: Run + stage-end dist** — `npx vitest run && npx tsc --noEmit && npm run build` — Expected: PASS (dist unchanged by hook work is fine; commit it if the earlier server tasks left it stale).
- [ ] **Step 5: Commit** (include `server/dist` if changed) — `git commit -m "feat(plugin): leak guard hook — PreToolUse scan of staged diffs on git commit"`

---

## Stage 2 — plugin surface

### Task 7: `mark` verb + `status` seed listing

**Files:**
- Create: `skills/cairn-trailhead/verbs/mark.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (row → live), `skills/cairn-trailhead/verbs/status.md`, `scripts/check-surface.mjs` (drop `mark` from `SPEC_RESERVED`), `skills/cairn-memory/SKILL.md`

- [ ] **Step 1:** SKILL.md row (live section):

```markdown
| `mark` | Zero-friction capture — backlog/seed to tracker, note to memory | `"<text>" [--seed "<trigger>"] [--note]` | verbs/mark.md | live |
```

- [ ] **Step 2:** `verbs/mark.md`:

```markdown
---
verb: mark
args: "\"<text>\" [--seed \"<trigger>\"] [--note]"
status: live
---

Capture in ONE tool call. NO questions — never AskUserQuestion, never
"want to add detail?". Structure happens at pickup, not capture (#1309).

- Default (backlog): `issue_create(title: <text>, labels: ["cairn:backlog"])`.
  Echo the id. Done.
- `--seed "<trigger>"`: `issue_create(title: <text>, labels: ["cairn:seed"],
  body: "Trigger: <trigger>")`. Seeds fire as judgment — `status` lists open
  seeds and flags any whose trigger reads as met.
- `--note`: `mem_card_create(type: "note", body: <text>)` scoped to the
  active phase/issue from `context_get` (include scopePhase/scopeIssue when
  set). Notes are knowledge, not work — they never become tracker noise.

Pickup paths: backlog marks get adopted by `plan` (via `plan_unplanned`) or
triaged later; notes surface through `recall` and the session banner.
```

- [ ] **Step 3:** `verbs/status.md` — add a step after its existing issue-state reporting:

```markdown
- Marks: from the open-issue list, group `cairn:backlog` and `cairn:seed`
  labeled issues separately from phase work. For each open seed, read its
  `Trigger:` line and flag it when current project state reads as meeting
  the trigger — firing is your judgment call to surface, the user's to act.
```

- [ ] **Step 4:** `skills/cairn-memory/SKILL.md` — add one policy line where card types are described: `note` cards are un-triaged jottings — cheap to write, first to prune; `confidence` (high/medium/low) rides on any card, is surfaced at recall, and is re-graded by `retro`, never silently.
- [ ] **Step 5:** check-surface.mjs: remove `mark` from `SPEC_RESERVED`.
- [ ] **Step 6: Verify** — `node scripts/check-surface.mjs` → clean, 19 live / 9 reserved; `cd server && npx vitest run && npx tsc --noEmit` → PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(plugin): mark verb live — zero-friction tracker-first capture"`

### Task 8: `retro` verb

**Files:**
- Create: `skills/cairn-trailhead/verbs/retro.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (row → live), `scripts/check-surface.mjs` (drop `retro`)

- [ ] **Step 1:** SKILL.md row:

```markdown
| `retro` | Retrospective — provenance-backed lesson cards, confidence re-grading | `[<N> \| --milestone]` | verbs/retro.md | live |
```

- [ ] **Step 2:** `verbs/retro.md`:

```markdown
---
verb: retro
args: "[<N> | --milestone]"
status: live
---

Write the lessons a future session needs (#1003). Default scope: the last
phase with VERIFICATION.md; `--milestone` spans every phase of the current
milestone (including just-archived `milestones/v<N>/`).

1. Gather evidence: the scope's LEDGER.md lines (what shipped, commit
   ranges), VERIFICATION.md (what passed/failed and how), `git log` over
   the ledger ranges, closed issues (`issue_get` per ledger issue id).
2. Extract lessons — what surprised, what broke, what a future session
   must know. Draft each as a card: `type` decision/constraint/gotcha,
   provenance = the files+commits from the ledger range that prove it,
   confidence: `high` = verified by this scope's events, `medium` =
   plausible inference, `low` = hunch worth recording.
3. Re-grade prior knowledge: `mem_card_recall` scoped to this phase — for
   each card, did this scope's events confirm or contradict it? Confirmed
   → `mem_card_update` confidence up one step. Contradicted → down to
   `low`, and draft the corrected lesson as a NEW card (bodies are
   immutable — corrections are new cards, not edits).
4. ONE AskUserQuestion approving the whole batch (new cards + re-grades),
   then write via `mem_card_create` / `mem_card_update`.
5. Report: cards written, cards re-graded (old → new confidence), and the
   one-line reason each.
```

- [ ] **Step 3:** check-surface.mjs: remove `retro` from `SPEC_RESERVED`.
- [ ] **Step 4: Verify** — check-surface clean, 20 live / 8 reserved; server suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(plugin): retro verb live — lessons with provenance + confidence re-grading"`

### Task 9: `distill` + `brief` verbs

**Files:**
- Create: `skills/cairn-trailhead/verbs/distill.md`, `skills/cairn-trailhead/verbs/brief.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (two rows → live), `scripts/check-surface.mjs` (drop both)

- [ ] **Step 1:** SKILL.md rows:

```markdown
| `distill` | Ship-time synthesis — plans + cards → public-safe docs/ | | verbs/distill.md | live |
| `brief` | Onboarding briefing from cards + plans | `[--stdout]` | verbs/brief.md | live |
```

- [ ] **Step 2:** `verbs/distill.md`:

```markdown
---
verb: distill
args: ""
status: live
---

Ship-time knowledge synthesis (#3519) — run at/after `ship` or `summit`.
The output must read as if the repo never had planning scaffolding.

1. Inputs: shipped phases' CONTEXT.md locked decisions, PLAN.md outcomes,
   LEDGER.md summaries, decision/constraint cards in scope
   (`mem_card_list`).
2. Generate into `docs/`:
   - ARCHITECTURE.md — per-section merge for what structurally changed.
     NEVER clobber hand-written content: update matching sections, append
     new ones, and surface conflicts to the user instead of overwriting.
   - docs/adr/NNNN-<slug>.md — one ADR per locked decision that shaped
     code (next free NNNN; context/decision/consequences; reference
     commits, not phase dirs).
   - CHANGELOG.md — entries from ledger summaries grouped by milestone or
     phase, newest first.
3. Sanitize BEFORE writing: run
   `node <plugin>/hooks/scripts/leak-patterns.mjs <each generated file>`
   (write to a temp path first). Any hit → rewrite that line to
   public-safe form: tracker ids → plain prose ("the issue tracker"),
   phase/dir refs → the milestone or version name, `.cairn/` paths →
   remove. Re-scan until clean — the scanner exiting 0 is the gate.
4. Show the diff summary (files, sections touched, ADR titles) — ONE
   confirmation — then write and offer a `docs(distill): …` commit.
```

- [ ] **Step 3:** `verbs/brief.md`:

```markdown
---
verb: brief
args: "[--stdout]"
status: live
---

Onboarding briefing for someone who wasn't there (#1219). A view, not a
source of truth — regenerate wholesale each run.

1. Gather: PROJECT.md (vision, requirements), roadmap.md (milestone,
   phase table, archive section), per-phase one-liners from LEDGER.md
   summaries, decision/constraint cards at confidence high (medium only
   when directly load-bearing) via `mem_card_list`.
2. Compose one readable briefing: what this project is, where it stands
   (milestone/phases shipped), how it's structured, the decisions and
   constraints a newcomer must respect, where to start.
3. Cache-stability rules: no volatile timestamps (date granularity only),
   stable ordering.
4. Default: write `docs/BRIEF.md` (full overwrite — it is generated) and
   say so; `--stdout`: print instead of writing.
```

- [ ] **Step 4:** check-surface.mjs: remove `distill` and `brief` from `SPEC_RESERVED`.
- [ ] **Step 5: Verify** — check-surface clean, 22 live / 6 reserved; server suite green.
- [ ] **Step 6: Commit** — `git commit -m "feat(plugin): distill + brief verbs live"`

### Task 10: `tune` verb + config template

**Files:**
- Create: `skills/cairn-trailhead/verbs/tune.md`
- Modify: `skills/cairn-trailhead/SKILL.md` (row → live), `scripts/check-surface.mjs` (drop `tune`), `templates/cairn.json.example`

- [ ] **Step 1:** SKILL.md row:

```markdown
| `tune` | Configure cairn.json — models, continuity, leak guard | `[key] [value]` | verbs/tune.md | live |
```

- [ ] **Step 2:** `verbs/tune.md`:

```markdown
---
verb: tune
args: "[key] [value]"
status: live
---

Config editor over cairn.json — all writes through `config_set`, never
hand-edits (single-writer rule).

- Bare `tune`: `config_get` → show the effective config grouped (tracker /
  agents / memory / continuity / leakGuard), marking values that are
  defaults vs explicitly set. Ask which group to change, then batch that
  group's edits into ONE AskUserQuestion. Apply via `config_set`; echo the
  resulting effective values.
- `tune <key> <value>`: direct dot-path set — build the nested patch from
  the dot path (`continuity.resume auto` → `{continuity: {resume:
  "auto"}}`), `config_set`, echo old → new. Value `null` deletes the key.
- `tune leakguard off|on` = `config_set({leakGuard: {enabled: false|true}})`
  — the guard's front door.
- Secrets: the server refuses credential-looking keys/values. When that
  happens, point at the env vars the backend actually reads (the adapter's
  *Env config keys name them).
```

- [ ] **Step 3:** `templates/cairn.json.example` — add a `leakGuard` block matching the schema defaults (`enabled: true`, empty `allow`/`extraPatterns`) with a one-line comment-style note in whatever convention the file already uses.
- [ ] **Step 4:** check-surface.mjs: remove `tune` from `SPEC_RESERVED`.
- [ ] **Step 5: Verify** — check-surface clean, **23 live / 5 reserved / 36 tools**; server suite green.
- [ ] **Step 6: Commit** — `git commit -m "feat(plugin): tune verb live — Tier B surface complete"`

### Task 11: Docs, drill procedures, final green

**Files:**
- Modify: `VERIFICATION.md`, `README.md`, `server/README.md`

- [ ] **Step 1:** server/README.md — add the 3 new tools to the tool table (descriptions matching the registrations), bump count to 36; document hook #4 in the hooks section.
- [ ] **Step 2:** README.md — verb list/count → 23 live.
- [ ] **Step 3:** VERIFICATION.md — append a Tier B section per the Tier A conventions: CI ratchet (23 live / 5 reserved / 36 tools), unit evidence summary (card confidence round-trip + id stability, config merge/refusal matrix, leak-pattern matrix incl. the GitHub `#N` non-match, hook block/pass/bypass/timing), and the spec §6.3 drill procedures — **Mark / Leak / Retro / Distill drills — each marked PENDING (run live)** with their pass conditions transcribed from the spec.
- [ ] **Step 4: Full gate** — `cd server && npx vitest run && npx tsc --noEmit && npm run build && cd .. && node scripts/check-surface.mjs` — all green; commit dist if changed.
- [ ] **Step 5: Commit** — `git commit -m "docs(cairn): Tier B verification record — drill procedures pending live run"`

---

**Success criteria traceability (spec §Success):** 1 one-call capture → Task 7 verb rule; 2 leak guard blocks <100ms + hatches → Task 6 tests + Task 11 drill; 3 confidence changes via retro → Tasks 2/8 + retro drill; 4 distill zero internal refs → Task 9 sanitize gate + drill; 5 tune safe round-trip → Tasks 3/4/10; 6 CI 23/5/36 → Tasks 7–10 ratchet, checked at Task 11.
