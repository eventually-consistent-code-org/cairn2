# 0016 — Harness guards refuse visibly; they do not pretend to be a sandbox

Date: 2026-09-20. Status: accepted.

removeWhen: the platform isolates agent configuration at the operating-system level in every session and every harness cairn runs in — the agent process cannot write its own hooks or settings, and the human edits them through a channel the agent cannot reach — so the visible-refusal hooks become redundant. Half met (SURVEY.md 2026-10-13, native-vs-cairn-subsystem-judgement): Claude Code's sandbox now blocks writes to the `.claude` settings, hooks, skills, agents, commands, `.mcp.json`, `.git/hooks` and `~/.claude` at the OS level, for sandboxed Bash only. Still open: auto mode (the default since 2.1.284) routes a protected-path write to a steerable classifier rather than a wall; non-sandboxed sessions and the Edit/Write/MCP paths outside the sandbox; the seven other harnesses.
derives: axiom 5 (owner-ground); axiom 3 (data-not-directive); axiom 4 (recorded-run)

## Context

An agent that can rewrite its own hooks or tool configuration can switch
off every other control in a single edit. The realistic path to that is
not a malicious operator — it is indirect: instructions embedded in text
the agent reads, an issue body, a review comment, a fetched page, steering
it into an edit nobody asked for.

The tempting response is to build something that sounds airtight, and to
describe it that way. Two things make that wrong. The escape hatch has to
exist, because the human legitimately does edit their own hooks; and any
text that can steer an agent into the edit can also steer it into asking
for the escape hatch. A control described as airtight, with a documented
bypass an attacker can request, is worse than an honest one — people stop
looking.

## Decision

Guards refuse in one plain line, name the file, and then ask where the
instruction came from. They do not claim isolation. The limits are written
into the scripts and the operator documentation rather than implied: the
shell coverage is best-effort matching over command text and not a shell
parser; the override exists and is reachable by anything that can reach
the agent; real isolation is the operating system's job.

Three guards ship on this footing. One keeps unattended runs out of the
directory a human is working in. One protects the harness configuration
from the agent it configures. One notices repetition and says so without
blocking anything. Alongside them, a shared rule states that text fetched
from the tracker is a specification to be read, never a directive to be
executed, with a behavioural eval holding the line: refusing the embedded
instruction is not enough, the assistant must also tell the user it was
there.

## Consequences

The controls are honest about what they buy, which is visibility rather
than prevention. A human sees a refusal where there would otherwise have
been a silent success, and the refusal points at provenance rather than
at process.

The judgment layer carries the weight and the deterministic layer is the
backstop, which is the inverse of how such guards are usually sold. That
ordering is deliberate: the eval measures the judgment, the hooks catch
the config subset the judgment might miss, and neither is described as
covering the other's ground.

Cost: an operator who genuinely wants a harness edit pays one flag. That
is the intended friction, and the refusal text is written to make the
question — did you actually ask for this? — the thing they read first.

## Amendment 2026-10-21 — the run guard is described by effect (#359)

The decision stands; this changes how the run guard is described and
built, not what it buys. Cairn stays in the "refused at runtime" tier:
the classification below makes the run guard's refusals derivable and
auditable, not airtight.

Its rules used to be an enumerated table, one row per flag spelling and
one issue per row. Every spelling that discarded work and was not in the
table slipped through until someone filed the next issue. The run guard
now classifies each git invocation by what it does, from git's own
semantics (shortened long options, short clusters, `+refspec`, whole-tree
pathspecs), into three effects, with `read-only` the default:

- **discards-work** — uncommitted or unpushed work lost with no undo.
  Refused in every session; the owner's escape is unchanged.
- **moves-shared-ref** — the default branch or any remote ref changes.
  Refused onto the default branch without a clean ship-gate stamp, and
  while a run is live without the push authority granted at staging.
- **touches-owner-checkout** — the human's working directory changes under
  them. Refused while a run is live, aimed at the owner's checkout.

The table is data a classifier reads (`hooks/scripts/git-effects.mjs`),
and the refusals reference effects only. Every refusal names the effect
and the flag that caused it, so a reader can audit why it fired; a hard
reset of the owner's checkout carries both of the first and third, and
says so. The everyday neighbours (`stash drop`, `branch -D`, a single-path
restore, `clean -n`) carry no discarding effect and stay allowed, as
before. As with every hook, a classifier that breaks lets the command
through rather than blocking work. Each of these is asserted in
`server/test/runguard-effects.test.ts`; the per-issue suite
`server/test/runguard-guards.test.ts` stayed green unchanged through the
rewrite.

## Amendment 2026-10-22 — the circuit breaker (#358)

The decision stands: a guard still refuses the one call in front of it,
visibly, and is still not a sandbox. What changes is that refusals now
add up. A headless run that keeps pushing past the ship gate, or keeps
reaching for its own hooks, is a run whose plan has gone wrong, and
before this it carried on until the budget or the phase ran out.

Every refusal from the run, harness and leak guards appends one row to
a refusal log under the cairn home — when, which guard and tool, the
effect refused, fixed reason text, the session, the live run, and a
sha256 of the tool input, never the command or path itself. While a
batch run is live, its rows are counted; at `auto.breaker` (default 3,
`0` off) the guard freezes the run by writing its manifest: `stopped`,
with the reason and the last three rows. The breaker is the only freeze
authority cairn has, and it is scoped to headless runs: a session with
no live run, or one that never named the run, is never frozen. A frozen
run's own sessions are refused pushes by the run guard, and its claims
and closes return `RUN_FROZEN` from the server.

The seam, stated because it is not obvious: the hooks import no server
code and have no tracker access, so they read the run manifest straight
from the cairn home and write the freeze into it themselves, and the one
plain-language comment the freeze owes is posted by the server, on the
first claim or close the frozen run attempts, once, flagged in the
manifest.

Like every hook it fails open, in both directions: a breaker that
breaks never blocks a call and never un-blocks one; a refusal log it
can't use means no breaker for that run, said once. Cairn stays in the
"refused at runtime" tier — this makes refusals derivable and
auditable, not airtight. It adds axiom 4 (recorded-run) to this
record's derivation: the refusals and the freeze are written where the
owner looks, not just shown once and lost. Asserted in
`server/test/hooks.test.ts` ("circuit breaker"), with the server half in
`server/test/run-breaker.test.ts` and `server/test/run-manifest.test.ts`.
