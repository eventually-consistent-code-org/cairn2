# 0009 — Seats are parameterized data with a server-validated dose

Date: 2026-09-11. Status: accepted.

removeWhen: the server-validated dose can go once models reliably size a viewpoint brief themselves, shown by minimal and full doses of the same seat producing equivalent findings across a milestone. Seats-as-data itself is permanent.
derives: axiom 2 (mechanism-vs-judgment)

## Context

Review and audit viewpoints ("a security reviewer", "a tests
specialist") are conventionally maintained as prose checklists — one
file per persona, each restating the same structure. Systems built that
way accumulate near-duplicate files, and their one recurring live bug
class is a persona injected at the wrong verbosity because nothing
validates how much of it should ride into a prompt.

## Decision

A seat is a data record under one schema: name, a one-line lens, rubric
categories, an anchored 0-10 scale (what a 10 looks like, plus a
fabrication-refusal honesty line), a REQUIRED injection dose
(minimal | standard | full), scope signals, and an optional advisory
model preference. Definitions live as editable per-project files in the
project's roles directory; shipped defaults resolve from the plugin's
templates when no override exists; enablement and tuning live in a
strict config block that rejects unknown keys. The server validates at
load: a missing or invalid dose is refused with an error naming the
file and the field — write-time validation, not a CI grep. Routing
reads narrow declared fields only, never definition bodies.

## Consequences

- One schema, N definitions — no duplicate-prose drift between seats.
- The wrong-verbosity bug class is structurally dead: an undeclared
  dose cannot load.
- Projects extend the roster without forking the plugin; an invalid
  project seat is skipped with a note and never shadows a default.

Commits: 3e50ecd (foundation), 917f887 (phase merge head).
