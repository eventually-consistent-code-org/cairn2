<!--
  Wave-brief template — the reusable skeleton a `work` coordinator fills
  when dispatching one wave worker per issue. The standing rules below are
  the boilerplate every dispatch used to retype; they live here once.

  Section order here is load-bearing, not taste:
    - The invariants — `## Standing rules`, {{model}} and {{rules}} —
      render LAST. The recency end of the context window is the reliable
      attention peak, so the constraints a worker must not violate sit
      closest to it, after the issue and plan content rather than before
      it. {{rules}} stays the final slot.
    - The prefix stays static. {{seat_framing}} and the headings are the
      same bytes for every worker in a wave; dated or counted content
      (memory-card dates, staleness marks) renders BELOW them, so a
      provider's prefix cache stays warm across the wave.
  Reordering these sections is a behavior change, not a cleanup — move
  the composer (server/src/seats/brief.ts) with it or the two disagree.

  Slots, in render order (filled by the server's composeBrief, or by the
  coordinator reading this file directly; every occurrence of a slot is
  replaced, an unfilled slot is left verbatim so the gap shows):
    {{seat_framing}} — the seat section composed from a roster seat at
                       its declared dose (minimal = lens; standard =
                       + categories + honesty line; full = + anchors +
                       lens body); empty when the task names no seat.
                       Static per seat — this is the cacheable prefix
    {{issue}}        — the tracker issue content: id, title, body
    {{plan_excerpt}} — this issue's PLAN.md task text, plus any locked
                       CONTEXT.md decisions that bind it
    {{seat_memory}}  — the seat's role-scoped memory cards, each with its
                       created date and any staleness mark; empty when
                       the seat remembers nothing. Dated content, so it
                       rides below the prefix and never inside it
    {{model}}        — one line: the model this worker runs on and which
                       step of work.md's resolution picked it (the
                       agents.model pin, the task's `model:` annotation,
                       the rubric's work class, or inherit), so the
                       worker sizes any delegation to its tier. Per-task
                       content, so it rides at the bottom, never in the
                       prefix; the composer fills an inherit line when no
                       routing was resolved
    {{rules}}        — wave-specific standing-rule details: expected
                       base sha, setup commands (e.g. `npm ci` first),
                       the dispatching session's commit trailer block
-->

{{seat_framing}}

## Task

{{issue}}

## Plan excerpt

{{plan_excerpt}}

{{seat_memory}}

## Report

Return: branch + shas, files touched (absolute paths), test evidence
(suite + counts), guard outputs, reported token usage, and any
deviations from the plan.

## Standing rules

- Work in your assigned isolated worktree. FIRST `git merge --ff-only main`;
  commit locally; never push.
- Conventional commits, atomic — one logical change per commit; every
  commit carries the dispatching session's trailer block (below).
- Leak-guard discipline: anything that reaches the tracker or the report
  stays in plain language — no local paths, tokens, or internal URLs.
- Stay on this issue's scope; a bug outside it is reported, never an
  inline detour.

{{model}}

{{rules}}
