---
verb: peers
args: "(none = status) | review [target] | plan <phase> | council [dimensions]"
status: live
---

Convene the external AI CLIs (codex, opencode, antigravity, grok) as
reviewers — a second (third, fourth) opinion on top of cairn's own
judgment, never a replacement for it. `peer_run` moves bytes to a peer and back; everything
below is the loop that decides what a peer's answer is actually worth.
**A peer saying something doesn't make it true** — every peer finding gets
verified against the code (or the plan) before it goes anywhere near the
tracker.

## Focus ask (before `review` or `plan` runs)

Before `review` or `plan` dispatches anything, ask ONE AskUserQuestion:
what should the peers focus on? Options are concrete candidates cairn
derives from the target (for `review`: the axes or hotspots the resolved
diff actually touches; for `plan`: the phase's stated goal and its riskiest
tasks), with "full pass — no particular focus" as the first, recommended
option; free text arrives via the built-in Other. The chosen focus is
woven verbatim into every peer prompt AND into cairn's own first pass, so
the whole run targets what the user cares about instead of a generic
sweep. One question, asked once per run — never re-asked between rounds,
never asked at all for bare `peers` (status is read-only). `council`
folds this ask into its dimension ask (below) — still one question, not
two.

## Run state (every dispatching mode)

A `review`/`plan`/`council` run is stateful so it survives interruption. At
dispatch — right after the focus ask — call `peer_state(op: "start")`
with the run's slug, mode, target, chosen focus, and the roster
`peer_list()` reported available. From there the store is the run's
memory, not the conversation: every `peer_run` reply lands via
`op: "record_output"` (verbatim, per peer per round), every
`parseFindings` result via `op: "record_findings"` (stable ids f1,
f2, ...), and every adversarial judgment via `op: "verdict"` —
`verified`, `dead`, `disputed`, or `open-disagreement` — the moment
it's made, never batched for later. `op: "close"` ends the run: it
refuses to close while any finding is still disputed or unjudged, and
its summary is the ONLY source for the `audit_record` findings —
provenance ("raised by <peer> round <n>; verdict <v>") assembles from
the records, never from what the conversation remembers. `start`
refuses a slug that already has an unfinished run — resume it (below)
or `op: "abandon"` it explicitly; nothing gets silently clobbered.

### Resuming an interrupted run

A run that died mid-flight (crash, `/clear`, timeout) resumes instead
of restarting: `peer_state(op: "status")` reports what's recorded and
what's missing — peers with no round-1 output, disputed findings whose
peer hasn't answered round 2, findings not yet at a final verdict.
Re-run only the missing pieces, recording as usual, then continue the
normal flow to `close`.

## Bare `peers` — status

`peer_list()` rendered plainly: each peer's provider, on PATH or not,
enabled or not, input cap, exec-capable or not, plus the run-wide
`maxConcurrent` fan-out budget. No workspace-wide judgment here, just the
facts a caller needs before deciding whether `review`/`plan`/`council`
will have anyone to talk to. Zero
peers on PATH is a normal result, not a warning — say so and stop; don't
suggest installing anything unasked.

## `peers review [target]`

1. Run cairn's own five-axis review FIRST, in full — same target
   resolution, same five axes, same finding discipline as the `review`
   verb. This is not optional and not skimmed: peers augment cairn's
   review, they don't stand in for it.
2. **Leak-scan the outbound content** (see below) before step 3 ever
   touches a peer.
3. For each peer `peer_list()` reports on PATH and enabled: `peer_run` with
   the ask built from the `findings-request` template
   (`templates/peers/findings-request.md`, filled via the server's
   `loadTemplate` — `focus` = the chosen focus verbatim, `dimension` = the
   axis this pass targets or "full pass", `content` = the leak-scanned
   diff). The template carries the whole structured contract — fenced-JSON
   findings matching the server's Finding schema — so nothing gets
   re-worded per run. Record each reply the moment it lands
   (`peer_state` `record_output`), then split it with `parseFindings`:
   validated `findings` plus verbatim `unparsed` leftovers — the
   `findings` pile goes straight into `record_findings`. Judge BOTH
   piles in step
   4 — off-schema prose in `unparsed` can still hold a real finding; it
   just arrives without the contract's guarantees. No peer on
   PATH → skip straight to step 6; that's proceed-without, not a stall.
