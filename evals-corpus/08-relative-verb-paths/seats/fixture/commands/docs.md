---
description: "Publish repo docs to the configured docs connector (Confluence or Docusaurus) — landing page + page tree (cairn — /cairn:help for the verb reference)"
argument-hint: "publish [--name \"<project>\"] | (none = status)"
allowed-tools: "mcp__plugin_cairn_cairn__*, Bash, Read, Write, Edit, Glob, Grep, ToolSearch, Task, AskUserQuestion"
---

Execute the cairn verb `docs`:

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/SKILL.md` — its shared
   rules apply to every step below.
2. Read `${CLAUDE_PLUGIN_ROOT}/skills/cairn-trailhead/verbs/docs.md` and
   execute it with `$ARGUMENTS` as its arguments.
