---
name: native-task-hook-mirror
description: Use when building or planning the native-Tasks→tracker mirror (phase 12, native grain) — validated hook behavior, payload shapes, and the three design constraints proven by probe-1733c5c9.
---

# Native Task hook mirror — validated design constraints

Claude Code's native Tasks can be auto-mirrored to an external tracker with
**zero polling**, driven entirely by `TaskCreated`/`TaskCompleted` lifecycle
hooks. Probed end-to-end against CLI 2.1.223 on 2026-08-14; verdict
VALIDATED, resolution proceed.

**Retired in phase 26 (2026-10-13, #329).** The spool hook, worker, tests
and advisory left the plugin because Claude Code ships the task tools
default-off on every current model, so the two events never fire. Nothing
below was disproved; it returns the day the tools are on by default again.

## What got validated

- `TaskCreated` and `TaskCompleted` both fire, including from headless
  (`claude -p`) child sessions, and deliver JSON on stdin with:
  `task_id`, `task_subject`, `task_description`, `session_id`,
  `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`.
  That is enough to open and close a tracker issue directly from the
  event — no read-back of the task store needed.
- The `TaskCompleted` payload reflects task state **at completion time** —
  a task renamed mid-flight arrives with its final subject, so the mirror
  can true-up the issue title on close.
- Working registration snippet and raw captured payloads:
  `references/hook-lab.md`.

## The three constraints (violate any = broken mirror)

1. **Create/close-only.** No event exists for intermediate mutations —
   `in_progress` transitions and subject edits are silent. `TaskUpdated`
   does not exist as an event; completion via `TaskUpdate state=completed`
   surfaces as `TaskCompleted`. Treat native Tasks as lifecycle signals,
   not a synced store.
2. **Key on `(session_id, task_id)`.** Task ids are per-session counters —
   two sessions both produce `task_id: "1"`. Keying on `task_id` alone
   collides issues across sessions.
3. **Spool, don't call inline.** Hooks block the session (measured: 5s
   hook sleep added ~6.6s wall-clock over a ~21s baseline run). A tracker
   API call inline taxes every task creation and a hung tracker hangs the
   session. Hook appends the payload to a local spool file and exits; a
   detached worker does the network I/O. Bonus: offline durability for
   free.

## What to avoid, and why

- **Don't register speculative event names.** Settings accepted the
  nonexistent `TaskUpdated` name silently — no validation error. A typo
  in the event name fails silent; verify each event empirically (see the
  repro recipe in `references/hook-lab.md`).
- **Don't trust the create-time subject for the final issue title.**
  Renames are invisible until close; the close-time payload is the truth.
- **Don't time hook behavior with the delay after `exit 0`.** The probe's
  first timing run appended `sleep` after `exit 0` and measured nothing.
  Instrument before the exit, and run a clean baseline the same day —
  model latency varies run to run.

## Origin

- Probe session: `probe-1733c5c9` (archive:
  `.cairn/probe/archive/probe-1733c5c9.md`)
- Tracker issue: #84 (closed, resolution `proceed`)
- CLI version probed: Claude Code 2.1.223, 2026-08-14
- Artifacts: `.cairn/probe/probe-1733c5c9/hook-lab/` — throwaway lab
  (settings, dump script, captured payload files); key contents preserved
  in `references/hook-lab.md`
- Feeds: phase 12 "native grain" (roadmap v4)
