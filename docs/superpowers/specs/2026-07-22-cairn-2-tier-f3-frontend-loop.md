# Cairn 2.0 — Tier F3: Frontend Quality Loop

**Date:** 2026-07-22
**Status:** Approved design (owner Q&A 2026-07-22: FULL #2290 build; remaining calls delegated + recorded)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier F item 23 (#2290)
**Siblings:** F1, F2 shipped 2026-07-22. This closes Tier F.

## Outcome

The full #2290 community proposal, built on rails that already exist: a
**Designer agent** (wireframes → design tokens → coded prototypes, all as
first-class planning context in draft sessions) and a **UAT agent**
(platform-aware acceptance walks with requirements traceability), plus the
connective tissue — a structured design-token file beside the theme,
requirements-traceability edges in the knowledge map, and design-fidelity
discipline in `audit ui`. **Zero new server tools, zero new verbs** — the
proposal's machinery landed in C2 (draft/themes), C3 (audit ui/uat), and
E (map edges); F3 ships the two agents and wires the loop.

## Why (decision record)

- **Agents, not verbs (delegated).** #2290 asks for autonomous Designer
  and UAT roles. Those are plugin AGENT definitions (`agents/
  cairn-designer.md`, `agents/cairn-uat.md`) dispatched by the existing
  verbs — `draft` hands design work to the designer, `audit uat`/`audit
  ui` hand acceptance and fidelity walks to the UAT agent. Rejected: new
  verbs (the verbs exist; the missing piece is the specialist role that
  runs under them).
- **Design tokens are the theme, structured (delegated).**
  `.cairn/draft/themes/tokens.json` mirrors `default.css`'s custom
  properties as typed groups (color/type/space/radius). The CSS stays the
  single source the variants LINK; tokens.json is its machine-readable
  twin the designer keeps in sync and planning context consumes. No
  server tool — the designer owns both files; `audit ui` checks the pair
  for drift (a token in one and not the other IS a finding).
- **Traceability rides the map (delegated).** Requirements ↔ designs ↔
  validation as map edges: requirement issues (`issue` nodes) —
  `implements` → design decisions (`decision` nodes recorded from draft
  sessions) — `decided-in` → the sessions/modules that realize them. The
  UAT agent walks the edges: every requirement issue must reach a
  verified flow or the audit record names the gap. Rejected: a bespoke
  traceability matrix file (the map IS the matrix; a second store would
  drift).
- **Fidelity is an audit discipline, not a new mode (delegated).**
  `audit ui` gains the fidelity contract: compare shipped UI against the
  draft session's decided direction + tokens.json; divergence findings
  cite the decision entry they violate. `audit uat` gains the
  platform-aware walk contract (real viewport/platform variations named
  per walk) and the traceability sweep.

## 1. Scope & surface

- New: `agents/cairn-designer.md`, `agents/cairn-uat.md` (the plugin's
  first agents dir).
- Modified verb docs: `draft.md` (designer dispatch + tokens.json
  discipline), `audit.md` (ui fidelity contract, uat platform walks +
  traceability sweep), `map.md` (one line: design traceability edges are
  first-class citizens of `map build`).
- Zero server changes; tools stay 62; verbs stay 36. check-surface
  untouched (it doesn't govern agents; a follow-up ratchet is a
  non-goal).

## 2. `agents/cairn-designer.md`

Role: turn a design question into decided direction with artifacts.
- Works INSIDE a draft session (the draft verb opens it): wireframes first
  (low-fi HTML variants, structure only), then tokens (create/update
  `themes/default.css` + `tokens.json` in the same change, always both),
  then coded prototypes (hi-fi variants on the tokens) — each stage's
  user pick logged as a `decision` entry, mirror comments per draft's
  rules.
- Records traceability as it goes: `map_set` decision nodes for each
  locked direction, `implements` edges from the requirement issue node.
- Hard rules: never edits `map.json`/board directly (tools only); tokens
  and CSS never diverge (both files in every token change); leak rules on
  tracker text; variants stay throwaway until `--wrap`.
- Tools it may reference: `draft_log` (session lifecycle belongs to the
  draft verb — amended 2026-07-22 to resolve §2/§4 conflict; the shipped
  agents reflect this), `issue_comment`, `map_set`, `map_get`,
  `session_landscape`.

## 3. `agents/cairn-uat.md`

Role: prove shipped flows meet requirements, platform-aware.
- Runs `audit uat`'s discipline as the specialist: enumerate the phase's
  requirement issues (`issue_list` + map edges), walk each shipped flow
  AS A USER on the named platform matrix (desktop/mobile viewport at
  minimum; the walk names what it actually exercised), evidence + verdict
  per flow.
- Traceability sweep: every requirement issue must trace (map edges) to a
  decided design and a walked flow; untraced requirements are findings
  (severity important), not footnotes.
- Fidelity handoff: visual divergence from the draft decision/tokens is
  recorded as an `audit ui` finding citing the violated decision entry.
- Same closing discipline as every audit: `audit_record`, Critical/
  Important → `cairn:audit` issues, `--fix` contract (mechanical vs
  trace).
- Tools: `issue_list`, `issue_get`, `issue_create`, `issue_comment`,
  `issue_close`, `map_get`, `audit_record`, `trace_start`, `plan_status`.

## 4. Verb-doc wiring

- `draft.md`: a "Designer dispatch" section — non-trivial design
  questions go to the `cairn-designer` agent (Task tool) with the session
  id + question; the verb stays the orchestrator (session lifecycle,
  tracker mirror). tokens.json discipline stated (both-files rule,
  drift = audit ui finding).
- `audit.md`: ui mode row gains the fidelity contract sentence; uat mode
  row gains platform-matrix + traceability-sweep sentences; both name
  the `cairn-uat` agent as the dispatchable specialist.
- `map.md`: one line under build — requirement→decision `implements`
  edges are part of the graph's job, sourced from draft sessions.

## 5. Testing

- **No server rings** (zero server change). check-surface + full suite
  must stay green untouched (`git diff main -- server/` empty is the
  compat statement).
- **Agent-lint ring:** both agent files carry valid frontmatter
  (name/description/tools per the Claude plugin agent format) — verified
  in Task review, not scripted (non-goal: an agents ratchet).
- **Drill (mechanical, post-merge): `drill-frontend-loop.mjs`** — the
  loop's data path with real tools (agents are prompt-level; the drill
  proves the rails they run on): a draft session decides a direction
  (decision entry + tokens.json + default.css written in sync); map_set
  records requirement→decision `implements` edges; the traceability
  sweep is computed from map_get (one requirement traced, one seeded
  untraced → exactly one gap named); a fidelity divergence lands as a
  real cairn:audit issue citing the decision entry; tokens/CSS drift
  seeded → detected by comparing the pair; leak scan on tracker text.

## Non-goals

- No screenshot/pixel tooling (fidelity is decision-level, not
  pixel-level, v1).
- No agents ratchet in check-surface.
- No browser automation dependency in the drill (the UAT agent uses
  whatever the session has; the drill proves the data rails).
- No new stores, tools, or verbs.

## Success criteria

1. Designer flow: wireframe → tokens (both files, never divergent) →
   prototype, every stage a decision entry with mirror discipline.
2. Traceability: requirement issues trace through map edges to decided
   designs and walked flows; a seeded untraced requirement is named as a
   finding (drilled).
3. Fidelity: divergence from a decided direction lands as a cairn:audit
   finding citing the decision entry it violates (drilled).
4. tokens.json ↔ default.css drift is detectable and IS an audit ui
   finding (drilled mechanically).
5. Server surface untouched: 62 tools, 36 verbs, suite green unedited.
6. Both agents carry valid plugin-agent frontmatter and reference only
   real tools.
