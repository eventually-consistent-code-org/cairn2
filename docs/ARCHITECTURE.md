# Architecture

Cairn is a Claude Code plugin backed by a TypeScript MCP server. The plugin
layer (commands, skills, hooks) owns policy and judgment; the server owns
every mechanism with a wrong answer — state transitions, tracker mirroring,
drift math, staleness checks. External work trackers are the source of truth
for work items; git owns prose.

## Server subsystems
<!-- docs: done -->


The boundaries below are not only described here — `server/test/architecture.test.ts`
asserts them on every run, so this section and the code cannot drift apart
quietly. Four rules hold today:

1. **Tracker adapters are leaves.** A file under `tracker/adapters/` imports
   only from within `tracker/` or the root-level shared modules. An adapter
   implements the contract; it does not consume the rest of the server.
2. **The tracker subsystem sits underneath its callers.** Planning, audit and
   docs all read the tracker; the tracker imports none of them back. That
   one-way arrow is what makes the SPI a layer rather than a tangle.
3. **Docs connectors are a sibling, not an extension.** They may reuse four
   named tracker modules — `http`, `probe`, `types`, `registry` — and nothing
   else from it. The list is explicit because that shared plumbing is arguably
   misplaced (it is transport, not tracker logic); widening the list is a
   decision someone makes on purpose, and an entry that stops being used fails
   the test until it is deleted.
4. **`index.ts` is the composition root.** Nothing imports it back, and the
   whole tree is free of import cycles.

What is deliberately *not* asserted: that peer subsystems avoid each other.
They do not, legitimately — planning reads the tracker, audit reads planning,
memory reads sessions. A rule forbidding that would have to be watered down
until it said nothing, and a rule that cannot fail is worse than no rule.
Every rule above fails when its file pattern matches zero files, for the same
reason.

- `tracker/` — eight tracker adapters (GitHub, GitLab, Jira, Asana,
  Azure Boards, ClickUp, Linear, and a zero-credential local backend)
  behind one normalized interface with per-backend capability flags, a
  shared HTTP core (retry/backoff, typed errors), and a contract test
  suite every adapter must pass.
- `planning/` — plan artifacts, tracker mirroring, drift detection,
  per-phase distill manifests, milestone lifecycle — plus the headless-batch
  primitives: per-phase token estimation calibrated from recorded spend,
  the run manifest (push authorization and scope, ADR 0007), and the
  budget ledger enforcing the ceiling at phase/wave boundaries (ADR
  0008).

  The plan↔tracker drift report has grown six reasons, and they are not
  all the same kind of thing. Two are errors the scan must not let pass:
  an issue the plan names that the tracker has lost, and an issue closed
  inside a phase nothing has verified. One is a staleness claim — the
  latest security audit no longer describing the commit it judged. Two
  are advisory and say so everywhere they surface: work that has gone
  quiet, meaning an issue held in progress with no tracker update and no
  commit naming it, or a branch whose last commit has aged past the
  window. Advisory means neither stops a ship nor fails a verification;
  forgotten work is worth seeing and is never a reason to block a good
  push. The sixth is a repair rather than a complaint: the roadmap's
  Status column was the last piece of plan state nothing computed — only
  the route verb ever wrote a cell, by hand, so a phase could sit
  verified for a week with its row still reading "planned". The scan now
  patches that cell from the evidence on disk (a phase directory holding
  VERIFICATION.md) and reports what it changed, the same posture every
  other drift class already has; milestone completion sets the shipped
  rows from the same event that archives their directories. Narrow on
  both sides by design — only a cell still saying exactly "planned"
  moves, and only for a row the table already holds, because overwriting
  a human's wording or inventing rows would be a worse bug than the one
  being fixed.

  Two sibling scans sit beside it. `docs_drift` reports which verified
  phases the published documentation has not caught up with. The
  plan-quality scan reports contract drift, unanchored thresholds, a
  phase that never wrote down its design alternatives, and a task that
  never declared how it would be proved.

  Closing a task measures it as well. The close derives the duration
  from timestamps it already controls (the claim comment, else the
  claim the server saw) and leaves a local receipt carrying that
  measurement with its source, the estimate with each number's
  provenance, and the caller's own figure as a claim. The ledger
  append consumes the receipt into one key=value segment on the line,
  and falls back to git dates across the commit range when the close
  measured nothing, since it is the only tool holding that range. A
  missing receipt is written as a named degraded marker, never as
  blanks, and no part of this can fail a close or an append (ADRs 0020,
  0021).
- `memory/` — disposable FTS index + git-committed memory cards with
  provenance, staleness checking, and phase/issue/role scopes.
