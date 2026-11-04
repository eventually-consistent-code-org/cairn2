# 0037 — cairn acts as the owner on every route

Date: 2026-11-04. Status: accepted.

removeWhen: a run can be given a scoped identity the services distinguish — a fine-grained GitHub token with no write to the default branch, issued per run and read from the run manifest, plus a browser profile with no saved sessions — at which point the ruleset the probe reads (#485) can name the agent and the push gate moves to the service.
derives: axiom 5 (owner-ground)

## Context

Removing a tool removes one door. The test that matters starts from the
action and lists every route to it — the tool, the shell, the browser, a
token in a script — and for each route writes down whose identity the
service at the end of it sees (Greenberg, "Your Agent Has a Side Door:
Testing MCP Policy Beyond the Tool List", dev.to, 2026-11-03, read
2026-11-04). A deny scoped to the agent can only live at that service,
and only when the service can tell the agent from the owner.

For cairn the answer on every route is the same, checked 2026-11-04: the
owner's. Tracker calls use `GITHUB_TOKEN` or `gh auth token`; `git push`
uses the owner's credential helper; the browser tools run as the owner's
signed-in session; Composio acts with the owner's connected account. No
cairn component holds a credential of its own — a plugin option hands the
owner's token to the server, and the server forwards it. The guards (ADR
0016), the write guard and the pre-push hook (#483, #484) and the ruleset
the probe reads (#485) narrow the routes; none of them changes who is
knocking. ADR 0016 records that the guards are not a sandbox. Nothing
recorded the prior fact: cairn has no principal for a sandbox to be
built around.

The issue filed this under two clauses — the owner's checkout and the
harness's own configuration. In this spine those are the two halves of
one axiom, the owner's ground, so the `derives:` line names it once.

## Decision

cairn has no identity of its own. Every service sees the owner, on every
route, so no service-side rule can be scoped to "the agent", and the
guards refuse by effect — what the command does: discards work, moves a
shared ref, touches the owner's checkout, writes the harness's
configuration — and never by principal, because there is no principal to
name. The effect classifier (ADR 0016, amendment #359) rests on this;
the record is now its own (asserted: `server/test/runguard-effects.test.ts`,
"each refusal names its effect and the flag that caused it").

The fact is a field, not a paragraph: `config_probe` reports
`identity: "owner"` beside the tracker verdict. A constant today, typed
as the literal so a scoped identity is a typed change rather than a
drift, and independent of the verdict — a bad token is still the owner's
bad token (asserted: `server/test/probe-tools.test.ts`, "config_probe
reports identity: owner (#486)").

The runtime rule the article ends on — sandbox the runtime so the agent
holds no signed-in session — is the owner's job, not cairn's: the shell
and the browser a cairn session uses should hold no signed-in session the
task does not need. One dated sentence in the runbook, under setup, and
no mechanism, because cairn cannot see which sessions a browser profile
holds, and a sentence pretending otherwise would be the bare claim this
record exists to avoid.

## Consequences

The push gate's honest shape follows. Ship's "the push gate is the guard
alone" line (#485) means exactly that the service has no way to refuse
the agent and allow the owner, because at the service they are one
principal; a ruleset on the default branch binds the owner too, which is
why it is a choice and not a default.

An audit that asks "which route carries a different identity" has its
answer here and need not re-derive it: a route that reaches a service
under the owner's credential is the expected state, not a finding,
until the removeWhen above is met. Building the per-run scoped identity
is its own phase when it comes; nothing here claims such a token is
available on the subscription-only path cairn runs on (a claim about the
platform, dated 2026-11-04).
