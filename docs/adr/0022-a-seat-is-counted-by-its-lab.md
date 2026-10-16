# 0022 — A seat is counted by its lab, and a seat's model is the owner's pin

Date: 2026-10-14. Status: accepted.

removeWhen: the peers roster is composed by lab at dispatch time — one seat per lab, chosen from whatever CLIs are on the machine — so the count is structural and no seat can speak for a lab already seated; or every seated CLI exposes the model it will run before the run, so the lab needs no pin to be known.
derives: axiom 4 (recorded-run); axiom 5 (owner-ground)

## Context

The peers council exists for cross-vendor judgement: a claim three
independent reviewers raise is worth more than one reviewer's conviction,
and a reviewer from the adjudicator's own model family shares the
adjudicator's blind spots. The first four seats mapped one-to-one onto
labs by accident of which CLIs existed. GitHub Copilot CLI breaks that
accident: it is a harness that routes to OpenAI, Google and Anthropic
models, every one of them a lab the council already seats or the
adjudicator's own. Seating it as a fifth reviewer and counting it as a
fifth voice would let one lab speak twice and call it convergence.

Copilot also picks its model unless told otherwise, and its default pick
is an Anthropic model. A seat whose model is decided by the vendor's
default is a seat whose lab is decided by the vendor.

## Decision

- **A seat declares the lab behind the model it speaks for.** Fixed-model
  CLIs declare it in their template. A model-pinned CLI derives it from
  the pinned id by family prefix. A CLI that picks its own model is
  `unknown` — stated, never guessed.
- **Convergence counts distinct labs, not seats.** Three labs raising the
  same claim is converged; the same lab through two harnesses is one
  voice. An unknown lab never completes a cluster on its own. An
  incomplete seat — one that never answered, or exited non-zero with no
  findings — is outside the count entirely.
- **A model-pinned seat's model is the owner's pin, never the call's and
  never the vendor's default.** The template carries a default; the
  project configuration may override it; the call cannot. Config load
  refuses a pin to the adjudicator's family and refused `auto`, because
  `auto` is not a pin (amended 2026-10-14, below).
- **The copy says what the count says.** Five seats, four labs. Never
  "five vendors".

Commits 89d6d1d (the seat), 8b16a10 (the lab rule), with the hardening
that made the seat safe to count at all in 34a6048 (child environment
minus tracker credentials) and 112cd57 (exit codes make a dead seat
incomplete, not clean).

## Consequences

- A project that pins Copilot to a Google model gains a lab only if
  antigravity is absent; pinning it to an OpenAI model gains none while
  codex is seated. The roster prose says so, and `peer_list` shows the
  lab beside each seat so the operator can see what the count will be
  before dispatch.
- The lab table is a prefix table and leaves ids it cannot place as
  `unknown` (two of Copilot's own catalog entries today). Unknown is
  honest and costs convergence weight; the fix is a table entry, never a
  guess.
- The default pin may not be on a given plan. The seat then exits
  non-zero with only an error on standard error, which the exit-code rule
  reads as an incomplete seat; the operator pins a served model. The
  default stays a real id so a fresh install fails loudly rather than
  routing to the vendor's choice.
- Convergence arithmetic lives in the verb's prose, not the state store,
  which holds no cluster math today. If the store ever counts, it counts
  labs.

## Amendment 2026-10-14

`auto` is accepted as the Copilot model pin. Reason: a plan that serves no
catalog model id answers "not available" to every pin and runs only
`auto`, so the refusal left the seat permanently incomplete on such a plan.
What does not change: a `claude-*` pin is still refused, the template
default is still a named non-Claude id, and `auto` is still not a lab —
the lab table reads it as `unknown`, so an auto-pinned seat contributes
findings and never completes a convergence cluster on its own, which is
the count's existing rule for any unplaceable model. Pin a served id as
soon as the plan has one; the stopgap costs a voice in the lab count, not
a finding.
