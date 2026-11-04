# 0036 — A git alias is judged by what it runs, not by what it is called

Date: 2026-11-03. Status: accepted.

removeWhen: git exposes the resolved command of an alias before running it, or the harness classifies a command by its effect rather than its text.
derives: axiom 5 (owner's-ground); axiom 2 (mechanism-vs-judgment)

## Context

The run guard sorts a git invocation into effects by its subcommand and
flags. An alias is a subcommand the table has never heard of, so an
alias for a hard reset — defined inline on the command line, or in the
repository's configuration a moment earlier — read as unknown, defaulted
to read-only, and ran. The guard's own header said it classified by
effect; an alias was the one spelling where it classified by name.

## Decision

The classifier resolves an alias before the table lookup. An alias
passed inline with the configuration flag is expanded to the command it
names and that command is classified. A subcommand with no table row and
not among git's builtins is probed once against the repository's
configuration through the helper the guard already has, and the probe's
answer is classified; a probe that fails or finds nothing leaves the
unknown classification, fail-open on the guard's own error. An alias
whose value starts with the shell marker is refused outright in every
session, because what it runs cannot be read (commit ada48ab).

## Consequences

The two spellings the audit reproduced — inline and configured — are
refused the way the underlying command is, asserted by tests that were
red first. The guard's header now says which channels it reads and which
it does not.

Git takes an alias from more channels than those two: an environment
variable named on the command line, the numbered configuration
environment variables, and an inline include of a configuration file.
The classifier reads none of them yet; the closing audit walked a hard
reset through each and it is filed (#467). The decision covers them —
resolve, then classify — and the follow-up is coverage, not a new rule.
