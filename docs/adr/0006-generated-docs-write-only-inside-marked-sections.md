# 0006 — Generated docs write only inside marked sections

Date: 2026-09-01. Status: accepted.

removeWhen: never — hand-written prose deserves a structural guard against any writer, script or model. A writer that follows instructions better makes a clobber rarer, not acceptable.
derives: axiom 5 (owner-ground)

## Context

Doc synthesis merges generated content into files that also hold
hand-written prose — including a ~95KB hand-authored runbook. The
never-clobber rule existed only as prose instructions to the synthesis
step; nothing structural prevented a full-file regeneration from
destroying authored work.

## Decision

Generated content lands exclusively inside sections that carry an
explicit machine-readable marker, using the same server-validated marker
grammar the research checkpoints already ship. The writer refuses
everything else by construction: a section that has not opted in is an
error, never a silent append; a malformed marker halts the run instead of
being guessed at; and writing identical content is a proven zero-diff
no-op, so repeated synthesis cannot churn history. Full-file regeneration
is banned outright. The changelog is the one exception — prepend-only
needs no markers.

## Consequences

Hand-written prose is untouchable by mechanism rather than by discipline,
and incremental per-phase synthesis becomes safe to automate at ship
time. The costs are accepted: opting a document in is a one-time manual
marker edit, and deleting a marker silently opts that section out of
updates — the drift report still flags the resulting staleness, which is
the designed backstop.
