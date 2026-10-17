# Cairn 2.0 — Tier C1: Trace (Persistent Debugging Sessions)

**Date:** 2026-07-21
**Status:** Approved design
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier C item 15
**Siblings:** C2 (probe/draft), C3 (audits & review governance) — separate specs, this tier decomposed by owner call 2026-07-20.

## Outcome

One new live verb — `trace` — backed by git-side session files that survive
`/clear`, a tracker mirror that keeps management informed in plain language,
and the #726 routing rule: a failed `verify` or a reported bug routes into
`trace`'s structured evidence → hypothesis → test flow, never an inline
improvised fix. Adds the tracker's first comment primitive (`commentIssue`,
native on all six backends) and five tools (36 → 41). Built mechanism-first,
one PR.

## Why (decision record)

- **Session file + tracker mirror hybrid (owner call, 2026-07-20).** The
  standing tracker-first law: the tracker mirrors ALL work and issues so
  management gets visibility without diving into code. Session detail
  (evidence, experiments) lives git-side under single-writer tools; the
  bug's tracker issue carries the plain-language story. Rejected:
  comments-as-the-log (noisy, offline-hostile) and status-only mirroring
  (fails the law).
- **`commentIssue` interface method** over body-append (rewrites race, no
  chronology, edit-history churn) and status-only. All six backends have
  native comment APIs — a clean Tier-A-style adapter sweep, and the
  primitive is general-purpose (auto/summit reports can adopt it later).
