# Docusaurus Docs Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A filesystem `DocsConnector` that publishes cairn's docs tree into a local Docusaurus site checkout, per `docs/superpowers/specs/2026-07-25-docusaurus-docs-connector-design.md` (CRN-47).

**Architecture:** New adapter `server/src/docs/adapters/docusaurus.ts` writing markdown + `_category_.json` under `<sitePath>/<docsDir>/<project-slug>/`. Three small SPI extensions: `DocsCapability.hasNativeToc` (publisher skips generated TOCs), `PageSpec.container` (folder-vs-file hint), optional `DocsConnector.finalize()` (post-publish hook → auto-commit warning). Confluence behavior stays byte-identical.

**Tech Stack:** TypeScript ESM, zod config schema, node:fs/node:path, vitest, temp-dir fixtures. No new dependencies.

## Global Constraints

- All errors are typed `CairnError`s (`CONFIG_INVALID`, `NOT_FOUND`) with `nextAction` strings — never raw throws.
- `Page.id` = path relative to `docsDir`, POSIX separators. `Page.url` = absolute file path.
- Everything under `<docsDir>/<project-slug>/` is cairn-managed; adapter never touches files outside it.
- Rename keeps the file path (stable URLs): `updatePage` with a new title rewrites front matter only.
- Auto-commit never pushes and never fails the publish — degradation is a `warning` string on the result.
- Match house style: file-purpose header comments, adapters mirror `confluence.ts` structure.

---

### Task 1: SPI extensions — `hasNativeToc`, `PageSpec.container`, `finalize?()`

**Files:**
- Modify: `server/src/docs/types.ts`
- Modify: `server/src/docs/fake.ts:20-22` (capabilities)
- Modify: `server/src/docs/adapters/confluence.ts:42-44` (capabilities)
- Modify: `server/test/docs-contract.ts:18-23` (capability assertions)

**Interfaces:**
- Produces: `DocsCapability.hasNativeToc: boolean`; `PageSpec.container?: boolean`; `DocsConnector.finalize?(): Promise<string | undefined>` — Task 2's publisher and Task 3's adapter consume all three.

- [ ] **Step 1: Extend the contract's capability test** (in `docsConnectorContract`, `declares capabilities` test)

```ts
      expect(typeof c.capabilities.hasNativeToc).toBe("boolean");
```

- [ ] **Step 2: Run contract-backed suites to verify they fail**

Run: `cd server && npx vitest run test/contract-docs-fake.test.ts`
Expected: FAIL — `hasNativeToc` is `undefined`, not boolean

- [ ] **Step 3: Extend the SPI** (`types.ts`)

```ts
export interface DocsCapability {
  /** Pages can nest under parent pages (tree, not flat list). */
  hasPageTree: boolean;
  /** Binary attachments can be uploaded to a page. */
  hasAttachments: boolean;
  /** Pages can carry labels/tags. */
  hasLabels: boolean;
  /** Backend renders directory/landing indexes natively — the publisher
   *  must not append generated TOC markdown. */
  hasNativeToc: boolean;
}
```

In `PageSpec`:

```ts
  /** Hint: this page will have child pages. Filesystem backends need to
   *  know folder-vs-file at create time; API backends may ignore it. */
  container?: boolean;
```

In `DocsConnector`:

```ts
  /** Post-publish hook (e.g. auto-commit). Returns a warning string when the
   *  step degraded, undefined when clean or not applicable. */
  finalize?(): Promise<string | undefined>;
```

- [ ] **Step 4: Declare the capability on both existing connectors**

`fake.ts`:

```ts
  readonly capabilities: DocsCapability = {
    hasPageTree: true, hasAttachments: false, hasLabels: false, hasNativeToc: false,
  };
```

`confluence.ts`:

```ts
  readonly capabilities: DocsCapability = {
    hasPageTree: true, hasAttachments: true, hasLabels: true, hasNativeToc: false,
  };
```

- [ ] **Step 5: Run the full suite**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all pass, typecheck clean

- [ ] **Step 6: Commit**

```bash
git add server/src/docs/types.ts server/src/docs/fake.ts server/src/docs/adapters/confluence.ts server/test/docs-contract.ts
git commit -m "feat(docs): SPI groundwork for filesystem connectors — hasNativeToc, container hint, finalize hook"
```

---

### Task 2: Publisher — native-TOC branch, container hint, finalize → warning

