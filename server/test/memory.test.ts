import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  OBSERVATION_WARN_THRESHOLD,
  observationBacklog,
  observationThreshold,
  observationsPath,
} from "../src/memory/observations.js";
import { renderBanner } from "../src/memory/banner.js";
import { bannerPath } from "../src/core/continuity.js";
import { cardsDir, createCard, deleteCard, listCards, readCard } from "../src/memory/cards.js";
import { auditMemory } from "../src/memory/audit.js";
import {
  ARCHIVE_MARKER,
  compactCards,
  proposeCompaction,
  renderArchiveBody,
} from "../src/memory/compaction.js";

/**
 * #173 — the observation buffer announcing its own state, through mem_stats'
 * `observations` block and the session banner's "run retro" line.
 */

// The observation log lives in the cairn home (#362), which the server reads
// as os.homedir() -- so this file runs under a scratch HOME, never the real one.
let savedHome: string | undefined;
let scratchHome = "";
beforeAll(() => {
  savedHome = process.env.HOME;
  scratchHome = mkdtempSync(join(tmpdir(), "cairn-memory-home-"));
  process.env.HOME = scratchHome;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cairn-observations-"));
  dirs.push(d);
  return d;
};

/** A registered project, optionally with a custom warn threshold. */
const registered = (warnAt?: number) => {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify({
    tracker: { type: "github", config: { repo: "o/r" } },
    ...(warnAt === undefined ? {} : { memory: { tokenThreshold: 150000, observationWarnThreshold: warnAt } }),
  }));
  return d;
};

const DAY_MS = 86_400_000;

/** Writes `rows` observation lines, the oldest `ageDays` old, newest at `now`. */
function seedObservations(projectDir: string, rows: number, ageDays = 0, now = Date.now()): void {
  const path = observationsPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    // First row is the oldest; the rest march forward an hour at a time.
    const ts = new Date(now - ageDays * DAY_MS + i * 3_600_000).toISOString();
    lines.push(JSON.stringify({ ts, session_id: "s", tool: "Edit", target: "src/x.ts", error: false }));
  }
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(bannerPath(d), { force: true });
    rmSync(d, { recursive: true, force: true });
  }
});

describe("observationBacklog", () => {
  it("reports an empty backlog when the buffer file does not exist", () => {
    const d = registered();
    expect(observationBacklog(d)).toEqual({
      count: 0, oldest: null, oldestAgeDays: 0, threshold: 25, overThreshold: false,
      path: observationsPath(d),
    });
  });

  it("counts rows and ages the oldest one in whole days", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    seedObservations(d, 4, 6, now);
    const backlog = observationBacklog(d, now);
    expect(backlog.count).toBe(4);
    expect(backlog.oldest).toBe(new Date(now - 6 * DAY_MS).toISOString());
    expect(backlog.oldestAgeDays).toBe(6);
  });

  it("ages the oldest row even when the file is not in chronological order", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    const path = observationsPath(d);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      JSON.stringify({ ts: new Date(now - 1 * DAY_MS).toISOString(), tool: "Bash" }),
      JSON.stringify({ ts: new Date(now - 9 * DAY_MS).toISOString(), tool: "Bash" }),
      JSON.stringify({ ts: new Date(now - 3 * DAY_MS).toISOString(), tool: "Bash" }),
    ].join("\n") + "\n");
    expect(observationBacklog(d, now).oldestAgeDays).toBe(9);
  });

  it("counts a row it cannot parse but takes no age from it", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    const path = observationsPath(d);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      "{\"ts\": \"2026-09-1",                                                  // killed mid-write
      JSON.stringify({ ts: new Date(now - 2 * DAY_MS).toISOString(), tool: "Edit" }),
      JSON.stringify({ ts: 17, tool: "Edit" }),                                // wrong type
      JSON.stringify({ ts: "not-a-date", tool: "Edit" }),
      "",                                                                      // trailing newline
    ].join("\n"));
    const backlog = observationBacklog(d, now);
    expect(backlog.count).toBe(4);
    expect(backlog.oldestAgeDays).toBe(2);
  });

  it("never reports a negative age for a row written with clock skew", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    seedObservations(d, 1, -1, now); // one day into the future
    expect(observationBacklog(d, now).oldestAgeDays).toBe(0);
  });

  // #351: past its cap the hook renames the live file to a closed segment;
  // the backlog is the live file plus every closed one.
  it("counts closed segments and ages from the oldest row in any segment", () => {
    const now = Date.parse("2026-09-20T12:00:00.000Z");
    const d = registered();
    seedObservations(d, 3, 1, now);
    const live = observationsPath(d);
    const closed = join(dirname(live), `${basename(live, ".jsonl")}.20260910-120000-00.jsonl`);
    writeFileSync(closed, [
      JSON.stringify({ ts: new Date(now - 10 * DAY_MS).toISOString(), tool: "Edit" }),
      JSON.stringify({ ts: new Date(now - 8 * DAY_MS).toISOString(), tool: "Bash" }),
    ].join("\n") + "\n");
    const backlog = observationBacklog(d, now);
    expect(backlog.count).toBe(5);
    expect(backlog.oldestAgeDays).toBe(10);
    // A just-rotated buffer -- closed segment, no live file -- is not empty.
    rmSync(observationsPath(d));
    expect(observationBacklog(d, now).count).toBe(2);
  });

  it("is over threshold at exactly the threshold, not one past it", () => {
    const d = registered(3);
    seedObservations(d, 2);
    expect(observationBacklog(d).overThreshold).toBe(false);
    seedObservations(d, 3);
    expect(observationBacklog(d).overThreshold).toBe(true);
  });
});

