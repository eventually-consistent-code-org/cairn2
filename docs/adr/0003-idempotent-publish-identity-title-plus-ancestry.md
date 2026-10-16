# 0003 — Idempotent publish: identity is title + ancestry

Status: accepted (v2, 2026-07-24)

removeWhen: every supported docs product lets a page carry a caller-supplied stable key that publish can look up, so identity can live on the page instead of being inferred from title and parent.
derives: axiom 2 (mechanism-vs-judgment)

## Context

Re-publishing must update pages in place, never duplicate. Candidates for
page identity: a stored id map (state to keep, breaks when pages move) or
lookup by structural position.

## Decision

A page's identity is its title under its parent. Publish is
find-then-update, create-only-when-absent (commit f00520f). Confluence
titles are unique per space — not per parent — so a title already taken
elsewhere in the space publishes under a `Title (Context)` suffix instead
of failing the run.

## Consequences

- No local state; re-publish from any checkout converges on the same tree.
- Renaming a document's title creates a new page and strands the old one —
  remote deletion is deliberately out of scope; stale pages are cleaned up
  by hand.
- Live-found constraint (space-wide title uniqueness) is encoded in the
  in-memory fake so unit tests hit it too.
