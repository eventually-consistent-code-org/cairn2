# 0021 — The close leaves a receipt; the append consumes it

Date: 2026-10-02. Status: accepted.

removeWhen: the durable per-task outcome record lands and both the close and the ledger append write into it directly, leaving the bridge receipt nothing to carry.
derives: axiom 4 (recorded-run); axiom 1 (tracker-truth)

## Context

A closed task's record is split between two tools that can't see each
other. The close holds the tracker facts: the estimate as stored, the
claim and close times, the claimed minutes, the worklog outcome. It has
no commit range, and in the normal flow it runs before the closing commit
exists. The ledger append runs last and holds the range, but recovering
the tracker side from it would take a network read at the one moment the
record must not depend on the network.

## Decision

The close writes a small ephemeral receipt, keyed by issue id, into a
local state folder that ignores itself in git. The ledger append reads
it, folds it into one key=value segment on the ledger line, and deletes
it.

Three rules carry more weight than the mechanism:

- **Absence is stated.** No receipt (an issue closed by hand, a tracker
  outage, a close from an earlier session) still writes the line, with a
  named degraded marker. A corrupt receipt is marked differently and
  cleared. No reader ever has to guess whether a blank means zero or
  unknown.
- **Instrumentation never blocks.** Every receipt read and write returns
  a value instead of throwing. A receipt is consumed only after the
  ledger entry passes validation, so a refused append leaves it for the
  retry.
- **Provenance travels with each number.** An estimate read from a real
  tracker field and one scraped from a prose line in the issue body are
  not the same evidence. Each number carries its source, because pooling
  them unlabelled is how a calibration curve ends up fitted to a parser
  bug.

## Consequences

The ledger line grew one more optional segment, placed like the earlier
evidence and test-pair segments, and the one parser that reads lines
positionally learned it. Older lines keep parsing.

This is deliberately the bridge, not the outcome record. A widened prose
line is the wrong container for a dozen structured numbers, and the
durable per-task record is designed separately. What this settles is the
prerequisite: the two halves of a closed task can now meet without a
network read, and nothing downstream has to invent the half it was
missing.
