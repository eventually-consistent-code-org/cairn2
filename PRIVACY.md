# Privacy and data handling

This page is the privacy policy for the cairn plugin and the
`@eventually-consistent/cairn` and `@eventually-consistent/cairn-server`
packages. It says what runs on your machine, what is stored where, what
leaves your machine, and how to remove it. Statements below describe the
code at the commit this file ships in (last reviewed 2026-10-28 against
`server/src`, `hooks/scripts` and `setup/`); the source is the record.

## Summary

- Cairn is local-first. The MCP server and every hook run on your
  machine as child processes of your coding harness.
- Nothing is sent to the plugin author. There is no telemetry, no
  analytics endpoint, no crash reporting, and no account.
- Data leaves your machine only to services **you** configure: the
  issue tracker named in `cairn.json`, an optional docs connector, and
  any external AI CLIs you choose to seat with the `peers` verb.
- Credentials are read from the plugin's `userConfig` prompt (Claude
  Code) or environment variables (other harnesses). They are never
  written to `cairn.json`, plan files, memory cards or logs.

## What runs

| Component | Where | What it does |
|---|---|---|
| `server/dist/index.js` | local MCP server over stdio | planning, memory, tracker mirroring, docs publishing |
| `hooks/scripts/*.mjs` | Claude Code hooks (PreToolUse, PostToolUse, PostToolUseFailure, SessionStart, Stop) | guards, breadcrumbs, observation capture, session continuity, cost tracking |
| `setup/cairn-setup.mjs` | optional installer for non-Claude-Code harnesses | writes harness config files in your project |

The server's runtime dependencies (`@modelcontextprotocol/server`,
`@modelcontextprotocol/client`, `better-sqlite3`, `zod`) are installed by
Claude Code from the root `package-lock.json` when the plugin is installed.
`better-sqlite3` is a native addon; its prebuilt binary comes from npm at
install time.

## What is stored, and where

**In your project (committed to git only if you choose to).**
`.cairn/` holds plans, memory cards, probe/draft/thread session notes,
the local tracker's issue files when `tracker.type` is `local`, and
`observations/observations.jsonl`. An observation row is: timestamp,
session id, tool name, a target label (file path, or the first 80
characters of a shell command), and an error flag. No prompt or response
text is recorded. The file is capped at 2000 rows.

**In your home directory, `~/.cairn/`.**
- `handoff/` session continuity checkpoints (phase, issue, next step)
- `metrics/<project>.jsonl` per-session token and cost totals, written
  by the Stop hook, which reads the session transcript Claude Code
  passes to it **for its `usage` fields and result byte sizes only**.
  It stores numbers and model ids, never message content.
- `refusals/<project>.jsonl` one row per guard refusal: tool name,
  guard, effect and a SHA-256 digest of the tool input. The raw input is
  never written, because a command line can carry a secret.
- `outlook/`, `sessions/`, `cache/` portfolio board, session landscape,
  and tracker read cache.

**What is deliberately not stored.** Conversation text, prompts, model
responses, file contents, tokens or passwords. Cairn does not build a
profile of you; the `profile` verb writes a short preferences block to
`cairn.json` in your project that you can read and edit.

## What leaves your machine

Only to endpoints you configure, over HTTPS, with the credential you
supplied:

| Destination | When | What is sent |
|---|---|---|
| Your issue tracker (GitHub `api.github.com`, GitLab, Jira/Atlassian, Asana, Azure Boards, ClickUp, Linear) | every `issue_*`, `milestone_*`, `plan_*` reconcile and `tracker_migrate` call | issue titles, bodies, comments, labels, close evidence, estimates, worklogs: the work record cairn mirrors |
| Your docs connector (Confluence API, or a local Docusaurus checkout) | `docs publish` | README and `docs/` content |
| External AI CLIs on your PATH (codex, grok, opencode, copilot, antigravity) | `peers` verb, when you convene them | the review brief and the diff under review; tracker tokens are scrubbed from their environment first |
| `registry.npmjs.org` | `cairn-setup` for non-Claude-Code harnesses, version check only | the package name; set `CAIRN_SETUP_OFFLINE=1` to skip |

The Claude Code plugin itself makes no network calls outside the table
above. The `local` tracker type makes none at all.

## Credentials

In Claude Code the GitHub token is requested through the plugin's
`userConfig` (`github_token`, marked sensitive) and passed to the server
as an environment variable; leaving it empty uses `gh auth login`
credentials. Other trackers read the environment variable **named** in
`cairn.json` (`tokenEnv`, `apiKeyEnv`, `patEnv`, `emailEnv`); the value
is never written to disk by cairn. The leak guard blocks commits that
contain a credential-shaped literal.

## Retention and removal

Everything is plain files. Delete `.cairn/` in a project and `~/.cairn/`
to remove every local record; uninstall the plugin to remove the server
and hooks. Data already mirrored to your tracker or docs site is governed
by that service's policy and your account there.

## Contact

Product and privacy questions: open an issue at
https://github.com/eventually-consistent-code-org/cairn2/issues.
Security reports: see [SECURITY.md](SECURITY.md).
