# 0004 — Folder-per-project containers in Confluence

Status: accepted (v2, 2026-07-24)

removeWhen: the team space stops organizing work as one top-level folder per project. This mirrors a house convention, not a model or platform limit.
derives: convention — a wiki layout choice mirroring the space convention; no clause decides where pages sit

## Context

The team's Confluence space organizes work by top-level folders, one per
project, with each project's pages inside its folder. The connector
originally parented landing pages directly under the space homepage.

## Decision

Mimic the space convention (commit 30d6f5f): ensure a folder named for the
project under the space root (case-insensitive lookup via CQL search —
folders have no title-filtered v2 listing; created via the v2 folders API
when absent), then keep the landing page and doc tree inside it. Container
handling is adapter-internal; the SPI is unchanged.

## Consequences

- Published projects match hand-organized ones; re-publish reuses existing
  folders without duplicating.
- Products without a folder concept implement their own container notion
  (or none) behind the same `ensureRoot` semantics.
- Space keys are immutable in Confluence — display-name changes don't touch
  configuration.
