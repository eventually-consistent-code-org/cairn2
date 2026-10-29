# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's vulnerability
reporting for this repository:

https://github.com/eventually-consistent-code-org/cairn2/security/advisories/new

Please do not open a public issue for a vulnerability. Include the
cairn version (`.claude-plugin/plugin.json`), the harness you run it in,
and a reproduction. You will get an acknowledgement within seven days and
a fix or a mitigation plan within thirty.

For product questions and non-security bugs, open an issue:
https://github.com/eventually-consistent-code-org/cairn2/issues

## Supported versions

The latest released tag (the one `.claude-plugin/marketplace.json` pins)
receives security fixes. Older tags do not.

## What the plugin can and cannot do

Cairn runs a local MCP server and a set of Claude Code hooks. The hooks
can refuse a tool call (leak guard, run guard, harness guard, circuit
breaker) but cannot make an unsafe path unreachable by construction;
that posture is recorded in `docs/adr/0016-*.md` and the audit history is
in `CHANGELOG.md`. What the plugin runs, stores and sends is listed in
[PRIVACY.md](PRIVACY.md).
