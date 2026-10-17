# Context economy layer — design

Date: 2026-09-20
Status: approved design, not yet planned
Supersedes: the proposals in `~/repos/claude-cache/HANDOFF-cairn-cache-layer.md`
Measurement: `~/repos/claude-cache/MEASUREMENT-step1-transcripts.md`

## Outcome

Cut the context a session holds, and the number of turns that hold it, without
degrading output quality. Target: 50% reduction in cache_read tokens per unit
of delivered work, held against leading indicators until the per-work-item
baseline is real.

## What the measurement changed

The handoff proposed three things: a local MoE pre-digest (C), a local peer
plus vector retrieval (A), and a deterministic tool-output cache (B). Step-1
instrumentation of 410 transcripts / 400 sessions / 28,176 API turns does not
support any of them as the primary lever.

**Subagent fan-out is not the problem — it is the best compression already in
use.** Sidechains are 60% of turns and 26% of cache_read: ~3.4x cheaper per
turn than the main thread. Policy should push work *into* subagents.

**Cost is session shape, not careless reads.** Median `Read` result is 878
tokens; p90 is 3,259; exactly one read in 1,346 exceeded 100k. A local digest
compresses individual reads, and there is nothing in a median read to
compress. The money is thousands of small items entering early and never
leaving: 76% of tool_result residency is created in the first 40% of a session.

**63% of all cache_read is spent above 300k of context.** No cache, digest, or
retrieval change touches that number.

**Vector retrieval solves an unobserved problem.** The "lexical miss → read the
whole file" failure the handoff predicts does not appear in the data.

Arithmetic ceiling of the three original proposals combined: roughly 19%. They
cannot reach the target.

## The harness constraints that decide the design

Verified against the Claude Code 2.1.267 binary:

- `updatedInput` is supported — **a PreToolUse hook can rewrite tool input.**
- `updatedOutput` does not exist — **nothing can rewrite or evict a tool
  result.** Eviction is not available to cairn at any hook.
- The harness already evicts: `tengu_time_based_microcompact`, a `keepRecent`
  policy, and the literal `[Old tool result content cleared]`. It triggers on
  `context_hint` — a server-side signal that the context window is nearly full.
- **The eviction threshold is configurable.** `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
  moves the percentage of the window at which auto-compact fires;
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` sets the window the client assumes, and the
  harness states plainly that "auto-compact keeps this session within N tokens
  (the context window it assumes)". Settings-level equivalents exist as
  `autoCompactThreshold` and `isAutoCompactEnabled`.
