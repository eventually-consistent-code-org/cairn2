# 0012 — One finding set, no matter how many seats

Date: 2026-09-11. Status: accepted.

removeWhen: one call can produce the whole panel's findings already merged, matching this engine's output on a recorded corpus. While seats run independently, the duplicates are structural and dedup stays.

## Context

Multiple viewpoints over one target rediscover the same defects. If
each seat's findings flow to the tracker independently, a five-seat
panel turns one bug into five issues — noise that erodes the
mirrors-everything principle the tracker discipline depends on.

## Decision

Deduplication is a hard requirement and runs BEFORE severity ranking
and issue creation, in both review's and audit's closing disciplines.
Findings merge when they name the same file, sit within a two-line
window of the cluster's anchor (anchored to the lowest line so windows
never chain-drift), and make the same claim — exact normalized-text
fast path, else token-overlap similarity at or above one half. The
merged finding credits every raising seat by name with each seat's
score attributed, keeps the highest severity, and takes its canonical
wording from the highest-severity raiser. Distinct claims at one
location stay separate. Output order is deterministic. The engine is a
pure dependency-free library — no new tool surface.

## Consequences

- N seats never means N issues; tracker noise is bounded by real
  defects, not roster size.
- Seat crediting preserves the yield statistic's input (which seats
  actually surface surviving findings).
- Determinism makes dedup testable under shuffle and safe to re-run.

Commits: b031a97 (dedup engine and closing-discipline wiring).

## Evidence — the sunset test (2026-10-13, #334)

The clause above is now testable: Claude Code ships one call that
returns a verified, deduplicated finding set (`/code-review` with
effort levels and `--max-findings all` since 2.1.288, a verify pass,
per-finding failure scenarios). The recorded corpus exists at
`evals-corpus/` — eleven real fix commits, each carried into a
scaffolded workspace as the files it touched plus its own reversal on a
`corpus/NN-<slug>` branch, so the diff under review is the defect at the
point in history where it lived, plus one clean control —
with two arms over it: the shipped five-seat panel with dedup and
refutation, and the native call. Recall is the share of runs naming the
known defect at its file; precision is the pass rate of a judge that
fails any invented finding (a proxy — the harness keeps no transcript).
Method and commands: `evals-corpus/README.md`;
`scripts/eval-corpus-score.mjs` prints the two numbers per arm.

Decision rule, written before the run: native matches or beats the
seats on recall without losing precision → the correctness axis is a
delegation candidate for the next major, and ADR 0010's byte-identical
default fold holds until then; otherwise the clause stands as unmet
with the numbers.

**Result (2026-10-14, Claude Code 2.1.299, one run per case, eleven
items per arm, latest run of each case scored):**

| arm | recall | precision proxy | cost per review |
|---|---|---|---|
| seats — five-seat panel, dedup, refutation (`/cairn:review`) | 100% (10/10) | 100% (11/11) | ~$0.75 median |
| native — `/code-review <branch> high --max-findings all` | 100% (10/10) | 27% (3/11) | ~$0.19 median |

**The clause is unmet.** The native call matches the panel on recall —
it named the known defect at its file on every item — and loses on
precision: on eight of eleven items, the clean control among them, it
raised efficiency notes on untouched code, comment inconsistencies and
hypotheticals as numbered findings with failure scenarios, and the
correctness-axis judge failed the run for it. `--max-findings all` is
the arm as #334 specified it and asks for exactly that breadth; the
panel's refutation vote and dedup are what the native call lacks, and
they are what the precision column measures. The native call is ~4×
cheaper per review, which is the number a future delegation argues
from. The fairer second shape — the native call at its default finding
limit — is #372.

How the numbers got here, because the first pass read differently. The
first full seats run scored recall 70% / precision 73% and the first
native run 90% / 0%; reading the misses showed three corpus defects,
each fixed in the generator and rerun for the affected cases only (the
scorer pools runs, latest per case): the main suite's `audit_record`
mock answered with a canned foreign record, so the reviewer reported
the tool instead of filing; the precision grader judged clarity notes
as invented defects, outside the correctness axis this test scores; and
the ground truth for items 04, 07 and 10 described the wrong mechanism
or file (checked against the fix commits, not against the review
output — all three reviews had named the real defect). Both arms were
rerun on those items with the corrected graders; the seats' three
misses and the native's one became passes, and three native runs also
passed precision where the fuller ground-truth text covered more of
what they raised. Single-run, judge-scored numbers — the precision
column in particular is a Haiku judge's verdict per run, stated as a
proxy.

Either way the other four axes, tracker filing, the audit record and
refutation voting are outside what the native call can see, and this
ADR's dedup stays while any two seats run.
