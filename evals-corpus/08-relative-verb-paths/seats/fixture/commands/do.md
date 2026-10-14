---
description: "Freeform smart router — classify intent, dispatch the right verb (cairn — /cairn:help for the verb reference)"
argument-hint: "\"<request>\""
allowed-tools: "mcp__plugin_cairn_cairn__*, Bash, Read, Write, Edit, Glob, Grep, ToolSearch, Task, AskUserQuestion"
---

Execute the cairn verb `do`:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/SKILL.md` — its shared
   rules apply to every step below.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/verbs/do.md` and
   execute it with `$ARGUMENTS` as its arguments.
