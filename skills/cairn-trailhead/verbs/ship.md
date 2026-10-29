---
verb: ship
args: ""
status: live
---

Pre-ship gate, then ship:

1. `plan_drift()` — anything flagged: **stop** and report; do not push.
   The two exceptions are `stale-issue` and `stale-branch`, which are
   advisory: mention them in one line each with the rest of the summary and
   carry on. Forgotten work is worth seeing, never a reason to block a good
   push.
   A `stale-audit` flag means the latest security audit no longer
   describes HEAD (written over a dirty tree, or code commits landed
   since its stamp): lead with its `detail` line — "re-run
   `/cairn:audit security`" — the code and commit second.
2. `plan_status()` — every phase with VERIFICATION.md must show all its issues
   closed (`issue_get` spot-check); report any still open and stop.
   Roadmap rows ride along with that sweep: a phase holding a
   VERIFICATION.md whose `roadmap.md` row still reads `planned` is a
   stale row, not a failed gate — repair it with the plan-doc commit in
   step 5 and name it in the push summary. Ship never flips a row to
   `shipped (v<N>)`; a phase that pushed is still a phase `verified`,
   and the shipped flip belongs to `summit` at the milestone archive.
3. Engineer mode only (`user.mode: engineer` in cairn.json): no
   cairn-authored PR may still be awaiting human review — list any that
   are and stop. Human review is the merge gate; ship never overrides it.
4. Docs catch-up (repo-local tier, gates passed, BEFORE the push
   confirmation): `docs_drift()` — for each verified phase being shipped
   that it flags, run the per-phase distill sequence (`distill <N>` in
   verbs/distill.md: CHANGELOG entry, that phase's ADRs, marked
   ARCHITECTURE sections via the section writer) and commit the generated
   docs (`docs(distill): …`). The leak-pattern gate stays mandatory —
   distill's own scan-until-clean rule applies unchanged — but distill's
   diff confirmation MERGES into step 5's push question: ONE question
   total, never a second ask. Advisory: any docs-generation failure
   (drift report or distill) is reported and skipped — it never blocks
   a good push.
5. Clean gate → commit outstanding plan-doc changes, then confirm before
   pushing: render a one-line summary of exactly what's about to happen —
   `N commits → origin/<branch>`, now including the generated-docs diff
   summary from step 4 (files, sections touched, ADR titles), plus any
   tracker mutations the gate itself performed (reassignments, ledger
   repairs) — and ask ONE AskUserQuestion
   (push / hold). Push only on "push"; on "hold", stop and report.
   Any commit made after step 1 (plan docs, step-4 distill) moves HEAD
   past the drift stamp the run guard checks, so re-run `plan_drift()`
   just before the push — anything newly flagged stops the ship.
   A rejected push (origin moved) merges `origin/main`, never rebases —
   the ledger cites shas. BEFORE that merge, run `node
   scripts/lib/merge-overlap.mjs HEAD origin/main` and lead the merge
   message and the tracker note with its line (`overlap: 3 files — a, b,
   c` or `overlap: none`); overlap names the files before the tree
   changes (asserted by sweep-surface.test.ts, #223).
   `ship.confirm: false` in cairn.json skips the ask (silent flow).
   After the push: `outlook_emit(tracker: {open, inProgress, blocked,
   nextVerb, asOf})` FIRST — the snapshot outlives the handoff, so the
   board still knows where this project stands after the session state is
   wiped — then `continuity_clear()` (shipping ends the session), and
   (if the project uses PRs) offer to open/update one.

   > Provenance: adopted from the 2026-08-12 product council (REC-5),
   > accepted by the project owner over cairn's no-action recommendation.
   > Vibe mode's silent-judgment rule explicitly does NOT apply to this ask.

Never push with flagged drift or open issues on a verified phase. The run
guard enforces the drift half: an agent push to the default branch is
refused unless the last `plan_drift()` came back clean for that exact
commit; the open-issues half is still this verb's job.
