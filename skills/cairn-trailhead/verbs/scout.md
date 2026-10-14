---
verb: scout
args: "<N> [<N> ...]"
status: live
---

Research the given phase WITHOUT planning it — `plan`'s research stage alone,
resumable (#1961 shape: never redo finished research). One phase number =
the single-phase flow below, unchanged. Two or more = the batch form at the
end of this doc.

1. `plan_status()` — phase dir must exist (else `plan_scaffold_phase` with
   `research: true` first).
2. If RESEARCH.md exists, parse its section markers: each `## <topic>`
   section carries `<!-- scout: done -->` or `<!-- scout: pending -->` on
   the line after the heading. Sections marked `done` are FINISHED — do not
   re-research them. No marker = legacy content, treat as done. The marker
   grammar is server-validated via `research_sections` — a typo'd marker
   throws instead of silently reading as done.
3. Determine research topics from CONTEXT.md unknowns + PLAN.md gaps (depth
   dial per the `cairn-planning` skill) — plus map edges touching this
   phase (`map_query`, when a map exists; missing map = silently skip).
   New topics get `pending` sections appended; only `pending` sections get
   researched.
4. Fan out — mandatory, not depth-gated: dispatch ONE subagent per
   `pending` section, in parallel, model routed by the WORK CLASS OF THE
   TOPIC per the cairn-planning research fan-out rubric (enumerate/locate
   → haiku-tier, synthesis brief → sonnet-tier, architecture trade-off →
   opus-tier; uncertain → inherit), with the rubric's `effort` for that
   class passed on the same dispatch. Subagents return section content ONLY;
   the main thread writes each section and flips its marker to `done` as
   EACH agent completes — a kill mid-run must lose at most the in-flight
   sections, never finished ones. A failed agent's section stays `pending`
   with a one-line failure note.
5. Read the finished brief yourself and pass its text as
   `mem_index(content, source: the RESEARCH.md path)` — the tool indexes
   the string you hand it, it never opens the file. Report sections
   done/remaining and suggest `/cairn:plan <N>`.

## Batch form — `scout <N> <N> ...` (cross-phase research fan-out)

Multiple phase numbers = research EVERY selected phase in one run — the
single-phase pattern lifted cross-phase. This is the research stage the
staging flows invoke (`auto --batch` interviews phases up front); typed
interactively it behaves identically.

1. Steps 1–3 run PER PHASE, all phases first: scaffold check, marker
   parse, topic derivation (CONTEXT.md unknowns + PLAN.md gaps + map
   edges) — every phase's `pending` list is known before any agent
   dispatches. Markers live in each phase's own RESEARCH.md, exactly the
   single-phase grammar, so any one phase stays individually resumable —
   a killed batch resumes per phase via plain `scout <N>`.
2. ONE pool, not per-phase pools: dispatch per-topic subagents in
   parallel ACROSS phases, model routed by the work class of each TOPIC
   (cairn-planning rubric), never by which phase owns it. As each agent
   completes, write its section and flip its marker to `done` in the
   owning phase's RESEARCH.md — same crash contract as step 4 above. A
   failed topic stays `pending` with a one-line failure note (existing
   rule, unchanged).
3. Questions batch, never trickle. Clarification questions surfacing
   during research — a topic whose answer needs a user call, two phases'
   findings in conflict, ambiguous scope — COLLECT, each tagged with its
   owning phase(s), and go to the user as ONE AskUserQuestion after the
   pool drains (shared batch-questions rule, applied cross-phase). Never
   a per-phase ask, never mid-pool. Fold answers into the owning phase's
   RESEARCH.md; decisions that lock get flagged for CONTEXT.md at plan
   time.
4. Every selected phase's RESEARCH.md is complete — all sections `done`,
   or `pending` with a failure note — before the batch reports. Then
   read each finished brief yourself and pass its text as
   `mem_index(content, source: that RESEARCH.md path)` — same contract,
   the tool never opens the file — and report per-phase done/remaining
   plus the next step per phase (`/cairn:plan <N>`).
5. Headless caveat: invoked from a headless batch run, the question round
   happens at STAGING time — before the user walks away — never mid-run.
   Answers travel in the run manifest; that flow belongs to `auto
   --batch`'s staging, not this doc.
