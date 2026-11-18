---
type: gotcha
provenanceFiles: [server/src/docs/adapters/docusaurus.ts, docs/diagrams/README.md]
provenanceCommits: [5903bce, 5903bce]
created: 2026-09-20
scopePhase: 24.5
confidence: medium
---
`docs_publish` is only the first of three steps to a live site, and the other two are outside this repo. The Docusaurus connector writes files into the site checkout (cairn.json `docs.sitePath`, currently ~/sites/cairn-docs). Nothing is version-controlled or deployed until someone commits and pushes IN THAT REPO; a GitHub Pages workflow then builds and publishes. Set up 2026-09-20 at eventually-consistent-code/cairn-docs, live at https://eventually-consistent-code.github.io/cairn-docs/ — a user account, so it is a project page and `baseUrl` must stay `/cairn-docs/` in lockstep with the repo name.

The trap that cost two wrong conclusions in one session: Docusaurus does NOT serve files at their source paths. Images are content-hashed into /assets/images/<name>-<hash>.png, and numeric filename prefixes are stripped from page slugs (docs/adr/0017-foo.md serves at /adr/foo/). I twice reported a live page or image as 404 when the site was fine and my guessed URL was not. Read the built HTML for the real href, or fetch the directory page and pull the links out of it, before concluding anything is broken.

A republish rewrites one frontmatter line (`cairn_version`) on every page, so a large "modified" list in the site repo is expected; diff a file nothing should have touched to confirm the churn is only the stamp before committing.
