# 0039 — A shape closes in the shared reader, once, so every guard inherits it

Date: 2026-11-04. Status: accepted.

removeWhen: never — a fix that lands in one guard's own matching is a fix the other guards did not inherit, and the guards will always be more than one.
derives: axiom 2 (mechanism-vs-judgment); axiom 6 (surface-is-rent)

## Context

Four guards read the same shell line: the run guard for git effects, the
harness guard for configuration writes, the leak guard for the commit it
precedes, the write guard for a subagent's authority. Each had grown its
own reading of the line — its own eval handling, its own project-root
lookup, its own idea of a word — and the audits kept finding the same
shape closed in one guard and open in its neighbour: an eval the run
guard split on spaces while the harness guard joined; a project root the
run guard probed from git while the leak guard took the working
directory.

## Decision

Shell shapes close in the shared reader beside the guards — the word
splitter, the eval reader, the root resolver — and the guards call it;
no guard carries a regex for a shape another guard also meets. The eval
reader joins the words the way the shell does and both guards call the
one function (#283, range b66705a..972827f). The project root, when the
harness sets no project-directory variable, is one helper every guard
calls: git's top level from the payload's working directory, else the
nearest folder holding the harness settings folder, else the working
directory itself, handed back in the working directory's own spelling
(#459, range ceabd8e..6d12931). The twin matrix runs every nested row a
second time with the variable stripped, so a reader that drifts is red
in forty-eight rows at once.

## Consequences

The decision was only partly kept in the phase that made it: the
same-line variable expansion the harness guard gained (#291) was written
into the harness guard alone, and the closing audit reproduced a hard
reset, a whole-tree remove and a default-branch push through a variable
the run guard never expanded (#494, #501, #509). Those are filed as the
next phase's first work, and this record is the reason they are one fix
in the reader and not three regexes. The reader is a dependency every
guard pays for on every call; it is cheaper than four readings that
disagree.
