# 0016 — Harness guards refuse visibly; they do not pretend to be a sandbox

Date: 2026-09-20. Status: accepted.

removeWhen: the platform isolates agent configuration at the operating-system level in every session and every harness cairn runs in — the agent process cannot write its own hooks or settings, and the human edits them through a channel the agent cannot reach — so the visible-refusal hooks become redundant. Half met (SURVEY.md 2026-10-13, native-vs-cairn-subsystem-judgement): Claude Code's sandbox now blocks writes to the `.claude` settings, hooks, skills, agents, commands, `.mcp.json`, `.git/hooks` and `~/.claude` at the OS level, for sandboxed Bash only. Still open: auto mode (the default since 2.1.284) routes a protected-path write to a steerable classifier rather than a wall; non-sandboxed sessions and the Edit/Write/MCP paths outside the sandbox; the seven other harnesses.

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
