---
verb: new
args: "[project name]"
status: live
---

Start a new cairn 2.0 project in this repo, per the `cairn-planning` skill.

1. Confirm `cairn.json` exists. Missing → one AskUserQuestion batching two
   choices: **tracker** — **local** first ("issues live in this repo as
   plain files; no accounts, no credentials"), then the hosted backends
   (github, gitlab, jira, asana, azure-boards, clickup, linear) — and
   **docs platform** — none (default), confluence, or docusaurus. Then
   cairn writes `cairn.json` itself from this plugin's
   `templates/cairn.json.example`: copy the template, set `tracker` to the
   chosen backend's block (top-level or from `_alternatives`), set `docs`
   from `_docs`/`_docs_docusaurus` when a docs platform was chosen, and
   drop every `_`-prefixed template key. Never tell the user to copy or
   edit the file by hand. Fill the backend-specific fields before writing:
   auto-detect what git already knows (`github`/`gitlab` repo from
   `git remote get-url origin`), and batch the rest (Jira baseUrl +
   projectKey, Confluence baseUrl + spaceKey, Docusaurus sitePath, …) in
   one follow-up AskUserQuestion — no placeholder values left behind
   silently. Credentials stay env vars: name the vars the chosen backends
   read (from the template blocks) and continue; missing creds surface at
   the first tracker call, not as a setup stop. Local tracker chosen →
   also check `.gitignore`: if any pattern matches `.tracker/`, show the
   offending line and stop until the user removes it — the store only
   works committed.
2. Interview the user briefly: vision, 3–10 requirements, phase breakdown. Native
   plan mode is appropriate for this conversation at standard/deep depth.
   The interview also asks the mode once (skip when cairn.json already
   sets `user.mode`): vibe — cairn drives end-to-end (default) — or
   engineer — you claim issues, write code, and make the design calls;
   cairn pairs, verifies, and keeps the tracker mirror honest for both.
   Engineer chosen → collect the tracker handle too and set both via
   `config_set` in one patch.
3. `plan_scaffold_project(name: <argument or the agreed name>)`, then write the
   vision and requirements into `.cairn/plans/PROJECT.md` and the phase table
   into `roadmap.md`.
4. For each phase N: `plan_scaffold_phase(number, name)` and
   `plan_phase_ensure(number, name)` → the tracker's `Phase N: <name>` phase.
5. For each requirement: `issue_create(title, body, phase: "<N>")` — the
   cairn phase number, never the tracker's phase id (on GitHub that id is a
   milestone number, and a bare number always means a cairn phase) — then
   record the ids per phase with `plan_issues_set(phaseDir, issues)`.
6. Report: phases created, issues created, next step `/cairn:survey`
   (project-wide research while unknowns are at their peak), then
   `/cairn:plan 1`. Recommendation only — never auto-run survey.