**Files:**
- Modify: `server/src/docs/publish.ts`
- Test: `server/test/publish-native-toc.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `hasNativeToc`, `container`, `finalize?()`.
- Produces: `PublishResult.warning?: string`; `upsert(connector, title, markdown, parentId, context, container)` (internal); publisher passes `container: node.children.length > 0` on every page upsert.

- [ ] **Step 1: Write the failing tests** (`server/test/publish-native-toc.test.ts`)

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FakeDocsConnector } from "../src/docs/fake.js";
import { publishTree } from "../src/docs/publish.js";
import type { DocsCapability } from "../src/docs/types.js";

/** Fake flipped to native-TOC mode, recording container hints and finalize. */
class NativeTocFake extends FakeDocsConnector {
  override readonly capabilities: DocsCapability = {
    hasPageTree: true, hasAttachments: false, hasLabels: false, hasNativeToc: true,
  };
  containers: string[] = [];
  finalized = false;
  override async createPage(spec: Parameters<FakeDocsConnector["createPage"]>[0]) {
    if (spec.container) this.containers.push(spec.title);
    return super.createPage(spec);
  }
  async finalize(): Promise<string | undefined> {
    this.finalized = true;
    return "commit skipped: not a git repo";
  }
}

function fixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-pub-"));
  writeFileSync(join(dir, "README.md"), "# Proj\n\nlanding");
  mkdirSync(join(dir, "docs", "guide"), { recursive: true });
  writeFileSync(join(dir, "docs", "intro.md"), "# Intro\n\nhello");
  writeFileSync(join(dir, "docs", "guide", "setup.md"), "# Setup\n\nsteps");
  return dir;
}

describe("publishTree with hasNativeToc", () => {
  it("appends no generated TOC markdown anywhere", async () => {
    const c = new NativeTocFake();
    await publishTree(c, fixtureProject(), "proj");
    for (const p of c.pages.values()) {
      expect(p.markdown).not.toContain("## Documentation");
      expect(p.markdown).not.toMatch(/^- \[.*\]\(fake:\/\//m);
    }
  });

  it("passes the container hint for directory nodes only", async () => {
    const c = new NativeTocFake();
    await publishTree(c, fixtureProject(), "proj");
    expect(c.containers).toContain("Guide");
    expect(c.containers).not.toContain("Intro");
  });

  it("calls finalize and surfaces its warning on the result", async () => {
    const c = new NativeTocFake();
    const result = await publishTree(c, fixtureProject(), "proj");
    expect(c.finalized).toBe(true);
    expect(result.warning).toBe("commit skipped: not a git repo");
  });

  it("without hasNativeToc the landing TOC is still generated", async () => {
    const c = new FakeDocsConnector();
    await publishTree(c, fixtureProject(), "proj");
    const bodies = [...c.pages.values()].map((p) => p.markdown).join("\n");
    expect(bodies).toContain("## Documentation");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/publish-native-toc.test.ts`
Expected: FAIL — `warning` undefined, TOC still appended, no container hints

- [ ] **Step 3: Implement in `publish.ts`**

`PublishResult` gains:

```ts
  /** Degraded-but-successful post-publish step (e.g. auto-commit skipped). */
  warning?: string;
```

`upsert` gains a trailing `container: boolean` param, threaded into both
`createPage` calls (`{ title, markdown, parentId, container }`) — update
signatures only, logic unchanged.

`publishNode`: pass `node.children.length > 0` to `upsert`; wrap the
child-list refresh:

```ts
  if (node.children.length > 0) {
    const childEntries: Array<{ title: string; url: string }> = [];
    for (const child of node.children) {
      const childPage = await publishNode(connector, child, page.id, node.title, sink);
      childEntries.push({ title: childPage.title, url: childPage.url });
    }
    if (!connector.capabilities.hasNativeToc) {
      const body = node.markdown
        ? `${node.markdown}\n\n${dirTocMarkdown(childEntries)}`
        : dirTocMarkdown(childEntries);
      page = await connector.updatePage(page.id, {
        title: page.title, markdown: body, parentId, container: true,
      });
    }
  }
```

`publishTree`: landing page markdown becomes

```ts
  const landing = connector.capabilities.hasNativeToc
    ? readme
    : `${readme}${tocMarkdown(topEntries)}`;
  const updatedRoot = await connector.updatePage(root.id, {
    title: name, markdown: landing, container: true,
  });
  const warning = await connector.finalize?.();
  return { root: updatedRoot, published: 1 + pages.length, pages,
    ...(warning ? { warning } : {}) };
```

