# Local Tracker Phase 1 — Adapter Core + Links SPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a usable `tracker.type: "local"` backend — full SPI on the probe-validated maildir layout, plus first-class issue links — per `docs/superpowers/specs/2026-07-26-local-tracker-design.md` (CRN-50, phase 1 of 4).

**Architecture:** New adapter `server/src/tracker/adapters/local.ts` storing issues as per-issue directories (`issue.md` spaced frontmatter, file-per-comment/worklog/edge). SPI gains optional `linkIssues`/`unlinkIssues`/`listLinks` (FakeTracker gets a real implementation; CachedTracker forwards). Contract suite gains a links section. Server exposes `issue_link`/`issue_unlink`/`issue_links` tools.

**Tech Stack:** TypeScript ESM, zod, node:fs, vitest. Zero new dependencies (design rule).

## Global Constraints

- Zero external dependencies; stock git only.
- `issue.md` frontmatter keeps ONE BLANK LINE between fields — merge-safety mechanism, never "cleaned up".
- IDs: `<prefix>-<5-char base36>`, retry against visible set.
- Edges: one file per edge `edges/<type>--<target>.md`; inverses derived, never stored.
- Typed CairnErrors only (`NOT_FOUND`, `CONFIG_INVALID`, `UNSUPPORTED`); no `TRACKER_DOWN` paths (no remote).
- Probe prototype at `.cairn/probe/probe-4e2e46ac/local-tracker-proto.ts` is REFERENCE ONLY — production code is written fresh in the server tree with tests first.

---

### Task 1: SPI link surface — types, FakeTracker, CachedTracker, contract

**Files:**
- Modify: `server/src/tracker/types.ts`
- Modify: `server/src/tracker/fake.ts`
- Modify: `server/src/tracker/cached.ts`
- Modify: `server/test/contract.ts`
- Test: `server/test/cache.test.ts` (extend)

**Interfaces:**
- Produces (Tasks 2–4 consume):

```ts
export type LinkType = "blocks" | "parent-of" | "relates-to" | "supersedes";
export interface IssueLink { from: string; type: LinkType; to: string }
// on Tracker (all optional — present only when hasDependencies):
linkIssues?(from: string, type: LinkType, to: string): Promise<void>;
unlinkIssues?(from: string, type: LinkType, to: string): Promise<void>;
listLinks?(id?: string): Promise<IssueLink[]>;
```

- [ ] **Step 1: Extend the contract** (`test/contract.ts`, new test at the end of `trackerContract`)

```ts
    it("links: create → list → unlink when hasDependencies; absent methods otherwise", async () => {
      if (!t.capabilities.hasDependencies) {
        expect(t.linkIssues).toBeUndefined();
        return;
      }
      const a = await t.createIssue({ title: "contract: link-from" });
      const b = await t.createIssue({ title: "contract: link-to" });
      await t.linkIssues!(a.id, "blocks", b.id);
      const all = await t.listLinks!();
      expect(all).toContainEqual({ from: a.id, type: "blocks", to: b.id });
      const ofA = await t.listLinks!(a.id);
      expect(ofA).toContainEqual({ from: a.id, type: "blocks", to: b.id });
      await t.unlinkIssues!(a.id, "blocks", b.id);
      expect(await t.listLinks!(a.id)).not.toContainEqual({ from: a.id, type: "blocks", to: b.id });
    });

    it("links: linking a nonexistent issue is NOT_FOUND; cycles are rejected", async () => {
      if (!t.capabilities.hasDependencies) return;
      const a = await t.createIssue({ title: "contract: cycle-a" });
      const b = await t.createIssue({ title: "contract: cycle-b" });
      await expect(t.linkIssues!(a.id, "blocks", "no-such-id"))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await t.linkIssues!(a.id, "blocks", b.id);
      await expect(t.linkIssues!(b.id, "blocks", a.id))
        .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });
```

- [ ] **Step 2: Run** `cd server && npx vitest run test/contract-fake.test.ts`
Expected: FAIL — fake declares `hasDependencies: true` but `linkIssues` missing (first test) — the existing dishonest flag surfaces immediately.

- [ ] **Step 3: Implement**

`types.ts` — add above the `Tracker` interface:

```ts
export type LinkType = "blocks" | "parent-of" | "relates-to" | "supersedes";

export interface IssueLink { from: string; type: LinkType; to: string }
```

