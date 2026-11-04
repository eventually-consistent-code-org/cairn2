# 0034 — A ledger line is typed at the writer: hashes are hashes and a field cannot spell a separator

Date: 2026-11-03. Status: accepted.

removeWhen: the ledger is a typed store the tracker keeps, not a text file a tool writes and other tools parse.
derives: axiom 4 (recorded-run); axiom 3 (data-not-directive)

## Context

The phase ledger is one line per closed task, fields separated by an em
dash: the summary, the commit range, the evidence and its result, the
server's own observed run, the actuals, the issue id and date. Readers
— the plan-quality scan, verification, distill — parse those fields back
and decide from them whether work is done. Two audits found the writer
trusting its caller. A summary that spelled the separator could append a
forged passing observation after the real one, and the reader took the
forgery because it bound the first segment run. A base or head commit was
any string: a symbolic name or an option-shaped value reached the git
range command and, in one reproduced case, overwrote a file. The
closing-side evidence of every task ran through a path an agent could
shape.

## Decision

The writer types what it writes. A base or head commit is a 7–40
character hex hash, checked before any git call or tracker write and
refused with a typed configuration error otherwise, at claim, append and
span alike; the range handed to git sits behind `--end-of-options` with
the path separator after it, so git cannot read the range as an option
or a pathspec (commit 8071071). The task reference and the summary pass
through the same segment sanitizer the evidence and note already used,
which turns a separator into plain punctuation, and the parser binds the
last segment run on the line, so a forged tail inside a field lands
inside the summary where it is text (commit a63c2f5). The rerun's set of
safe references drops symbolic names for the same reason.

## Consequences

A ledger line can no longer be forged by its summary or fed a non-hash,
and a reader's answer about a task is the server's, not the caller's.
Both are asserted by tests that were red against the previous writer.

The decision was applied to the fields the audits named and not yet to
their neighbours: the issue id and the close date on the same line still
pass only a newline check, and the closing audit of this phase forged a
passing observation through them (#469); the red and green commit
references on a test-driven line are not hash-checked (recorded). The
rule generalizes — every field on the line goes through the sanitizer,
every reference is a hash — and the follow-up is to finish applying it
rather than to re-decide it.

## Amendment 2026-11-04

The rule is applied to the rest of the line (#469). The issue id and the
close date pass through the same segment sanitizer as every other field,
and both are typed before anything is read or written: the id must match
the tracker id shape every adapter mints — an optional leading `#`, one
alphanumeric, then alphanumerics, dots, underscores and hyphens — and the
date must be an ISO calendar date or an ISO timestamp. The red and green
commit references on a test-driven line are hash-checked like the base
and head. Each refusal is a typed configuration error that names the
field, raised at `checkLedgerEntry` so the folded close refuses while the
issue is still open and the close receipt is left in place.

The id shape rules out whitespace, slashes and separators, so the crafted
id the closing audit used can neither spell a field run nor name a file
outside the receipts folder it keys. The date shape is what makes the
readers' lexical ranking of two lines for one task a ranking by time (ADR
0028's amendment of the same date). Asserted by `test/ledger.test.ts`
"the issue id and close date are typed at the writer too": the audit's
crafted id and crafted date are refused with nothing written, the hostile
spellings the audit did not name (a path climb, an option, a bare `#`)
are refused, and the harmless twins — every tracker's id shape, a day, a
timestamp — render byte-for-byte as before. The test was red against the
writer this record described before the change landed.
