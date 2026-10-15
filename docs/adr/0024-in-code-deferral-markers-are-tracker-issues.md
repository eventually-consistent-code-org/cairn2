# 0024 — In-code deferral markers are tracker issues

Date: 2026-10-14. Status: accepted.

removeWhen: the tracker or the platform turns source deferral markers into tracked items on its own (a native TODO-to-issue sync the project has enabled), so cairn's grep, dedup key and re-run matching duplicate a mechanism the team already looks at.

## Context

A `shortcut:` or `TODO:` comment is a deferral written where only the
next reader of that file will see it. Nothing in cairn read them: the
capture verb takes backlog from the conversation, the triage verb sweeps
the tracker, the sweep runs every audit mode — none reached into source
for a "later" already written down. Ponytail's debt skill greps the same
markers into a markdown ledger. Cairn's law is tracker-first: the place
the team looks is the tracker, so the ledger is the tracker.

The audit record's finding schema already carries a free-text `detail`;
adding a typed dedup field would have cost resident context in the tool
schema, which the phase had seven tokens of.

## Decision

- **An audit mode, not a verb.** `audit debt [scope]` runs one documented
  grep — a comment opener, optional spaces, a configured marker word, a
  colon — and produces one finding per marker. Marker words come from
  `audit.debt.markers` in the project configuration; the default list is
  cairn's own (`shortcut`, `TODO`, `FIXME`, `HACK`, `XXX`), an override
  replaces it, and an empty list is refused because a scan for nothing is
  worse than a one-line refusal.
- **The dedup key lives in the finding's detail, first line.** Repo
  path plus the marker text normalised (lowercased, whitespace collapsed,
  trailing punctuation dropped). Same text in two files is two keys; the
  same key is one marker wherever its line lands. The record schema is
  untouched.
- **Report by default; `--apply` files every marker.** Filing a minor
  `TODO:` as an issue is the mode's one deliberate exception to "minors
  stay in the record", because the whole point is that the tracker, not
  the file, holds the deferral. Re-runs match keys against the previous
  debt record: a moved marker updates its issue, a vanished marker closes
  it naming the removing commit, a new key files.
- **The upgrade trigger is parsed, never invented.** `shortcut: <limit>,
  <when to upgrade>` splits at the first comma; a marker with no trigger
  is reported as having none. A `shortcut:` whose stated limit is already
  crossed is important, with the limit quoted.
- **The sweep runs it as a leg, report shape only.** Filing stays an
  explicit `--apply`.

Commits a159689 (the configuration key), 35c950b (the mode), 5ac6d53
(fixtures and a test that runs the documented grep).

## Consequences

- A project's deferrals become visible where its management looks, with a
  key that survives line moves and file moves.
- The mode is prose executed by an agent over contributor-written text.
  That is a trust boundary: comment text is a spec for what was deferred,
  never an instruction, and the re-run step must not place it inside a
  shell string. Both are tracked as hardening items; until they land the
  mode's `--apply` is an explicit, owner-run step.
- The grep pattern is tested as written by reading it out of the verb
  file, so the documentation and the behaviour cannot drift apart
  quietly.