and inside `Tracker`, after `resolveSelf?`:

```ts
  /** Issue links. Present only on adapters with hasDependencies. */
  linkIssues?(from: string, type: LinkType, to: string): Promise<void>;
  unlinkIssues?(from: string, type: LinkType, to: string): Promise<void>;
  /** id given → links touching that issue (either direction); omitted → all. */
  listLinks?(id?: string): Promise<IssueLink[]>;
```

`fake.ts` — real in-memory implementation:

```ts
  private links: IssueLink[] = [];

  private wouldCycle(from: string, type: LinkType, to: string): boolean {
    if (type !== "blocks" && type !== "parent-of") return false;
    // walk from `to` along same-type edges; hitting `from` closes a cycle
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const l of this.links) if (l.from === cur && l.type === type) stack.push(l.to);
    }
    return false;
  }

  async linkIssues(from: string, type: LinkType, to: string): Promise<void> {
    await this.getIssue(from);
    await this.getIssue(to);
    if (this.wouldCycle(from, type, to)) {
      throw new CairnError("CONFIG_INVALID",
        `link ${from} ${type} ${to} would create a cycle`);
    }
    if (!this.links.some((l) => l.from === from && l.type === type && l.to === to)) {
      this.links.push({ from, type, to });
    }
  }

  async unlinkIssues(from: string, type: LinkType, to: string): Promise<void> {
    this.links = this.links.filter((l) => !(l.from === from && l.type === type && l.to === to));
  }

  async listLinks(id?: string): Promise<IssueLink[]> {
    return id === undefined ? [...this.links]
      : this.links.filter((l) => l.from === id || l.to === id);
  }
```

(import `IssueLink, LinkType` from `./types.js`.)

`cached.ts` — alongside `logWork`/`resolveSelf` fields:

```ts
  linkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
  unlinkIssues?: (from: string, type: LinkType, to: string) => Promise<void>;
  listLinks?: (id?: string) => Promise<IssueLink[]>;
```

constructor, after the `resolveSelf` block (writes clear the cache; the list read is not cached — link data is cheap and cache-coherence is not worth the keys):

```ts
    if (inner.linkIssues) {
      this.linkIssues = async (f, ty, to) => { await this.inner.linkIssues!(f, ty, to); this.cache.clear(); };
    }
    if (inner.unlinkIssues) {
      this.unlinkIssues = async (f, ty, to) => { await this.inner.unlinkIssues!(f, ty, to); this.cache.clear(); };
    }
    if (inner.listLinks) {
      this.listLinks = (id) => this.inner.listLinks!(id);
    }
```

(import the two types.)

- [ ] **Step 4: CachedTracker forwarding tests** (append to `cache.test.ts`)

```ts
  it("forwards the link methods when the inner adapter has them", async () => {
    const inner = new FakeTracker();
    const t = new CachedTracker(inner);
    const a = await t.createIssue({ title: "la" });
    const b = await t.createIssue({ title: "lb" });
    await t.linkIssues!(a.id, "blocks", b.id);
    expect(await t.listLinks!(a.id)).toContainEqual({ from: a.id, type: "blocks", to: b.id });
    await t.unlinkIssues!(a.id, "blocks", b.id);
    expect(await t.listLinks!(a.id)).toEqual([]);
  });
```

- [ ] **Step 5: Run** `npx vitest run && npx tsc --noEmit` — all green (contract-fake now passes the links section).
- [ ] **Step 6: Commit** `feat(tracker): issue-link SPI — types, fake implementation, CachedTracker forwarding, contract coverage`

---

### Task 2: Local adapter core (no edges yet) — passes the base contract

**Files:**
- Create: `server/src/tracker/adapters/local.ts`
- Test: `server/test/local.unit.test.ts` (create) + `server/test/contract-local.test.ts` (create)

**Interfaces:**
- Consumes: `Tracker`/`Capability` types; Task 1's link types (declared, wired in Task 3).
- Produces: `configSchema` (zod: `dir` default `".tracker"`, `prefix` string 2–10 lowercase alnum, default `"lt"`), `make(config, projectDir)` and `LocalTracker` class; `newId(prefix, taken)` exported for tests.

