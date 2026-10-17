# Local tracker — design

**Date:** 2026-07-26 · **Issue:** CRN-50 · **Status:** approved
**Probe:** CRN-51 / `probe-4e2e46ac` — all four design risks validated before this spec.

## Problem

Every cairn backend today is a hosted service needing accounts and
credentials. Teams (and solo devs, and agents in CI) who just want issues
in the repo have no option — beads filled this niche and then grew a
database dependency (Dolt). Cairn needs a zero-dependency local tracker
that is *just another adapter*: chooseable at `/cairn:new`, scaffolded
automatically, every verb working unchanged, and promotable to a hosted
backend when the team grows.

## Decisions locked by the probe

1. **Storage: maildir-style, one directory per issue.** Single-file stores
   (JSONL) conflict on every concurrent scenario; per-issue files with
   *spaced* frontmatter (blank line between fields) and one-file-per-record
   for append streams merge cleanly with stock git. The only surviving
   conflict is two branches rewriting the same field — a genuine race that
   *should* conflict.
2. **IDs: `<prefix>-<5-char base36>`** (e.g. `crn-x7k2m`), random with
   retry against the visible set. 4 chars = 26% collision by 1k issues;
   5 chars = 0.8% even for fully blind cross-branch creation. Same-ID
   merge collisions are detected and repaired (medic), never silent.
3. **Full SPI on flat files works.** A ~200-line prototype passed the same
   11-test contract suite the six hosted adapters pass, in 8ms.
4. **Promotion works through the SPI alone.** Phases → issues → comments
   order, ID remap table, provenance backlinks. Only cosmetic loss:
   migrated comments carry original author/time in text.

## Storage layout

Default `tracker.config.dir = ".tracker"` at the repo root — committed to
git (that is the point; `/cairn:new` scaffolding must ensure it is NOT
gitignored). Layout:

```
.tracker/
  config.json                      # { "prefix": "crn", "version": 1 }
  issues/<id>/issue.md             # spaced frontmatter + markdown body
  issues/<id>/comments/<ts>-<who>.md
  issues/<id>/worklog/<ts>-<who>.md    # first line: "<minutes>m"
  issues/<id>/edges/<type>--<target>.md  # one file per edge; body = optional note
  phases/<id>.json                 # { id, name, number?, state }
  milestones/<id>.json             # { id, name, state }
```

`issue.md` frontmatter (one blank line between every field — this is the
merge-safety mechanism, not styling). **Amended during implementation:**
`updatedAt` is NOT stored — a stored timestamp turns every concurrent
update-pair into a same-field conflict (caught by the merge regression
suite before first merge). It derives from the file's mtime on read:

```
---
id: crn-x7k2m

title: "Fix the thing"

state: open                # open | in_progress | closed

labels: ["core"]

assignee: jsreed

phase: ph-2k9df

priority: P2               # optional; surfaced through the SPI as label "priority:P2"
---

Markdown body.
```

## Graph data model (REQUIRED; model, not database)

- **Nodes** = issues. **Edges** = typed, directed, one file each:
  `edges/<type>--<target>.md`. Types v1: `blocks`, `parent-of`,
  `relates-to`, `supersedes` (iteration lineage). Inverses (`blocked-by`,
  `child-of`, `superseded-by`) are derived at load, never stored.
- **In-memory graph** built per read from a directory walk. Project scale
  is thousands of nodes; no index files, no database.
- **Write-time guards:** creating a `blocks`/`parent-of` edge that closes a
  cycle → `CONFIG_INVALID`-class typed error naming the cycle path. Edge to
  a nonexistent issue → `NOT_FOUND`.
- **Graph features (phase 2):** ready frontier (open issues with no open
  blockers), effective priority (an issue inherits the max priority of
  anything it transitively blocks), lineage chains (`supersedes` walk),
  dangling-edge detection as a `medic` repair.

## SPI extension: links

Mirrors the `logWork`/`resolveSelf` optional-method pattern (and
`CachedTracker` forwards them — contract-tested, the CRN-31 lesson):

```ts
export type LinkType = "blocks" | "parent-of" | "relates-to" | "supersedes";
export interface IssueLink { from: string; type: LinkType; to: string }

/** Present only on adapters with hasDependencies. */
linkIssues?(from: string, type: LinkType, to: string): Promise<void>;
unlinkIssues?(from: string, type: LinkType, to: string): Promise<void>;
/** id given → edges touching that issue (both directions); omitted → all. */
listLinks?(id?: string): Promise<IssueLink[]>;
```

- Local: implements all three; `hasDependencies: true` — the first honest
  `true` in the fleet.
