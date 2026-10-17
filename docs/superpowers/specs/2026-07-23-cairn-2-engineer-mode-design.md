# cairn 2.0 — engineer mode (vibe/engineer posture switch)

**Date:** 2026-07-23
**Status:** approved design, pre-implementation
**Depends on:** tracker-mirror fidelity spec
(2026-07-23-cairn-2-tracker-mirror-fidelity-design.md) — engineer-added
work rides its inbound delta ingest; human work rides its paper trail.

## Outcome

cairn stops assuming it does all the coding. A per-user mode chooses the
posture: **vibe** (today's behavior, cairn drives end-to-end) or
**engineer** (the human is a peer — claims issues, writes code, makes the
design calls — and cairn pairs, scaffolds, verifies, and keeps the tracker
mirror honest for both parties' work).

## Mechanism

- `cairn.json` key `user.mode: "vibe" | "engineer"`, default `vibe` —
  existing projects see zero behavior change until they opt in.
- Set via `tune mode engineer`; offered once during the `new` interview
  and the `profile` interview-lite.
- Per-user (it lives beside `user.handle`), so a basecamp team mixes
  modes: the PM runs vibe, the staff engineer runs engineer.
- Mode is posture, not surface: no new verb, no new command shim, no new
  server tool. Verb docs branch on the mode where behavior differs.

## v1 scope (decided: pairing, review-both-ways, decision surfacing)

### 1. `work` becomes pairing

Per issue in the phase list, engineer mode asks "mine or yours?" (batched
into one AskUserQuestion across the wave, not per-issue friction):

- **cairn-claimed** → unchanged lifecycle: claim → work → close, full
  paper trail per the fidelity spec.
- **human-claimed** → cairn scaffolds and steps back: branch created,
  context pointers posted as the claim comment (relevant PLAN.md task
  text, files likely touched, the failing test written first when the
  issue is in `tdd:` frontmatter), tracker state moved to `in_progress`
  with the human as assignee. Then cairn waits.
- **On "done"** (human says so, or resync/delta detects their commits
  landing) → cairn runs the tests and the verify posture, writes the
  close comment with evidence and approximate time, and closes — the
  human's work gets the same tracker fidelity as cairn's. Comments cairn
  writes about human work say so plainly ("logged by cairn for <handle>").
- Wave ordering, TDD gates, and the failed-issue stop rule apply
  identically regardless of who holds an issue.

### 2. Review flips both ways

- **cairn's diffs**: in engineer mode, `work` and `auto` do not self-merge.
  A finished cairn issue lands as a branch/PR and waits for human review;
  the close comment links it. `ship` gates on no cairn-authored PR
  awaiting review, same shape as its existing drift gate.
- **human's diffs**: when a human-claimed issue closes, cairn offers
  `review` on that diff (offer, not force — declining is one keypress and
  is recorded in the close comment as "review declined").

### 3. Decision surfacing

- Vibe mode: batch questions minimal, judgment calls silent — unchanged.
- Engineer mode: at genuine design forks — multiple defensible shapes,
  meaningful trade-offs — cairn stops and presents the options with its
  recommendation before committing code, one AskUserQuestion per fork.
  Boilerplate, mechanical edits, and obvious implementations stay
  automatic; the bar is "would a peer have wanted a say," not "is this a
  decision."
- The fork-vs-boilerplate call is cairn's judgment; `profile` calibration
  can tighten or loosen it per user over time.

## Explicitly deferred (not v1)

- **Plan-reconcile posture** — `plan` treating human-authored PLAN.md
  edits and self-filed issues as primary, with cairn as gap-filler. The
  inbound delta ingest already covers the tracker half; the deep-interview
  posture change waits for v2.
- **TDD handoff split** — human writes RED, cairn drives GREEN/REFACTOR
  (or inverse) as a config sub-key. Waits for v2.

## Surface cost

- One `cairn.json` key (`user.mode`), read by verb docs.
- Verb doc edits: `work` (pairing split), `auto`/`ship` (no-self-merge
  gate), `review` (offer-on-human-close), `tune`/`new`/`profile` (mode
  setting).
- No server changes beyond what the fidelity spec already adds.

## Testing

- Drill: engineer-mode phase with one cairn-claimed and one human-claimed
  issue — verify the pairing split, the scaffold comment, the
  human-work close path (tests run, close comment, time logged), and the
  no-self-merge gate holding a cairn PR open until reviewed.
- `tune mode` round-trip and default-vibe backward compatibility (a
  cairn.json without the key behaves exactly as today).