4. Judge every peer finding adversarially against the actual code — not
   against what the peer says the code does. A peer claiming a bug that
   the code doesn't actually have is a finding that dies right here, never
   reaching the tracker. A peer surfacing something cairn's own pass
   missed is a real finding, provenance and all. Record each judgment
   as it's made (`peer_state` `verdict`): dies-right-here is `dead`, a
   verified survivor is `verified`, anything unsettled is `disputed`.
5. Converge: round 2 runs ONLY over material disagreements — a peer
   standing by a finding cairn's first pass disputed, or a peer citing
   something the round-1 verification didn't settle. Round-2 sends use the
   `round2-steelman` template (`templates/peers/round2-steelman.md`, same
   slots; `content` = the peer's disputed finding plus cairn's
   counter-read), which forces a verdict — concede, refute with NEW
   evidence, or stand by with stated confidence — instead of a free-form
   rehash. Hard cap at two
   rounds, no exceptions; a peer that still disagrees after round 2 gets
   noted as an open disagreement in the record, not a third round.
   Round-2 replies get `record_output` (round 2) like any other, and
   every disputed finding ends the round re-judged: `verified`, `dead`,
   or `open-disagreement`.
6. Survivors follow `review`'s exact closing discipline: `issue_create`
   with label `cairn:review`, severity as the literal first line, plain
   language a non-engineer could read cold. Add provenance the plain
   review never carries — which peer(s) raised it, which round it
   survived to.
7. `peer_state(op: "close")`, then `audit_record(scope:
   "peers-review-<slug>", verdict, findings)` with the verdict and
   findings exactly as close's summary returned them — `<slug>` follows
   `review`'s exact slugging rule (lowercase, collapse
   every run of non-`[a-z0-9]` to one hyphen), the same slug the run
   started under. Crediting provenance in the
   record is what makes this run distinguishable from a plain `review` —
   which peers ran, which rounds, what survived versus what got thrown
   out under adversarial check.

## `peers plan <phase>`

1. Leak-scan the phase's `PLAN.md` content (see below) before it goes to
   any peer.
2. For each available peer: `peer_run` with the plan content (cap-aware —
   a constrained peer gets truncated input, not a skipped run), asking for
   critique against the phase's stated goal. Same recording discipline
   as `review`: `record_output` per reply, `record_findings` for the
   parsed pile.
3. Judge each critique adversarially — verify it against the actual
   PLAN.md and phase context before it counts as material, same rule as
   `review`: a peer's opinion is a claim, not a finding, until checked.
   Record each verdict as it's made, same vocabulary as `review`.
4. Converge, same two-round hard cap as `review` — round 2 only for
   critiques cairn's own judgment disputed in round 1.
5. Material, verified critiques become plan edits directly when the call
   is unambiguous; route to a `cairn:audit` issue instead when the plan's
   owner should decide (a scope call, a tradeoff, anything opinionated
   enough that cairn shouldn't silently rewrite the plan out from under
   the person who wrote it). If a converged critique makes an already-open
   `cairn:audit` issue moot, `issue_comment` explaining why, then
   `issue_close` — a resolved question doesn't get to sit open.
6. `peer_state(op: "close")`, then `audit_record(scope:
   "peers-plan-<phase>", verdict, findings)` sourced from close's
   summary — `<phase>` is the phase number/slug as it appears in the
   routing table, same provenance requirement as `peers review`.

## `peers council [dimensions]`

The whole product on trial, not one diff: convene every available peer
as a review council across up to four dimensions — code, functionality,
look-and-feel, market — and end with ONE report whose recommendations
go through the shared gate in `references/proposal-gate.md`. NOTHING
mutates before that gate, in any mode.

1. Dimension ask — council's version of the focus ask: ONE
   AskUserQuestion, multiSelect — `code`, `functionality`,
   `look-and-feel`, `market`. `code` is the existing `review` flow's
   axes folded in as one dimension of the council. Free text via the
   built-in Other becomes the run's focus, woven verbatim into every
   packet; no free text = "full pass — no particular focus". Dimensions
   passed as args skip the question entirely. One question, once per
   run — never re-asked between rounds.