- **Hard route with a trivial fast-lane** (#726 vs #1120): failed verify /
  reported bug MUST open a trace — but a proven-obvious cause with a
  ≤3-line fix may start+evidence+verdict+close in one motion. Full paper
  trail at ~30s ceremony; "never improvised" holds without typo-class
  friction.
- **Verdict-gated close.** `trace_close` mechanically refuses a session
  with no `verdict` entry — a debugging session that ends without a stated
  cause is exactly the knowledge leak trace exists to prevent.
- **Mirroring is verb-driven, not tool-implicit.** The trace tools never
  comment on their own; the verb posts at milestones only (started / cause
  identified / resolved). Noise policy lives in one place; mechanism stays
  composable.
- **Mechanism-first, one PR** — fourth consecutive tier on the pattern.

## 1. Scope & surface

**Live verbs 23 → 24:** `trace`. Reserved drops to 4: `probe draft`(C2)
`triage`(D) `basecamp`(F).

**Verb args:** `trace ["<bug description>" | <trace-id> | close <trace-id>]`
— bare: list open sessions, resume the most recent; description: start;
`close`: resolve.

**New server tools (36 → 41):** `issue_comment`, `trace_start`,
`trace_log`, `trace_list`, `trace_close`.

**Tracker interface:** `commentIssue(id, text)` + `Capability.hasComments`
(true on all six adapters this tier; the flag exists so future backends can
degrade to recorded-skip like `hasPhaseClose`).

**Session files:** `.cairn/trace/<id>.md` live,
`.cairn/trace/archive/<id>.md` on close. Single-writer through the tools,
git-committed, survive `/clear` by construction.

**Tracker mirror:** every trace ties to a real tracker issue — existing
(`issueId` passed) or created at `trace_start` with label `cairn:bug`.
Plain-language mirror touches at milestones only: comments for "started"
and "cause identified"; "resolved" rides as the issue's close note. Never
per-entry noise, never code dumps.

**Routing (#726):** failed `verify` and user-reported bugs at checkpoints
MUST route into `trace`; fast lane for proven-obvious ≤3-line fixes.

**Out of scope:** comment reading/threading (mirror is write-only);
`probe`/`draft` (C2); audits/governance (C3); cross-session trace locking;
automatic hypothesis generation.

## 2. Tracker comments

### Interface

```ts
commentIssue(id: string, text: string): Promise<{ id: string; url?: string }>
```

`Capability.hasComments: boolean`.

### Per-backend mapping

| backend | endpoint |
|---|---|
| GitHub | `POST /repos/{repo}/issues/{n}/comments` |
| GitLab | `POST /projects/:id/issues/:iid/notes` |
| Jira | `POST /rest/api/3/issue/{key}/comment` (ADF-wrapped via the adapter's existing `adf()` helper) |
| Azure Boards | `POST …/wit/workItems/{id}/comments?api-version=7.0-preview` |
| Asana | `POST /tasks/{gid}/stories` (comment story) |
| ClickUp | `POST /task/{id}/comment` |

FakeTracker stores comments in-memory with a `comments(id)` test accessor;
CachedTracker passes through with whole-cache invalidation (comments can
touch issue `updatedAt`). Contract test gated on `hasComments`, same shape
as the milestone contract.

### `issue_comment` tool

Thin wrapper, general-purpose: `{ id, text }`. Trace consumes it; later
verbs (auto run reports, summit summaries) may adopt it — that adoption is
C3/backlog, not this spec.

Mirror text obeys the leak rules: the same `leak-patterns.mjs` rules apply
to comment text (a code-free plain-language summary never trips them; if
one does, that is a leak caught, not a false positive).

## 3. Trace store + tools

### Session file

`.cairn/trace/<id>.md`, id = `trace-<sha256(description)[:8]>` (card
convention). Frontmatter (constrained flat form): `status: open|resolved`,
`issue: <tracker id>`, `created: <YYYY-MM-DD>`, `resolved: <YYYY-MM-DD>`
(close-time). Body = append-only typed entries:

```markdown
## evidence — 2026-07-21
test X fails only when the index file exceeds 64KB

## hypothesis — 2026-07-21
chunk boundary math off-by-one at the page edge

## test — 2026-07-21
seeded a 65KB fixture; failure reproduces at exactly 65536 → CONFIRMS hypothesis

## verdict — 2026-07-21
off-by-one in chunk pagination; fixed in <sha>
```

### Tools

- **`trace_start({ description, issueId? })`** — no `issueId` → creates
  the tracker issue (label `cairn:bug`, title = description). Writes the
  session file. Returns `{ id, issue }`. Same-description open session →
  `PRECONDITION_FAILED` pointing at it.
- **`trace_log({ id, kind: evidence|hypothesis|test|verdict, text })`** —
  appends a dated block. Append-only, ledger discipline. Unknown id →
  `NOT_FOUND`; resolved session → `PRECONDITION_FAILED`.
- **`trace_list({ status? })`** — id, status, issue, created, entry counts.
  Read surface for `status`, the banner, and resume.
- **`trace_close({ id, resolution })`** — requires ≥1 `verdict` entry
  (else `PRECONDITION_FAILED`: "close needs a verdict — log one first").
  Stamps `resolved`, moves the file to `archive/`, closes the tracker
  issue (close note = resolution), returns the material for the gotcha
  card. The VERB writes the card (`mem_card_create`, provenance +
  confidence) — card content is judgment, not mechanism.

### Continuity

`trace_start`/`trace_log` refresh the handoff (source `tool`) — a killed
debug session resumes into its trace via the A0 machinery.

## 4. Verb + routing + surfacing

### `verbs/trace.md`

- **Start:** `trace_start` → mirror comment #1 ("Investigation started:
  <plain summary>"). Loop: `evidence` (reproduce FIRST — no hypothesis
  before a reproduction) → `hypothesis` → `test` (an experiment that can
  DISPROVE it) → repeat. Confirmed → mirror comment #2 ("Cause identified:
  <plain language>"). Discipline: evidence before hypothesis, test before
  fix, never two open hypotheses without distinguishing evidence.
- **Resume:** bare `trace`/`trace <id>` → `trace_list`, re-read the
  session file, continue from the last entry — the file IS the surviving
  context.
- **Close:** fix lands with tests passing → log `verdict` (cause + fix +
  commit sha) → `trace_close(resolution)` → gotcha card
  (provenance = files/commits involved, confidence `high` — proven) →
  the issue close note is mirror touch #3. Commit the archived file.
- **Fast lane** (proven-obvious, ≤3-line fix): start → one `evidence` +
  one `verdict` → fix → close. One motion, full paper trail, two mirror
  touches.
- **Mirror text rules:** manager-readable plain language; no code blocks,
  no file paths, no internal refs; one comment per milestone.

### Routing edits (#726)

- `verify.md`: failed verification MUST open a trace with the failure as
  first evidence (fast lane allowed); never patch-and-rerun inline.
- `work.md`: a bug surfacing mid-issue outside that issue's scope routes
  to `trace`, never an inline detour.
- `auto.md`: the failed-verify hard-stop report offers the ready-made
  `trace` handoff; auto still never self-repairs — starting the trace is
  the user's move.

### Surfacing

`status.md` lists open traces (id, age, issue, last entry kind). The
SessionStart banner gains one stable line per open trace via `trace_list`
— byte-stability rules hold (date granularity, stable order).

## 5. Testing (three rings)

1. **Unit:** comment mapping fixtures per adapter (URL/method/body incl.
   Jira ADF) + `hasComments`-gated contract test (create → read-back on
   fake); trace store — id stability, append-only (two logs → both blocks,
   prior bytes untouched), duplicate-open refusal, close-without-verdict
   refusal, close archives + stamps, resolved-session log refusal; handoff
   write-through on start/log; banner open-traces line + byte-stability
   across two renders.
2. **Contract/CI:** check-surface ratchets to **24 live / 4 reserved / 41
   tools**; dangling-ref scan covers `trace.md`; routing edits reference
   only real tools.
3. **Dogfood drills** (PENDING until run live):
   - **Trace drill:** real tracker — start creates the `cairn:bug` issue +
     comment #1; loop logged; SIGKILL mid-investigation → fresh session
     resumes from file + handoff, zero re-derived evidence; confirm →
     comment #2; close with verdict → issue closed with resolution, session
     archived, gotcha card with provenance + `high`; comments read back in
     order, plain-language, zero leak-pattern hits.
   - **Routing drill:** rigged failed `verify` → lands in an open trace
     with the failure as evidence #1, not an inline fix; fast-lane leg:
     trivial failure → one-motion start/evidence/verdict/close, both mirror
     comments present.

## Non-goals

- Comment reading/threading.
- Cross-project trace sessions; cross-session locking.
- Automatic hypothesis generation.
- `probe`/`draft` (C2); audits & governance (C3).

## Success criteria

1. A trace survives session death: resume continues from the exact last
   entry with zero re-derived work.
2. Management visibility: the bug's issue tells the whole story — created,
   cause identified, resolved — in plain language, verified by reading the
   comment stream back on a real backend.
3. A failed verify cannot produce an inline improvised fix — the routing
   drill proves the path.
4. Close-without-verdict is mechanically impossible.
5. The resolution's gotcha card recalls in a later session with provenance
   intact.
6. CI green at 24 live / 4 reserved / 41 tools.
