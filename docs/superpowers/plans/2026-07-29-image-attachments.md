# Image Attachments — Docs Publish + Tracker Mirror (CRN-61, CRN-24) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Images become first-class on both outbound mirrors — docs publish uploads page-referenced images as Confluence attachments (CRN-61), and tracker issues accept screenshot evidence (CRN-24). One upload idiom, two surfaces.

**Architecture:** Docs side: `DocsConnector.uploadAttachment?` + an image scan in `tree.ts` (`![alt](relative)` refs resolved against the source file's directory) + a publish pass that uploads then rewrites refs to `attachment://<filename>`, which `markdownToStorage` renders as `<ac:image><ri:attachment/></ac:image>`. Tracker side: `Tracker.attachFile?` + `Capability.hasIssueAttachments`, Jira multipart upload, local file-per-attachment storage, `issue_attach` server tool (70 → 71). Fake implementations back the contract suites.

**Tech Stack:** TypeScript ESM, vitest, native `FormData`/`Blob` for multipart (no new deps).

## Global constraints

- Remote (`http(s)://`) image refs pass through untouched — only local, existing files upload.
- Idempotent republish: Confluence attachment with the same filename gets its data updated, never duplicated.
- A failed image upload degrades to the current behavior (link text) with one stderr warning — never fails the page publish.
- Honest flags: docusaurus keeps `hasAttachments` only if the copy-alongside implementation lands in this branch; otherwise flip to false. Every tracker adapter without `attachFile` declares `hasIssueAttachments: false`.

---

### Task 1: Docs pipeline — SPI, image scan, rewrite, Confluence upload

**Files:**
- Modify: `server/src/docs/types.ts`, `server/src/docs/tree.ts`, `server/src/docs/publish.ts`, `server/src/docs/markdown.ts`, `server/src/docs/fake.ts`, `server/src/docs/adapters/confluence.ts`, `server/src/docs/adapters/docusaurus.ts`
- Test: `server/test/docs-contract.ts` (extend), `server/test/markdown.test.ts` / publish tests (extend where they live)

**Interfaces:**

```ts
// DocsConnector, optional:
uploadAttachment?(pageId: string, filename: string, data: Buffer,
  mediaType: string): Promise<{ id?: string; downloadUrl?: string }>;
// DocNode += images: Array<{ ref: string; path: string }>  (resolved, existing local files only)
```

- [ ] **Step 1: Failing tests.** tree: a doc with `![map](diagrams/x.png)` next to a real file yields one image entry, http refs and missing files yield none. markdown: `![alt](attachment://x.png)` → `<ac:image><ri:attachment ri:filename="x.png" /></ac:image>`. contract: upload → page body referencing the attachment publishes; fake stores attachments per page. publish: page with images → upload called once per image, body rewritten before the final updatePage; upload failure → page still publishes, warning logged. confluence unit: POST `/rest/api/content/{id}/child/attachment` multipart with `X-Atlassian-Token: nocheck`, existing filename → data-update endpoint instead.
- [ ] **Step 2: Run — red.**
- [ ] **Step 3: Implement.** Scan in `fileNode` (regex `!\[[^\]]*\]\(([^)]+)\)`, resolve vs file dir, `existsSync`). Publish: after `upsert`, upload each image, rewrite ref → `attachment://basename`, then `updatePage` with the rewritten body (fold into the existing dir-TOC refresh where possible — one update, not two). Docusaurus: copy file next to the written page (`static` sibling), rewrite ref relative — or flip flag false and log why.
- [ ] **Step 4: Run — green; full suite + tsc.**
- [ ] **Step 5: Commit** `feat(docs): image attachments — scan, upload, rewrite; Confluence multipart (CRN-61)`

### Task 2: Diagrams index page

**Files:** Create `docs/diagrams/README.md` — H1 "Architecture Diagrams", one section per diagram embedding the PNG with a two-line description (code map / workflow / plugin-in-Claude), note pointing at the `.excalidraw` sources.

- [ ] Commit `docs(diagrams): index page — diagrams join the published tree`

### Task 3: Tracker attachments — SPI, Jira, local

**Files:**
- Modify: `server/src/tracker/types.ts` (Capability += `hasIssueAttachments`, `attachFile?`), all 8 adapters (flag), `server/src/tracker/fake.ts` (implement), `server/src/tracker/adapters/jira.ts` (multipart), `server/src/tracker/adapters/local.ts` (file store)
- Test: `server/test/contract.ts`, `server/test/jira.unit.test.ts`, `server/test/local.unit.test.ts`

- [ ] **Step 1: Failing tests.** contract: `attachFile` roundtrip when `hasIssueAttachments` (fake stores; local writes `issues/<id>/attachments/<filename>` and a second attach with the same name gets a de-collided name), method absent otherwise. jira unit: POST `/rest/api/3/issue/{key}/attachments` with `X-Atlassian-Token: no-check`, body is FormData (assert header + url; no JSON content-type).
- [ ] **Step 2: Run — red.**  **Step 3: Implement** (jira uses `fetchImpl` directly with FormData/Blob — `fetchJson`'s JSON body path doesn't fit multipart; reuse `fetchRaw` semantics or a small helper).  **Step 4: Green + tsc.**
- [ ] **Step 5: Commit** `feat(tracker): issue attachments — SPI, Jira multipart, local file store (CRN-24)`

### Task 4: `issue_attach` tool + verb/docs wiring

**Files:**
- Modify: `server/src/index.ts` (tool 71: `{ id, path, filename? }` — reads the file, infers mediaType from extension, UNSUPPORTED on incapable backends), `server/test/mcp.test.ts` (pins 70 → 71)
- Verb text: `skills/cairn-trailhead/verbs/audit.md` (ui/uat findings attach screenshots when the backend supports it), `docs/01-runbook.md` (capability table row + tool count sweep 70 → 71), `server/README.md` (count), diagram `cairn-code-map.excalidraw` + `cairn-in-claude.excalidraw` text nodes ("70 typed tools" → 71) + re-render PNGs, rebuild `server/dist`.

- [ ] Red (pins) → green; full suite + tsc + `check-surface.mjs`.
- [ ] **Commit** `feat(server): issue_attach tool — screenshot evidence reaches the tracker (CRN-24)`

## Verification (gate)

- Full suite + tsc + check-surface + dist freshness green.
- **Live smoke (creds present):** (1) `issue_attach` a small PNG to a scratch-titled CRN issue → visible as a real Jira attachment → close scratch. (2) `docs_publish` → diagrams index page appears in the Confluence tree with all three PNGs rendering inline (not broken links); republish once more → no duplicate attachments (idempotency).
- Comment + close CRN-61 and CRN-24 on merge.
