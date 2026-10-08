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
4. TDD evidence: for every id in PLAN.md `tdd:` frontmatter, this phase's
   LEDGER.md line for that id must carry a `tdd <red>..<green>` segment.
   Any TDD task missing its pair → the phase FAILS verification — report
   which ids, do not write VERIFICATION.md.
   4b. Close evidence (phase 23): every issue in PLAN.md `issues:` must
   have a LEDGER.md line carrying an `evidence <command> => <result>`
   segment or a `waived <reason>` segment. A line with neither → the
   phase FAILS verification the same way — report which ids. Lines
   written before the gate existed (pre-phase-23 ledgers) are exempt
   only in phases already verified; a live phase re-verified after the
   gate is held to it.
   4c. Evidence-only lines (`- [ ] … evidence for <id> <date>`, written by
   `ledger_append kind: "evidence"`) are never closures — they don't
   satisfy 4/4b as the issue's closing line, and a closure line followed
   later by an evidence line for the SAME taskRef reads as NOT closed
   (the evidence line is its correction; `distill_manifest` lists it
   under `superseded`).
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
8. FAILED verification routes to `trace` — MANDATORY (#726): open a trace
   (`trace_start` with the failure as the description), log the failing
   output as the first `evidence`, and continue there. Never patch-and-
   rerun inline. Proven-obvious ≤3-line causes may take trace's fast lane —
   still traced, still mirrored, still closed on a logged repro (the
   failing command + output as the trace's first `test` entry).
