# Cairn 2.0 — Tier 0: Trailhead

**Date:** 2026-07-15
**Status:** Draft for review — implements Section 1 of the parity roadmap
(single entrypoint + trail vocabulary); precedes all other tiers
**Author(s):** John Reed (with Claude)
**Depends on:** P2/P3/P4 surfaces (the verbs being migrated)

## Outcome

One command — `/cairn <verb> [args]` — replaces the per-verb command flood.
A routing skill with a rich verb table dispatches to per-verb subroutine
files loaded only when invoked, so the always-present context cost is one
thin command entry instead of N command definitions. The surface becomes
structurally impossible to confuse with GSD's flat ~60-command namespace,
`/cairn help` becomes the single discoverable reference, and every later
tier adds verbs by dropping a subroutine file and a table row — the shape
this tier defines is the contract all of them conform to. Directly answers
the GSD community's top structural complaint (#3235, command flooding) and
applies Buildomator's thin-stub lesson (~92% per-turn overhead cut came
from exactly this move).

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Entry | One command file, `commands/cairn.md` — parses verb from `$ARGUMENTS`, delegates to the router skill |
| 2 | Router | New skill `skills/cairn-trailhead/` — SKILL.md holds the routing table + shared policy; one subroutine file per verb at `skills/cairn-trailhead/verbs/<verb>.md`, read on demand |
| 3 | Existing policy skills | `cairn-planning` and `cairn-memory` stay — they own judgment (depth dial, distill policy); subroutines own *procedure* and reference them. No duplication: procedure in verbs/, policy in skills |
| 4 | Shims | Old `/cairn:<verb>` command files shrink to two-line pointers ("this moved — run `/cairn <verb>`" + auto-forward); removed at P5′ cutover |
| 5 | Vocabulary | Locked per parity roadmap Section 1 — reproduced below with land-now vs reserved status; naming rule: short, imperative, trail-flavored where natural, never a hyphen-shifted GSD name |
| 6 | Unknown verb | Routes to `help` with the unrecognized token echoed and nearest-verb suggestion — never a silent fallthrough to `do` |
| 7 | Plugin scaffolding | Tier 0 also ships cairn2's own `.claude-plugin/plugin.json` (name `cairn2`, private dogfood manifest) so the restructured surface is installable — the 1.x manifest stayed in the public repo and cairn2 currently has none |
| 8 | Surface conformance CI | G9 ratchet extended: every routing-table row must have a subroutine file and vice versa; every verb doc's tool references must exist in the server's tool registry. Hard-fail on drift |

## Layout

```
commands/
  cairn.md                  # the one entrypoint (thin: verb parse → route)
  plan.md … import.md       # shims until P5′ (two lines each)
skills/
  cairn-trailhead/
    SKILL.md                # routing table, arg conventions, shared rules
    verbs/
      plan.md  work.md  verify.md  ship.md  status.md
      new.md   import.md  help.md  do.md
  cairn-planning/SKILL.md   # unchanged (policy)
  cairn-memory/SKILL.md     # unchanged (policy)
.claude-plugin/plugin.json  # new — cairn2 dogfood manifest
.mcp.json                   # unchanged — launches the server
```

## Routing mechanics

1. `commands/cairn.md` receives `$ARGUMENTS`, splits `<verb> [rest]`,
   and instructs: read `skills/cairn-trailhead/verbs/<verb>.md`, execute it
   with `[rest]` as the verb's arguments. No verb → run `help`.
2. **SKILL.md routing table** is the canonical registry — one row per verb:
   name, one-line purpose, args/flags summary, subroutine path, status
   (live / reserved-for-tier-X). `help` renders directly from it.
3. **Shared rules live once in SKILL.md**, inherited by every subroutine:
   the batch-questions rule (#1010), fail-loud error handling with typed
   server errors, the precedence rule (git plan docs win over tracker
   text), and active-context awareness.
4. **`do` (smart router):** `/cairn do "<freeform>"` classifies intent
   against the routing table's purpose column and dispatches — confirming
   first when confidence is low or the action mutates tracker state.
5. **Subroutine contract** (what each `verbs/*.md` must contain, enforced
   by review + the CI ratchet): frontmatter (`verb`, `args`, `status`),
   procedure steps naming exact server tools, and a "next step" line — the
   same shape the seven existing command files already follow, so migration
   is mostly a move plus de-duplication of shared boilerplate into SKILL.md.

## Verb vocabulary (locked)

Migrating now (P2/P3/P4 surfaces): `plan` `work` `verify` `ship` `status`
`new` `import` `help` `do`.

Reserved — table rows marked `reserved`, no subroutine files yet; each lands
with its tier and must use these names:

| verb | tier | verb | tier |
|---|---|---|---|
| `scout` `probe` `draft` `route` `summit` `auto` `fast` `resync` | A | `waypoint` | A0 |
| `mark` `retro` `distill` `brief` `tune` | B | `trace` | C |
| `triage` | D | `basecamp` | F |

`remember`/`recall` fold into `cairn-memory`'s surface as `/cairn remember`
and `/cairn recall` subroutines (thin wrappers over the memory skill —
live at Tier 0 since P3 shipped the substrate). `init`/`migrate` land with
P5′ packaging.

## Context-footprint accounting

Measured, not asserted (the claude-mem credibility lesson applies to
ourselves): record the always-present token cost before (7 command files
registered) and after (1 command file + shims) in the tier's
VERIFICATION.md. Shims are ~2 lines each precisely so the transition
period doesn't erase the win. Subroutine bodies and SKILL.md load only on
invocation.

## Migration steps (build order)

1. Scaffold `cairn-trailhead` skill + routing table with the nine live
   verbs; write `help` and `do`.
2. Move each command body into its subroutine file; hoist shared
   boilerplate into SKILL.md; bind tool names against the server registry.
3. Shrink old command files to shims.
4. Add `plugin.json`; install cairn2 as a local dogfood plugin; drive one
   full lifecycle (`new → plan → work → verify → ship`) through `/cairn`
   only.
5. Land the surface-conformance CI ratchet.

## Non-goals

- Removing the shims (P5′ cutover, per the roadmap's regression rule).
- Building any reserved verb (their tiers own them).
- GSD-style namespace meta-skills — the single entrypoint makes them
  structurally unnecessary (roadmap non-goal restated).
- Renaming `cairn-planning`/`cairn-memory` skills — internal names, no
  user surface.

## Success criteria

1. `/cairn` is the only non-shim top-level command; `/cairn help` renders
   the full verb reference including reserved verbs with their tiers.
2. Full lifecycle drivable end-to-end through `/cairn <verb>` alone,
   verified against a real tracker in dogfood.
3. Old `/cairn:<verb>` forms still work via shims and say where they went.
4. `/cairn do "plan the next phase"` routes to `plan` with confirmation;
   an unknown verb routes to `help` with a suggestion — both demonstrated.
5. Before/after always-present token cost recorded in VERIFICATION.md.
6. CI ratchet fails the build on a routing-table row without a subroutine
   file, an orphan subroutine, or a verb doc referencing a nonexistent
   server tool.
