# Quickstart

Zero to a tracker-mirrored project in about fifteen minutes. This guide
covers installing cairn, wiring up your issue tracker — including every step
that happens *outside* Claude — and running your first phase end to end.
For the full operating manual, see the Runbook.

## What you're setting up

Cairn is a Claude Code plugin backed by a typed MCP server. Three stores,
three jobs:

- **Your issue tracker** (GitHub, GitLab, Jira, Asana, Azure Boards,
  ClickUp, Linear, or the zero-credential local backend) holds the work
  items — the single source of truth for what's planned, in progress, and
  done.
- **Your git repo** holds the prose — plans, decisions, memory cards.
- **`~/.cairn/`** is a disposable cache. Losing it costs nothing.

Why this split matters: your PM can watch real issues move in the real
tracker while the agent works, and nothing important lives in a place that
can't survive a crash.

## Step 1 — install the plugin

In Claude Code:

```
/plugin marketplace add eventually-consistent-code-org/cairn2
/plugin install cairn@cairn-dev
```

Restart Claude Code afterward so the MCP server connects. The server's
`dist/` is committed and the installer installs its runtime dependencies,
so there is no build step. (Running from a plain source checkout instead?
Run `npm ci && npm run build` in `server/` first.)

## Step 2 — create your tracker credentials (outside Claude)

No tracker account at all? Skip this whole step: `"type": "local"` in
Step 3 stores issues as plain files in your repo — zero credentials, and
you can promote to a hosted tracker later.

Cairn never stores secrets in config files — only the *names* of environment
variables. Create a token for your backend and export it in your shell
profile:

- **GitHub**: `gh auth login`, or export `GITHUB_TOKEN` with a PAT that has
  repo + issues scope.
- **GitLab / Asana / Azure Boards / ClickUp**: create a personal access
  token in the product's settings and export it under the env var named in
  your config (`GITLAB_TOKEN`, `ASANA_TOKEN`, `AZURE_DEVOPS_PAT`,
  `CLICKUP_TOKEN`).
- **Jira**: create an API token at
  https://id.atlassian.com/manage-profile/security/api-tokens, then
  `export JIRA_EMAIL="you@example.com"` and
  `export JIRA_API_TOKEN="<token>"`. Both token kinds work: classic tokens
  hit the site URL as always, and the newer scoped (`ATCTT`-prefixed)
  tokens are auto-detected and routed through Atlassian's cloud gateway —
  no config changes needed either way (see the runbook's Jira section for
  the scopes a scoped token needs).

## Step 3 — write cairn.json

Easiest path: skip straight to `/cairn:new` — it asks which tracker and
docs platform you want and writes `cairn.json` for you from the shipped
template. Prefer doing it by hand? Drop a `cairn.json` at your repo root;
the plugin ships `templates/cairn.json.example` with copy-paste blocks for
every backend. GitHub, for instance:

```json
{
  "tracker": {
    "type": "github",
    "config": { "repo": "owner/name" }
  }
}
```

No hosted tracker yet, or just kicking the tires? The zero-credential local
backend stores issues as plain files in your repo — promote to a hosted
tracker whenever you're ready:

```json
{
  "tracker": {
    "type": "local",
    "config": { "dir": ".tracker", "prefix": "proj" }
  }
}
```

Jira works too, once you've got a token (see the classic-token caveat
above):

```json
{
  "tracker": {
    "type": "jira",
    "config": {
      "baseUrl": "https://your-domain.atlassian.net",
      "projectKey": "PROJ",
      "issueType": "Task",
      "emailEnv": "JIRA_EMAIL",
      "tokenEnv": "JIRA_API_TOKEN",
      "transitions": { "in_progress": "In Progress", "closed": "Done" }
    }
  }
}
```

Optional but worth it — the docs connector, so your documentation publishes
to Confluence:

```json
"docs": {
  "connector": "confluence",
  "config": {
    "baseUrl": "https://your-domain.atlassian.net/wiki",
    "spaceKey": "DOCS",
    "emailEnv": "CONFLUENCE_EMAIL",
    "tokenEnv": "CONFLUENCE_API_TOKEN"
  }
}
```

(Same Atlassian site? Jira and Confluence share API tokens — point the env
names at your Jira credentials and you're done.)

No Confluence? The `docusaurus` connector is the credential-free default —
`"docs": {"connector": "docusaurus", "config": {"sitePath": "../my-docs-site",
"docsDir": "docs"}}` writes markdown straight into a local Docusaurus site
checkout. No tokens, no env vars — the site's `docs/` folder is the store,
and building/deploying the site stays with you.

## Step 4 — your first project

```
/cairn:new my-project
```

Cairn interviews you about the goal, writes the plan artifacts
(`PROJECT.md`, `roadmap.md`, per-phase context), creates one tracker issue
per requirement, and mirrors phases into whatever your backend calls them
(epics, milestones, lists). Everything it creates is visible in your
tracker immediately — that's the point.

## Step 5 — the lifecycle

Five commands carry a phase from idea to shipped:

```
/cairn:plan 1      # research + task breakdown → PLAN.md, issues reconciled
/cairn:work 1      # claim issues, do the work, close each with evidence
/cairn:verify 1    # goal-backward check: does the code deliver the promise?
/cairn:ship        # gate on clean drift + closed issues, then push
/cairn:summit      # complete the milestone: release, archive, tag
```

Each verb refuses to lie for you: `verify` fails phases whose tests fail,
`ship` won't push with drift flagged, `summit` won't archive unverified
phases. When something's off, the error names the next action.

## Step 6 — publish your docs (optional)

With the docs connector configured:

```
/cairn:docs publish
```

Your README becomes the project's landing page inside a folder named for
the project; everything under `docs/` becomes a child-page tree with a
generated table of contents. Re-running updates pages in place — never
duplicates.

## Where to next

- **Runbook** — every verb, every flag, every config knob, every error
  code. The complete operating manual.
- `/cairn:help` — the verb reference, in-session.
- `/cairn:do "<anything>"` — not sure which verb? Describe what you want;
  cairn routes it.