`publishReadme`: same `finalize` call before returning.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run`
Expected: new file passes; existing suites (fake path is `hasNativeToc: false`) unchanged

- [ ] **Step 5: Commit**

```bash
git add server/src/docs/publish.ts server/test/publish-native-toc.test.ts
git commit -m "feat(docs): publisher honors hasNativeToc, container hints, finalize warnings"
```

---

### Task 3: Docusaurus adapter — filesystem connector

**Files:**
- Create: `server/src/docs/adapters/docusaurus.ts`
- Test: `server/test/docusaurus.unit.test.ts` (create)

**Interfaces:**
- Consumes: `DocsConnector`/`PageSpec.container` from Task 1.
- Produces: `configSchema` (zod: `sitePath: string`, `docsDir` default `"docs"`, `autoCommit` default `false`), `make(config): DocsConnector`, `slugify(title): string` — Task 4 registers it; Task 5 wires auto-commit into its `finalize`.

Behavior being built (from the spec):
- `ensureRoot(name)` → `<docsDir>/<slugify(name)>/` + `_category_.json` `{label: name, ...}`; probes `docusaurus.config.{js,ts,mjs}` in `sitePath` first → `CONFIG_INVALID` if absent; creates `docsDir` if missing.
- Leaf create → `<parent>/<slug>.md`: YAML front matter `title` (double-quoted, `"`/`\` escaped), `sidebar_position` (= md-file sibling count + 1), `sidebar_custom_props: {cairn_version: N}`; body verbatim below.
- Container create/update → folder; non-empty markdown → `index.md` + `_category_.json {label, position}`; empty markdown → `_category_.json` with `"link": {"type": "generated-index"}` and no `index.md`.
- `updatePage` → rewrite in place (folder ids keep folder semantics — detect via `statSync`); keep `sidebar_position`, bump `cairn_version`, keep file path on title change.
- `findPage(title, parentId)` → probe `<parent>/<slug>.md` then `<parent>/<slug>/`; miss → scan the parent dir's front matter/`_category_.json` for an exact title match (rename fallback); no `parentId` → recursive scan under the project root (`ensureRoot` result, else `docsDir`).
- `getPage` on a missing path → `NOT_FOUND`.
- `Page.version` = `cairn_version`; `Page.url` = absolute path.

- [ ] **Step 1: Write the failing unit tests** (`server/test/docusaurus.unit.test.ts`)

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configSchema, make, slugify } from "../src/docs/adapters/docusaurus.js";

function tempSite(): string {
  const site = mkdtempSync(join(tmpdir(), "cairn-dsite-"));
  writeFileSync(join(site, "docusaurus.config.js"), "export default {};\n");
  return site;
}

function connectorAt(site: string) {
  const cfg = configSchema.parse({ sitePath: site });
  return { cfg, c: make(cfg) };
}

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, trims", () => {
    expect(slugify("Quick Start!")).toBe("quick-start");
    expect(slugify("API — v2 (draft)")).toBe("api-v2-draft");
  });
});

