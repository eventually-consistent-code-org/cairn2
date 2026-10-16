# How cairn compares — mechanisms, not vocabulary

Ever noticed that every agent-workflow tool now claims "drift detection"
and "adversarial review"? The words stopped meaning anything — so this
page doesn't argue vocabulary. It compares **mechanisms**: what the
software actually computes, where the source of truth actually lives,
and what happens when a claim is wrong…

**Maintenance contract:** this is a standing page, not launch copy.
Every competitor row carries a *last verified* date. If a row is stale
or wrong, [open an issue](https://github.com/eventually-consistent-code-org/cairn2/issues)
— a corrected row with a fresh date beats a flattering one. We never
repeat a competitor's unverifiable marketing claims, and we expect the
same courtesy.

Cairn's column reflects version <!-- auto:version -->2.8.3<!-- /auto:version -->:
<!-- auto:verb-count -->39<!-- /auto:verb-count --> verbs,
<!-- auto:tool-count -->87<!-- /auto:tool-count --> typed MCP tools, 2124
passing tests, <!-- auto:tracker-count -->8<!-- /auto:tracker-count --> tracker
backends. Counts are script-computed from the same sources CI gates on and
refreshed each release by `scripts/refresh-comparison.mjs`; the test count
is re-measured by a full suite run (verified 2026-10-12).

## The head-to-head — tools doing a similar job

These are the closest substitutes: agent planning/memory layers you'd
consider *instead of* cairn.

| Mechanism | cairn | GSD lineage (GSD / GSD Pro / open-gsd / buildomator) | Superpowers | gstack | claude-mem |
|---|---|---|---|---|---|
| **Where work-item truth lives** | Your external tracker — <!-- auto:trackers-cell -->8 write-through backends (GitHub, GitLab, Jira, Asana, Azure Boards, ClickUp, Linear, zero-credential local)<!-- /auto:trackers-cell -->. Plans mirror to it; it remains the source your team already reads. | Repo files — now under new stewardship: the original repo was locked after the May 2026 maintainer exit, and the line continues at open-gsd (gsd-core / get-shit-done-redux); buildomator keeps project state in an MCP-backed store. The pre-fork one-way GitHub sync was export, not a source-of-truth mirror, and hasn't been re-verified post-move. | No tracker concept — it's a skills/discipline layer. | Repo files — Markdown plans (`/autoplan` writes a plan you save); no tracker concept. | No tracker concept — it's a memory layer. |
| **Drift: what is actually computed** | Plan↔external-tracker drift *math*: the server diffs plan-referenced issues against live tracker state (missing, closed-unverified, edited, unplanned) and blocks ship on flags. | buildomator v4's drift detection is *repo-internal code integrity* — duplicated logic, phantom scaffolding, structural near-clones (`verify drift`) — plus HANDOFF.json session checkpoints. Real machinery now, but nothing diffs against an external tracker. | None. | None found — the 2026-09 skill roster has no drift concept. | None. |
| **Verification** | Goal-backward verify gate: a phase passes only when the codebase delivers what the phase promised, evidenced in a committed VERIFICATION.md; closed-but-unverified issues are a drift flag, not a success. | gsd-core's verify step walks what was built and generates fix plans — its own plan steps, no tracker cross-check; buildomator adds UAT-resume invariants and an advisory convention-conformance gate. | Verification is prompt discipline (checklists), not a computed gate. | `/qa` drives a real browser and `/review` hunts production bugs — reviewer methodology, not a computed gate; nothing blocks on tracker state. | n/a |
| **External review** | Claim-verified-against-source cross-vendor review: `peers` seats codex, grok, antigravity, opencode, and copilot (five seats, four labs), and a claim without a locatable evidence ref is discarded before convergence. | GSD Pro routes across models for *generation* — multi-model routing, not adversarial verification of claims. | None. | Persona reviewers (`/review`, `/cso` security audit) plus a `/codex` skill — no claim-verified-against-source convergence documented. | n/a |
| **Memory honesty** | Provenance-checked cards: each memory records the file+commit it came from; recall runs `git diff` against that provenance and flags `STALE` instead of asserting stale facts. | Plan/handoff files carry state; no provenance re-check on recall. | None. | `/retro`, `/learn`, and a "gbrain" store — no provenance refs or staleness checks found. | Capture + summarization; no provenance refs, no staleness checking on recall. |
| **Harness reach** | Claude Code plugin first-class; one installer wires the same server + verbs into Grok Build, Copilot CLI, Codex, Gemini CLI, Cursor, OpenCode, Zed. | gsd-core targets Claude Code, OpenCode, Antigravity, Kimi, Kilo, Codex, Copilot, Cursor, Windsurf, and more — file conventions travel well. | No longer Claude Code-centric: documented installers for Claude Code, Codex, Cursor, Devin, Factory Droid, Gemini CLI, Copilot CLI, Grok Build, Kimi, OpenCode, and more. | Setup auto-detects 10 agents (Claude Code, Codex, OpenCode, Cursor, Factory, Kiro, OpenClaw, and more) — no longer single-harness. | Multi-agent now: Claude Code, Codex, Gemini, Copilot, OpenCode, and more. |
| *Last verified* | 2026-09-10 (script-refreshed) | 2026-09-10 | 2026-09-10 | 2026-09-10 — the July staleness flag is cleared; full column re-checked | 2026-09-10 |

Honest credit where due: cairn keeps GSD's best ideas — the phase
shape, the depth dial, goal-backward verification — and adds the layer
those flows can't hold in files: tracker truth and provenance-checked
memory.

## Adjacent, not substitutes — different job

You'll use some of these *alongside* cairn. Each row says why it
doesn't replace the mechanisms above.

**Native Tasks (Claude Code).** The platform's built-in task list:
local, session-scoped, dependency edges, with an open feature request
for sync. It answers "what am I doing right now", not "what does my
team's tracker say". cairn's verbs put the work in the tracker
themselves — claim, progress, close — so the two never competed. cairn
once mirrored native Tasks to the tracker by hook as well; that mirror
was retired in phase 26 (2026-10-13) because Claude Code ships the task
tools default-off on every current model, so the events it listened
for never arrive. The validated design is kept in-repo and returns if
the tools come back on by default.

**Auto Memory (Claude Code).** On by default since 2.1.59 — session
continuity is now a platform freebie, and cairn doesn't compete with
it. What it doesn't do is provenance: nothing records which file+commit
a remembered fact came from, so nothing can tell you the fact went
stale. That check is cairn's memory mechanism. *Re-verified 2026-09-10.*

**beads.** No longer just maturing — a Dolt-backed distributed graph
issue tracker (cell-level merge, dependency types, ready-work
detection, per-harness setup for Claude Code, Codex, Cursor, and more),
now under the gastownhall org. It still lives at the layer *below*
cairn's mirror — a place work items can live, not a plan-to-tracker
mirror with drift math. Cairn ships its own zero-credential local
backend today; beads occupies the same slot in a different stack.
*Re-verified 2026-09-10.*

**Anthropic's Product Management plugin.** First-party knowledge-work
suite, now housed in `anthropics/knowledge-work-plugins` and aimed
primarily at Cowork, Anthropic's agentic desktop app (it runs in
Claude Code too) — specs, roadmaps, stakeholder comms, research
synthesis. Adjacent today, and we watch it each survey; no tracker
mirroring found this pass either. *Re-verified 2026-09-10.*

**Agent IDEs (Cursor, Copilot Workspace, Devin).** The coding
environment itself. Cairn is the work-management layer that rides along
inside them — the installer wires Cursor explicitly. *2026-09-10.*

## Try it

```
/plugin marketplace add eventually-consistent-code-org/cairn2
/plugin install cairn
```

or, for any bare-MCP harness: `npm i @eventually-consistent/cairn-server`
— a fresh install boots the full tool surface with no extra setup
(smoke-tested from the public registry, 2026-08-14). Quickstart:
[docs/00-quickstart.md](00-quickstart.md). The proof behind the review
claims: [the council case study](case-study-council.md).
