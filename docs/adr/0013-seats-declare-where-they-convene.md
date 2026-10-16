# 0013 — Seats declare where they convene

Date: 2026-09-13. Status: accepted.

removeWhen: never — when a viewpoint is useful (against a draft plan or against a diff) is a property of the work, not of model capability.
derives: axiom 2 (mechanism-vs-judgment)

## Context

A roster built for diff review has no place for viewpoints whose
moment is earlier — a product interrogator has nothing useful to say
about a diff and everything to say about a draft plan. Adding
plan-time viewpoints as a second roster would fork the mechanism the
review fold just unified.

## Decision

One roster, staged convening. Every seat carries a stage field —
review, plan, or any — defaulting to review and server-validated at
load exactly like the injection dose (a bad value is refused naming
the file and the field). The review panel filters to review-stage
seats through a documented helper; plan-stage seats convene only when
planning asks for a challenge round; any-stage seats appear at both.
The sixth shipped default exercises the new stage: an interrogation
seat that questions a draft plan's audience, failure modes, timing,
and scope honesty at full dose. Consultation deliberately ignores the
stage filter — asking a plan-stage seat about a diff is a user's
prerogative.

## Consequences

- The byte-identical review promise survives growth: the panel
  composition is pinned over the stage filter, so new plan-stage
  defaults never leak into diff review.
- Challenge rounds are advisory and opt-in (a flag, or deep planning):
  the seats propose amendments in one batched question, the user's
  plan always wins, and rejections are recorded with reasons.
- Stage joins dose in the write-time validation contract — misplaced
  convening is structurally impossible, not a review-time surprise.

Commits: 02036e8 (stage + interrogation), d7c05be (challenge round).
