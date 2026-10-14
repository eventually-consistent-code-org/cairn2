---
verb: do
args: "\"<request>\""
status: live
---

Freeform smart router — classify the request against the routing table's
purpose column and dispatch.

1. Match the intent to exactly one live verb (and its arguments, extracted
   from the request — phase numbers, queries, flags).
2. "Ask the `<seat>` seat about …" / "what does the `<seat>` seat think
   of …" → `verbs/review.md` with `--seat <seat>` and the rest of the
   request as the target — the single-seat consultation path, never a
   full panel.
3. Read-only verb with a clear match → run it directly. Read-only means
   every server tool the verb calls carries `readOnlyHint: true` in its
   MCP annotations (`status`, `recall`, `help` are the everyday cases);
   the annotation is the source, not this list.
4. Mutating verb — one that calls any tool without `readOnlyHint` (`new
   plan work verify ship import remember` and most others) — or low
   confidence → confirm first: "Sounds like `/cairn:plan 4 --deep` — run it?"
5. "Rescan this project" / "sweep" / "audit everything" → `/cairn:audit
   sweep` (add `--fix` only when the request asks for fixes) — always
   through the confirm path in 4: a sweep files issues and can run long.
6. Matches a reserved verb's purpose → say which tier ships it and offer the
   nearest live alternative.
7. No plausible match → `verbs/help.md`.
