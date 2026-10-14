---
verb: review
args: "[target] | --seat <name> [target] | --fix"
status: live
---

Five-axis code review of a diff, branch, or phase — a fresh read against
the code as it stands, not a retro-check against old claims (that's
`audit`). Every review closes the same way: a record, then tracker issues
for anything that matters.

## Target resolution

| target | resolves to |
|---|---|
| (none) | the working diff — `git diff` plus whatever's staged |
| a branch name | the range between that branch and `main` |
| a phase number | that phase's ledgered commit ranges (read `LEDGER.md` for the phase — the base/head commits recorded there, not a guess at the range) |

No target means the working diff, full stop — don't go hunting for a
"more interesting" target when the caller didn't name one.

## The panel — the axes come from the roster

Call `seat_roster` once at dispatch: the valid seats, in roster order,
ARE the review panel — the axes are not hardcoded in this file. One
framing line to keep straight: internal seats are framing lenses —
cheap, same-model; `peers` remains the genuinely adversarial external
council. There is exactly one review path, and this is it. The panel
convenes the roster's review-stage seats (`stage` review or `any`);
plan-stage seats convene at plan time instead (`plan`'s challenge
round) and never join the diff panel.

With no project seats and no `seats` config block, the review-stage
roster is exactly the five shipped defaults, in this order — today's
review, byte for byte:

| seat | what it's looking for |
|---|---|
| correctness | logic errors, wrong edge-case handling, off-by-ones, state that can drift out of sync |
| clarity | code a future reader (or agent) will misread — misleading names, buried intent, comments that lie |
| architecture | the wrong layer doing the work, coupling that will bite the next change, reuse that got skipped |
| security | injection, auth gaps, secrets in the diff, trust boundaries crossed without a check |
| tests | claims the diff makes that nothing verifies — new behavior with no test, a test that can't actually fail |

A project-added seat (`.cairn/roles/*.md`) joins the panel where the
roster puts it, same rules as every default. A seat disabled in
`cairn.json` sits out with exactly one line in the record
("`<name>`: disabled by config — sat out"); an invalid seat file
likewise gets its roster note echoed as one line. Never silently shrink
the panel — the record shows every seat, seated or not.

**Dispatch — which seats fire this pass.** The dial defaults to `auto`;
`off` is the explicit opt-in that fires the full panel exactly as above
on every pass (`"seats": { "dispatch": "off" }` in cairn.json). On
`auto`, derive scope signals
from the resolved diff per the standard vocabulary (`touches-auth`,
`touches-server`, `touches-docs`, `touches-tests`, `touches-config`,
`touches-ci`, `touches-scripts` from paths; `diff-small` under 50
changed lines, `diff-large` over 500 — the tested rules live in
`server/src/seats/signals.ts`) and seat only the seats whose declared
`signals` intersect the derived set. A seat declaring NO signals always
fires — declaring signals is how a seat opts into gating. Auto also
consults the per-seat yield store (`~/.cairn/yield/`, written after each
pass: per seat +1 dispatched plus its raised finding count — the
SURVIVING count is credited by the server when `audit_record` judges
the panel, never by the pass itself):
a seat with ten or more dispatches and fewer than one surviving finding
per ten gets gated on that evidence — never the security seat, never a
dose-`full` seat. `inherit` follows cairn.json `seats.dispatch`
(`seat_roster` returns the resolved value; absent means auto). A young
project has no yield history yet — the store needs ten dispatches per
seat before low-yield gating can act, so until then only the signal
rule gates. Every gated seat lands in
the record in ONE report line, never silently:
"seats gated this pass: X (no matching signals), Y (low yield)".
Custom signal names a project seat declares beyond the standard
vocabulary never fire this iteration — nothing derives them yet, so on
`auto` such a seat needs at least one standard signal (or none at all)
to keep its chair.

Walk the resolved diff against each seat's lens. A clean seat is still
worth a line in the record ("no findings") — silence isn't the same as
checked.

