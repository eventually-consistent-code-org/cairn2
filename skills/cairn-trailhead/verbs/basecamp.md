---
verb: basecamp
args: "init | focus <member> | dispatch | claim|update|done <id>"
status: live
---

Multi-project workspaces and the parallel-workstream dispatch board — the
one verb that knows there's more than one project in the room. Everything
else in the routing table operates on a single resolved project dir;
`basecamp` is where that dir gets picked, and where work gets fanned out
across the members that share a workspace root.

## Bare `basecamp` — the board view

`workspace_list()` + `board_get()` + `workspace_status()`, rendered as the
dispatch board: per member, a focus marker (who's "home" right now),
workstreams grouped by status (`queued` / `active` / `blocked` / `done`),
and the open-issue / open-session counts `workspace_status` already
curated. Unconfigured members show up too — flagged, not hidden.

No workspace (`workspace_list()` returns `{ workspace: null }`) is not an
error. Explain what a workspace buys (focus switching, the dispatch
board, one place to see every member at once) and offer `basecamp init`.
Don't run init unasked — this is an offer, not an assumption.

## `basecamp init`

Interview-lite, not a form:

1. Look for candidate member directories — anything with its own
   `cairn.json` a level or two down from here, plus any dir that's an
   obvious project root (its own `.git`, its own `package.json`/similar)
   even if cairn isn't set up there yet.
2. Show the candidates, ask which ones are actually workspace members
   (and their names — default to the dir name, let the user override).
3. Write `cairn-workspace.json` at the workspace root: `workspace` name,
   `members` array (`name` + relative `path`). A member without its own
   `cairn.json` still gets listed — it just shows `unconfigured` on the
   board until someone runs cairn's own `new`/`tune` in it.
4. Confirm what got written, plain language: workspace name, member
   count, which ones are focusable today (focusable = configured — an
   unconfigured member can't take focus until it gets its own `cairn.json`).

No workspace tracker, no workspace-level cairn.json — each member keeps
its own tracker-first setup untouched. `init` only ever writes the
workspace file itself.

## `basecamp focus <member>`

`workspace_focus(project: <member>)`. One-line confirmation of what just
changed, and the note that matters: **for a session launched at the
workspace root (or in a folder no member owns), every verb now operates
on that member** — `plan`, `work`, `issue_*` calls other verbs make, the
banner, the handoff — all of it follows the focus automatically, because
they resolve through the same project dir this call just repointed.
Nothing downstream needs to know a workspace exists.

**A session launched inside a member is never redirected** (#487). The
focus file is one file under the workspace root, shared by every session
beneath it; a session launched in member B is B's session, and another
session's `basecamp focus a` does not move its writes. The tool result
says which case you are in: `focusApplied: true` means this session now
operates on the member; `focusApplied: false` with `projectDir` still your
launch dir means the focus was written for the workspace but this session
stays home. Say so in the confirmation, plainly — "focus is now `a`; this
session stays in `b`" — never imply a redirect that did not happen.
`workspace_status` reports the same three fields (`launchDir`,
`resolvedProject`, `focusApplied`) on every call, so a redirect is a field
to read, not a surprise to discover in another project's planning folder.
(Asserted: `server/test/workspace-context.test.ts` "a member launch is
never redirected" and the member-launch block in `server/test/mcp.test.ts`.)

`focus <member>` on an unconfigured or unknown member fails with the
tool's own error — say what it named as the problem, don't paper over
it with a guess at what the user meant.

`workspace_focus(project: null)` clears focus back to the launch dir —
mention this exists, but only use it when asked.

## `basecamp dispatch`

Takes a goal, breaks it into workstreams, and queues them — it never
starts them.

1. Decompose the stated goal into workstreams sized for one parallel
   session each, and figure out which member project each one actually
   belongs to.
2. `board_update(patch)` — one `queued` entry per workstream, each with
   a title and its `project` (member name). Let the tool assign ids
   (or pick short stable ones); don't invent a numbering scheme by hand.
3. Print the copy-pasteable per-workstream openers — the #3256 shape: N
   lines, each one a session-starter line naming the workstream id and
   what it's for, ready to paste into N separate sessions (or an
   automation harness). **Never auto-spawn sessions.** Dispatch's job
   ends at the printed openers; a human (or a `/loop` harness someone
   set up on purpose) decides when and how many actually start.

## `claim <id>` / `update <id>` / `done <id>` — the lifecycle

Run from inside whichever session picked up a workstream.

**Focus discipline: expect it to get stolen.** The #3256 dispatch pattern
means N parallel sessions are running against the same workspace root at
once, and the focus file (`.cairn/basecamp/focus.json`) is workspace-global
— one file, shared by every session, last write wins. Another session's
`basecamp focus` can flip it out from under you between two of your own
tool calls. Which sessions that reaches is the #487 rule above: a session
launched inside a member stays in that member whatever the focus says, so
the safest shape for a dispatched workstream is to open the session in the
member's own directory. A session launched at the workspace root is the
one the focus moves, and for it the step-5 race check below catches board
writes that lose a race to another session's board update; it does **not**
catch a wrong-member write, because by the time you re-read `board_get`,
your `issue_create` or `issue_comment` already landed in whichever member
happened to be focused at that instant — there's nothing left to detect.
So, from a root-launched session: before ANY tracker or board write (not
just at claim — every write, every step, every time), confirm
`workspace_status()` reports `focusApplied: true` and `resolvedProject`
is YOUR member. If it doesn't, `workspace_focus` back to your member and
re-verify before writing.

**`claim <id>`** — in this order, always:

1. `board_get()` — check the workstream's current status first. If already
   `active`, another session has the claim. Stop and say so (note who has
   it, if visible), then pick different work.
2. `workspace_focus(project: <that workstream's member>)` — focus
   switches next, because everything claim does next (the issue, the
   session tag) needs to land in the right member's tracker. Read the
   result: `focusApplied: false` with a `projectDir` that is not that
   member means this session was launched inside a different member and
   will not be moved (#487) — stop, say so, and open a session in the
   workstream's own directory instead of creating the issue from here.
3. If the workstream has no `issue` yet: `issue_create` in the now-focused
   member's tracker, plain-language title, `phase` left unset unless the
   workstream clearly maps to one. If it already names an issue, link to
   that one — never create a second issue for the same workstream.
4. `board_update(patch: { <id>: { status: "active", session: <a free-text
   tag identifying this session>, issue: <the issue id> } })`.
5. **Race check:** immediately after `board_update`, re-read `board_get` and
   confirm YOUR session tag is in place. The board is last-write-wins: if
   another session's tag appears instead, you lost the race. Back off: close
   or abandon any issue you just created (one-line comment), and pick
   different work.

**Never claim a workstream that's already `active`.** Two sessions on one
workstream is exactly what the single-writer board exists to prevent.

**`update <id>`** — `board_update` with a fresh `note` (one line, current
state) and `status` when it changed. `status: "blocked"` REQUIRES a `note`
saying why — a blocked entry with no reason is worse than no update at
all. No focus switch implied; `update` doesn't touch focus on its own
(claim already set it, or the caller isn't focused on this member and
that's fine for a status note).

**`done <id>`** — `issue_comment` on the workstream's issue with a
plain-language close note (what shipped, in a sentence a non-engineer
would follow), then `issue_close`, then `board_update(patch: { <id>:
{ status: "done", note: <same close note> } })`. The board and the
tracker tell the same story — that's the point of naming the issue on
the workstream in the first place.

## Leak rules

Same discipline as `trace`, `audit`, `review`, and `triage`: every
`issue_create`/`issue_comment` body is plain language, no code blocks, no
file paths, no internal refs a non-engineer would bounce off of. Board
`note`/`title` fields get the same treatment — the board is
management-visible surface, not a scratchpad.