describe("observationThreshold", () => {
  it("defaults to the shipped threshold when cairn.json omits the key", () => {
    expect(observationThreshold(registered())).toBe(OBSERVATION_WARN_THRESHOLD);
    expect(OBSERVATION_WARN_THRESHOLD).toBe(25);
  });

  it("honors an explicit memory.observationWarnThreshold", () => {
    expect(observationThreshold(registered(5))).toBe(5);
  });

  it("falls back to the default for an unregistered project instead of throwing", () => {
    // The backlog warning must survive exactly the conditions that break
    // everything else -- no cairn.json is not a reason to go quiet.
    expect(observationThreshold(dir())).toBe(OBSERVATION_WARN_THRESHOLD);
  });
});

describe("recall banner — observation backlog", () => {
  it("banner says nothing about observations below the threshold", () => {
    const d = registered(10);
    createCard(d, { type: "decision", body: "project-wide decision" });
    seedObservations(d, 9);
    expect(renderBanner(d)!).not.toContain("run retro");
  });

  it("banner flags the count and the oldest age past the threshold", () => {
    const d = registered(3);
    createCard(d, { type: "decision", body: "project-wide decision" });
    seedObservations(d, 42, 6);
    expect(renderBanner(d)!).toContain("**42 unreviewed observations (oldest 6d) — run retro**");
  });

  it("banner renders on the backlog alone, with no cards and no open sessions", () => {
    const d = registered(3);
    seedObservations(d, 30, 2);
    const rendered = renderBanner(d);
    expect(rendered).not.toBeNull();
    expect(rendered!).toContain("## cairn recall index — ");
    expect(rendered!).toContain("**30 unreviewed observations (oldest 2d) — run retro**");
    // Nothing else to show -- no card table headers.
    expect(rendered!).not.toContain("| id | type | title | fetch cost |");
  });

  it("banner puts the warning directly under the header, above the card table", () => {
    const d = registered(3);
    createCard(d, { type: "gotcha", body: "GitHub 403 means throttle, not just auth" });
    seedObservations(d, 5, 1);
    const lines = renderBanner(d)!.split("\n");
    expect(lines[0]).toContain("## cairn recall index — ");
    expect(lines[1]).toBe("**5 unreviewed observations (oldest 1d) — run retro**");
    expect(lines[2]).toBe("| id | type | title | fetch cost |");
  });

  it("banner singularizes a lone observation", () => {
    const d = registered(1);
    seedObservations(d, 1, 0);
    expect(renderBanner(d)!).toContain("**1 unreviewed observation (oldest 0d) — run retro**");
  });

  it("banner stays silent when the recall index is disabled, backlog or not", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      memory: { tokenThreshold: 150000, observationWarnThreshold: 3 },
      continuity: { recallIndex: { enabled: false } },
    }));
    seedObservations(d, 50, 9);
    expect(renderBanner(d)).toBeNull();
  });
});

