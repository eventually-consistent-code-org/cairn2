---
description: "Chained hands-off execution of remaining phases (opt-in) (cairn — /cairn:help for the verb reference)"
argument-hint: "[--batch [--budget <tokens|$usd>] [--phases <N,N,...>]]"
allowed-tools: "mcp__plugin_cairn_cairn__*, Bash, Read, Write, Edit, Glob, Grep, ToolSearch, Task, AskUserQuestion"
---

Execute the cairn verb `auto`:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/SKILL.md` — its shared
   rules apply to every step below.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/verbs/auto.md` and
   execute it with `$ARGUMENTS` as its arguments.
