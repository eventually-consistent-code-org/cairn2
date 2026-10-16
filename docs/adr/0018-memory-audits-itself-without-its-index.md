# 0018 — Memory's self-checks read files and git, never the search index

Date: 2026-09-20. Status: accepted.

removeWhen: the search index moves to a runtime-bundled SQLite (Node's built-in sqlite module, once stable on every supported runtime) and the compiled native binding is gone, so the index is no more fragile than the files.
derives: axiom 4 (recorded-run)

## Context

The memory subsystem has two halves that fail independently. Cards are
plain markdown files in git. The search index is SQLite behind a compiled
native binding, and that binding is genuinely fragile: a plugin cache
installed under a newer runtime ships without one, which happened live
during the phase that produced this record.

Phase 24 added three things that inspect memory's own health — an audit
of the card store, a backlog count for unreviewed observations, and a
compaction proposal. Each of them could naturally have been computed from
the index, which already knows how much is stored.

## Decision

None of them touch the index. All three read plain files and git.

The statistics tool that carries them now computes the file-derived
blocks outside the guard that wraps the index, so a missing binding
degrades that one block to a note and leaves everything else intact.

## Consequences

The property this buys is worth naming precisely: a memory audit that
dies exactly when memory is unhealthy is the wrong shape. The most likely
moment for someone to ask what is wrong with the card store is the moment
something is wrong, and a broken binding is one of the few ways that
happens. A health check coupled to the component most likely to be broken
answers a question nobody asked.

The cost is duplicated traversal — the audit walks the card directory
that the index has already catalogued — which is cheap on a store the
capacity guard exists to keep small, and would be the wrong thing to
optimise away.

A second-order effect worth recording: because the card audit already
computes which cards are aged and low-confidence, the compaction proposal
reuses that list rather than re-deriving the criteria. A test asserts the
two agree exactly, so they cannot drift into disagreeing about what
"aged" means.
