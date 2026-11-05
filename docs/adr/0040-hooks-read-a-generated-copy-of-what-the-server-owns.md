# 0040 — Hooks read a generated copy of what the server owns, held equal by a test

Date: 2026-11-04. Status: accepted.

removeWhen: hooks may import server code without paying for its start-up on every tool call, or the platform delivers one list to the server and the hooks alike.
derives: axiom 2 (mechanism-vs-judgment); axiom 6 (surface-is-rent)

## Context

Hooks import no server code: they are dependency-free scripts that start
in tens of milliseconds on every tool call, and a server import would
bring the whole module graph with it (ADR 0025 and the import test that
asserts it). Yet two facts the hooks need are the server's to define —
which cairn.json keys only the owner may set, and which text shapes
count as a leaked secret — and the audits found the two copies of each
drifting: a key the config tool refused that the harness guard let
through a shell write, a pattern the commit guard knew that the peer
screen did not.

## Decision

The server is the single source. It exports the owner-only key list with
the one safe value each key may be set to without the owner
(`OWNER_ONLY_KEYS`), and the config tool refuses a patch that sets a key
away from that value with a typed owner-only code unless the session
carries the harness-edit escape. The harness guard reads a generated
copy of the list, written by a script with a check mode, applies an edit
or write to the configuration in its head and compares keys, and refuses
a shell line or tool input that writes the file and spells a key's last
word (#281, range 972827f..2cf8fd6). The leak patterns are one module
the commit guard and the peer screen both load, with a parity test
holding the two copies byte-equal (#280, range b66705a..972827f). In
both cases a test fails when the copy and the source differ, and the
generator's check mode runs in the surface guard.

## Consequences

A new owner-only key is one line in the server and one generator run;
forgetting the run is a red test, not a silent gap. The hooks stay
import-free and fast. What the copy cannot carry is the server's
reasoning — the hook knows the key, not why it is the owner's — so the
refusal names the key and the escape and leaves the why to the
configuration verb. The closing audit noted one key that belongs on the
list and is not yet (the verify re-run switch, #500).
