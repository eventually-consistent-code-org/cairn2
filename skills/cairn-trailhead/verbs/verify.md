---
verb: verify
args: "<N>"
status: live
---

Verify the given phase per the `cairn-planning` skill.

1. Goal-backward: re-read the phase's CONTEXT.md and PLAN.md; check the codebase
   delivers what the phase PROMISED, not merely that tasks closed. Run the test
   suite. Deep depth: adversarial verification subagent per the routing rubric.
2. `plan_drift()` — this phase must contribute nothing flagged. A
   `stale-audit` flag (the latest security audit predates code commits,
   or was recorded over a dirty tree) fails verification the same way:
   report its `detail` line first — "re-run `/cairn:audit security`" —
   then the commit it was stamped at. `stale-issue` and `stale-branch` do
   NOT fail verification: they describe work that went quiet elsewhere, not
   a claim this phase is making. Note them in the report and move on.
2b. Declared verification (phase 24.5): `plan_check(phase: <N>)` must
   report no `missing-verify` for this phase, and every ledger line's
   evidence should cite the command PLAN.md declared for that task. A
   mismatch is reported with both strings — what was promised, what was
   run — and judged, not auto-failed: a declaration that turned out to be
   the wrong check is a legitimate finding about the plan, as long as it
   is written down rather than quietly ignored.
3. `issue_list(phase: "<N>")` — no state filter: every issue it returns
   must have `category: "closed"`. Anything still `open` or `in_progress`
   (whatever its board state name) FAILS verification — report each
   straggler with its state instead of closing it unexamined.
4. Ledger gates: the same `plan_check` must report none of `tdd-missing`,
   `evidence-missing`, `closure-superseded` (the server reads LEDGER.md and
   owns the pre-phase-23 exemption). Any one → the phase FAILS
   verification — report each id and line, do not write VERIFICATION.md.
5. Write `.cairn/plans/phases/<NN-dir>/VERIFICATION.md`: what was checked, what
   passed, deviations. (Its presence marks the phase verified — drift treats
   closed issues in verified phases as normal.)
   Then `outlook_emit(tracker: {open, inProgress, blocked, nextVerb, asOf})`
   — verify has no continuity write of its own, so this is the moment the
   portfolio snapshot learns the phase went verified. Counts come from the
   `issue_list` calls this verb already made; `nextVerb` is the next step
   you are about to report; `asOf` today. Skip silently only if the emit
   tool errors — a snapshot problem never fails verification.
6. PASSING verification only: `docs_drift()` — report the flagged list as
   a docs-debt line ("docs owe entries for phases X, Y —
   `/cairn:distill <N>` generates them"). Report ONLY: verify never
   generates docs, and a docs_drift error never blocks the verification
   result — skip silently on error, same posture as the outlook emit
   above. Nothing flagged → one line: docs are current.
6b. Roadmap row (#184): once VERIFICATION.md exists, this phase's row in
   `.cairn/plans/roadmap.md` must read `verified` — the two surfaces
   make the same claim, and the roadmap is the one a reader actually
   opens. Confirm the row reads `verified`; if it still reads `planned`,
   repair it and say so in the report. Drift repairs the row on its own
   where it can, so the usual outcome here is a one-line confirmation
   and no edit at all — the step is the check, not the typing. A FAILED
   verification leaves the row alone: nothing about a failure is
   verified.
7. Report pass/fail and next step (`/cairn:ship` or the fixes needed).
8. FAILED verification routes to `trace` — MANDATORY (#726): one call,
   `trace_start(description: <the failure>, evidence: <the failing
   output>)` — the evidence is the first entry and the started comment
   posts itself — then continue there. Never patch-and-rerun inline.
   Proven-obvious ≤3-line causes may take trace's fast lane — still
   traced, still mirrored, still closed on a logged repro (the failing
   command + output as the trace's first `test` entry).
