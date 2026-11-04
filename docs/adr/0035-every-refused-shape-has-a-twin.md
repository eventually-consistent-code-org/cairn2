# 0035 — Every refused shape has an allowed twin, and holds from a nested working directory

Date: 2026-11-03. Status: accepted.

removeWhen: never — a guard shown only the commands it must refuse has been tested for one of its two failure modes.
derives: axiom 4 (recorded-run)

## Context

The hook guards are tested by running each one against a command and
asserting the refusal. That proves the guard fires; it does not prove the
guard fires only when it should. An over-match — a refusal that also
catches the harmless command beside the dangerous one — passes every
such test forever, and a plugin eval of this repository found exactly
that shape: a README claim the tests could not have contradicted. The
tests also set the working directory per test, by hand, so a guard that
read its project root from the wrong place passed when run from the
repository root and was never run from a subfolder.

## Decision

The guard tests are a table. Each row names a refused shape, the
harmless twin that must pass, and runs both from the repository root and
from a nested working directory; a meta-test fails when any row lacks a
twin or a working-directory variant, so a new refused shape cannot land
without its pair (commit 2da9100). The first run of the matrix recorded
thirty twin gaps and eighty-five subfolder gaps and fixed what it found,
including a guard root taken from the subfolder when the harness did not
name the project (filed as the next phase's work).

## Consequences

A refusal is now tested for both of its failure modes: not firing, and
firing on the wrong thing. A nested working directory is a first-class
test case rather than an accident of where the suite was started.

The matrix covers the shapes the audits named, not every row of the
effect table; the closing audit counted the uncovered rows and recorded
that the meta-test can only notice a row someone already added. The
discipline is the decision; its coverage is a number that grows.
