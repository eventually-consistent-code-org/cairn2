# 0025 — Rules derive from axioms; a rule that derives from none is the finding

Date: 2026-10-16. Status: accepted.

removeWhen: never — a rule justified by the incident that produced it is a reaction, and reactions written one per incident never converge; the classification is what makes the next unseen case recognizable, whatever platform the guards run on. What can go is the copy: if every harness one day loads a project's architecture document directly at session start, the rendered spine copy and its readers check become redundant.
derives: convention — the clause set is what every other rule derives from; it cannot name a clause above itself

## Context

By the autumn of 2026 cairn carried three guards, two dozen ADRs and a
page of shared rules every verb inherits, and each had been written in
response to something: an issue number, a review finding, an article read
that week. The guards were honest about their reach (ADR 0016), but a
reader asking *why this rule and not another* was sent to the incident.
Rules written per incident never converge; the seventeenth spelling of a
discarding git flag was still a new issue, and nothing said what the
eighteenth would have in common with it.

A critique read on 2026-10-13 (Alex Aslam, "Why your agents need a
constitution, not a prompt") named the shape: a prompt tells an agent what
to do, a constitution tells it what counts as what, and only the second
lets it recognize a case nobody wrote down. The critique was accurate on
exactly the points this record covers.

## Decision

Six clauses open the architecture document (commit 5b6d786): what the
record of work is, what a mechanism is as opposed to a judgment, what is
data and what is a directive, what a recorded run is as opposed to a
claim, what the owner's ground is, and that every resident surface is
rent. They classify and prohibit nothing; the prohibitions follow from
them, in the guards.

Every ADR carries a `derives:` line directly after its `removeWhen:`,
naming the clause or clauses it follows from, or stating `convention` and
why no clause decides it. Every hook script carries the same line in its
header. A test fails on an ADR or hook that names none, on a clause no
rule cites, and on a clause count that moved without its pin. A rule that
derives from no clause is therefore a finding, not an exception to be
noted.

The clauses render into the harness spine's shared rules through the
spine generator, from the checkout and never from a home directory, so
every harness that loads the spine reads the same six. The claims rule
joined them the same week (commit 32e3001) as the operational form of the
fourth clause: a modal sentence is asserted by a named test, measured as a
runtime field, or a dated claim, and a check is not done until it was made
red once.

A copy nobody loads is half a promise. Enumerating the readers found the
gap on the first mechanism it was applied to: Claude Code reads
`AGENTS.md` only when no `CLAUDE.md` is in scope (a claim, as of 2026-10,
per its memory docs), so in any project carrying both files the one
harness this plugin targets never saw the clauses. Setup now installs an
`@AGENTS.md` import at the top of `CLAUDE.md` and its check is red when a
live import is missing (commit ec0ced6); the spine's drift check gained a
readers leg that runs every setup target in a scratch project and is red
when any harness has no path from the file it loads to the fragment
(commit c4605f7). This checkout is the dogfood copy (commits f27cf16,
2912d18).

## Consequences

A new guard's justification is a clause, not an issue number, and the
next unseen case is classified before anyone writes a rule for it. The
same phase proved the point twice over: the run guard's enumerated table
became a classifier reading git's own semantics (ADR 0016, amendment),
and six fixed call chains the verb prose narrated moved into the server
because the second clause says a sequence with one right order is a
mechanism (ADR 0026).

Which file each harness reads is a dated claim per harness, never the
asserted kind — a third party's behavior cannot be asserted from here —
and only the Claude Code row was re-read in 2026-10. The readers check
asserts cairn's side: that each setup target writes the file and that the
fragment is reachable from it.

Cost, recorded as the sixth clause asks: the import makes roughly 13 KB of
spine resident in every Claude Code session of a project that installs it.
That is the price of the clauses being read rather than copied, and it is
paid on purpose.