- `docs/` — documentation connectors (below) plus the marked-section
  writer: generated doc content lands only inside explicitly marked
  sections, never over hand-written prose (ADR 0006).
- `research/` — research-artifact section markers (scout/survey
  checkpoint discipline, server-validated; the docs writer shares this
  marker grammar).
- `sessions/` — persistent session stores for trace/probe/draft/thread
  work.
- `trace/` — debugging-session records (evidence → hypothesis → test →
  verdict).
- `audit/` — audit records: single-writer, date-scoped, immutable
  history.
- `map/` — the project knowledge graph (build, query, diff).
- `peers/` — external-CLI peer review and council runs (roster of
  five seats: codex, opencode, antigravity, grok, copilot; fixed-argv
  templates, a model pin for seats whose CLI takes one, the lab behind
  each seat, the child env minus tracker credentials, scratch-dir
  containment, the outbound leak gate, convergence state that records
  exit codes and names incomplete seats). ADR 0022 — removeWhen: the
  roster is composed by lab at dispatch, or every seated CLI exposes its
  model before the run.
- `seats/` — the review roster: seat schema and roster resolution,
  dose-tiered brief composition, signal dispatch with the yield store,
  and finding dedup (see the Seats subsystem section below).
- `workspace/` — multi-project workspaces and the dispatch board.
- `core/` — continuity, active context, project registry, outlook
  emission.

## Docs connector subsystem (v2)
<!-- docs: done -->

Publishes repo documentation outward to a team wiki. Deliberately a sibling
of the tracker subsystem, not an extension of it — trackers manage work
items, docs connectors publish documentation, and nothing is shared but the
HTTP core and the config pattern.

- **SPI** (`server/src/docs/types.ts`) — `DocsConnector` (ensureRoot,
  getPage, findPage, listChildren, createPage, updatePage) plus
  `DocsCapability` flags. Bodies cross the SPI as **markdown**; each adapter
  owns conversion to its product's native format. This keeps the interface
  neutral for future Notion / GitBook / Slite / SharePoint adapters.
- **Registry** (`server/src/docs/registry.ts`) — same two-level config shape
  as the tracker registry: the top-level config block names the connector
  and carries an opaque config record; the adapter module's Zod schema does
  the deep validation. Credentials never live in config — only env-var
  *names* do.
- **Confluence adapter** (`server/src/docs/adapters/confluence.ts`) —
  Confluence Cloud v2 REST client reusing the shared HTTP core, Atlassian
  API-token Basic auth, and a body-cursor pagination variant (Confluence
  puts the next link in the response body rather than a Link header).
  Projects follow the space convention: a **folder named for the project**
  under the space root, with the landing page and doc tree inside it
  (folder lookup is case-insensitive via CQL search; folders have no
  title-filtered v2 listing).
- **Docusaurus adapter** (`server/src/docs/adapters/docusaurus.ts`) — the
  default connector: a filesystem backend that writes the doc tree into a
  Docusaurus site checkout (markdown pages plus `_category_.json` for the
  sidebar tree). No HTTP, no credentials; optional auto-commit to the site
  repo, and it never pushes.
- **Converter** (`server/src/docs/markdown.ts`) — dependency-free
  markdown → Confluence storage format (XHTML) for a supported subset:
  headings, paragraphs, nested lists, fenced code (code macro with CDATA
  escaping), tables, blockquotes, links; images degrade to links and
  unknown constructs degrade to escaped text. Conversion never throws.
  List nesting clamps to one level per indent step — multi-level jumps
  previously produced unbalanced markup Confluence rejects.
- **Publisher** (`server/src/docs/publish.ts`) — README.md becomes the
  landing page; `docs/` (plus a root CHANGELOG.md) becomes the child page
  tree; directory pages get generated child listings and the landing page
  gets a Documentation contents section with real page URLs (two-pass
  publish). Idempotent: pages are matched by title + ancestry and updated
  in place. Confluence titles are unique per **space**, so a title already
  taken elsewhere publishes under a `Title (Context)` disambiguation
  instead of failing. Remote pages are never deleted when local files
  disappear — instead the publish result reports them as orphans
  (structured list + warning line), and every published page is stamped
  with the release it came from (Docusaurus front matter, Confluence
  footer; re-publish never duplicates the stamp).
- **Surface** — `docs_publish` / `docs_status` MCP tools with a per-project
  connector memo (evicted on config writes), and the `docs` verb for
  publish/status from chat.

### Testing

