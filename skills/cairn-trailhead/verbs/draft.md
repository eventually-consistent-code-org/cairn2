---
verb: draft
args: "[\"<design question>\" | (none = frontier) | --wrap [<id>]]"
status: live
---

Multi-variant sketch sessions on a shared theme — every variant in a session
links the same CSS file, so a picked direction reads as one system instead of
three unrelated pages. A draft is not a build: the HTML is throwaway, the
decisions it locks in are not.

## With a question: `draft "<design question>"`

1. `draft_start(description)` — creates/links the `cairn:sketch` issue.
   Mirror comment #1 via `issue_comment`: "Design session started: <plain
   summary>" — no jargon, no file paths, just what's being explored and why.
2. FIRST session in a project: create `.cairn/draft/themes/default.css` —
   CSS custom properties ONLY (colors, type scale, spacing, radii). No
   component styles, no layout rules, ever — the theme is a palette, not a
   design. Every session after the first reuses this same file; never fork
   a second theme file for a new session.
   Alongside it, `.cairn/draft/themes/tokens.json` mirrors the same custom
   properties as typed groups (color/type/space/radius) — the CSS stays the
   single source the variants LINK, tokens.json is its machine-readable
   twin. Every token change touches BOTH files in the same change, never
   one without the other; a token in one file and not the other is drift
   `audit ui` will catch and flag as a finding.
3. Variant loop, ONE design question per variant set — don't bundle "pick a
   color AND a layout" into one round, the user can't evaluate two axes at
   once:
   - write `.cairn/draft/<id>/NNN-<name>.html` per option — self-contained,
     linking `../themes/default.css`, nothing else. Number sequentially
     within the session.
   - `draft_log(kind: "variant")` — the file and the specific question it
     answers, before the user looks at it.
   - user views the set in a browser and picks. The pick lands as
     `draft_log(kind: "decision")` plus a plain-language mirror comment —
     "Went with <direction> for <question>." Decisions COMPOUND: every
     variant written after this point honors it, never re-litigates it in a
     later round.
   - anything the user says in passing that isn't a decision but matters —
     a constraint, a thing to avoid, a reaction to a detail — is a
     `draft_log(kind: "note")`. Don't let it evaporate because it wasn't
     phrased as a pick.
4. `draft_close(resolution: "<chosen direction>")` — archives the session,
   comments the resolution on the issue, and closes it. The resolution is
   the one line that survives without the round-by-round detail above it.

## No args: frontier mode

1. `session_landscape` — the ONLY source of truth for what's already been
   drafted and decided. Don't reconstruct it from memory or by grepping
   `.cairn/draft/`; the tool exists so the picture can't drift out from
   under you.
2. Cross-reference decided directions against the current screens/roadmap
   and propose two kinds of candidates: consistency sketches (an existing
   screen that's drifted from a locked decision) and frontier sketches
   (an area with no design decision yet).
3. HARD RULE, same as `probe`: an archived session whose resolution is a
   stop — the direction was rejected, not just left unfinished — is listed
   as "already explored — stopped," full stop, and is NEVER re-proposed as
   a candidate. Re-opening a settled rejection wastes the exact round-trips
   drafting exists to save.

## `--wrap [<id>]`

1. Pick the resolved session to promote — the one named, or the latest
   resolved session if `<id>` is omitted. Read its archive and whatever
   variants survived in `.cairn/draft/<id>/`.
2. Write `.claude/skills/<name>/SKILL.md` plus a `references/` directory:
   the design decisions made and why, the CSS custom-property patterns
   worth reusing, the HTML structures that worked, what to avoid and why,
   and an origin block (session id, tracker issue, files touched). This is
   the only durable output a draft session is allowed to leave outside the
   tracker and the shared theme file.
3. Offer to delete the variant directory once the skill is written. NEVER
   auto-delete — the user gets the last look before the throwaway HTML
   actually gets thrown away.

## Designer dispatch

Non-trivial design questions — anything past a one-line pick — go to the
`cairn-designer` agent (Task tool), handed the session id and the question.
The verb stays the orchestrator: session lifecycle (`draft_start`/
`draft_close`) and the tracker mirror are `draft`'s job; the wireframe →
tokens → prototype work itself is the agent's. At the hi-fi stage the agent
reads an installed `ui-ux-designer` skill (when one is present) for its
acceptance bar — see "The hi-fi acceptance bar" in `agents/cairn-designer.md`;
it reads the file, it is granted no Skill tool. A question simple enough to
decide without comparing variants doesn't need dispatch at all — see Fast
lane.

## Mirror rules

Plain language on the tracker, same as `trace` and `probe`: no code blocks,
no file paths, no internal refs a non-engineer would bounce off of. Comment
at the start and at each decision — not at every variant, not at every note.
The round-by-round detail lives in `draft_log`; the tracker gets the story
of what got decided and why.

## Fast lane

There isn't one. A draft's whole point is comparing options side by side
before committing — collapsing straight to one variant skips the comparison
that makes the decision worth logging. If the direction is already obvious,
that's a `mark` or a one-line decision, not a sketch session.