**Anchored score, beside the verdict — never a gate.** Each seat also
reports a 0-10 score on its own scale. A seat is a judgment gate in the
cairn-planning rubric: dispatch it at `effort: high`. At dispatch, quote the seat's
anchors (`anchor_ten` / `anchor_five` / `anchor_zero`) and its honesty
line verbatim from the definition file — defaults under
`templates/seats/`, project seats under `.cairn/roles/` (`seat_roster`
names each seat's source). The score lands beside that seat's findings
and the overall verdict in the record, and that's all it does: no
threshold hangs off it, no pass/fail derives from it, no finding gets
upgraded or downgraded because of it. When the seat's honesty line
applies — the evidence wasn't actually read — report `unscored`; an
invented number is worse than none.

Findings keep today's shape exactly. Every finding gets ranked
**critical**, **important**, or **minor**, and every finding names a
`file:line` and a concrete failure scenario — not "this could be a
problem" but the actual input or sequence that breaks it. A finding
without a scenario is a hunch, not a finding; downgrade it or cut it
before it goes in the record. The scenario is a typed field, not a
prose nicety: every finding handed to the dedup engine carries
`failure_scenario`, and `audit_record` REFUSES a finding without one
(`PRECONDITION_FAILED`) — the record enforces the bar, the seat states
the scenario. Two seats whose claims differ but whose scenarios match
dedup as one finding (same failure, different headline).

## `--seat <name> [target]` — consult one seat

A single-seat advisory pass — "ask the security seat about the auth
change" — not a smaller panel. Same framing line as the panel: internal
seats are framing lenses — cheap, same-model; `peers` remains the
genuinely adversarial external council.

**Resolve the seat.** Call `seat_roster` and match `<name>` against the
valid seats at ANY stage — consultation ignores the stage filter on
purpose (you can ask the plan-stage interrogation seat about a diff; a
question is not a panel). An unknown name is a human-first error: one
plain line naming what was asked for, then the roster's valid seat
names so the caller can re-aim — never a raw payload.

**Warm the seat up.** Compose the seat's framing at its declared dose
(same composition as the panel and the wave briefs —
`composeBrief` in `server/src/seats/brief.ts` is the tested reference).
The brief's roleCards come from the seat's own memory:
`mem_card_recall(scopeRole: "<seat name>")` — the staleness-checked
form of `mem_card_list` — so the "what this seat remembers" section
renders each card with its date and confidence, and a card whose
provenance has rotted arrives marked STALE rather than trusted.

**Run the pass over the target.** Consultation takes a wider target
set than the panel: a diff (the panel's table above applies), a file
path, a plan doc, or a freeform question with no artifact at all.
Resolve whatever was given and read it through the seat's lens —
categories, anchors, honesty line, all at the declared dose.

**Answer conversationally.** The output is a conversation, not a
record: what the seat sees, what it would push on, in plain prose. No
per-seat table, no verdict block. The anchored score is optional here —
quote it only if it sharpens the answer.

**Findings still ride the one path.** A finding that clears the
severity bar (critical or important, with a `file:line` and a concrete
failure scenario) goes through the EXISTING closing discipline below —
dedup first, then `issue_create` with the same label, severity line,
and mirror rules as any panel finding. Consultation never grows a
parallel tracker path. Below-bar observations stay in the conversation;
that's what the conversation is for.

**Write the seat's memory back.** A notable outcome — a real
recommendation the caller acted on, a risk the seat caught — becomes
ONE card via `mem_card_create` with `scopeRole` = the seat's name, so
the seat arrives warmer next time. One card, not a transcript: distill
the takeaway. A consultation that surfaced nothing durable writes
nothing.

## Closing discipline — every review, no exceptions

**Dedup first — before severity ranking, before any `issue_create`.**
When more than one seat walked the target, collapse the combined finding
list through the dedup engine (`dedupFindings` in
`server/src/seats/dedup.ts` — run it via `node` against dist; it's a
pure library, no tool call). Same file, within ±2 lines, same claim by
normalized-token overlap → one finding crediting every raising seat,
keeping the highest severity and each seat's score. Distinct claims at
the same location stay separate. Each tracker-bound finding then names
its crediting seats in plain language in the body — "raised by the
security and correctness seats" — and N seats over one bug NEVER means
N issues: the tracker sees the deduplicated set only.

**Refutation panel — verify before the tracker.** A finding reaches the
tracker only after someone tried to disprove it. For each deduped
finding rated **critical** or **important**, dispatch a bounded
read-only verifier: one lens normally; two or three (correctness plus
security, plus the raising seat when it's neither) when the scope is
`security-*`. Effort scales how much the verifier may read, never how
many verifiers there are — the panel never thins. The verifier's brief
is the finding as recorded (file:line, claim, `failure_scenario`) and
one charge: reproduce the scenario against the code as it stands, and
vote. Default vote is **REFUTED** — evidence moves it, absence of
counter-evidence does not: `CONFIRMED` (the scenario reproduces, here's
where), `PLAUSIBLE` (couldn't prove or disprove — say what's missing),
`REFUTED` (the scenario cannot happen — here's the guard/path that
prevents it). Each vote is `{seat, verdict, evidence}`. Minor findings
skip the panel. With no critical/important findings this step does
nothing and the flow is exactly today's.

1. `audit_record(scope: "review-<target>", verdict, findings)` — every
   review ends here, clean or not, and it comes BEFORE any
   `issue_create`: each finding carries its `failure_scenario`, its
   `seats` (dedup's credit list), and — critical/important — its
   `panel` votes; the server computes the quorum (a REFUTED strict
   majority kills the finding; ties survive as plausible) and refuses a
   critical/important finding with no panel. The result's
   `results[].survived` is the filing list. `<target>` is whatever
   resolved above (`working`, the branch name, or `<phase>`). Before
   using it in the scope, slug the target — lowercase it and collapse
   every run of characters outside `[a-z0-9]` to a single hyphen (e.g.,
   `feature/ABC-123` becomes `feature-abc-123`, `HEAD~3` becomes
   `head-3`). A clean pass is still a finding worth recording — it's the
   proof the review ran.
2. For each SURVIVING finding rated **critical** or **important**:
   `issue_create` with label `cairn:review`, the severity as the literal
   first line of the body (`Critical: …` / `Important: …`), plain
   language a non-engineer could read cold — the scenario, not the
   stack trace. A refuted finding is never filed — it stays in the
   record with its votes, and the report says so in one line: "panel:
   N confirmed, N plausible, N refuted (not filed)".
3. **Minor** findings stay in the review record only. The record already
   has them; a tracker full of minors is a tracker nobody reads.

Skipping the record because the diff looked fine is still skipping it.

## `--fix`

Only after the record exists and the critical/important issues are filed.
Same contract as `audit` — two shapes, and only two:

- **Mechanical** (the fix is obvious and small — a missing null check, a
  wrong comparison, a test that should've existed): STAGED, never applied
  on the verb's own say-so — follow `audit`'s staged-patch discipline
  verbatim (dirty tree refused; detached scratch worktree; one patch
  file per finding mirrored to its issue; one independent verifier
  stating `targeted` / `no_new_issue` / `behavior_unchanged`; the
  record's `results[].applyEligible` decides what may be offered; apply
  only on the user's choice, one commit per finding, `issue_comment` +
  `issue_close`; worktree torn down after).
- **Investigation-shaped** (the fix isn't obvious, or touches more than
  the finding itself): open `trace_start` instead and hand it off — don't
  guess at a fix under review's roof.

Never an improvised inline fix for anything in between. Not clearly
mechanical means investigation-shaped by default — that's the safe side
to be wrong on. No `--fix` flag → nothing here runs.

## Mirror rules

Same discipline as `audit` and `trace`: plain language, no code blocks, no
file paths, no internal refs a non-engineer would bounce off of, on
everything that lands on the tracker. `file:line` and the failure scenario
belong in the review record, not the issue body — the record is for
engineers re-deriving the fix, the issue is for a manager triaging by
severity. The severity-first-line rule is the one place those two
audiences meet: it's the first thing both of them read.
