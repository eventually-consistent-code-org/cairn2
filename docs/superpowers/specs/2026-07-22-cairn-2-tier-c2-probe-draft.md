# Cairn 2.0 — Tier C2: Probe & Draft (Spike and Sketch Sessions)

**Date:** 2026-07-22
**Status:** Approved design
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier C item 16
**Siblings:** C1 (trace — shipped 2026-07-21), C3 (audits & review governance) — separate specs, tier decomposed by owner call 2026-07-20.

## Outcome

Two new live verbs — `probe` (risk-ordered throwaway experiments with
verdicts, GSD spike parity) and `draft` (multi-variant HTML mockups on a
shared theme system, GSD sketch parity) — both backed by a generalization
of C1's trace store into a single session-store core, both mirrored to the
tracker one-issue-per-session in plain language, both with in-verb
wrap-up-to-skill packaging, and a frontier mode grounded by one new
`session_landscape` tool that makes "what should we probe/sketch next"
deterministic instead of improvised.

## Why (decision record)

- **Generalize the trace store, don't fork it (owner call, 2026-07-21).**
  The Tier A decision record already placed probe/draft "beside `trace`"
  as stateful-session machinery. Trace's mechanism (append-only markdown
  session, frontmatter status, typed entry blocks, gated close, immutable
  archive) is exactly what a spike session and a sketch session need — the
  only deltas are the entry-kind vocabulary and the close gate. One core,
  three kinds. Rejected: separate probe/draft store modules (three copies
  of the same file discipline drifting apart), and a file-convention-only
  approach with no server tools (loses banner/list/resume integration and
  the landscape join).
- **Trace-pattern tracker mirror: one issue per session (owner call,
  2026-07-21).** `probe` sessions land as a `cairn:spike` issue, `draft`
  sessions as `cairn:sketch`, with the same three-touch plain-language
  comment story C1 drilled (started → key finding/decision → resolution as
  the close note). Rejected: one issue per experiment/variant (tracker
  noise — the drill scratch repo rate-limits around 80 rapid creates), and
  comments-only-on-existing-issues (frontier-mode sessions would have no
  tracker home, violating tracker-first).
- **Wrap-up packaging is in-tier, as flags (owner call, 2026-07-21).**
  Roadmap item 16 bundles "wrap-up-to-skill packaging" with the verbs
  explicitly. GSD ships spike-wrap-up/sketch-wrap-up as separate commands;
  cairn folds them into `probe --wrap` / `draft --wrap` — no extra routing
  rows, packaging lives where the session lives. Rejected: deferring to
  Tier E (roadmap language is explicit) and separate wrap verbs (surface
  growth for no behavioral gain).
- **Frontier mode ships with server support (owner call, 2026-07-22).**
  No-arg `probe`/`draft` proposes what to explore next. A prompt-only
  version improvises the project scan each time and can re-propose a spike
  that already closed with a `stop` verdict if the agent skips the archive.
  The `session_landscape` tool makes the proposal input deterministic:
  resolved-session memory is server-computed, byte-stable, and drillable.
  Cost is one tool; the join is over data the store generalization already
  exposes.

## 1. Scope & surface

- `probe`, `draft`: `reserved-C` → **live** (routing table + `check-surface.mjs`
  `SPEC_RESERVED` ratchet down accordingly).
