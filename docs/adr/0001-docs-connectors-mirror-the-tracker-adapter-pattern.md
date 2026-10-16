# 0001 — Docs connectors mirror the tracker adapter pattern

Status: accepted (v2, 2026-07-24)

removeWhen: wiki vendors ship their own maintained servers for page find/create/update with declared capabilities, so cairn can call those directly instead of keeping a second adapter registry of its own.
derives: axiom 2 (mechanism-vs-judgment)

## Context

Cairn needed to publish repo documentation to team wikis (Confluence first,
competitors later). The tracker subsystem already solved the same shape of
problem: many third-party backends behind one normalized interface, with
per-backend capability flags, per-adapter config validation, and a contract
test suite.

## Decision

Docs connectors are a sibling subsystem (`server/src/docs/`) with their own
`DocsConnector` interface, capability flags, and registry — the same
two-level config pattern (top-level block names the connector; the adapter
module's Zod schema deep-validates the opaque config record) and the same
env-var-name credential rule. They do not extend or share the tracker
interface; only the HTTP core is reused. Introduced in commit e4df5a8.

## Consequences

- New wiki products are additive: one adapter module + registry entry, and
  they inherit the shared behavioral contract suite.
- Two registries with near-identical shapes to maintain — accepted cost;
  merging them would couple work-item semantics to publishing semantics.
