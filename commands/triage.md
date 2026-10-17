---
description: "Open-issue sweep against project conventions — report by default, --apply for the safe subset (/cairn:help)"
argument-hint: "[--stale-days N] | --apply"
allowed-tools: "mcp__plugin_cairn_cairn__*, Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-parse:*), Bash(git describe:*), Bash(git branch:*), Bash(git worktree:*), Read, Write, Edit, Glob, Grep, ToolSearch, Task, AskUserQuestion"
---

Execute the cairn verb `triage`:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/SKILL.md` — its shared
   rules apply to every step below.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/verbs/triage.md` and
   execute it with `$ARGUMENTS` as its arguments.