- Adjacent knobs worth knowing: `CLAUDE_CODE_SUBAGENT_MODEL` (sidechains are
  60% of turns), `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, and
  `CLAUDE_CONTEXT_COLLAPSE` / `CLAUDE_CONTEXT_COLLAPSE_MODEL` — a
  harness-native form of the local-digest idea the handoff proposed.
- The harness already computes the residency breakdown this design set out to
  re-derive: `messageBreakdown: {toolCallTokens, toolResultTokens,
  attachmentTokens, assistantMessageTokens, userMessageTokens,
  redirectedContextTokens, unattributedTokens}`.

The keystone: **cost-optimal eviction and window-safety eviction are different
policies, and the shipped default is the second one.** The harness protects the
window, not the wallet. It intervenes around 900k; 63% of spend happens above
300k. The gap between those two numbers is the whole opportunity — and it is
closed by configuration, not by code.

Cairn cannot evict. But it does not need to: it needs to own the threshold,
per project and per verb, and measure what moving it costs in quality.

### Simulated effect of moving the threshold

Replaying every recorded session's per-turn context growth under a policy that
compacts at T and resumes at prefix + 20k:

| T | rent | saving | compactions across 400 sessions | avg ctx |
|---|---|---|---|---|
| 150k | 2.85B | 56% | 244 | 101k |
| 200k | 3.27B | **50%** | 97 | 116k |
| 300k | 3.92B | 40% | 36 | 139k |
| 400k | 4.42B | 32% | 24 | 156k |
| 500k | 4.88B | 25% | 14 | 172k |

Baseline average context is 229k. In the longest sessions, T=200k is one
compaction every 217-436 turns.

The result is robust to re-reading. Modelling a penalty where the agent pulls
back a fraction p of the dropped context over the following 40 turns:

| T | p=0% | p=30% | p=50% | p=100% |
|---|---|---|---|---|
| 200k | 51% | 49% | 49% | 50% |
| 300k | 41% | 38% | 37% | 40% |

At T=200k the saving holds near 50% even if the agent re-reads everything it
lost. **Residency duration dominates byte count**: a re-read byte lives ~40
turns and is dropped again, where the same byte in the baseline stays resident
for thousands of turns. That single sentence is the most useful thing this
measurement produced.

### What the knob cannot do

It is global and static. It cannot know that a survey should run lean while a
refactor needs the tree in view, and it cannot tell whether a compaction
boundary cost anything. Compaction is lossy: ten summarizations in a
2,500-turn session accumulate drift that no simulation here models. And
`MAX_CONTEXT_TOKENS` is off-label for this purpose — the harness frames it as
declaring an unknown model's true window. `AUTOCOMPACT_PCT_OVERRIDE` is the
cleaner instrument.

So cairn's job is not a turnover protocol. It is to **own the threshold per
project and per verb, and measure quality across compaction boundaries** —
which nothing does today, and which is the only evidence that can say whether
200k is free or expensive.

## Section 1 — the metric

**Rent** is the primary series: `cache_read` tokens. That is the measured
97.4% term; everything else is rounding. It is what a session pays per turn
for bytes it already bought.

**Two faces, one collection path.**

- *Quota face* — raw tokens per work item. Correct under a subscription, where
  dollars are fiction.
- *Money face* — the same tokens priced through the existing `PRICES` table in
  `stop-costtracker.mjs`, labelled notional. Correct for API-billed users of
  the plugin, who are most of them.

**Denominator.** Not the active-context tag. Across the whole recorded history
only 7 of 33 sessions carry an issue tag, 24 are untagged and carry 45% of
spend, and 4 distinct issues appear in total. Work is counted instead from
durable timestamped facts:

- primary: tracker issues closed within the session's time span
- secondary: commits landed in the repo within that span
- deduped where a commit closes an issue

This is derivable retroactively over the full history, so the baseline exists
the day it ships rather than 30 days later.

**Primary KPI:** rent per closed work item, 30-day trailing.

**Leading indicators**, with today's baseline:

| Indicator | Baseline |
|---|---|
| avg context per turn | 229k |
| share of rent spent above 300k context | 63% |
| prefix size | p50 32.5k historical; 79.7k observed today |
| sidechain cost advantage | 3.4x cheaper per turn |
| superseded + duplicate residency | ~9% of tool_result residency |

The 50% target is held against these indicators until attribution produces a
real per-work-item baseline. The indicators are trustworthy today; the KPI is
not.

## Section 2 — architecture and components

### A finding in cairn's own house

`scripts/check-footprint.mjs` reports 2,264 tokens resident and passes with 36
to spare. Cairn's 86 MCP tool schemas are **11,396 estimated tokens** —
descriptions 4,819, schemas 5,388, plus envelope. Real resident cost is
~13,660 tokens. The guard counts the slash-listing descriptions and excludes
on-demand bodies, but tool schemas are neither: they are resident on every
turn of every session, and they are 83% of cairn's real rent. The guard
watches the small half and reports clean.

### Placement

New `server/src/context/` sibling module; hooks extend what already exists.

**The layer pays its own rent.** It adds exactly one MCP tool
(`context_meter`, ~100 tokens). Everything else lives in hook scripts and
repo scripts, which cost nothing resident. A context-cost layer that ships six
new tool schemas has spent its own savings before it starts.

### Components

**1. Meter.** Extends `hooks/scripts/stop-costtracker.mjs`, which already makes
one forward pass over the transcript per Stop, throttled at 30s. Residency
accounting rides that same pass — no new hook, no second pass. New row fields:
per-producer residency, band histogram, prefix size, turn count, average
context.

**2. Attribution.** `server/src/context/attribution.ts`. A reporting-time join,
not a hook: session span → issues closed + commits landed. Depends on no tags,
and runs retroactively.

**3. Band signal.** Two channels, deliberately asymmetric:

- *statusline*, for the human: live context and band, **zero context cost**
- *`additionalContext`*, for the agent: only at a band crossing, once per band
  per session, at most two lines

Bands at 150k / 300k / 500k, taken from the measured distribution.

**A plugin cannot provide a statusline.** The harness's capability table admits
hooks, skills, agents and MCP servers from a plugin, but `statusLine` only from
user or project settings. So the free channel is opt-in: `/cairn:tune` offers
to write it into the user's settings, and never writes it unasked. The agent
channel must therefore stand alone and carry the signal by itself wherever the
statusline is absent, which is the default.

**4. Threshold management** (replaces the turnover protocol of the first
draft). Cairn owns the auto-compact threshold per project and per verb, via
`/cairn:tune`, and measures what it costs. Three parts:

- a recommended threshold written into the project's configuration, defaulting
  to T=200k on the simulation above, with per-verb overrides where a verb
  genuinely needs breadth
- **a compaction artifact contract.** Setting a threshold without defining
  what a good compaction *contains* is half a design. Borrowed from Writer's
  harness (see Prior art), a checkpoint carries four typed artifacts:
  durable memory (decisions, constraints, and **rejected approaches** — the
  most commonly lost and most expensive to rediscover), a summary written for
  resumability (current state, files touched, errors, next steps), the user's
  requirements preserved **verbatim**, and skill references. Each checkpoint
  folds the previous one forward so cost stays incremental.

  Two rules carry most of the value. Summarization runs on a **cheaper helper
  model** off the paying loop — `CLAUDE_CONTEXT_COLLAPSE_MODEL` is the harness
  knob for exactly this. And **a degraded or empty summary aborts the
  compaction** rather than persisting it: a bad checkpoint is worse than no
  checkpoint, because the context it replaced is already gone.

  Cairn has most of this vocabulary already — `continuity_checkpoint`, memory
  cards, `distill`. What it lacks is the contract and the abort rule.
- **compaction-boundary quality measurement** — the piece nothing does today,
  and it measures in **both** directions (see the risk section). Detect each
  boundary, then look for symptoms of a bad one: a re-read of a file that was
  resident before the boundary, a repeated question, a contradicted decision.
  Without this the threshold is a guess.
- the existing `continuity_checkpoint` and `waypoint` remain the manual path
  for a deliberate hand-off; they are no longer load-bearing for cost.

For delegated work, a genuine per-task budget is buildable today: `--resume`,
`--fork-session`, `--session-id` and the SDK control protocol all exist, and
`server/src/peers/run.ts` already spawns external CLIs through `execFile`. A
cairn-supervised `claude` child with its own context budget is a later phase,
not part of this one.

**5. Context guard.** `hooks/scripts/pretooluse-contextguard.mjs`. The only
enforcing component. See section 3.

**6. Footprint audit.** Closes the blind spot above: `check-footprint.mjs`
grows to count MCP tool schemas, with the budget re-pinned at the true figure
and enforced in CI; plus a report-only machine-wide mode ranking every
installed plugin by resident cost. That is what makes a 79.7k prefix
actionable, and most of that prefix belongs to plugins other than cairn.

The remedy for cairn's own 11,396 tokens is **progressive disclosure applied
to tool schemas**. Skill bodies already load on demand — that lazy split is the
design `check-footprint` exists to protect — but tool schemas do not. The
harness supports deferred tools (`deferredBuiltinTools`, resolved on demand via
tool search), so rarely-used verbs' tools can leave the resident prefix and
load when called. A tool count of 86 is not the problem; 86 *resident* schemas
is.

**7. Subagent report cap and sidecar.** Sidechains are 60% of turns and 26% of
rent — the cheapest place work can happen. The one channel where that cost
re-enters the parent is the report. Cap it (Writer uses 8KB), write the detail
to a file the parent reads only on demand, and depth-cap delegation so
delegated exploration cannot inflate the parent loop. Cairn already measures
`report_bytes` under #176 and caps nothing; this turns that measurement into a
control.

**8. Bounded refinement loops.** Review and reflection loops are the largest
single source of waste in multi-agent systems, and growth is quadratic — a
10-cycle self-critique loop can burn ~50x a single pass. Published results put
runtime supervision at ~30% savings and dynamic turn limits at 24%, both at
comparable quality.

Cairn's `peers`, `review`, `audit` and `verify` are exactly these loops. ADR
0008 caps budget at phase and wave boundaries, but nothing caps *iterations*.
Each loop gets a maximum turn count, a **minimum-improvement stop rule**
(if an iteration does not measurably improve correctness or completeness, stop
rather than spend another pass), and an explicit handoff condition when the cap
is hit.

### Data flow

```
transcript → meter (Stop hook) → context-meter state file (per-project
                                 planning state dir)
                               → one row on the per-project metrics log
                                        ↓
                      statusline + band hook read the state file
                                        ↓
                    report joins rent against git and tracker
