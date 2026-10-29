# 0026 — A fixed call chain is a parameter on a tool, not a step in the prose

Date: 2026-10-18. Status: accepted.

removeWhen: every harness cairn runs in executes a skill-declared tool sequence atomically on the model's behalf — a composite or workflow primitive a verb file can name — so a chain with one right order can live in the verb without the model re-sequencing it on each run. Until then such a chain is a mechanism and belongs in the server.
derives: axiom 2 (mechanism-vs-judgment); axiom 6 (surface-is-rent)

## Context

Six verb files narrated chains whose steps had exactly one right order.
Claiming an issue meant resolving the current commit, posting a comment
and moving the state. Closing one meant composing the close comment,
measuring the duration, closing the issue, writing the receipt and then
appending the ledger line that reads the receipt — in that order, because
a fix-up line appended out of order retracts the closure it was meant to
record. A wave checkpoint composed notes and a resume verb, wrote the
handoff and emitted the outlook. A debugging session posted its own
started comment, mirrored cause-identified and wrote the closing lesson
card. An audit's closing steps deduplicated findings, wrote the record and
filed the survivors with severity first in the body. Verification read
three ledger gates by eye.

Each step was a sentence, and a sentence is something the model can skip,
reorder or paraphrase. Each chain was also something with a wrong answer,
which the second clause says is a mechanism. The obvious shape — one new
tool per chain — was closed off by the sixth: the tool count is pinned at
87 and every schema is paid for in every session.

## Decision

Every fold is a parameter on a tool that already existed. `issue_create`
takes a claim and the server resolves and keeps the base commit (commit
f55db99). `issue_close` takes the summary and the ledger block and does
the whole close through the one shared append (commit 1e54781).
`continuity_checkpoint` takes a wave run id and emits the outlook itself
(commit edf201c). The trace tools own their mirror and their card (commit
cacccca). `audit_record` takes `dedup` and `file` flags and the closing
steps of the audit verbs shrink to those flags (commit 34d3435).
`plan_check` reports a missing red/green pair, missing evidence and a
superseded closure from the ledger, so verification defers to it (commit
ba58d54). The verb files keep the judgment — what to summarize, when to
checkpoint, which findings survive the panel — and lose the sequencing.

No tool was added; the count held at 87 through the phase and the resident
footprint stayed under its pin.

## Consequences

Ordering is now asserted by the server rather than hoped for in prose, and
two later mechanisms stand on it: the base commit the server stamps at
claim is what the declared-verify re-run keys on (ADR 0017, amendment),
and the frozen-run check sits in the claim and close handlers the chains
now pass through (ADR 0016, amendment).

The seam moved rather than vanished. A worker's summary string now crosses
into a ledger line the server also writes its own segments on, and the
phase's closing security audit found that seam twice: a summary can place
a forged observed segment ahead of the real one, and a close reached by
editing the issue's state skips the frozen-run check that the close tool
makes. Both are filed for the next hardening pass, stated here so the
boundary reads as a decision and not an oversight.

Cost: each folded tool's schema grew by the parameters it took, which is
rent under the sixth clause; the verb files shrank by more than the
schemas grew. A verb that re-narrates a folded chain is the finding.
