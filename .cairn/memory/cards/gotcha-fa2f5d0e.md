---
type: gotcha
provenanceFiles: [server/dist/planning/docs-drift.js]
provenanceCommits: [fc0de75]
created: 2026-09-08
scopePhase: 15
confidence: high
---
Dogfood lag: while developing cairn in cairn, the RUNNING plugin server (versioned cache, pinned release) lags repo main — newly built MCP tools are not callable in-session (outlook_emit and docs_drift were both unavailable mid-v5 despite existing in the repo). Workaround: invoke the freshly built module directly, e.g. node --input-type=module -e "import('server/dist/planning/docs-drift.js')...". Resolves permanently at next release + /reload-plugins; verbs that call new tools must treat MISSING TOOL as the skip-on-error path during dogfood.