A shared behavioral contract suite (`server/test/docs-contract.ts`) runs
against every connector: the in-memory fake (which enforces the space-wide
unique-title rule so unit tests hit production constraints), and — behind
an environment gate — a live Confluence space. Publisher and converter are
pure and unit-tested without HTTP.

## Seats subsystem (v7)
<!-- docs: done -->

Named, reusable review viewpoints as data (v7). One Zod schema — name,
one-line lens, rubric categories, anchored 0-10 scale with an honesty
line, a REQUIRED injection dose (minimal | standard | full,
server-validated at load, ADR 0009), a convening stage (review | plan |
any, default review, validated the same way, ADR 0013), scope signals,
advisory model preference — with eight shipped defaults: five reproduce
review's classic axes byte-identically until a project overrides them
(ADR 0010), the interrogation seat convenes at plan time, the ux seat
joins review only when the diff touches UI files (`touches-ui`), and the
lean seat — code that should not exist, after ponytail's ladder — joins
when the diff is large or touches server code (`diff-large`,
`touches-server`).

- **Schema + roster** (`server/src/seats/schema.ts`, `roster.ts`) —
  flat-frontmatter seat files; project overrides by name from the
  project roles directory; shipped defaults from the plugin's
  templates; strict config block for enablement and the dispatch dial;
  `seatsForStage` filters convening by stage. Invalid files are
  skipped with a note and never shadow a default.
- **Brief composition** (`server/src/seats/brief.ts`) — wave-brief
  assembly at the seat's declared dose: lens only at minimal,
  categories and honesty line at standard, full anchors at full; an
  optional role-memory section ("what this seat remembers", stale
  cards marked) renders when the seat has role-scoped cards
  (ADR 0014) and is byte-absent otherwise. Section order is the
  template's and is load-bearing: static framing first (the prefix a
  provider can cache across a wave), then issue and plan, then the
  dated memory section, and the standing rules LAST at the recency
  end of the window.
- **Dispatch** (`server/src/seats/signals.ts`, `yield.ts`) —
  diff-derived scope signals select firing seats (opt-in per seat,
  full-panel off dial is the default); a persisted per-seat yield
  store retires low-evidence seats, floored so security and full-dose
  seats are never gated; the blast-radius routing rule always beats a
  seat's model preference (ADR 0011).
- **Dedup** (`server/src/seats/dedup.ts`) — location-and-claim merge
  producing one deterministic finding set crediting every raising
  seat, run before anything reaches the tracker (ADR 0012).
- **Consultation + challenge** — flags on existing verbs, zero new
  surface (ADR 0015): review consults one seat at its dose over a
  diff, file, plan, or question; plan's challenge round convenes
  plan-stage seats over a draft as proposed amendments, advisory
  never a gate.
- **Surface** — one `seat_roster` MCP tool (validate + list + dispatch
  dial); the roster also renders into every generated harness spine
  with a stage column under a CI drift rule. Internal seats are
  framing lenses; the external peers council remains the adversarial
  mechanism.

## Hook surface
<!-- docs: done -->

Nine dependency-free Node scripts, fired by the harness around tool
calls and session boundaries. They divide into three kinds, and the
distinction matters more than the count.

- **Recorders** write state and are invisible by construction: the
  breadcrumb that refreshes the session handoff, the observation
  capture, the session-start resume injection, and the stop-time cost
  tracker. Any error is a silent no-op — a recorder must never be the
  reason a session stops.
- **Refusers** block a tool call and say why. The leak guard stops a
  commit whose staged diff would carry internal references into source.
  The run guard keeps an unattended run out of the working directory a
  human is using. The harness guard protects the configuration that
  decides what the agent may do at all — the hook directory, the tool
  server config, the settings cascade, the plugin manifests — from the
  agent it configures. Each refuses in one plain line naming the file
  and the way to proceed deliberately, and each fails open: an error
  inside a guard exits zero rather than blocking work.
- **Advisers** say something and block nothing. The loop check notices
  the same tool called with the same input three times running and
  offers one line, once per streak.

Two properties hold across all three. They import no server code — the
path schemes they need are recomputed in a shared helper, so the server
stays the source of truth without becoming a dependency. And their
escape hatches share one shape: an assignment prefixed to the command,
prefix-only so that a mention elsewhere in the line cannot bypass the
guard.

The refusers are honest about their reach. They convert a silent
success into a refusal a human sees; they are not isolation. The shell
coverage is best-effort matching over command text rather than a shell
parser, and an override reachable by the agent is reachable by anything
that can steer the agent. That ordering — judgment first, deterministic
backstop second — is deliberate and documented rather than implied.
