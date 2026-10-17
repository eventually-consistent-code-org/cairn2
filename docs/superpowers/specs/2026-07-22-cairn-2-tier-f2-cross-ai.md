# Cairn 2.0 — Tier F2: Cross-AI Peer Review

**Date:** 2026-07-22
**Status:** Approved design (owner Q&A 2026-07-22: fixed shortlist codex/opencode/gemini/grok; remaining calls delegated + recorded)
**Author(s):** John Reed (with Claude)
**Parent:** `2026-07-15-cairn-2-parity-roadmap-design.md` §Tier F item 22 (#697, #997)
**Siblings:** F1 (basecamp — shipped 2026-07-22), F3 (frontend loop — separate spec).

## Outcome

One new live verb — `peers` — and two new tools that let cairn convene
external AI CLIs (codex, opencode, gemini, grok — first-class adapters,
owner's shortlist) as reviewers: peer-augmented code review with a
convergence loop, plan-review convergence before execution, per-provider
context-buffer caps for constrained models (#997), and graceful
degradation when a CLI is absent (none are guaranteed installed —
verified on the dev machine: zero of four present).

## Why (decision record)

- **Fixed shortlist, first-class adapters (owner call).** codex, opencode,
  gemini, grok. Each gets a command template + output handling tuned to
  that CLI, not a lowest-common-denominator shim. Others unsupported
  until asked for.
- **The server runs the CLIs, not the agent (delegated).** A `peer_run`
  tool shells the provider CLI with a timeout, captures output, and
  enforces the context-buffer cap deterministically. Rejected:
  prompt-level `Bash` invocations (no cap enforcement, no timeout
  discipline, undrillable). The server's child-process surface is
  bounded: exactly the four allow-listed argv templates, never
  shell-interpolated input (input via stdin), never user-supplied
  command strings.
- **Caps are config, absence is normal (delegated, #997).** `cairn.json`
  gains a `peers` block: per-provider `{ enabled?, maxInputChars? }` with
  conservative defaults. A provider not on PATH is a DETECTED state, not
  an error — `peer_list` reports it; `peer_run` on a missing CLI is
  PRECONDITION_FAILED naming the install hint. Nothing anywhere assumes a
  peer exists.
- **Convergence is verb-level judgment on tool-level transport
  (delegated).** `peer_run` moves bytes; the `peers` verb runs the loop:
  collect each peer's findings, judge them against cairn's own review
  (adversarially — a peer finding is a claim, not a fact), converge until
  a round yields nothing material or two rounds elapse (hard cap — peer
  loops must terminate). Surviving findings enter the EXISTING review
  discipline: `cairn:review` issues + `audit_record`, with the record
  crediting which peer raised what. No new finding pipeline.

## 1. Scope & surface

- `peers`: new live verb (35 → 36).
- Tools 60 → **62**: `peer_list`, `peer_run`.
- Config schema: optional `peers` block (validated; unknown providers
  rejected).
- check-surface `TOOL_PREFIXES` gains `peer`.

## 2. Peer runner — `server/src/peers/run.ts`

```ts
export const PROVIDERS = ["codex", "opencode", "gemini", "grok"] as const;
export type Provider = (typeof PROVIDERS)[number];
export interface PeerResult {
  provider: Provider; output: string; exitCode: number;
  truncatedInput: boolean; durationMs: number;
}
export function peerList(projectDir: string): Array<{
  provider: Provider; onPath: boolean; enabled: boolean; maxInputChars: number }>;
export function peerRun(projectDir: string, provider: Provider,
  input: string, timeoutMs?: number): Promise<PeerResult>;
```

- Command templates (argv arrays, input ALWAYS via stdin, never argv):
  codex → `codex exec --json -` (fallback plain if --json unsupported:
  template is fixed argv; output parsed as text either way);
  opencode → `opencode run -`; gemini → `gemini -p -`; grok → `grok -p -`.
  Exact templates are constants — adapters may adjust flags at
  implementation against each CLI's --help, but the shape (fixed argv,
  stdin input) is binding.
- Cap: input longer than the provider's `maxInputChars` (default 200_000;
  #997's constrained-model knob) is head-truncated WITH a marker line
  appended (`[cairn: input truncated at N chars]`) and
  `truncatedInput: true`.
- Timeout default 120s → kill + PRECONDITION_FAILED naming the provider
  and elapsed time. Missing binary → PRECONDITION_FAILED with install
  hint. Non-zero exit → returned in the result (NOT an error — peers are
  advisory; the verb judges).
- Disabled provider (config `enabled: false`) → PRECONDITION_FAILED.

## 3. Config

```jsonc
"peers": {
  "codex":   { "enabled": true, "maxInputChars": 200000 },
  "gemini":  { "maxInputChars": 900000 }
  // absent provider = enabled with defaults; unknown keys rejected
}
```

Schema in `config.ts`; `config_set` patching works unchanged.

## 4. `verbs/peers.md`

- `peers` (bare) — `peer_list` rendered plainly: on PATH / enabled / cap.
- `peers review [target]` — cairn runs its own five-axis review FIRST
  (the review verb's discipline), then `peer_run` per available provider
  with the diff + a structured findings request; judge each peer finding
  adversarially (verify against the code; a peer saying it doesn't make
  it true); converge: round 2 only for material disagreements, hard stop
  after round 2. Surviving findings follow review's exact rules
  (`cairn:review` issues, severity first line, record via
  `audit_record(scope: "peers-review-<slug>")` crediting provenance —
  which peer(s), which round). Peers absent → say so and proceed with
  cairn's own review; never block on a missing CLI.
- `peers plan <phase>` — plan-review convergence: each available peer
  critiques the phase's PLAN.md (cap-aware input); cairn judges;
  material, verified critiques become plan edits (or `cairn:audit`
  issues when the plan's owner should decide); record scope
  `peers-plan-<phase>`. Same two-round cap.
- Leak rules: peer INPUT is code/plans leaving the machine — the doc
  states plainly that `peers` sends content to external services and the
  leak-pattern scan runs on the OUTBOUND input before every `peer_run`
  (scan hits → stop, name the lines, let the user decide).

## 5. Testing (three rings)

- **Unit:** runner with a STUB binary on PATH (fixture script echoing
  stdin length + canned findings): detection (on/off PATH), cap
  truncation + marker + flag, timeout kill, missing-binary error,
  disabled-provider error, non-zero exit passthrough; config schema
  (unknown provider rejected, defaults applied).
- **MCP ring:** 62 pin; `peer_list` shape; `peer_run` against the stub.
- **Drills (mechanical, post-merge):** `drill-peers.mjs` — stub CLIs for
  all four providers staged on PATH (real CLIs not assumed anywhere):
  detection lists all four; cap truncation proven at a tiny configured
  cap; a stubbed "peer finding" flows the convergence mechanics into a
  real `cairn:review` issue + record crediting the peer; outbound leak
  scan blocks a seeded secret from ever reaching the stub (assert the
  stub never saw it); a missing provider (stub removed) degrades to
  proceed-without.

## Non-goals

- No API-key management for peers (their CLIs own their auth).
- No structured-output contracts per provider beyond text parsing (v1
  judges prose).
- No peer auto-invocation from review/audit — peers run only when the
  `peers` verb is asked for.
- No provider plugins beyond the shortlist.

## Success criteria

1. All four adapters detect, cap, and run (proven against stubs); a
   missing CLI degrades to proceed-without, never blocks.
2. Peer findings only reach the tracker AFTER adversarial verification,
   with provenance (peer, round) in the record.
3. The outbound leak scan runs before every peer_run and a hit stops the
   send (proven: the stub never receives the seeded secret).
4. Convergence terminates: hard two-round cap, drilled.
5. Config caps enforce truncation with the marker (#997).
6. Existing surfaces untouched: 60 prior tools unchanged, F1 compat
   intact (suite unedited except pins).