```

### Failure posture

Every hook stays fire-and-forget and swallows its own errors, except the
guard's deliberate refusal, which must be loud (ADR 0016 — harness guards
refuse visibly rather than sandbox).

## Section 3 — the guard's correctness rules

### Scope, cut to what the data supports

Bounding "firehose" output was proposed and then cut. Bash results across the
corpus: 7,318 calls, median 99 tokens, p90 954, **max 7,295**. There is not one
firehose in the record, and `Read` is already capped at 2,000 lines by the
harness. That rule would bound output nothing is producing.

It survives as **shadow mode only**: the meter records what the rule would have
blocked, and the rule is built only if shadow data finds a target.

The guard therefore ships with **one rule**: do not re-read a file that is
unchanged and already resident. Ceiling ~9% of tool_result residency, ~4% of
total. Modest — the investment is sized to match. Turnover is where the money
is.

### The governing principle

**Fail open, always.** A wrongly-blocked read costs a turn and confuses the
agent; a wrongly-allowed read costs tokens. Those are not symmetric, so every
ambiguity resolves to *allow*.

### Threats to residency, each forcing a fail-open

| Threat | Detection | Response |
|---|---|---|
| Harness microcompact cleared old results | `microcompact_boundary` transcript subtype, plus `[Old tool result content cleared]` | wipe ledger entries older than the boundary |
| `/compact` | PreCompact hook, where `precompact-refresh.mjs` already fires | wipe ledger |
| `/clear` | new session id; the ledger is session-scoped | resets naturally |
| The read happened in a **subagent**, not this context | match `isSidechain` on the prior result against the current invocation | if undeterminable, allow |
| File changed underneath | mtime + size + content hash | allow |
| Prior read was **partial** | ledger records the returned range and truncation flag | block only if the requested range is a subset of the resident range |

The subagent row is the one that would have bitten us: sidechains share a
session id but not a context window, and they are 60% of all turns. A naive
ledger would block main-thread reads for bytes that only ever existed inside a
subagent.

### Ledger

`{path, hash, size, mtime, rangeStart, rangeEnd, truncated, turnIndex,
sidechain, resultUuid}` — written by PostToolUse, read by PreToolUse, stored
per session in the project's planning state directory.

Refusal text carries its evidence: which turn read the file, that it is
unchanged since, and how to override.

## Section 4 — testing and rollout

### Testing

`server/test/hooks.test.ts` already exercises the hook scripts; the meter and
guard extensions test where the existing ones do.

- **Residency math** — pure functions in `server/src/context/`, run against
  fixture transcripts. The 410 real transcripts are the golden corpus: the
  meter must reproduce the figures in the measurement doc, which makes the
  analysis itself a regression test.
- **Fail-open table** — one case per threat in section 3, each asserting
  *allow*. The subagent case carries the most cases.
- **Attribution** — session span to closed issues and commits, including
  overlapping sessions, a commit closing two issues, and a session that closes
  nothing.
- **Guards** — `check-footprint` re-pinned at the true figure with schemas
  counted; tool-count pins in `mcp.test.ts` and `standalone.test.ts` move for
  the one new tool; `check-dist` requires the rebuild committed in the same
  logical unit.

### Rollout

| Phase | Ships | Behavior change | Gate to next |
|---|---|---|---|
| **A** | meter, attribution, report, footprint audit (incl. tool-schema deferral proposal) | none | real per-work-item baseline exists |
| **B** | threshold at T=200k + compaction artifact contract + boundary quality measurement | the 50% claim lands here | boundary quality holds or improves |
| **C** | per-verb thresholds + band signal + subagent report cap and sidecar | tuned per workload | measured better than the flat setting |
| **D** | bounded refinement loops across peers/review/audit/verify | caps iteration | loops end earlier at equal quality |
| **E** | guard rule 1, shadow then enforcing | first enforcement | shadow shows a real target |

Phase B is the phase that delivers the target, and it is a configuration change
plus the artifact contract and measurement that prove it safe. That inverts the
first draft, where B was a signal and the savings waited on C.

Phase A ships first and alone. It changes nothing and produces the number every
later claim depends on — including the honest possibility that the target needs
revising once the denominator is real.

### Kill criteria

A cost layer that costs more than it saves is the failure mode here.

- If phase B's boundary measurement shows quality loss, the threshold rises
  until it does not, and the saving is whatever survives.
- If D's loop caps reduce output quality at any measured iteration bound, the
  caps loosen rather than the quality bar.
- If E's shadow mode finds under ~2% recoverable, E never ships.
- If the layer's own resident footprint exceeds ~500 tokens, it has eaten its
  margin and gets cut back.

### Principal risk, and why it is smaller than it looks

No longer compliance — the threshold is enforced by the harness once set. The
risk is **quality across compaction boundaries**, which is unmeasured today and
which the simulation cannot speak to.

But the framing "compaction is lossy, so cutting context trades quality for
cost" is only half true. **Riding a 900k context is also lossy.** Anthropic's
own context-rot research finds recall accuracy degrades as context grows:
larger contexts do not merely cost more, they perform worse. Practitioner
accounts describe the same failure in symptoms — the model stops following
earlier instructions, answers drift generic, and it asks for something already
provided.

So T=200k may *improve* output quality rather than trade against it, and the
measurement must look in both directions. Three symptoms are mechanically
detectable in a transcript and become the detector:

- a re-read of a file that was resident before the boundary
- a question the user already answered earlier in the session
- a decision reversed without new evidence

Phase B ships this measurement alongside the setting. If boundary quality
degrades, the threshold rises and the saving is whatever quality allows. If it
improves, the threshold comes down.

## Rejected, with reasons

**Local MoE pre-digest (handoff proposal C).** Compresses individual reads;
the median read is 878 tokens. Adds latency and a blind-spot risk — the local
model would decide what Opus never sees — to claim a term worth ~1% of spend.

**Vector retrieval alongside FTS5 (handoff proposal A part 2).** Solves a
retrieval failure that does not appear in the data.

**Local peer provider (handoff proposal A part 1).** Cheap and low-risk, but it
saves nothing on its own. Shelved, not refuted; it can return if a later phase
finds work worth running locally.

**Deterministic tool-output cache (handoff proposal B).** Cached bytes still
enter context, so it saves the turn and not the residency — and residency is
97.4% of the bill.

**Local API gateway (handoff dropped it; briefly revived, now moot).** A proxy
at `ANTHROPIC_BASE_URL` owns the message list and could implement cost-optimal
eviction directly. It is moot: `AUTOCOMPACT_PCT_OVERRIDE` achieves the same
thing supported, in one environment variable. It was also rejected on its own
terms: the auth path is a
subscription OAuth token, and putting a proxy in it is a credential-handling
risk that standing policy forbids. It also fights the harness's own cache
prefix, breaks across upgrades, and silently dropping a result the model still
needed is an invisible correctness failure.

**A cairn-built session-restart API.** Considered and unnecessary. Auto-compact
already restarts the context; only its trigger needed moving. Supervised child
sessions remain available for delegated work via the SDK surfaces named above.

## Related work, not in this spec

**Verb compilation.** Vivek Haldar cut an agent skill's token use by 94% by
treating the natural-language skill as a specification, collecting execution
traces, identifying the steps that had stabilized into deterministic behavior,
and lowering those into code — keeping model calls only where semantic judgment
genuinely lives. Run fluid first; compile once the shape is known; amortize
over every later run.

This lands squarely on cairn. Cairn is 39 verbs expressed as natural-language
skill bodies, executed repeatedly, with traces, run manifests, ledgers and
metrics already recorded — the trace substrate the method requires already
exists. And cairn's stated architecture (the plugin layer owns policy and
judgment; the server owns every mechanism with a wrong answer) *is* the
compiler thesis, never yet applied systematically with trace evidence deciding
what moves.

It is a different thesis with its own measurement needs, and it gets its own
design. Noted here so it is not lost.

## Prior art

| Source | What was taken |
|---|---|
| Writer, *How to rein in token costs with your harness* | The compaction artifact contract, the cheaper-helper-model rule, abort-on-degraded-summary, sub-agents as context firewalls with capped reports and a metadata sidecar. Their two-zone prompt reaching 99.9% cache reads independently confirms that prefix caching is solved and not a lever here. |
| Glean, *How to optimize token efficiency in agentic systems* | Context rot as a quality argument *for* smaller contexts; bounded refinement loops with minimum-improvement stop rules; the published 24-30% figures; the observation that review loops dominate multi-agent spend. |
| Monte Carlo, *Working smarter with Claude* | "Start a new conversation for every new task" as the highest-impact habit, and the three degradation symptoms that became the boundary detector. |
| Zylon, *How to use tokens efficiently in enterprise AI workflows* | Independent arrival at tokens-per-resolved-task as the correct metric; the discipline of returning only needed fields from tools. |
| Vivek Haldar, *How I cut an AI agent's token use by 94%* | The compiler thesis, carried to Related work above. |

Where these sources lead with compressing tool outputs or improving retrieval,
the measurement in this repo rejects both: median read result is 878 tokens and
the largest Bash result in the corpus is 7,295.

## Open items

- The exact re-pinned `check-footprint` budget, set once schemas are counted in
  the guard rather than estimated here.