Behavior (spec §Storage layout):
- Root `<projectDir>/<dir>`; `issues/`, `phases/`, `milestones/` created lazily; `config.json` written on first init `{ prefix, version: 1 }`.
- `issue.md` = spaced frontmatter (`id`, `title` JSON-quoted, `state`, `labels` JSON array, `assignee`, `phase`, `priority`, `updatedAt`) + body. Reader tolerates missing fields.
- `priority` field surfaces through the SPI as a `priority:<value>` label appended to `labels` on read; a `priority:<value>` label in a patch is stripped back into the field on write.
- Comments: `comments/<ISO-ts-with-[:.]-stripped>-<who>.md`; `who` = `resolveSelf()` or `"anon"`.
- Worklog: `worklog/<ts>-<who>.md`, first line `<minutes>m`.
- `resolveSelf()`: `git config user.name` (via `execFileSync`, cwd = projectDir, errors swallowed) → `process.env.USER` → undefined; memoized.
- Capabilities: everything true EXCEPT `hasDependencies` stays `false` until Task 3 flips it with the edge implementation (the flag is never ahead of the code — that is the whole lesson).
- Errors: `NOT_FOUND` on missing issue/phase/milestone ids; `CONFIG_INVALID` from zod via registry (Task 4).

- [ ] **Step 1: Failing tests.** `contract-local.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackerContract } from "./contract.js";
import { configSchema, make } from "../src/tracker/adapters/local.js";

trackerContract("local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-local-"));
  return make(configSchema.parse({ prefix: "lt" }), dir);
});
```

`local.unit.test.ts` — the local-specific behaviors the contract can't see:

```ts
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configSchema, make, newId } from "../src/tracker/adapters/local.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-lu-"));
  return { dir, t: make(configSchema.parse({ prefix: "lt" }), dir) };
}

describe("LocalTracker storage shape", () => {
  it("writes spaced frontmatter — a blank line between every field", async () => {
    const { dir, t } = fresh();
    const i = await t.createIssue({ title: "Spacing", body: "b" });
    const raw = readFileSync(join(dir, ".tracker", "issues", i.id, "issue.md"), "utf8");
    const fm = raw.split("---")[1];
    // no two field lines may be adjacent
    expect(fm).not.toMatch(/^[a-z]+: .*\n[a-z]+: /mi);
  });

  it("ids are prefix + 5-char base36 and newId retries taken ids", () => {
    const taken = new Set<string>();
    const id = newId("lt", taken);
    expect(id).toMatch(/^lt-[0-9a-z]{5}$/);
    taken.add(id);
    expect(newId("lt", taken)).not.toBe(id);
  });

  it("priority field roundtrips as a priority: label through the SPI", async () => {
    const { t } = fresh();
    const i = await t.createIssue({ title: "P", labels: ["core", "priority:P1"] });
    const got = await t.getIssue(i.id);
    expect(got.labels).toContain("priority:P1");
    expect(got.labels).toContain("core");
  });

  it("comments and worklog land as one file each", async () => {
    const { dir, t } = fresh();
    const i = await t.createIssue({ title: "C" });
    await t.commentIssue(i.id, "hello");
    await t.commentIssue(i.id, "again");
    await t.logWork!(i.id, 25);
    const base = join(dir, ".tracker", "issues", i.id);
    expect(readdirSync(join(base, "comments")).length).toBe(2);
    const wl = readdirSync(join(base, "worklog"));
    expect(wl.length).toBe(1);
    expect(readFileSync(join(base, "worklog", wl[0]), "utf8")).toMatch(/^25m/);
  });

  it("scaffolds config.json once with the prefix", async () => {
    const { dir, t } = fresh();
    await t.createIssue({ title: "seed" });
    const cfg = JSON.parse(readFileSync(join(dir, ".tracker", "config.json"), "utf8"));
    expect(cfg).toEqual({ prefix: "lt", version: 1 });
  });

  it("body with frontmatter-looking content survives roundtrip", async () => {
    const { t } = fresh();
    const body = "intro\n\n---\nnot: frontmatter\n---\n\noutro";
    const i = await t.createIssue({ title: "tricky", body });
    expect((await t.getIssue(i.id)).body).toContain("not: frontmatter");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/contract-local.test.ts test/local.unit.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement `local.ts`.** Start from the probe prototype's shape (reference only) with these production upgrades: file-purpose header comment; zod `configSchema`; `make(config, projectDir)`; frontmatter parser anchored to the FIRST `---\n...\n---` block only (regex `^---\n([\s\S]*?)\n---\n?` with the remainder as body — tricky-body test above pins this); `priority` field ↔ label mapping; comment/worklog author from `resolveSelf`; `newId` exported; `logWork` + `resolveSelf` per spec; capabilities `hasDependencies: false` for now.

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green (contract-local passes 11 base tests + skips links via absent methods... note: the Task 1 contract asserts `linkIssues` is `undefined` when `hasDependencies` is false — satisfied).

- [ ] **Step 5: Commit** `feat(tracker): local adapter core — maildir store passing the full base contract`

---

### Task 3: Edges — link methods, cycle guard, merge-safety regression

**Files:**
- Modify: `server/src/tracker/adapters/local.ts`
- Test: `server/test/local.unit.test.ts` (extend) + `server/test/local-merge.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `LinkType`/`IssueLink`.
- Produces: `hasDependencies: true` on the local adapter; edge files `edges/<type>--<target>.md`.

