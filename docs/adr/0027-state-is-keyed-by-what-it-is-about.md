# 0027 — Per-machine state is keyed by what it is about: the repository for knowledge, the worktree for a task in flight

Date: 2026-10-29. Status: accepted.

removeWhen: the harness hands every session one state directory per repository that its linked worktrees already share — so cairn no longer derives the repository key itself — and keeps a separate per-session slot for the task in flight.
derives: axiom 2 (mechanism-vs-judgment); axiom 4 (recorded-run)

## Context

Cairn keeps a disposable cache per machine under the cairn home: a memory
index, a cost log, an observation log, a cost meter, a yield store, loop
state, the portfolio snapshot, run manifests, the ship-gate stamp, the
budget ledger, the session handoff and the session banner. Every one of
them was keyed by a hash of the resolved project directory.

A linked worktree is a different directory. Two agents on one repository
in two worktrees therefore got two memory indexes (the second empty until
rebuilt), two cost logs, two meters, and — worst — two observation logs,
one of them inside each worktree, so a retrospective run from the main
checkout never saw what the wave workers' hooks had observed, which is
most of the observations a phase produces. The parallel path the project
was building was being measured by a fraction of its own telemetry.

Not everything should be shared. A session's handoff is one session's task
in flight; two worktrees are two tasks, and merging their handoffs would
be wrong in the other direction.

## Decision

State is keyed by what it is about, not where it is written. Knowledge of
the project — the index, metrics, observations, meter, loop state, yield,
outlook mirror, refusals, breaker-off flag, run manifests and their prefix
scan, ship-gate stamp, budget ledger — is per repository and keys by the
hash of the resolved `git rev-parse --git-common-dir`. A task in flight —
the handoff, the banner, the active context — stays per worktree. A folder
outside git falls back to the folder key, byte for byte the old behavior.

One definition of the key lives in the server's run-manifest module and is
mirrored in the hooks' shared helper, with a test that pins the two
byte-equal on a main checkout, a linked worktree and a plain folder; the
hooks still import no server code. The observation log moves out of the
checkout to the cairn home under the repository key, carrying the rotation
decided the same phase (commits 8ad572c, 9922713): past the cap the live
file is renamed to a stamped closed segment, never rewritten, and every
temp file carries the writer's pid and a random suffix. On the first run
after the upgrade a file under the old key is moved to the new one with a
hard link that refuses an existing target, so the move happens once and
never replaces a shared file by name; each move is logged as a rekey row
on the metrics log (commits 1a9356f, 2e2888a). The architecture document
carries the table of which file is keyed which way.

## Consequences

A wave's observations, spend and seat yields are the ones the main
checkout's retrospective and the portfolio board read. The ship-gate stamp
is shared too, which is safe because the guard compares the stamp's commit
to the commit being pushed, not the folder.

Sharing is not atomicity. The yield store and the outlook snapshot are
still read-modify-write files; the yield store's header answers the three
concurrency questions (rename atomic, last writer wins, accepted rather
than locked) and the board's does not yet. The phase's closing security
audit found four gaps in the migration and the rotation, all filed for
the next hardening pass and stated here so the boundary reads as a
decision: a database sidecar can be moved without the database it belongs
to and corrupt the shared index; the rekey row can be written before the
metrics folder migrates, leaving the old cost history unread and the skip
unlogged; two writers rotating at the same instant can replace the
segment one of them just closed; and the observation hook still gates on
a cairn folder in the worktree, which a linked worktree of a repository
that ignores that folder does not have.

The per-worktree key did not change, so an existing symlinked checkout
keeps the handoff it had.
