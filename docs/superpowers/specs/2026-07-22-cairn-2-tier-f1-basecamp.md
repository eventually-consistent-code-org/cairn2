# Cairn 2.0 — Tier F1: Basecamp (Workspace Awareness + Workstreams)

**Date:** 2026-07-22
**Status:** Approved design (owner Q&A 2026-07-22: full workspace awareness, focus-switch model; remaining calls delegated + recorded)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier F item 21 (#3256)
**Siblings:** F2 (cross-AI: codex/opencode/gemini/grok — separate spec), F3 (frontend quality loop, full #2290 — separate spec). Tier F decomposed by owner call 2026-07-22.

## Outcome

Multi-project workspaces, for real: a `cairn-workspace.json` at a workspace
root names member projects; the server discovers it by walking up from its
launch dir; `workspace_focus` switches which member every existing tool
operates on — **all 55 tools keep their schemas** and follow the focus.
Parallel workstreams ride the #3256 dispatch-board pattern as a
single-writer board at the workspace root. One new live verb — `basecamp`
— closes the routing table: 35 live, 0 reserved.

## Why (decision record)

- **Full workspace awareness (owner call, 2026-07-22).** Not just the
  board — the single-project assumption is retired. The focus-switch
  model (owner pick) is what makes that survivable: the project selector
  lives in ONE place (workspace state), not in 55 tool schemas.
- **Focus is dynamic resolution, not a rewire (delegated).** `deps.projectDir`
  becomes a resolved value: when a workspace is present and a focus is
  set, tools operate on the focused member; with no workspace (every
  existing cairn project), resolution returns the launch dir and NOTHING
  changes — single-project behavior is byte-identical, which is the
  compatibility gate for this tier. Rejected: per-call project params
  (owner rejected: 55-schema churn) — a curated read-only aggregate
  (`workspace_status`) covers the cross-project dashboard need instead.
- **Workspace file at the root, not a home-dir registry (delegated).**
  `cairn-workspace.json` is versionable, reviewable, and discovered like
  `.git` — walk up from the launch dir. Home-dir state stays what it
  already is: per-project path-hashed caches (handoff/banner), which keep
  working per-member with zero changes because they key on the resolved
  project path.
- **Per-member trackers, no workspace tracker (delegated).** Each member
  keeps its own `cairn.json`; the server holds a per-project tracker
  cache (the current single `getTracker` memo becomes a map keyed by
  resolved dir). A workspace spanning GitHub + Jira members just works.
  Rejected: workspace-level tracker config (nothing to put there —
  tracker-first stays per-project).
- **Workstreams are a board, not sessions (delegated).** The #3256
  dispatch board is workspace-scoped state for MANY parallel sessions;
  the sessions core is project-scoped state for ONE session's continuity.
  Board = `.cairn/basecamp/board.json` at the WORKSPACE root,
  single-writer via `board_update` (config_set discipline), read via
  `board_get`. Statuses `queued|active|blocked|done`; every workstream
  names its member project and (once claimed) its tracker issue —
  tracker-first holds because each workstream's real work lands as
  issues in its member project.

## 1. Scope & surface

- `basecamp`: `reserved-F` → **live** (34 → 35 live; **reserved set now
  EMPTY** — check-surface `SPEC_RESERVED = {}`).
- Server tools 55 → **60**: `workspace_list`, `workspace_focus`,
  `workspace_status`, `board_get`, `board_update`.
- check-surface `TOOL_PREFIXES` gains `workspace|board`.
- Zero tracker-adapter interface changes.

## 2. Workspace core — `server/src/workspace/context.ts`

```jsonc
// cairn-workspace.json at the workspace root
{
  "workspace": "acme-platform",
  "members": [
    { "name": "api",  "path": "services/api"  },
    { "name": "web",  "path": "apps/web"      },
    { "name": "infra", "path": "infra"        }
  ]
}
```

- **Discovery:** from the server's launch dir, walk parent dirs for
  `cairn-workspace.json` (stop at filesystem root; `.git` NOT required).
  A member path resolves relative to the workspace root and MUST contain
  a `cairn.json` to be focusable — members without one are listed as
  `unconfigured` and refuse focus with a pointed hint.
- **Focus state:** `.cairn/basecamp/focus.json` at the WORKSPACE root
  (`{ focus: "<member name>" }`), single-writer. No workspace → no focus
  file → resolution = launch dir (the compatibility path). A workspace
  WITHOUT a focus set resolves to the launch dir too (a session opened
  inside `services/api` works on api until it says otherwise).
- **Resolution:** `resolveProjectDir(launchDir): string` — the ONE
  function every tool call now goes through (via the `deps.projectDir`
  getter). Focus names a member → that member's absolute path. Focused
  member's dir missing/unconfigured → CONFIG_INVALID with the fix named.
- **Per-project tracker cache:** `getTracker()` becomes
  `getTracker(resolvedDir)` memoized per dir — existing single-project
  behavior identical (same dir every call).

## 3. Board — `server/src/workspace/board.ts`

`.cairn/basecamp/board.json` at the workspace root:

```jsonc
{
  "workstreams": {
    "<id>": {
      "title": "migrate api auth",
      "project": "api",             // member name
      "status": "queued|active|blocked|done",
      "issue": "GH-12",             // once claimed — the member-project issue
      "session": "…",               // free-text claim tag (who/where)
      "note": "…",                  // one-liner, latest state
      "updated": "YYYY-MM-DD"
    }
  }
}
```

- `board_update(patch)` — merge by workstream id, `null` deletes,
  validated (status enum, project must be a member name, title required
  on create); single-writer, atomic (tmp+rename). Board requires a
  workspace — no workspace → PRECONDITION_FAILED ("run basecamp init").
- `board_get()` — deterministic (ids sorted), plus derived counts by
  status.
- Claim discipline is verb-level: a session claims by setting
  `status: active` + `session` + creating/naming the member-project
  tracker issue; the drill pins the mechanics, the verb doc pins the
  rules (never claim `active` work; `blocked` must say why in `note`).

## 4. Tools

- `workspace_list()` — workspace name, root, members (name/path/
  configured/focusable), current focus. No workspace → `{ workspace: null }`
  (not an error — single-project projects call this too via status).
- `workspace_focus(project)` — validates member + configured, writes
  focus, returns the resolution ({ focus, projectDir }). `project: null`
  clears focus.
- `workspace_status()` — the curated cross-project read: per member
  (skipping unconfigured), `{ name, phase, openIssues, openSessions }`
  from that member's own stores/tracker — read-only, never switches
  focus. Members whose tracker errors report `{ error }` rather than
  failing the whole call.
- `board_get` / `board_update` — §3.

## 5. `verbs/basecamp.md`

- `basecamp` — the board view: `workspace_list` + `board_get` +
  `workspace_status`, rendered as the dispatch board (per member: focus
  marker, workstreams by status, open counts). No workspace → explain +
  offer init.
- `basecamp init` — interview-lite: find candidate member dirs (things
  with `cairn.json` or obvious project roots), write
  `cairn-workspace.json`, confirm members.
- `basecamp focus <member>` — `workspace_focus` + one-line confirmation
  of what every verb now operates on. The banner/handoff/etc. follow
  automatically (path-hashed per member).
- `basecamp dispatch` — decompose a goal into workstreams (`board_update`
  queued entries, each naming its member project); print the
  copy-pasteable per-workstream session openers (the #3256 pattern: N
  parallel sessions, each claims one workstream).
- `basecamp claim <id>` / `update <id>` / `done <id>` — the workstream
  lifecycle from inside a working session: claim = `active` + session tag
  + member-project issue created/linked (focus switches to that member
  first); update = note + status; done = `done` + issue closed with a
  plain-language close note. Leak rules on all tracker text.

## 6. Testing (three rings)

- **Unit:** workspace discovery (found/not-found/nested launch dirs,
  unconfigured members, focus resolution incl. the no-workspace
  compatibility path, focused-member-missing error); board (merge,
  null-delete, status enum, member validation, no-workspace rejection,
  deterministic reads, atomicity — store unchanged after rejection).
- **MCP ring:** five tools (60 pin); `workspace_status` per-member
  isolation (one erroring member doesn't fail the call); focus actually
  redirects an existing tool (e.g. `context_set` under focus lands in the
  member's `.cairn/`).
- **Compatibility ring (this tier's hard gate):** the ENTIRE existing
  suite runs with no workspace present and passes unedited — that IS the
  single-project byte-compatibility proof.
- **Drills (mechanical, post-merge):**
  - `drill-basecamp.mjs` — real tracker: scratch workspace with two
    members (one GitHub-configured, one unconfigured); focus switch
    redirects `issue_create` to the focused member's tracker and its
    `.cairn/`; board dispatch → claim (issue created, active) → blocked
    (note required) → done (issue closed, plain close note); unconfigured
    member refuses focus but lists; `workspace_status` aggregates with
    the unconfigured member marked; board byte-equal double read; leak
    scan on all tracker text.
  - `drill-focus-compat.mjs` — no workspace anywhere: `workspace_list`
    returns null-workspace, every stateful tool behaves byte-identically
    to a pre-F1 baseline capture (session file, banner, record paths).

## Non-goals

- No cross-project issue moves or workspace-level tracker.
- No auto-spawning of sessions — dispatch prints openers, humans (or
  /loop harnesses) start them (#3256's actual shape).
- No recursive workspaces (a member can't be a workspace).
- No per-call project params (owner-rejected; `workspace_status` is the
  read path).
- F2 (cross-AI) and F3 (frontend loop) are separate specs.

## Success criteria

1. A session in a workspace switches focus and EVERY tool follows —
   proven by an issue landing in the focused member's tracker and its
   session/banner files landing under the member's paths.
2. No workspace → byte-identical single-project behavior (existing suite
   unedited + the compat drill).
3. The dispatch board runs the full workstream lifecycle with
   tracker-first evidence (claim creates the member issue, done closes it
   with a plain note), and two parallel claims on one workstream are
   impossible to record as both-active (single-writer board, verb rule).
4. A mixed workspace (configured + unconfigured members) degrades
   member-by-member, never call-wide.
5. Reserved verb set is EMPTY — the routing table is complete.
6. All 55 existing tools untouched in name and schema.