- [ ] **Step 1: Failing tests.** Append to `local.unit.test.ts`:

```ts
describe("LocalTracker edges", () => {
  it("linkIssues writes one file per edge; listLinks derives both directions", async () => {
    const { dir, t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    await t.linkIssues!(a.id, "blocks", b.id);
    expect(existsSync(join(dir, ".tracker", "issues", a.id, "edges", `blocks--${b.id}.md`))).toBe(true);
    // stored once, visible from both ends
    expect(await t.listLinks!(a.id)).toContainEqual({ from: a.id, type: "blocks", to: b.id });
    expect(await t.listLinks!(b.id)).toContainEqual({ from: a.id, type: "blocks", to: b.id });
    expect((await t.listLinks!()).length).toBe(1);
  });

  it("rejects cycles on blocks and parent-of; allows relates-to loops", async () => {
    const { t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    const c = await t.createIssue({ title: "C" });
    await t.linkIssues!(a.id, "blocks", b.id);
    await t.linkIssues!(b.id, "blocks", c.id);
    await expect(t.linkIssues!(c.id, "blocks", a.id))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await t.linkIssues!(a.id, "relates-to", b.id);
    await t.linkIssues!(b.id, "relates-to", a.id); // fine — undirected in spirit
  });

  it("unlink removes the file; edge to unknown issue is NOT_FOUND", async () => {
    const { dir, t } = fresh();
    const a = await t.createIssue({ title: "A" });
    const b = await t.createIssue({ title: "B" });
    await t.linkIssues!(a.id, "supersedes", b.id);
    await t.unlinkIssues!(a.id, "supersedes", b.id);
    expect(existsSync(join(dir, ".tracker", "issues", a.id, "edges", `supersedes--${b.id}.md`))).toBe(false);
    await expect(t.linkIssues!(a.id, "blocks", "lt-zzzzz"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
```

`local-merge.test.ts` — the probe's E1b productionized (helper runs `git init`/branch/edit/merge in a temp dir via `execFileSync`, asserting clean merges): scenarios `two branches create issues`, `both sides comment the same issue`, `both sides add different edges to the same issue`, `different fields of the same issue edited`. Each scenario drives edits THROUGH a LocalTracker instance pointed at the branch checkout (not hand-written files), commits, merges, expects merge exit 0. One scenario asserts the desired conflict: same field both sides → merge fails.

- [ ] **Step 2: Run both files** — FAIL (no link methods on local).

- [ ] **Step 3: Implement.** Edge files under the SOURCE issue's dir; `listLinks()` walks all issue dirs' `edges/`; `listLinks(id)` filters `from === id || to === id`; cycle guard identical in shape to fake's `wouldCycle` but walking edge files; flip `hasDependencies: true`. Also update `contract-local.test.ts` — nothing to change (contract links section now runs against local automatically).

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — green, including contract links section on BOTH fake and local, and merge regression suite.

- [ ] **Step 5: Commit** `feat(tracker): local adapter edges — file-per-edge links, cycle guard, merge-safety regression suite`

---

### Task 4: Registry, config enum, server link tools

