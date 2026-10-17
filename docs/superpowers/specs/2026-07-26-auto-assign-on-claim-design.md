# Auto-assign on claim — design

**Date:** 2026-07-26 · **Issue:** CRN-34 · **Status:** approved

## Problem

When a cairn verb claims an issue (`issue_update` → `in_progress`), the
issue stays unassigned in the tracker. Management can't see who did what.
Assignment should follow the credentials doing the work, automatically.

## Approach (chosen)

Server-side hook in the `issue_update` tool — one choke point, every verb
benefits, no verb doc changes. Rejected: verb-level prompt changes (relies
on prompt compliance, edits every verb) and adapter-level transition hooks
(logic duplicated per backend).

## SPI: `resolveSelf?()`

`Tracker` gains an optional method:

```ts
/** Backend-native identifier for the authenticated user (assignee form).
 *  Present only on adapters that can derive it. Memoized per instance. */
resolveSelf?(): Promise<string | undefined>;
```

- **Jira**: `GET /rest/api/3/myself` → `accountId`. Also adds the missing
  assignee surface: read (`fields.assignee` → accountId, displayName kept
  out of the SPI), write (`fields.assignee = {accountId}` in updateIssue,
  accepting an accountId; a value containing `@` is resolved via
  `GET /rest/api/3/user/search?query=<email>` → accountId).
- **GitHub**: `GET /user` → `login`.
- **Azure Boards**: `GET <org>/_apis/connectionData` → authenticated user's
  `uniqueName` (email), which `System.AssignedTo` accepts.
- **Fake**: returns `"fake-user"`.
- **GitLab / ClickUp**: not implemented — assignee writes there need
  numeric-id resolution (pre-existing gaps); absent method = auto-assign
  silently unavailable.
- **CachedTracker forwards it** conditionally (same pattern as `logWork`,
  CRN-31 lesson) — and the contract suite now asserts optional-method
  parity between a wrapped and unwrapped tracker.

## Server hook (`issue_update` handler)

Fires only when ALL hold:
1. patch sets `state: "in_progress"`,
2. caller passed no explicit `assignee`,
3. the issue is currently unassigned (one `getIssue` probe — cached reads
   make this cheap).

Identity: `config.user.handle` when set, else `tracker.resolveSelf?.()`.
Resolved identity folds into the same `updateIssue` patch; the tool result
gains `autoAssigned: true` when it fired. Any resolution failure degrades
silently — claiming an issue is never blocked by an identity lookup
(same best-effort rule as the close-time worklog).

Never: overrides an existing assignee, fires on other transitions, or
competes with an explicit `assignee` argument.

## Testing

- Hook matrix via MCP harness (FakeTracker): unassigned + in_progress →
  assigned to `fake-user` + `autoAssigned: true`; already assigned →
  untouched; explicit assignee wins; `user.handle` set → handle wins over
  `resolveSelf`.
- CachedTracker forwards `resolveSelf`; stays undefined when inner lacks it.
- Jira unit tests (mock fetch): `myself` resolution + memoization, assignee
  read in normalize, accountId write, email → user-search resolution.

## Out of scope

GitLab/ClickUp assignee writes (numeric-id resolution), un-assign on
un-claim, multi-assignee backends beyond first assignee.
