# Case study: four rival AI vendors reviewed this product — here's everything they found

What actually happens when you convene AI reviewers from four competing
vendors, hand them screened evidence, and enforce one rule — *a claim
without a locatable evidence ref is discarded before convergence*?

On 2026-08-12 we found out, by pointing cairn's `peers council` mode at
cairn itself. This page is the full, unflattering record: every number,
every degradation, every finding that died under scrutiny, and the one
recommendation the tool argued against and lost. The raw run record
lives in the repo's planning history; the tracker arc is public
(issues [#70](https://github.com/eventually-consistent-code-org/cairn2/issues/70)–[#76](https://github.com/eventually-consistent-code-org/cairn2/issues/76)).

## The setup

Four dimensions — functionality, look-and-feel, market, code — times
four reviewers: **codex, grok, antigravity, opencode**. Sixteen seats,
every reviewer receiving the same screened evidence packet per
dimension, findings clustered and stress-tested across up to two
rounds, and nothing counted unless its evidence could be located in
source. The council machinery itself had been built and drilled in the
two phases prior (issues #66–#69), including a scripted rehearsal with
stand-in reviewers before any real vendor was seated.

Why cross-vendor? Because a reviewer that shares your model's blind
spots confirms them. This is *claim-verified-against-source*
cross-vendor review — the qualifier matters; "adversarial review" alone
is now a category label anyone can print.

## The run, by the numbers

- **58 findings recorded. 50 survived verification. 8 died under
  adjudication.**
- Round 1 only — no verified finding met the round-2 escalation bar
  (severity gap greater than one tier, or mutually exclusive
  recommendations).
- Degradations, recorded rather than hidden: one reviewer timed out at
  300 seconds on a 60k-line diff and its seat closed empty; another hit
  vendor capacity twice and succeeded on retry; a third returned a
  clean bill on functionality — score 5, zero findings — and that
  stands in the record too.

The 8 dead findings are the system working. Three were invented — a
reviewer cited runtime errors that don't exist and called a 280-line
file "truncated"; killed against source and passing tests. Two misread
the evidence packet's shape as a product gap. One misunderstood a
deliberate design split. Plausible-sounding claims died because the
evidence rule doesn't negotiate.

## What the fifty real findings clustered into

**The strongest cluster of the whole council — all four vendors,
independently:** raw machine-format error payloads reached the user
before (or instead of) a plain-language line, and two error paths
rendered inconsistently. When four reviewers with different training
data converge unprompted on the same UX failure, that's signal no
single review produces.

**Ten code defects, each verified against source** — among them: the
council verb couldn't record its own runs under its own mode (this very
run had to record as a plain review); a retry path duplicated findings
instead of replacing them; a run with a silent reviewer could close as
"pass" — ironically exercised by this run closing with one seat empty;
a file-update path persisted its write before validation finished; and
lexical path containment that a symlink could step around. Every one
named a shipped, public surface; every one became tracked work.

**A four-seat market finding:** the README positioned the product more
narrowly than what it shipped, and the differentiators read as workflow
vocabulary rather than the mechanisms that are genuinely unmatched.
The reviewers' prescription — lead with the mechanism, name the real
competitor set, retire follower framing — is why the repo now carries a
[mechanism-level comparison page](comparison.md).

## The council caught itself

Mid-run, the adjudicator noticed one reviewer quoting internal research
its evidence packet never contained. Root cause: peer CLIs ran with the
repository as their working directory, so the leak gate was screening
*packets* while reviewers could simply read files. That exposure —
demonstrated live, by the process, on the process — became REC-4, and
the fix (reviewers run from a scratch directory containing only their
packet) shipped within the following phase.

A review process that can't discover its own flaws isn't rigorous; it's
theater with good production values.

## The override — the part we're proudest of

REC-5 proposed a confirmation step before the ship command pushes and
reassigns tracker items. Cairn's own recommendation was **no action** —
its silent-judgment contract is deliberate, and it said so in the
report. Two reviewers disagreed. The maintainer sided with the
reviewers, **over the tool's recommendation**, and the dispositions
table records exactly that: a product decision of record, made against
the software's stated position, now shipped as ship's
confirm-before-push gate.

A sixth recommendation wasn't from the reviewers at all — the
maintainer raised at the approval gate that sixteen parallel seats had
exhausted the laptop's memory, and resource-aware throttling became
tracked work alongside the rest.

## What shipped

All six dispositions were approved on 2026-08-12 and landed as issues
[#71](https://github.com/eventually-consistent-code-org/cairn2/issues/71)–[#76](https://github.com/eventually-consistent-code-org/cairn2/issues/76)
in a follow-up phase, verified and closed the next day: the ten code
defects fixed with tests, the human-first error renderer, the
positioning realignment, the peer scratch-directory containment, the
council throttle, and the confirm-before-push gate. The findings above
that read like open wounds are healed ones — this page describes the
run, and the tracker shows the repairs.

## Why we publish this

Anyone can claim their review process is rigorous. A rigorous process
leaves artifacts: counts that include the failures, degradations in the
record, findings that died with reasons, and at least one decision
where the tool lost the argument. That's what this page is…

Run it on your own project:

```
/plugin marketplace add eventually-consistent-code-org/cairn2
/plugin install cairn
```

then `/cairn:peers council`. Prerequisite: install the reviewer CLIs
you want seated — the review is only as cross-vendor as your roster.
