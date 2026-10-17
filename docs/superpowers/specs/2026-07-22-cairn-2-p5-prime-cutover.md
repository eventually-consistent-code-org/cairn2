# Cairn 2.0 — P5′: Dogfood Gate, 1.x Cutover, Publish

**Date:** 2026-07-22
**Status:** Approved design (cutover half delegated; the two human gates named below stay with the owner)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Placement — "P5′ Dogfood gate + 1.x cutover + publish — moved to the very end."

## Outcome

The roadmap's final stage, split honestly by who can do what:

- **In-repo cutover (this spec's buildable half):** the seven transition
  shim commands (`import/new/plan/ship/status/verify/work`) are removed —
  `commands/cairn.md` becomes the plugin's only registered command,
  landing the Tier 0 record's promised always-present token win
  (~213 → ~23 tok). Version moves to `2.0.0-rc.1`: cutover-complete,
  publish-pending. README records the cutover and the two open gates.
- **Human gate 1 — live dogfood:** the Tier 0 dogfood drill (and the A0
  live-pass caveat) needs a real session with cairn2 installed as the
  local plugin: `/cairn new → plan → work → verify → ship`, `/cairn do`,
  a typo'd verb, plus one waypoint resume. Recorded in VERIFICATION.md
  when run. The 46 mechanical drills (216/216 checks across ten tiers)
  are necessary-not-sufficient; this is the sufficiency pass.
- **Human gate 2 — publish:** removing the 1.x `/cairn:gsd` parity
  passthrough happens at INSTALL time (cairn2 replaces cairn 1.x in the
  marketplace/plugin config), and publishing is an outward-facing owner
  action. Neither is automatable from this repo, by design.

## Why (decision record)

- **Shims go now (delegated).** Every shim's target verb has been live
  since its tier shipped; the shims have been pure redirect stubs for the
  whole 2.0 line. Tier 0's spec always scheduled their removal "at P5′."
- **rc.1, not 2.0.0 (delegated).** The version that says "everything
  built, both human gates open." 2.0.0 lands when the dogfood gate
  passes and John publishes.
- **No new verification machinery.** check-surface never governed
  commands/; the gate for this change is the existing full suite + the
  entrypoint's own registration staying intact.

## Scope

- Delete: `commands/{import,new,plan,ship,status,verify,work}.md`.
- Keep: `commands/cairn.md` untouched.
- `plugin.json`: version `2.0.0-alpha.0` → `2.0.0-rc.1`.
- README: cutover note + the two open gates named.
- VERIFICATION.md: P5′ section — token math re-stated from Tier 0's
  table, the deletion list, both human gates PENDING with their exact
  procedures.
- Zero server changes; 62 tools / 36 verbs untouched.

## Success criteria

1. `commands/` contains exactly `cairn.md`.
2. Full gate green untouched (suite, tsc, check-surface 36/0/62).
3. Version reads `2.0.0-rc.1`.
4. Both human gates recorded PENDING with runnable procedures.
