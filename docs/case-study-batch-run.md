# Case study: the first headless batch run — seven fixes in 22 minutes, and the budget meter read zero

What actually happens the first time you hand an AI build system two
phases of real work, a token ceiling, and pre-authorized push access —
then walk away?

On 2026-09-07 we found out, by pointing cairn's batch mode at cairn
itself. This page is the full record: the run as it happened, the
numbers against the estimates, and the centerpiece — the
instrumentation gap the run discovered in its own budget enforcement,
published here because a case study that omits the embarrassing part
isn't a case study. The tracker arc is public (issue 141); the
narration below quotes it.

## The setup

A batch run is one staging conversation followed by zero attended ones.
You pick the phases (or fit them to a budget), the estimator prints an
honest cost range per phase — never a point claim, wide by admission
when history is thin — and you set a token ceiling the run must respect
at every phase and wave boundary. The guarantee is stated up front and
it is deliberately modest: no *new* work starts past the ceiling, so
overshoot is bounded by at most one in-flight wave — recorded, never
hidden.

Push authority is the part that took a product-council fight to get
right. The council case study on the neighboring page records cairn
arguing *against* a confirm-before-push gate and losing; the batch
design keeps that adopted confirmation but moves it to run start —
collected once at the staging gate, scope-limited to exactly the
approved phases, declinable without losing the run. Pre-authorized,
never silently bypassed.

This run staged two phases — a dress-rehearsal of four friction fixes
and a follow-up of three guards, seven work items total — under a
deliberately tight 500,000-token ceiling picked from the low end of the
estimate ranges. Staging said so plainly, and said something else
plainly too: a boundary refusal would count as an acceptance *pass*.
The run was allowed to be stopped by its own budget, on the record.

## The run, as it happened

Staged at roughly 23:03, complete at roughly 23:25 — about 22 minutes
of wall time against a combined estimate of roughly thirteen hours of
human-paced work. Every transition was narrated live on the public
tracker issue while nobody watched:

- Phase one dispatched four work items in parallel isolated checkouts
  and closed all four with regression tests — 1240 passing on the
  merged tree. One discovery during the work (issues can't be re-phased
  after creation — a contract gap two flows silently hit) was filed to
  the backlog as issue 142 rather than absorbed. Verified, then pushed
  under the pre-authorization: `5feb2a5..a619f71`, nine commits.
- Phase two landed the three guards, verified at 1248 tests, and pushed
  `a619f71..1ab0834`, seven commits.

Both phases shipped. Four unattended decisions were taken along the
way, each logged with the principle that resolved it — scope cut and
filed rather than expanded, guard code chosen after config provably
couldn't express the rule — and three cosmetic taste calls were queued
for review at leisure, blocking nothing.

One touch worth keeping from the live narration: phase one's cargo
included a fix for the docs-staleness matcher's handling of hyphenated
headings, and minutes later the ship-time docs tier generated a
changelog entry whose hyphenated heading that very fix cleared on the
first try. The repair proving itself in production before the run was
over…

## The honest part: the ceiling was blind

Now the finding this page exists to publish. The run's budget ledger —
the number the ceiling checks at every boundary — read **zero tokens
the entire run**.

Root cause: the boundary ledger scoped itself to metrics sessions that
*started after* the run opened. The driving session's row predated the
run, and the wave subagents doing the actual work wrote no rows of
their own — so in-session batch spend was structurally invisible to the
very ceiling meant to bound it. The boundary mechanics themselves
(rows, verdicts, stop semantics) executed correctly, on a number that
could not see the cost.

The machinery caught its own gap: the run report's estimate-vs-actual
section is where the zero surfaced, and the report named it the
headline finding rather than burying it. The budget-refusal acceptance
criterion was marked NOT exercised — unit-tested, but a live refusal
needs instrumentation that can see spend first.

### The reconstruction

From the agents' own transcripts: phase one's agents used roughly 302k
tokens, phase two's roughly 259k — about **561k total against the 500k
ceiling**. Replaying the run with working instrumentation, it plays out
*identically*: the boundary before phase two reads ~302k, under the
ceiling, so the run proceeds; it finishes ~61k over, squarely inside
the documented at-most-one-wave overshoot bound. The contract held in
reconstruction; the plumbing had to catch up. Both phases also landed
far inside their estimate ranges — ranges honest but wide, another
finding with a fix attached.

### The fix, one release later

The gap became the first intake item for the release phase, and the fix
shipped in v2.4.0 on 2026-09-10 — three days after the run that found
it. The ledger now charges the driving session as a delta from run
start and folds each wave's reported agent totals into its boundary
rows, and the proof is not a unit test: a live refusal test walks the
full stop path — a tiny ceiling over a real phase, refused at the
boundary, on the record. The same release fixed the estimator bug the
wide ranges pointed to (an archived-phase path silently discarded the
per-issue history), narrowing ranges up to 73% for phases resembling
ones already run.

And the loop is closing where you'd want it to: the batch run producing
this very document staged with estimate ranges roughly 40% narrower on
that per-issue calibration — under a ceiling that can actually see it
spend.

## What this proves — and what it doesn't

It proves the shape of the thing works: staged phases with honest
ranges, push authority granted once and scope-held, every transition
narrated on a public tracker while nobody watched, seven fixes shipped
unattended with regression evidence in 22 minutes. It proves the
reporting is honest enough to headline its own instrumentation failure
and ship the fix in the next release.

It does not prove the ceiling stops a runaway build in every case.
One live refusal is on the record now, which beats a promise — but the
guarantee remains what it always was: bounded overshoot of at most one
in-flight wave, not a hard wall. And the resume machinery was armed but
never exercised, because nothing killed the run. Those stay on the list
until a run proves them the way this one proved the rest — live, in
public, with the numbers attached.

Run it on your own project:

```
/plugin marketplace add eventually-consistent-code-org/cairn2
/plugin install cairn
```

then `/cairn:auto --batch`. Set the ceiling low the first time — a
refusal you can read is worth more than a run you have to trust.
