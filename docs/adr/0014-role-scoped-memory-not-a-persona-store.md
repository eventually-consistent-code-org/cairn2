# 0014 — Role-scoped memory reuses the card store, not a persona store

Date: 2026-09-13. Status: accepted.

removeWhen: the platform ships per-agent persistent memory with provenance and staleness that cairn can read, write and filter by role, making the role scope a second store.
derives: axiom 2 (mechanism-vs-judgment)

## Context

Consultable viewpoints need continuity — a security reviewer that
forgets last month's finding re-litigates it. The obvious build is a
per-persona state store; the codebase already carries one for external
peers. But a second internal state store would mean two provenance
models, two staleness rules, and two answers to "what does this seat
know."

## Decision

Memory cards gain a role scope beside the existing phase and issue
scopes — create, list, and recall all accept and filter it, and the
full-text index carries a role column (migrated in place, since the
index engine cannot add columns to an existing table). Seat-attributed
work writes cards scoped to the seat's name; consultation recalls them
through the staleness-checked path and renders them into the brief as
a "what this seat remembers" section, with stale cards explicitly
marked as needing re-verification. Notable consultation outcomes write
one card back. The same change made the card tools honest: provenance
arrays round-trip exactly as passed (they were being silently
stripped), and updates accept partial patches.

## Consequences

- One memory system: role knowledge gets provenance, staleness
  checking, and retro re-grading for free.
- A seat "arriving warm" is inspectable — its memory is ordinary cards
  a human can read, edit, or delete.
- Cards without a role scope behave exactly as before; the scope is
  additive.

Commits: 1e30658 (role scope + contract fixes), 9230956 (the
consultation loop).