2. Read the `## Dispositions` table at the tail of
   `.cairn/plans/COUNCIL.md` BEFORE anything dispatches. Every rejected
   entry goes into every outbound packet as "previously considered and
   declined — do not re-raise without new evidence"; a peer re-asserting
   one bare dies in round-1 adjudication.
3. Build the evidence packets — main thread, ONCE per dimension, before
   any send:
   - **functionality** — README + verb docs (the promise) plus 1–2
     captured verb-run transcripts (the delivery).
   - **look-and-feel** — 3–5 transcripts spanning happy, error, and
     multi-step paths, plus the tracker bodies those runs produced.
   - **market** — a short positioning brief written from
     PROJECT.md/README plus a competitor shortlist (seed: Cursor,
     Aider, Devin, Copilot Workspace, OpenHands, Continue — peers may
     know others; their knowledge is dated by their training cutoff).
   - **code** — the resolved diff, exactly as `peers review` builds it.
   Cap-trim every packet BEFORE send (peer input caps apply, per peer),
   and pass each through the outbound leak gate (below) — a hit blocks
   that packet's sends, full stop. The packet is ALL a peer gets: peers
   run contained by default (`peer_run` stages the packet in a throwaway
   scratch dir and runs the child from there), so nothing outside the
   packet is readable.
4. `peer_state(op: "start")` with slug `council-<YYYY-MM-DD>`, mode,
   the chosen dimensions + focus, and the `peer_list()` roster. Mirror:
   `issue_create` ONE run issue — title "Product council:
   <dimensions>", label `cairn:council` — plain language per the mirror
   rules below.
5. Fan-out, per dimension: every peer `peer_list()` reports on PATH and
   enabled gets `peer_run` — dispatched in batches of at most the
   `maxConcurrent` budget `peer_list()` returns, never all seats at
   once; a batch finishes before the next one starts. This is a hard
   rule because it already failed live: the 2026-08-12 council dispatched
   all 16 seats concurrently and exhausted the host's memory. Each send
   uses the dimension's template filled via
   `loadTemplate` (`templates/peers/council-functionality.md`,
   `council-feel.md`, `council-market.md`; `code` reuses
   `findings-request.md`) — `focus` = the run's focus, `dimension` =
   the dimension name, `content` = the packet. Functionality only: a
   peer whose `peer_list()` entry says `execCapable` may be told it can
   run the product itself — and ONLY that peer, on ONLY this dimension,
   gets `peer_run` with `cwdMode: "project"` (repo cwd access is exactly
   what the trust flag grants); every other peer runs contained (the
   scratch-cwd default) and judges the captured transcripts instead —
   never skipped, and exec is never granted implicitly. The server holds
   the trust half of that line: `peer_run` refuses `cwdMode: "project"`
   with `PRECONDITION_FAILED` for any peer `cairn.json` doesn't mark
   `execCapable`, so a refusal there means the roster read was wrong,
   not that the flag needs flipping — only the user grants it. The
   dimension half (functionality only) is still this verb's call.
   Record as replies land, `review`'s exact discipline:
   `record_output`, then `parseFindings`, then `record_findings` —
   judge the `unparsed` pile too. No peers at all → the absent-peers
   rule below: cairn's own pass still writes the report.
6. Converge: cluster near-duplicate claims across peers by topic. 3+
   peers independently raising a claim = converged; a single-peer claim
   stands or falls on its evidence (the templates' evidence-or-discarded
   rule is the floor). Adjudicate every claim against the actual
   artifacts — the docs, the transcripts, spot-checkable competitor
   facts; one peer's stale training data is a claim, not evidence.
   Record verdicts as they're made, `review`'s vocabulary. Round 2 ONLY
   for material disagreement — a severity gap of more than one tier, or
   mutually exclusive recommendations — using `round2-steelman`
   (`content` = the disputed claim plus the counter-read). Hard
   two-round cap; still disputed after round 2 = `open-disagreement` in
   state, never a round 3.