- Server tools 41 → **48**: `probe_start`, `probe_log`, `probe_close`,
  `draft_start`, `draft_log`, `draft_close`, `session_landscape`.
  (`trace_*` and `issue_comment` are untouched; `trace_list` remains — the
  landscape tool subsumes its cross-kind view but trace keeps its narrow
  tool for the verb's own flow.)
- **Zero adapter work.** The mirror rides C1's `commentIssue` /
  `createIssue` / `closeIssue`. No `Tracker` interface change, no contract
  test change.

## 2. Session store generalization

`server/src/trace/store.ts` → `server/src/sessions/store.ts`. The core is
parameterized by a kind descriptor; behavior per kind:

| kind | dir | entry kinds | close gate |
|---|---|---|---|
| `trace` | `.cairn/trace/` | `evidence` `hypothesis` `test` `verdict` | ≥1 `verdict` |
| `probe` | `.cairn/probe/` | `experiment` `result` `requirement` `verdict` | ≥1 `verdict` |
| `draft` | `.cairn/draft/` | `variant` `decision` `note` | ≥1 `decision` |

- **Trace compatibility is a hard constraint.** `server/src/trace/store.ts`
  becomes a thin re-export binding the core to the `trace` descriptor; the
  C1 public API (`startTrace`, `appendTrace`, `listTraces`, `closeTrace`,
  `lastEntryKind`, `traceId`) and its on-disk format stay byte-identical.
  `server/test/trace-store.test.ts` passes without edits.
- Session ids remain description-derived (`probe-<sha8>`, `draft-<sha8>`)
  with the same already-open guard; archives immutable at
  `.cairn/<kind>/archive/<id>.md`.
- Probe/draft frontmatter adds one optional field over trace's:
  `phase: <n>`, stamped at `*_start` from the active context when one is
  set. That field is the landscape's phase linkage — trace's frontmatter is
  untouched (compatibility constraint above).
- **Probe entry semantics (GSD spike parity):** each `experiment` entry
  names what runs and what it validates; `result` records what actually
  happened (investigation trail, surprises — never verdict-only);
  `requirement` captures constraints that emerge mid-spike and are
  non-negotiable for the real build; `verdict` grades one experiment
  `VALIDATED` / `INVALIDATED` / `PARTIAL`. The **close resolution** states
  `proceed` / `pivot` / `stop` plus the reason in plain language.
- **Draft entry semantics (GSD sketch parity):** `variant` names one
  mockup file and the design question it answers; `decision` records a
  user-picked direction (these compound — later variants honor earlier
  decisions); `note` is free-form observation.

### Artifacts

Session artifacts live beside the session file and are deliberately
throwaway:

```
.cairn/probe/<id>.md              <- session log (the store's file)
.cairn/probe/<id>/                <- experiment code, runnable
.cairn/draft/<id>.md
.cairn/draft/<id>/001-<name>.html <- one variant per file
.cairn/draft/themes/default.css   <- shared theme, CSS custom properties ONLY
```

- Probe experiments default to something the user can run and *feel*
  working (small UI or interactive demo over stdout-only), per the GSD
  spike rule.
- The theme file defines custom properties only — no component styles, no
  layout. All variants of all draft sessions link the shared theme so
  design decisions compound across sessions (roadmap: "shared theme
  system").
- `trace_close`-equivalent archive moves the session `.md` only; artifact
  dirs remain until `--wrap` packages what is worth keeping, after which
  they are deletable (the verb offers, never auto-deletes).

## 3. Tools

`probe_start` / `draft_start` — mirror `trace_start`: create the tracker
issue when no `issueId` given (`cairn:spike` / `cairn:sketch` label), write
the session file, refresh the handoff. `probe_log` / `draft_log` — typed
append with the per-kind entry enum (schemas stay tight; no stringly kinds).
`probe_close` / `draft_close` — gate on the kind's close entry, archive,
comment `Resolved: <resolution>` (best-effort) and close the issue.

`session_landscape` — read-only join over all three kinds:

```jsonc
{
  "sessions": [ { "kind": "probe", "id": "probe-ab12cd34", "status": "resolved",
                  "issue": "GH-41", "description": "...", "entryCounts": {...},
                  "resolution": "stop — SDK cannot stream", "created": "...", "resolved": "..." } ],
  "openByKind": { "trace": 1, "probe": 0, "draft": 2 },
  "phases": [ { "phase": "3", "sessions": ["probe-ab12cd34"] } ]   // linkage via scoped issue/phase when present
}
```

Resolution text is read from the archived session's `## resolution` block —
that is the "already probed, verdict was stop" memory frontier mode must
never lose. Output ordering is deterministic (kind, then id) — same project
state, same bytes.

### Continuity

`probe_start`/`probe_log`/`draft_start`/`draft_log` refresh the handoff the
same way the trace tools do — a killed mockup session resumes from its
session file with zero re-derived work, same C1 guarantee, drilled the same
way.

## 4. Verbs

### `verbs/probe.md`

- `probe "<question>"` — start (or resume, on the already-open guard) a
  spike session. Discipline: risk-ordered — highest-uncertainty experiment
  first; re-ground against the session file before each experiment;
  `result` before `verdict`, never verdict-only; requirements captured the
  moment the user expresses one; mirror comment at start and at the key
  finding.
- `probe` (no arg) — **frontier mode**: `session_landscape` + roadmap/phase
  state → risk-ordered proposals of what to spike next, split integration
  vs frontier candidates (GSD shape). Hard rule: an archived session whose
  resolution starts with `stop` is surfaced as "already probed — stop" and
  never re-proposed.
- `probe --wrap [<id>]` — curate one resolved session into a project-local
  skill: `.claude/skills/<name>/SKILL.md` + `references/` in the GSD
  synthesis shape (what was validated / patterns that worked / what to
  avoid / origin), provenance = session id + tracker issue + artifact
  files. Offers artifact-dir deletion after packaging; never auto-deletes.

### `verbs/draft.md`

- `draft "<design question>"` — start a sketch session: variants as
  self-contained HTML files on the shared theme, one design question per
  variant set; the user views them in a browser; each user pick lands as a
  `decision` entry and a plain-language mirror comment.
- `draft` (no arg) — frontier mode, same landscape grounding: propose
  consistency sketches (screens diverging from decided direction) and
  frontier sketches (undesigned areas).
- `draft --wrap [<id>]` — package decided direction into
  `.claude/skills/<name>/` (design decisions / CSS patterns / HTML
  structures / what to avoid / origin), same provenance rules.

### Surfacing

- `status.md` gains open probe/draft counts beside open traces.
- Banner (see §5).
- No routing edits this tier — verify/work/auto routing stays trace's
  (#726 was C1 scope; a failed experiment is a probe *result*, not a bug).

## 5. Banner

The C1 open-traces line generalizes to open sessions across kinds:

```
open sessions: trace 1 (issue GH-12, last: hypothesis) · probe 1 (issue GH-40, last: experiment)
```

Same contract as C1: renders with zero cards, byte-stable across renders of
an unchanged store, killed outright by the `recallIndex.enabled` switch.

## 6. Testing (three rings)

- **Unit:** session-store core per kind (entry enums enforced, close gates,
  archive immutability, id guards); `trace-store.test.ts` unchanged and
  green — that file IS the compatibility test. Landscape determinism
  (byte-equal on unchanged store; resolution text read from archive).
- **MCP ring:** the seven tools against the fake tracker (labels, gate
  errors, `issueClosed`, handoff refresh).
- **Drills (mechanical, real tracker, post-merge on main — Tier A/B/C1
  harness):**
  - `drill-probe.mjs` — experiment → result → requirement → verdict loop,
    kill/resume mid-spike, close `proceed`, three-comment story leak-clean,
    `--wrap` mechanics produce a real `.claude/skills/` package with
    provenance.
  - `drill-draft.mjs` — two variants linking the shared theme (asserted in
    the HTML), decision entry, close, wrap package includes the CSS
    pattern synthesis.
  - `drill-landscape.mjs` — archive a `stop`-resolution probe, assert the
    landscape output carries the resolution text and lists it resolved
    (the never-re-propose input), plus byte-stability across two calls.

## Non-goals

- No adapter/interface changes (comments shipped in C1).
- No audits/review machinery (C3), no triage (D), no knowledge graph (E) —
  the landscape tool joins sessions to phases, it does not build a graph.
- No auto-deletion of artifacts, ever.
- Frontier proposals are grounded by the landscape tool but remain
  prompt-authored — no server-side "proposal engine".

## Success criteria

1. A spike session survives a cold kill mid-experiment and resumes from the
   session file with zero re-derived results (C1 guarantee, new kinds).
2. The tracker tells each session's story in plain language — started, key
   finding/decision, resolution as close note — with zero leak-pattern hits.
3. Frontier mode never re-proposes an archived `stop`-verdict probe, proven
   mechanically from `session_landscape` output.
4. `probe --wrap` / `draft --wrap` produce a working project-local skill
   with provenance (session id, tracker issue, files) — GSD wrap-up parity.
5. All draft variants across sessions share one theme file, custom
   properties only.
6. Trace's C1 surface is bit-for-bit unaffected: same tools, same file
   format, `trace-store.test.ts` green without edits.