/**
 * #172 -- retro-gated card compaction. The capacity guard's action: aged
 * low-confidence cards merge into ONE dated archive card whose provenance
 * carries their commits, and nothing is retired outside an approved batch.
 */
describe("compaction", () => {
  const NOW = Date.parse("2026-09-20T00:00:00Z");
  const OLD = "2026-01-01"; // ~262 days before NOW -- well past AGED_DAYS
  const NEWISH = "2026-09-19";

  /**
   * Writes a card and back-dates its `created`, since createCard always
   * stamps today and every candidate here has to be aged.
   */
  function seedCard(projectDir: string, body: string, opts: {
    created: string;
    confidence?: "high" | "medium" | "low";
    provenance?: Array<{ file: string; commit: string }>;
  }): string {
    const card = createCard(projectDir, {
      type: "gotcha",
      body,
      confidence: opts.confidence ?? "low",
      provenance: opts.provenance,
    });
    const path = join(cardsDir(projectDir), `${card.id}.md`);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace(/^created: .*$/m, `created: ${opts.created}`));
    return card.id;
  }

  /** Two aged low-confidence cards -- the smallest batch worth compacting. */
  function twoAged(projectDir: string): [string, string] {
    return [
      seedCard(projectDir, "hunch about the retry loop", { created: OLD }),
      seedCard(projectDir, "hunch about the cache key", { created: OLD }),
    ];
  }

  const ids = (d: string) => listCards(d, {}).map((c) => c.id).sort();

  it("proposes nothing while the card store is under its token threshold", () => {
    const d = dir();
    twoAged(d);
    const p = proposeCompaction(d, { now: NOW, threshold: 1_000_000 });
    expect(p.triggered).toBe(false);
    expect(p.overThreshold).toBe(false);
    expect(p.reason).toContain("under the");
    // The candidates are still reported -- retro shows the evidence either way.
    expect(p.retiring).toHaveLength(2);
  });

  it("proposes the aged batch once the store crosses the threshold", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    const p = proposeCompaction(d, { now: NOW, threshold: 1 });
    expect(p.triggered).toBe(true);
    expect(p.retiring.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(p.archiveBody).toContain(`${ARCHIVE_MARKER} 2026-09-20`);
    expect(p.archiveBody).toContain(a);
    expect(p.archiveBody).toContain(b);
    expect(p.tokensReclaimed).toBeGreaterThanOrEqual(0);
  });

  it("holds back a single candidate -- one card is not a compaction", () => {
    const d = dir();
    seedCard(d, "the only hunch", { created: OLD });
    const p = proposeCompaction(d, { now: NOW, threshold: 1 });
    expect(p.overThreshold).toBe(true);
    expect(p.triggered).toBe(false);
    expect(p.reason).toContain("need 2");
  });

  it("takes its candidates from auditMemory's aged list, not a second copy", () => {
    const d = dir();
    const aged = seedCard(d, "aged and unsure", { created: OLD });
    seedCard(d, "recent and unsure", { created: NEWISH });
    seedCard(d, "aged but certain", { created: OLD, confidence: "high" });
    const p = proposeCompaction(d, { now: NOW, threshold: 1 });
    expect(p.retiring.map((c) => c.id))
      .toEqual(auditMemory(d, NOW).aged.map((c) => c.id));
    expect(p.retiring.map((c) => c.id)).toEqual([aged]);
  });

  it("compacts an approved batch into one dated archive card", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    const result = compactCards(d, [a, b], { now: NOW });
    expect(result.retired.sort()).toEqual([a, b].sort());
    expect(ids(d)).toEqual([result.archiveId]);
    const archive = readCard(d, result.archiveId);
    expect(archive.body).toContain(`${ARCHIVE_MARKER} 2026-09-20`);
    expect(archive.body).toContain(a);
    expect(archive.body).toContain(b);
    // An archive is not a claim about the code -- and a `low` one would age
    // straight back into the next candidate list.
    expect(archive.frontmatter.confidence).toBeUndefined();
  });

  it("carries the retired cards' provenance onto the archive, deduplicated", () => {
    const d = dir();
    const a = seedCard(d, "hunch one", {
      created: OLD,
      provenance: [{ file: "src/a.ts", commit: "aaaaaaa" }, { file: "src/b.ts", commit: "bbbbbbb" }],
    });
    const b = seedCard(d, "hunch two", {
      created: OLD,
      // src/a.ts@aaaaaaa repeats -- the pair must collapse, not a single entry.
      provenance: [{ file: "src/a.ts", commit: "aaaaaaa" }, { file: "src/c.ts", commit: "ccccccc" }],
    });
    const result = compactCards(d, [a, b], { now: NOW });
    expect(result.provenanceFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(result.provenanceCommits).toEqual(["aaaaaaa", "bbbbbbb", "ccccccc"]);
    const archive = readCard(d, result.archiveId);
    expect(archive.frontmatter.provenanceFiles).toEqual(result.provenanceFiles);
    expect(archive.frontmatter.provenanceCommits).toEqual(result.provenanceCommits);
  });

  it("refuses a batch of fewer than two distinct cards, retiring nothing", () => {
    const d = dir();
    const [a] = twoAged(d);
    expect(() => compactCards(d, [a, a], { now: NOW })).toThrow(/at least 2 distinct cards/);
    expect(ids(d)).toHaveLength(2);
  });

  it("leaves the store untouched when an approved id has gone missing", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    // The approval drifted: something retired `b` between propose and apply.
    deleteCard(d, b);
    expect(() => compactCards(d, [a, b], { now: NOW })).toThrow(/no card/);
    // Write-then-delete means a failed read writes no archive and retires nothing.
    expect(ids(d)).toEqual([a]);
  });

  it("refuses to retire an archive card, so the trail cannot erode", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    const first = compactCards(d, [a, b], { now: NOW });
    const c = seedCard(d, "a third hunch", { created: OLD });
    expect(() => compactCards(d, [first.archiveId, c], { now: NOW }))
      .toThrow(/refusing to retire archive card/);
    expect(ids(d)).toEqual([first.archiveId, c].sort());
  });

  it("never offers its own archive as a later candidate", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    const first = compactCards(d, [a, b], { now: NOW });
    // Force the worst case the marker guard exists for: an archive that has
    // somehow acquired a low confidence and an old created date.
    const path = join(cardsDir(d), `${first.archiveId}.md`);
    writeFileSync(path, readFileSync(path, "utf8")
      .replace(/^created: .*$/m, `created: ${OLD}\nconfidence: low`));
    expect(auditMemory(d, NOW).aged.map((c) => c.id)).toEqual([first.archiveId]);
    expect(proposeCompaction(d, { now: NOW, threshold: 1 }).retiring).toEqual([]);
  });

  it("renders the same archive bytes for the same batch whatever the input order", () => {
    const d = dir();
    const [a, b] = twoAged(d);
    const cards = [readCard(d, a), readCard(d, b)];
    expect(renderArchiveBody(cards, "2026-09-20"))
      .toBe(renderArchiveBody([...cards].reverse(), "2026-09-20"));
  });

  it("refuses a card id that would escape the card store", () => {
    const d = dir();
    expect(() => deleteCard(d, "../../../etc/passwd")).toThrow(/invalid card id/);
    expect(deleteCard(d, "gotcha-deadbeef")).toBe(false);
  });
});
