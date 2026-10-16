# 0002 — Markdown crosses the SPI; adapters own conversion

Status: accepted (v2, 2026-07-24)

removeWhen: every supported wiki product accepts markdown on its publish API and renders it faithfully, so no adapter needs a converter.
derives: axiom 2 (mechanism-vs-judgment)

## Context

Wiki products disagree about body formats: Confluence wants storage-format
XHTML, Notion wants blocks, GitBook wants markdown. The SPI needed a body
type that keeps the publisher product-neutral.

## Decision

`PageSpec` carries markdown. Each adapter converts to its native format
internally — for Confluence, a dependency-free converter
(`server/src/docs/markdown.ts`) covering a supported subset, degrading
unknown constructs to escaped text rather than failing (commit b4c0d69).

## Consequences

- The publisher and structure mapper stay pure and product-agnostic.
- Conversion fidelity is bounded by the subset; adapters may differ in
  richness. Acceptable: a publish never fails on exotic markdown.
- No heavy markdown dependency in the server (four runtime deps total, as
  of the MCP v2 migration — three at the time of this decision).