describe("DocusaurusConnector", () => {
  it("ensureRoot creates docs/<slug>/ with _category_.json, idempotently", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const a = await c.ensureRoot("My Proj");
    const b = await c.ensureRoot("My Proj");
    expect(b.id).toBe(a.id);
    const cat = JSON.parse(readFileSync(join(site, "docs", "my-proj", "_category_.json"), "utf8"));
    expect(cat.label).toBe("My Proj");
  });

  it("rejects a sitePath without a docusaurus config", async () => {
    const bare = mkdtempSync(join(tmpdir(), "cairn-bare-"));
    const { c } = connectorAt(bare);
    await expect(c.ensureRoot("x")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("createPage writes front matter + verbatim body; position from sibling order", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "First", markdown: "# First\n\nbody", parentId: root.id });
    const page = await c.createPage({ title: 'He said "hi"', markdown: "x", parentId: root.id });
    const raw = readFileSync(join(site, "docs", page.id), "utf8");
    expect(raw).toContain('title: "He said \\"hi\\""');
    expect(raw).toContain("sidebar_position: 2");
    expect(raw.endsWith("x\n")).toBe(true);
  });

  it("container spec creates a folder; empty markdown gets a generated-index category", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const dir = await c.createPage({ title: "Guide", markdown: "", parentId: root.id, container: true });
    const catPath = join(site, "docs", dir.id, "_category_.json");
    expect(JSON.parse(readFileSync(catPath, "utf8")).link).toEqual({ type: "generated-index" });
    expect(existsSync(join(site, "docs", dir.id, "index.md"))).toBe(false);
    const child = await c.createPage({ title: "Setup", markdown: "s", parentId: dir.id });
    expect(child.parentId).toBe(dir.id);
  });

  it("updatePage bumps version, keeps the file path on rename, preserves position", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const page = await c.createPage({ title: "Old Name", markdown: "v1", parentId: root.id });
    const updated = await c.updatePage(page.id, { title: "New Name", markdown: "v2", parentId: root.id });
    expect(updated.id).toBe(page.id); // old-name.md — path stable
    expect(updated.version ?? 0).toBeGreaterThan(page.version ?? 0);
    const raw = readFileSync(join(site, "docs", page.id), "utf8");
    expect(raw).toContain('title: "New Name"');
    expect(raw).toContain("sidebar_position: 1");
  });

  it("findPage locates by slug, falls back to front matter title after rename, null on miss", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    const page = await c.createPage({ title: "Original", markdown: "m", parentId: root.id });
    await c.updatePage(page.id, { title: "Renamed", markdown: "m", parentId: root.id });
    expect((await c.findPage("Renamed", root.id))?.id).toBe(page.id);
    expect(await c.findPage("Nope", root.id)).toBeNull();
  });

  it("listChildren returns md files and folders, never index.md or _category_.json", async () => {
    const site = tempSite();
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "Leaf", markdown: "x", parentId: root.id });
    await c.createPage({ title: "Sub", markdown: "landing", parentId: root.id, container: true });
    const kids = await c.listChildren(root.id);
    expect(kids.map((k) => k.title).sort()).toEqual(["Leaf", "Sub"]);
  });

  it("never touches files outside the project folder", async () => {
    const site = tempSite();
    writeFileSync(join(site, "docs.keep"), "untouched");
    mkdirSync(join(site, "docs"), { recursive: true });
    writeFileSync(join(site, "docs", "handwritten.md"), "mine");
    const { c } = connectorAt(site);
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "P", markdown: "x", parentId: root.id });
    expect(readFileSync(join(site, "docs", "handwritten.md"), "utf8")).toBe("mine");
    expect(readdirSync(join(site, "docs")).sort()).toEqual(["handwritten.md", "proj"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/docusaurus.unit.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `server/src/docs/adapters/docusaurus.ts`**

Skeleton (full behavior per the bullets above; mirror confluence.ts's
header-comment style):

```ts
// Docusaurus docs connector — filesystem backend. Docusaurus has no runtime
// page API: the site's docs/ folder IS the store. Pages are markdown files
// with front matter, the tree is folders + _category_.json, and deploy stays
// with the user's CI. Page.id = path relative to docsDir (POSIX).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import { CairnError } from "../../errors.js";
import type { DocsCapability, DocsConnector, Page, PageSpec } from "../types.js";

export const configSchema = z.object({
  /** Docusaurus site checkout, absolute or relative to the cairn project. */
  sitePath: z.string().min(1),
  docsDir: z.string().min(1).default("docs"),
  autoCommit: z.boolean().default(false),
});

export type DocusaurusConfig = z.infer<typeof configSchema>;

export function make(config: DocusaurusConfig): DocsConnector {
  return new DocusaurusConnector(config);
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
```

Implementation notes the code must honor:
- `sitePath` resolved via `resolve(process.cwd(), cfg.sitePath)` when relative.
- Site probe (in `ensureRoot`, cached): `docusaurus.config.js|ts|mjs` exists in
  `sitePath`, else `CairnError("CONFIG_INVALID", ...)` naming the checked path,
  nextAction "point docs.config.sitePath in cairn.json at a Docusaurus site checkout".
- Front matter writer:

```ts
function frontMatter(title: string, position: number, version: number): string {
  const quoted = `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `---\ntitle: ${quoted}\nsidebar_position: ${position}\n` +
    `sidebar_custom_props:\n  cairn_version: ${version}\n---\n\n`;
}
```

- Front matter reader: regex over the leading `---` block for `title:`,
  `sidebar_position:`, `cairn_version:` (no YAML dependency).
- `_category_.json` shape: `{ label, position, customProps: { cairn_version },
  ...(emptyMarkdown ? { link: { type: "generated-index" } } : {}) }`.
- Container pages: markdown non-empty → write `index.md` (same front matter,
  no `sidebar_position` — the folder's `_category_.json` position covers it).
- `sidebar_position` on create = count of existing sibling entries
  (`.md` files excluding `index.md`, plus subfolders) + 1.
- Root tracking: `ensureRoot` stores the root id; `createPage` with no
  `parentId` targets it, else the `docsDir` top level.
- `getPage`: `statSync` the id under `docsDir`; dir → read `_category_.json`;
  file → read front matter; `ENOENT` → `NOT_FOUND`.
- All ids built with `posix.join`; absolute paths only at fs-call boundaries.
- `finalize` is NOT implemented in this task (Task 5).

- [ ] **Step 4: Run the unit tests**

Run: `cd server && npx vitest run test/docusaurus.unit.test.ts`
Expected: PASS

- [ ] **Step 5: Add the contract suite run** (append to `docusaurus.unit.test.ts`)

```ts
import { docsConnectorContract } from "./docs-contract.js";

docsConnectorContract("docusaurus (temp dir)", () => {
  const { c } = connectorAt(tempSite());
  return c;
});
```

- [ ] **Step 6: Run full suite**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add server/src/docs/adapters/docusaurus.ts server/test/docusaurus.unit.test.ts
git commit -m "feat(docs): Docusaurus connector — filesystem adapter with native tree"
```

---

### Task 4: Registry + config template

**Files:**
- Modify: `server/src/docs/registry.ts:6-8`
- Modify: `templates/cairn.json.example` (docs block comment/example — locate with `grep -rn "docs" templates/cairn.json.example`)
- Test: `server/test/docs-registry.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's module (`configSchema`, `make`).
- Produces: `makeDocsConnector` resolves `connector: "docusaurus"`.

- [ ] **Step 1: Write the failing test** (append to `docs-registry.test.ts`, matching its existing style — read the file first and mirror how the confluence case builds a `CairnConfig`)

```ts
  it("docusaurus: valid config constructs; invalid config is CONFIG_INVALID", async () => {
    const site = mkdtempSync(join(tmpdir(), "cairn-reg-dsite-"));
    writeFileSync(join(site, "docusaurus.config.js"), "export default {};\n");
    const ok = await makeDocsConnector({
      ...baseConfig, docs: { connector: "docusaurus", config: { sitePath: site } },
    } as CairnConfig);
    expect(ok.capabilities.hasNativeToc).toBe(true);
    await expect(makeDocsConnector({
      ...baseConfig, docs: { connector: "docusaurus", config: {} },
    } as CairnConfig)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/docs-registry.test.ts`
Expected: FAIL — import error for unknown connector `docusaurus`

- [ ] **Step 3: Register**

```ts
const CONNECTOR_PATHS: Record<string, string> = {
  confluence: "./adapters/confluence.js",
  docusaurus: "./adapters/docusaurus.js",
};
```

Add a docusaurus example alongside the confluence one in
`templates/cairn.json.example`:

```json
"docs": { "connector": "docusaurus",
  "config": { "sitePath": "../my-docs-site", "docsDir": "docs", "autoCommit": false } }
```

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run test/docs-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/docs/registry.ts server/test/docs-registry.test.ts templates/cairn.json.example
git commit -m "feat(docs): register docusaurus connector"
```

---

### Task 5: Auto-commit via `finalize()`

**Files:**
- Modify: `server/src/docs/adapters/docusaurus.ts`
- Test: `server/test/docusaurus.unit.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `finalize?()` slot; Task 2 already calls it from `publishTree`/`publishReadme`.
- Produces: `finalize()` on the Docusaurus connector — commits the project folder when `autoCommit: true` and `sitePath` is a git work tree; returns a warning string otherwise; `undefined` when `autoCommit: false` or the commit succeeds with changes staged.

- [ ] **Step 1: Write the failing tests** (append to `docusaurus.unit.test.ts`)

```ts
import { execFileSync } from "node:child_process";

function gitSite(): string {
  const site = tempSite();
  execFileSync("git", ["init", "-q"], { cwd: site });
  execFileSync("git", ["-C", site, "config", "user.email", "t@t"], {});
  execFileSync("git", ["-C", site, "config", "user.name", "t"], {});
  return site;
}

describe("finalize / autoCommit", () => {
  it("autoCommit off → finalize returns undefined, no commit", async () => {
    const site = gitSite();
    const c = make(configSchema.parse({ sitePath: site }));
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "P", markdown: "x", parentId: root.id });
    expect(await c.finalize!()).toBeUndefined();
  });

  it("autoCommit on + git repo → commits the project folder, never pushes", async () => {
    const site = gitSite();
    const c = make(configSchema.parse({ sitePath: site, autoCommit: true }));
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "P", markdown: "x", parentId: root.id });
    expect(await c.finalize!()).toBeUndefined();
    const log = execFileSync("git", ["-C", site, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("docs(cairn): publish proj");
    const status = execFileSync("git", ["-C", site, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.trim()).toBe("");
  });

  it("autoCommit on + not a git repo → warning, publish unharmed", async () => {
    const site = tempSite();
    const c = make(configSchema.parse({ sitePath: site, autoCommit: true }));
    const root = await c.ensureRoot("proj");
    await c.createPage({ title: "P", markdown: "x", parentId: root.id });
    const warning = await c.finalize!();
    expect(warning).toMatch(/auto-commit skipped/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run test/docusaurus.unit.test.ts`
Expected: FAIL — `finalize` undefined

- [ ] **Step 3: Implement `finalize` on the connector**

```ts
  async finalize(): Promise<string | undefined> {
    if (!this.cfg.autoCommit) return undefined;
    if (!this.rootDirAbs || !this.projectName) return undefined; // nothing published
    try {
      execFileSync("git", ["-C", this.siteAbs, "rev-parse", "--is-inside-work-tree"],
        { stdio: "pipe" });
      execFileSync("git", ["-C", this.siteAbs, "add", this.rootDirAbs], { stdio: "pipe" });
      execFileSync("git", ["-C", this.siteAbs, "commit", "-m",
        `docs(cairn): publish ${this.projectName}`], { stdio: "pipe" });
      return undefined;
    } catch (e) {
      // nothing-to-commit exits non-zero too — that is a clean no-op, not a warning
      const msg = e instanceof Error ? e.message : String(e);
      if (/nothing to commit/i.test(msg)) return undefined;
      return `auto-commit skipped: ${msg.split("\n")[0]}`;
    }
  }
```

(`execFileSync` imported from `node:child_process`; `this.siteAbs`,
`this.rootDirAbs`, `this.projectName` are instance fields set in the
constructor / `ensureRoot`. The nothing-to-commit probe needs stderr/stdout in
the error — `stdio: "pipe"` provides it; match on the combined message and
`e.stdout`/`e.stderr` buffers if the message alone misses it.)

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run test/docusaurus.unit.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite + typecheck**

Run: `cd server && npx vitest run && npx tsc --noEmit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add server/src/docs/adapters/docusaurus.ts server/test/docusaurus.unit.test.ts
git commit -m "feat(docs): opt-in auto-commit for the docusaurus connector"
```

---

### Task 6: Docs + tool-count hygiene

**Files:**
- Modify: `docs/01-runbook.md` (docs-connector section — `grep -n "connector" docs/01-runbook.md` to find it)
- Modify: `README.md` / `server/README.md` only if they enumerate docs connectors (`grep -rn "Confluence" README.md server/README.md`)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the runbook's docs-connector section**

Add a "Docusaurus" subsection mirroring the Confluence one: config example
(from Task 4's template block), the filesystem model (pages = files, tree =
folders, `_category_.json`, native sidebar — no generated TOCs), the
ownership rule (only `docs/<project-slug>/` is touched), autoCommit semantics
(commit only, never push, degrades to a `warning` on the publish result), and
the v1 exclusions (no attachments, no versioned docs, `Page.url` is a file
path).

- [ ] **Step 2: Sweep for stale connector enumerations**

Run: `grep -rn "Confluence" README.md server/README.md docs/00-quickstart.md docs/01-runbook.md`
Anywhere the text says the docs connector is Confluence-only ("the configured
docs connector (Confluence)"), add Docusaurus.

- [ ] **Step 3: Commit**

```bash
git add docs/01-runbook.md README.md server/README.md docs/00-quickstart.md
git commit -m "docs: document the docusaurus docs connector"
```

---

## Verification (whole feature)

- `cd server && npx vitest run && npx tsc --noEmit` — full suite green.
- Manual smoke: scaffold a real site (`npx create-docusaurus@latest tmp-site classic` in scratch), point a scratch cairn.json at it, run a publish through `publishTree`, then `cd tmp-site && npx docusaurus build` — build must succeed with the generated tree.
- Close CRN-47 with a summary comment + time spent.