**Files:**
- Modify: `server/src/config.ts` (tracker.type enum)
- Modify: `server/src/tracker/registry.ts`
- Modify: `server/src/index.ts` (three new tools)
- Modify: `templates/cairn.json.example` (`_alternatives` gains a local block)
- Test: `server/test/mcp.test.ts` (extend), registry test file (find with `grep -rln "makeTracker" server/test`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `tracker.type: "local"` end-to-end; MCP tools `issue_link`, `issue_unlink`, `issue_links`.

- [ ] **Step 1: Failing tests.** Registry test (mirror the file's existing per-type case): `type: "local"` + `{ }` config constructs a LocalTracker (dir defaults), capabilities.hasDependencies true. `mcp.test.ts` (harness runs FakeTracker, which now has real links):

```ts
  it("issue_link → issue_links → issue_unlink roundtrip", async () => {
    const a = await call("issue_create", { title: "link a" });
    const b = await call("issue_create", { title: "link b" });
    await call("issue_link", { from: a.json.id, type: "blocks", to: b.json.id });
    const links = await call("issue_links", { id: a.json.id });
    expect(links.json.links).toContainEqual({ from: a.json.id, type: "blocks", to: b.json.id });
    await call("issue_unlink", { from: a.json.id, type: "blocks", to: b.json.id });
    expect((await call("issue_links", { id: a.json.id })).json.links).toEqual([]);
  });

  it("issue_link surfaces cycle rejection as a typed error", async () => {
    const a = await call("issue_create", { title: "cyc a" });
    const b = await call("issue_create", { title: "cyc b" });
    await call("issue_link", { from: a.json.id, type: "blocks", to: b.json.id });
    const res = await call("issue_link", { from: b.json.id, type: "blocks", to: a.json.id });
    expect(res.isError).toBe(true);
    expect(res.json.code).toBe("CONFIG_INVALID");
  });
```

- [ ] **Step 2: Run** — FAIL (unknown tools / unknown type).

- [ ] **Step 3: Implement.**
`config.ts`: `type: z.enum(["github", "gitlab", "jira", "asana", "azure-boards", "clickup", "local"])`.
`tracker/registry.ts`: add `local: "./adapters/local.js"` to its adapter path map, passing `projectDir` to `make` the way the registry constructs adapters (read the registry first; if its `make(config)` convention is single-arg, export `make(config, projectDir?)` from local.ts and extend the registry's constructor call site for the local case).
`index.ts`, three tools following `issue_update`'s shape:

```ts
  const LinkTypeEnum = z.enum(["blocks", "parent-of", "relates-to", "supersedes"]);

  server.registerTool("issue_link",
    { description: "Link two issues (blocks/parent-of/relates-to/supersedes); UNSUPPORTED unless the tracker hasDependencies",
      inputSchema: { from: z.string(), type: LinkTypeEnum, to: z.string() } },
    wrap(async (a: { from: string; type: LinkType; to: string }) => {
      const t = await getTracker(dir());
      if (!t.capabilities.hasDependencies || !t.linkIssues) {
        throw new CairnError("UNSUPPORTED", "this tracker has no dependency links");
      }
      await t.linkIssues(a.from, a.type, a.to);
      return { linked: { from: a.from, type: a.type, to: a.to } };
    }));
```

(`issue_unlink` mirrors with `unlinkIssues`; `issue_links` takes `{ id: z.string().optional() }` and returns `{ links: await t.listLinks(id) }` with the same gate.)
`templates/cairn.json.example`: add to `_alternatives`: `{ "type": "local", "config": { "dir": ".tracker", "prefix": "proj" } }` with a one-line `$comment` (zero-credential, repo-resident; commit the dir).

- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit` — all green.
- [ ] **Step 5: Commit** `feat(tracker): local backend registered end-to-end + issue link tools`

---

## Verification (phase gate)

- Full suite + typecheck green; contract suite passing for local AND all existing adapters (no regressions in the links section on flag-false backends).
- Manual smoke: temp project with `tracker: {type: "local"}` in cairn.json → through the real MCP server create/claim/link/comment/close a few issues; inspect the `.tracker/` tree by eye (human-diffable is a requirement — look at it); `git diff` the store to confirm readable diffs.
- Merge-safety regression suite green (the E1b scenarios as durable tests).
- Comment progress on CRN-50 (phase 1 shipped, PR link); phases 2–4 get their own plan docs when started.
