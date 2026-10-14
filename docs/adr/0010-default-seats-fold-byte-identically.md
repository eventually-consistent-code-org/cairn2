# 0010 — Default seats fold into review, byte-identically

Date: 2026-09-11. Status: accepted.

removeWhen: a major version deliberately drops the promise that unconfigured projects see the pre-roster review output, and the byte-identical pin goes with it.

## Context

Adding a roster mechanism to an existing review verb risks two
regressions: a second parallel review path (the old hardcoded axes plus
a new panel), and silent behavior drift for every project that never
configures a seat.

## Decision

Fold, never stack. Review's five axes and the seat-shaped audit lenses
ARE the default roster entries — the same five viewpoints, now data.
With no seats configured, the composed panel reproduces the previous
hardcoded behavior exactly, and a regression test pins the no-config
roster byte-for-byte (names, order, content). Anchored 0-10 scores land
BESIDE pass/fail verdicts as calibration signal; they never replace or
gate verdicts. Internal seats are framing lenses — cheap, same-model;
the external peers council remains the genuinely adversarial mechanism.
One review path exists.

## Consequences

- Zero migration: unconfigured projects see identical output.
- Any future edit to a default seat is a visible, reviewable data
  change that trips the byte-identical pin.
- The lenses-vs-council distinction is stated wherever both appear,
  preventing a second council from growing by accident.

## Amendment 2026-10-14

The default roster may grow by signal-gated default seats. The five
axes stay byte-identical and first, in review's order; a default seat
added after them must declare at least one scope signal, so under the
default auto dispatch it sits out whenever its signal does not fire.
The first such seat is ux (seventh in the roster, after the plan-stage
interrogation seat), gated on `touches-ui` — presentation files and
UI-shaped path segments. With the default auto dispatch a server-only
diff therefore convenes the same five seats it always did, so
unconfigured projects see identical output unless their diff touches UI
files. The byte-identical pin now checks the five-first ordering plus
the signal-gating of every default seat after them; the original
removeWhen stands.

Commits: a2dfab7 (fold), 8d213b6 (wave-brief reuse).