- FakeTracker: gains a real in-memory implementation (today it declares
  `hasDependencies: true` with nothing behind it — that lie ends here).
- Hosted adapters: unchanged this milestone (flag stays `false`, except
  fake); GitHub/Jira/GitLab native link APIs are a follow-up.
- Server tools: `issue_link`, `issue_unlink`, `issue_links` (list), gated
  on capability with typed `UNSUPPORTED` otherwise.

## Server wiring

- `config.ts`: `tracker.type` enum gains `"local"`.
- `tracker/registry.ts`: `local: "./adapters/local.js"`; zod config
  `{ dir: string (default ".tracker"), prefix: string (default: repo
  basename slug, 2–10 chars) }`.
- Adapter root = `<projectDir>/<dir>`; auto-created on first write;
  `TRACKER_DOWN` never applies (no remote) — error surface is
  `NOT_FOUND`/`CONFIG_INVALID` only.
- Concurrency: the MCP server is the single writer per checkout (existing
  cairn model); cross-checkout concurrency is git's job (that's what the
  merge-safe layout is for). No lock files in v1.

## Scaffolding (`/cairn:new`)

Tracker choice at project setup gains "local — issues live in this repo".
Selecting it: write the `tracker` block, create `<dir>/config.json`, seed
nothing else, and verify the dir isn't matched by `.gitignore` (warn +
nextAction if it is).

## Migration / promotion (phase 4)

`tracker_migrate` server tool: local → any configured hosted backend
(target config passed explicitly; never destructive to the local store).

- Order: phases → issues (phase refs remapped) → state/assignee → comments
  (`[<orig-time> <orig-author>] text` prefix) → worklogs (same prefix
  form) → edges (native links when the target grows link support).
  **Amended during implementation:** unmigratable edges land as target
  COMMENTS (`[link] blocks → <new-id>`) rather than body rewrites — one
  mechanism, no post-create body surgery, and the degradation is recorded
  as a warning. Migration also needed comment/worklog READS the SPI lacked:
  optional `listComments?`/`listWorklogs?` were added (local + fake).
- Emits an ID remap table (old → new) written to
  `<dir>/MIGRATED.json` and appended to each migrated issue as a
  provenance backlink `[migrated from <old-id>]`.
- Local store is left intact and marked migrated (config.json gains
  `migratedTo`); cairn warns if verbs keep writing to a migrated store.
- Reverse direction (hosted → local) reuses `plan_import`-style reading —
  same tool, either direction, later phase if demand shows.

## Capability matrix (local)

| capability | value | note |
|---|---|---|
| hasInProgress / hasPhases / hasLabels / hasComments | true | |
| hasPhaseClose / hasMilestones / hasWorklog | true | |
| hasDependencies | **true** | first real implementation |
| resolveSelf | git `user.name` → fallback `$USER` | matches commit identity |

## Testing

- Contract suite (`test/contract.ts`) against the local adapter on a temp
  dir — same 11 tests as every hosted backend, plus a new gated links
  section (link → listLinks roundtrip, unlink, cycle rejection,
  `UNSUPPORTED` on flag-false adapters) run against local AND fake.
- CachedTracker forwarding tests for the three link methods.
- Merge-safety regression: scripted two-branch scenarios (from the probe's
  E1b) asserting clean merges for create/create, comment/comment,
  edge/edge, different-field edits — as a real test, not a probe artifact.
- Graph unit tests: frontier, effective priority, lineage, cycle paths,
  dangling edges.
- Migration roundtrip against FakeTracker (E4 shape, productionized).

## Phases

1. **Adapter core + links SPI** — types, registry, local adapter (issues,
   comments, phases, milestones, worklog, resolveSelf, edges), link
   methods on SPI + fake + CachedTracker, server link tools, contract +
   merge-safety tests. *Ships a usable `type: "local"` tracker.*
2. **Graph features** — `graph_report` tool (ready frontier, effective
   priority, lineage), cycle guard, medic dangling-edge repair, status
   verb surfacing.
3. **Scaffolding + docs** — `/cairn:new` local option, cairn.json.example,
   runbook section, README.
4. **Migration** — `tracker_migrate` local→hosted with remap + provenance;
   migrated-store guard.

Each phase lands independently green; later phases have their own plan
docs written when reached.

## Out of scope (this milestone)

- Hosted-adapter link implementations (GitHub/Jira/GitLab native links).
- Hosted → local reverse migration.
- Lock files / multi-writer coordination beyond git.
- Compaction/retention of closed issues (CRN-27 owns retention).
- Web/board UI over the local store.
