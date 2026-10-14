# cairn2 — Claude context

Work-harness plugin for Claude Code (and 7 other harnesses): a TypeScript
MCP server + verb skills that mirror all work into an external tracker.

## Commands

```bash
cd server && npm ci && npm test        # full suite (vitest; excludes *.live.test.ts)
cd server && npx tsc --noEmit          # CI type gate — NOT covered by npm test
cd server && npm run build             # tsc → dist/ (the only tsc invocation)
cd server && npm run test:live         # github.live.test.ts; needs GITHUB_TOKEN
node scripts/check-surface.mjs         # verbs/tools/seats drift guard
node scripts/check-dist.mjs            # committed dist freshness
node scripts/check-pins.mjs            # tool-count pin agreement
node scripts/check-versions.mjs        # version surfaces agree
node scripts/check-diagrams.mjs        # diagram count labels agree
node scripts/check-footprint.mjs       # resident context stays under its pinned budget
node scripts/release.mjs <version>     # bump every version surface (see Releases)
```

Guards run from the **repo root**; tests from `server/`. Root
`package.json` has **no scripts field** — every root tool is
`node scripts/*.mjs`; `npm run <x>` at the root always fails.

## Architecture

The plugin layer (`commands/`, `skills/`, `hooks/`) owns policy and
judgment; `server/` (TypeScript MCP) owns every mechanism with a wrong
answer — state transitions, tracker mirroring, drift math, validation.
Eight tracker adapters (`server/src/tracker/adapters/`) behind one SPI;
two docs connectors (`server/src/docs/adapters/`: confluence, docusaurus)
are a sibling subsystem. `docs/ARCHITECTURE.md` + `docs/adr/` carry the
full picture.

Not a workspace: two independent packages with separate lockfiles — root
`@eventually-consistent/cairn` (bin `cairn-setup` → `setup/cairn-setup.mjs`)
and `server/` `@eventually-consistent/cairn-server` (bin → `dist/index.js`).
MCP entry is `server/dist/index.js`, wired in `.mcp.json` via
`${CLAUDE_PLUGIN_ROOT}`, which passes `CLAUDE_PROJECT_DIR` (required).

Env (no `.env.example`): `CLAUDE_PROJECT_DIR`, `GITHUB_TOKEN`,
`CAIRN_SETUP_OFFLINE`.
`cairn.json` is gitignored but present locally — machine-local config.

## Gotchas

- `server/dist` is **committed**. Any commit touching `server/src` must
  `npm run build` and commit dist in the same logical unit —
  check-dist enforces it.
- Tool-count pins live in `server/test/mcp.test.ts` and
  `server/test/standalone.test.ts`; both move with every registered
  tool. check-surface self-computes and needs no edit.
- Four generated surfaces, never hand-edited: README marker spans
  (`scripts/refresh-readme.mjs`), `docs/comparison.md` marker spans
  (`scripts/refresh-comparison.mjs`, shares `scripts/lib/claims.mjs`),
  harness spine (`scripts/gen-agents.mjs`), command shims
  (`scripts/gen-commands.mjs`). Regenerate after merges that touch
  their inputs — branch-side green is not merge-side green.
- The leak guard is a **PreToolUse Bash hook** (`hooks/hooks.json` →
  `hooks/scripts/pretooluse-leakguard.mjs`), not a git hook: it blocks
  planning-directory path literals in staged changes (server src/dist
  exempt) only for commits made through the agent's Bash tool. Commits
  from a plain terminal are unguarded. Phrase docs around it.
- Some tests are environment-conditional (live-credential and
  external-CLI gated) — skip counts vary by machine; the passed count
  is the stable baseline. `server/drills/` holds 29 hand-run
  live-credential scripts outside vitest.
- Conventional commits. Git author uses the repo-local
  eventually-consistent-code noreply identity — never a personal email.

## Releases

Write the real `## vX.Y.Z` CHANGELOG entry first (cut-first), then `node
scripts/release.mjs X.Y.Z` (uses the entry as-is; refuses placeholder
scaffolds), commit, tag `vX.Y.Z`, push. Version surfaces are exactly
three — `package.json`, `server/package.json`,
`.claude-plugin/plugin.json` — and `publish.yml` fails the tag on any
disagreement, gates on tests + dist freshness, and publishes
`cairn-server` before `cairn`.