7. Write the report — `.cairn/plans/COUNCIL.md`, same epoch convention
   as survey's artifact: a `# Council — <YYYY-MM-DD>` header opens each
   run's block, newest first; prior blocks are read-only history. Per
   dimension, a `##` section carrying `<!-- council: done -->` or
   `<!-- council: pending -->` on the line after the heading
   (server-validated via `research_sections`, namespace `council`),
   holding the peers' dimension scores and the converged findings;
   `issue_comment` a progress note on the run issue as each dimension
   converges. Then the typed recommendations — `REC-N` blocks, each
   carrying: dimension(s), convergence verdict (which peers, which
   round), exactly ONE proposal shape from
   `references/proposal-gate.md`, a rough effort, `status: proposed`. A
   recommendation that can't be typed stays in its dimension section as
   research — untyped never reaches the gate. The persistent
   `## Dispositions` table sits at the file tail, below every run
   block, and survives across runs.
8. The gate: run `references/proposal-gate.md` over the `REC-N` blocks
   exactly as specified — ONE batched AskUserQuestion (holds in vibe
   mode), apply mechanics per the spec. ACCEPTED recommendations only:
   `issue_create` per REC, label `cairn:council`. Update
   `## Dispositions` with every REC's verdict + a one-line why, then
   close the loop on the tracker: a closing comment on the run issue
   enumerating every REC's disposition, one line each.
9. `peer_state(op: "close")`, then `audit_record(scope:
   "peers-council-<slug>", verdict, findings)` from close's summary —
   provenance assembled from the records, `review`'s rule. `mem_index`
   the finished run block (source: the COUNCIL.md path).

An interrupted council resumes like any run (`op: "status"` names
what's missing) — but resume completes PENDING dimensions only: the
COUNCIL.md markers and the run state agree on what's done, and a `done`
dimension never re-dispatches.

## Outbound leak gate (hard rule)

Peer input is code or plan content leaving this machine for an external
CLI. Before EVERY `peer_run` call, in any mode above, scan the exact
content about to go out against the leak patterns
(`hooks/scripts/leak-patterns.mjs` — the same source the commit-time leak
guard and `distill`'s scrubbing gate consume, applied here to outbound peer
input instead of a git diff). A hit STOPS the send: name the matching
lines to the user and let them decide whether to redact and retry or skip
that peer entirely. This is never a soft warning that gets sent anyway —
a hit blocks that `peer_run` call, full stop, until the user says
otherwise.

The server enforces the same rule, so the gate no longer rests on this
step being remembered: `peer_run` scans the capped input — the exact
bytes the child would get — with its own port of those patterns
(honouring `leakGuard.enabled` and `extraPatterns`) before anything
spawns. A hit refuses the call with `PRECONDITION_FAILED` naming the hit
kinds and line numbers, never the matched text, and nothing is sent.
Treat that refusal exactly like a hit of your own: take it to the user
— redact and retry, or skip that peer — and never reword content just
to slip it past the scan. Know the limits: the built-in patterns cover
planning paths, phase refs, cairn labels and Jira-style tracker ids;
credentials are caught only by patterns the user adds to
`leakGuard.extraPatterns`.

Containment backs the gate from the other side: `peer_run` runs every
peer from a throwaway scratch dir by default, so a peer can no longer
read around the screened packet via the project cwd — the gate decides
what goes out, and the scratch cwd guarantees nothing else is
reachable.

## Absent peers

Zero peers on PATH, or every peer disabled in `cairn.json`, is a normal
outcome: proceed with cairn's own review/plan/council judgment alone, say
plainly that no peers were available, and record the run exactly as
usual. A missing external CLI NEVER blocks any mode from completing —
peers are an augmentation, and the verb's job is to degrade gracefully to
"cairn reviewed this alone" rather than stall waiting on a CLI nobody
installed.

## Mirror rules

Same discipline as `review`, `audit`, `trace`, `triage`, and `basecamp`:
every `issue_create`/`issue_comment` body is plain language, no code
blocks, no file paths, no internal refs a non-engineer would bounce off
of. Peer names and round numbers are fine in the tracker body (provenance,
not internals) — file:line and the verification detail stay in the
`audit_record`, same audience split `review` already draws.
