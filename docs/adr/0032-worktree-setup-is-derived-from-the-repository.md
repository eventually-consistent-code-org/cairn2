# 0032 — Worktree setup is derived from the repository, never typed into a brief

Date: 2026-11-03. Status: accepted.

removeWhen: the harness provisions a worktree when it creates one — dependencies from the lockfile, the ignored files the repository lists, a port — so no brief has to say how.
derives: axiom 4 (recorded-run); axiom 2 (mechanism-vs-judgment)

## Context

A fresh git worktree has the tracked files of one commit and nothing
else: no installed dependencies, no ignored environment files, and a dev
server that reaches for the same port as every other worktree. The wave
brief that dispatches a worker into one carried a hint — "e.g. `npm ci`"
— and left the rest to the worker. In a pnpm workspace that hint writes a
stray lockfile and the wrong module tree; in a repository with a
`.worktreeinclude` it skips the files the owner listed; everywhere it is
a sentence standing in for a mechanism, which is the pattern the
hardening phases exist to remove.

## Decision

The plan status tool derives the setup from the repository and reports
it as lines: the installer per tracked lockfile at the root and in each
workspace package (`npm ci`, `pnpm install --frozen-lockfile`, `bun
install --frozen-lockfile`, `yarn --immutable`), the ignored paths a
tracked `.worktreeinclude` names for copying, and whether a
`.worktree-port` file exists to read. The work and auto verbs paste
those lines verbatim into the brief's standing rules; a repository with
none of the three gets no setup line at all rather than an invented one.
The hint left the template (commit f8af015). Surface count flat: the
result is a field on an existing tool.

## Consequences

Two agents on one repository start from the same, derived instructions,
and a worker never installs from a guessed command. A mixed workspace
reads one line per package manager it actually uses. Tests cover each
package manager, a mixed workspace, and the none case yielding no line.

The derivation reads tracked files, and tracked files already steer the
agent (the project's own instructions do), so no new trust boundary is
crossed; the closing audit noted that an entry's text is rendered without
escaping and recorded it as a rough edge. The setup lines are only as
current as the plugin that computes them: a released plugin older than
the verb that asks for the field hands the brief nothing, and the brief
says so rather than inventing a line.
