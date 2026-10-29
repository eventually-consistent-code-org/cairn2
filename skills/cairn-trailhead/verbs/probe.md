---
verb: probe
args: "[\"<question>\" | (none = frontier) | --wrap [<id>]]"
status: live
---

Risk-ordered throwaway spike sessions — burn the highest-uncertainty
question first, keep a paper trail even when the answer is "no," and mirror
the arc to the tracker in plain language a manager reads. A probe is not a
feature build: the artifact is disposable, the verdict is not.

## With a question: `probe "<question>"`

1. `probe_start(description)` — creates the `cairn:spike` issue and posts
   the started comment itself (plain language, composed from the
   description). If one is already open for this question (the guard
   fires), don't start a duplicate: re-read `.cairn/probe/<id>.md` and
   resume from the last entry instead.
2. Experiment loop, run HIGHEST-UNCERTAINTY FIRST — the question most
   likely to kill the whole approach gets tested before anything that only
   refines it:
   - re-ground before every experiment: re-read the session file. A probe
     spans multiple sittings; the file is the memory, not your head.
   - `probe_log(kind: "experiment")` — state what you're about to run and
     what it validates BEFORE running it. If you can't say what it
     validates, you're not ready to run it.
   - build it in `.cairn/probe/<id>/` — throwaway, scoped, runnable. Prefer
     something the user can FEEL working over a stdout dump when it's
     feasible — a small UI or demo earns more trust than a log line, and
     costs little more to stand up.
   - `probe_log(kind: "result")` — what actually happened: the trail, the
     surprises, the edge cases that showed up uninvited. NEVER
     verdict-only. "it worked" is not a result; the surprising thing that
     happened on the way there is the result.
   - the moment the user states a preference or a hard constraint mid-loop
     — a UI shape, a latency ceiling, a library they won't use —
     `probe_log(kind: "requirement")` immediately. These are non-negotiable
     inputs to the real build later; losing one here means re-discovering
     it the expensive way in `work`.
   - `probe_log(kind: "verdict")` — VALIDATED | INVALIDATED | PARTIAL, plus
     the why in one or two sentences. A verdict without a why is a guess
     wearing a lab coat.
3. Key-finding mirror comment whenever the picture materially changes —
   not every log line, just the moments that would change what a manager
   thinks is true about this question.
4. `probe_close(resolution: "proceed|pivot|stop — <reason>")` — archives
   the session, comments the resolution on the issue, and closes it. The
   resolution is the one line that has to survive without any of the
   detail above it.

## No args: frontier mode

1. `session_landscape` — the ONLY source of truth for what's already been
   probed. Don't reconstruct this from memory or from grepping
   `.cairn/probe/`; the tool exists so the picture can't drift out from
   under you.
2. Read roadmap/phase state alongside it and propose risk-ordered
   candidates, split integration risk (does this fit what already exists)
   from frontier risk (has anyone here done this at all).
3. HARD RULE: an archived session whose resolution starts with `stop` is
   listed as "already probed — stop," full stop, and is NEVER re-proposed
   as a candidate. Re-litigating a settled `stop` wastes the exact budget
   probing exists to protect.

## `--wrap [<id>]`

1. Pick the resolved session to promote — the one named, or the latest
   resolved session if `<id>` is omitted. Read its archive and whatever
   artifacts survived in `.cairn/probe/<id>/`.
2. Write `.claude/skills/<name>/SKILL.md` plus a `references/` directory:
   what got validated, the patterns that worked, what to avoid and why,
   and an origin block (session id, tracker issue, files touched). This is
   the only durable output a probe is allowed to leave behind outside the
   tracker.
3. Offer to delete the artifact directory once the skill is written. NEVER
   auto-delete — the user gets the last look before the throwaway work
   actually gets thrown away.

## Mirror rules

Plain language on the tracker, same as `trace`: no code blocks, no file
paths, no internal refs a non-engineer would bounce off of. Comment at
milestones — started, key finding, resolved — not at every log line. The
detail lives in `probe_log`; the tracker gets the story.

## Fast lane

There isn't one. Unlike `trace`, where an obvious fix can collapse the
loop to one motion, a probe's whole point is testing an assumption you're
NOT sure of — if the answer really is already obvious, this is a `mark`
or a one-line decision, not a spike. Reach for `probe` when you'd
otherwise be guessing.
