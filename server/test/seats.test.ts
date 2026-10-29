import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/index.js";
import { FakeTracker } from "../src/tracker/fake.js";
import { CairnError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";
import { parseSeatDoc } from "../src/seats/schema.js";
import { loadRoster, seatsForStage, type Roster } from "../src/seats/roster.js";
import { composeBrief } from "../src/seats/brief.js";
import {
  deriveSignals,
  selectSeats,
  resolveSeatModel,
  ROUTING_TABLE,
} from "../src/seats/signals.js";
import {
  loadYield,
  recordYield,
  yieldRate,
  yieldStatePath,
  YIELD_MIN_DISPATCHES,
  YIELD_GATE_RATE,
  type YieldCounters,
} from "../src/seats/yield.js";

// Builds a valid seat doc, with per-test frontmatter overrides. An override
// value of undefined DROPS the line entirely (the missing-field cases).
function seatDoc(over: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    name: "correctness",
    lens: "logic errors and drifting state",
    categories: "[logic, edge-cases]",
    dose: "standard",
    signals: "[code]",
    anchor_ten: "every path traced and sound",
    anchor_five: "happy path sound, an edge unexamined",
    anchor_zero: "a reachable logic error is present",
    honesty: "unscored beats invented",
    ...over,
  };
  const lines = Object.entries(base)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\nThe lens prose body.\n`;
}

// Seeds a temp project dir with cairn.json (plus optional seats block) and
// optional .cairn/roles/ seat files.
function makeProject(opts: {
  seats?: Record<string, unknown>;
  roles?: Record<string, string>;
} = {}): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-seats-"));
  writeFileSync(
    join(d, "cairn.json"),
    JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      ...(opts.seats ? { seats: opts.seats } : {}),
    }),
  );
  if (opts.roles) {
    mkdirSync(join(d, ".cairn", "roles"), { recursive: true });
    for (const [file, text] of Object.entries(opts.roles)) {
      writeFileSync(join(d, ".cairn", "roles", file), text);
    }
  }
  return d;
}

// Shipped-default roster order == filename order (the 01-..08- prefixes in
// templates/seats/ enforce it). The first five are review's axes in review's
// order — the byte-identical promise (ADR 0010); the sixth (interrogation)
// is the plan-stage seat and never joins the diff panel; the seventh (ux)
// is review-stage but signal-gated on touches-ui, so under auto dispatch a
// server-only diff still convenes the five axes without it; the eighth
// (lean) is review-stage, gated on diff-large or touches-server, so it
// joins a server diff and sits out a small docs-only one.
const REVIEW_PANEL_NAMES = [
  "correctness",
  "clarity",
  "architecture",
  "security",
  "tests",
];
// The full review-stage roster: the five axes first, then the signal-gated
// default seats.
const REVIEW_STAGE_NAMES = [...REVIEW_PANEL_NAMES, "ux", "lean"];
const DEFAULT_NAMES = [...REVIEW_PANEL_NAMES, "interrogation", "ux", "lean"];

// Review's flow: stage-filter the roster FIRST, then dispatch — the panel
// selectSeats sees is exactly the review-stage seats.
const reviewPanel = (r: Roster): Roster => ({
  ...r,
  seats: seatsForStage(r, "review"),
});

describe("seat schema (parseSeatDoc)", () => {
  it("accepts a full valid definition and composes the nested scale", () => {
    const { seat, body } = parseSeatDoc(seatDoc(), "/x/correctness.md");
    expect(seat.name).toBe("correctness");
    expect(seat.categories).toEqual(["logic", "edge-cases"]);
    expect(seat.dose).toBe("standard");
    expect(seat.signals).toEqual(["code"]);
    expect(seat.scale.anchors.ten).toBe("every path traced and sound");
    expect(seat.scale.anchors.zero).toBe("a reachable logic error is present");
    expect(seat.scale.honesty).toBe("unscored beats invented");
    expect(seat.model).toBeUndefined();
    expect(body).toContain("The lens prose body.");
  });

  it("missing dose is CONFIG_INVALID naming the file and the field", () => {
    try {
      parseSeatDoc(seatDoc({ dose: undefined }), "/proj/.cairn/roles/bad.md");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      const err = e as CairnError;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.message).toContain("/proj/.cairn/roles/bad.md");
      expect(err.message).toContain("dose: required");
      expect(err.message).toContain("minimal | standard | full");
    }
  });

  it("an invalid dose value is CONFIG_INVALID naming the field", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ dose: "maximal" }), "/x/s.md"),
    ).toThrowError(/\/x\/s\.md.*dose/);
  });

  it("rejects a non-kebab name", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ name: "Correct_Ness" }), "/x/s.md"),
    ).toThrowError(/name.*kebab/);
  });

  it("maps nested-scale errors back to the flat frontmatter key", () => {
    expect(() =>
      parseSeatDoc(seatDoc({ anchor_ten: undefined }), "/x/s.md"),
    ).toThrowError(/anchor_ten/);
  });

  it("accepts the advisory model and rejects unknown values", () => {
    const { seat } = parseSeatDoc(seatDoc({ model: "haiku" }), "/x/s.md");
    expect(seat.model).toBe("haiku");
    expect(() =>
      parseSeatDoc(seatDoc({ model: "gpt" }), "/x/s.md"),
    ).toThrowError(/model/);
  });

  it("stage defaults to review when the frontmatter omits it", () => {
    const { seat } = parseSeatDoc(seatDoc(), "/x/s.md");
    expect(seat.stage).toBe("review");
  });

  it("stage accepts review | plan | any", () => {
    for (const stage of ["review", "plan", "any"] as const) {
      const { seat } = parseSeatDoc(seatDoc({ stage }), "/x/s.md");
      expect(seat.stage).toBe(stage);
    }
  });

  it("a bad stage value is CONFIG_INVALID naming the file and the field", () => {
    try {
      parseSeatDoc(seatDoc({ stage: "shipping" }), "/proj/.cairn/roles/s.md");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      const err = e as CairnError;
      expect(err.code).toBe("CONFIG_INVALID");
      expect(err.message).toContain("/proj/.cairn/roles/s.md");
      expect(err.message).toContain("stage");
    }
  });
});

describe("seat roster (loadRoster)", () => {
  it("no project seats, no seats block: the eight shipped defaults", () => {
    const roster = loadRoster(makeProject());
    expect(roster.seats.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    expect(roster.seats.every((s) => s.valid && s.source === "default")).toBe(
      true,
    );
    expect(roster.notes).toEqual([]);
  });

  it("interrogation ships as the sixth default: stage plan, dose full, no signals", () => {
    const roster = loadRoster(makeProject());
    const seat = roster.seats.find((s) => s.name === "interrogation")?.seat;
    expect(seat).toBeDefined();
    expect(seat?.stage).toBe("plan");
    expect(seat?.dose).toBe("full");
    expect(seat?.signals).toEqual([]); // plan-stage seats always convene at their stage
    expect(seat?.model).toBeUndefined(); // no model preference
    expect(seat?.categories).toEqual([
      "audience",
      "failure-modes",
      "why-now",
      "scope-honesty",
    ]);
    // the five review defaults stay stage review — implicitly, via the default
    for (const name of REVIEW_PANEL_NAMES) {
      expect(
        roster.seats.find((s) => s.name === name)?.seat?.stage,
        `${name} stage`,
      ).toBe("review");
    }
  });

  it("ux ships as the seventh default: stage review, dose minimal, gated on touches-ui", () => {
    const roster = loadRoster(makeProject());
    const names = roster.seats.map((s) => s.name);
    expect(names.indexOf("ux")).toBe(names.indexOf("interrogation") + 1);
    const seat = roster.seats.find((s) => s.name === "ux")?.seat;
    expect(seat).toBeDefined();
    expect(seat?.stage).toBe("review");
    expect(seat?.dose).toBe("minimal");
    expect(seat?.signals).toEqual(["touches-ui"]); // the one gate — never fires on a server-only diff
    expect(seat?.model).toBeUndefined();
    expect(seat?.categories).toEqual([
      "states",
      "accessibility",
      "responsiveness",
      "interaction",
    ]);
    // honesty line: unread means unscored
    expect(seat?.scale.honesty).toContain("unread means unscored");
  });

  it("lean ships as the eighth default: stage review, dose minimal, gated on diff-large or touches-server", () => {
    const roster = loadRoster(makeProject());
    expect(roster.seats.at(-1)?.name).toBe("lean"); // after ux — last
    const seat = roster.seats.find((s) => s.name === "lean")?.seat;
    expect(seat).toBeDefined();
    expect(seat?.stage).toBe("review");
    expect(seat?.dose).toBe("minimal");
    // two gates: a server diff seats it, a small docs-only diff does not
    expect(seat?.signals).toEqual(["diff-large", "touches-server"]);
    expect(seat?.model).toBeUndefined();
    expect(seat?.categories).toEqual([
      "necessity",
      "reuse",
      "dependencies",
      "abstraction",
    ]);
    // honesty line: "unused" / "already exists" needs the grep that proves it
    expect(seat?.scale.honesty).toContain("grep that proves it");
    expect(seat?.scale.honesty).toContain("unscored");
  });

  it("a project seat overrides the default by name, in place", () => {
    const d = makeProject({
      roles: { "my-correctness.md": seatDoc({ lens: "project lens" }) },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    const seat = roster.seats.find((s) => s.name === "correctness")!;
    expect(seat.source).toBe("project");
    expect(seat.seat?.lens).toBe("project lens");
  });

  it("a project seat with a new name appends", () => {
    const d = makeProject({
      roles: { "perf.md": seatDoc({ name: "performance" }) },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual([
      ...DEFAULT_NAMES,
      "performance",
    ]);
    expect(roster.seats.at(-1)?.source).toBe("project");
  });

  it("enabled picks AND orders; unknown names become notes", () => {
    const d = makeProject({
      seats: { enabled: ["tests", "correctness", "ghost"] },
    });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual(["tests", "correctness"]);
    expect(roster.notes).toHaveLength(1);
    expect(roster.notes[0]).toContain("'ghost'");
  });

  it("disabled removes by name; the rest keep default order", () => {
    const d = makeProject({ seats: { disabled: ["security", "clarity"] } });
    const roster = loadRoster(d);
    expect(roster.seats.map((s) => s.name)).toEqual([
      "correctness",
      "architecture",
      "tests",
      "interrogation",
      "ux",
      "lean",
    ]);
  });

  it("one bad project file skips that seat with a note — roster loads", () => {
    const d = makeProject({
      roles: {
        "broken.md": seatDoc({ name: "broken-seat", dose: undefined }),
        "perf.md": seatDoc({ name: "performance" }),
      },
    });
    const roster = loadRoster(d);
    const bad = roster.seats.find((s) => !s.valid)!;
    expect(bad.name).toBe("broken");
    expect(bad.source).toBe("project");
    expect(bad.note).toContain("dose");
    // the good ones all survived
    expect(roster.seats.filter((s) => s.valid).map((s) => s.name)).toEqual([
      ...DEFAULT_NAMES,
      "performance",
    ]);
  });

  it("an invalid override never shadows the default it aimed at", () => {
    const d = makeProject({
      roles: { "correctness.md": seatDoc({ dose: "wrong" }) },
    });
    const roster = loadRoster(d);
    const def = roster.seats.find((s) => s.name === "correctness" && s.valid)!;
    expect(def.source).toBe("default");
    expect(roster.seats.some((s) => !s.valid && s.note?.includes("dose"))).toBe(
      true,
    );
  });
});

describe("stage filtering (seatsForStage)", () => {
  it("review stage seats the five axes then ux then lean; plan stage seats interrogation", () => {
    const roster = loadRoster(makeProject());
    expect(seatsForStage(roster, "review").map((s) => s.name)).toEqual(
      REVIEW_STAGE_NAMES,
    );
    expect(seatsForStage(roster, "plan").map((s) => s.name)).toEqual([
      "interrogation",
    ]);
  });

  it("a plan-stage project seat is excluded from the review panel, included at plan", () => {
    const roster = loadRoster(makeProject({
      roles: {
        "10-ambition.md": seatDoc({
          name: "ambition", stage: "plan", signals: "[]",
        }),
      },
    }));
    expect(seatsForStage(roster, "review").map((s) => s.name)).toEqual(
      REVIEW_STAGE_NAMES,
    );
    expect(seatsForStage(roster, "plan").map((s) => s.name)).toEqual([
      "interrogation",
      "ambition",
    ]);
  });

  it("an any-stage seat convenes at both stages", () => {
    const roster = loadRoster(makeProject({
      roles: { "10-everywhere.md": seatDoc({ name: "everywhere", stage: "any" }) },
    }));
    expect(seatsForStage(roster, "review").map((s) => s.name)).toContain(
      "everywhere",
    );
    expect(seatsForStage(roster, "plan").map((s) => s.name)).toContain(
      "everywhere",
    );
  });

  it("invalid roster entries never seat at any stage", () => {
    const roster = loadRoster(makeProject({
      roles: { "bad.md": seatDoc({ name: "bad-seat", dose: undefined }) },
    }));
    for (const stage of ["review", "plan"] as const) {
      expect(seatsForStage(roster, stage).every((s) => s.valid)).toBe(true);
    }
  });
});

describe("seats config block", () => {
  it("unknown keys in the seats block are rejected", () => {
    const d = makeProject({ seats: { enabled: ["tests"], order: ["x"] } });
    expect(() => loadConfig(d)).toThrowError(/seats/);
  });

  it("absent block parses as undefined (today's behavior)", () => {
    expect(loadConfig(makeProject()).seats).toBeUndefined();
  });
});

describe("seat_roster tool", () => {
  it("returns the wire shape over MCP", async () => {
    const projectDir = makeProject({
      roles: { "broken.md": seatDoc({ name: "broken-seat", lens: undefined }) },
    });
    const server = buildServer({
      projectDir,
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({
      name: "seat_roster",
      arguments: {},
    });
    const roster = JSON.parse(
      (res.content as Array<{ text: string }>)[0].text,
    );
    expect(roster.seats).toHaveLength(9); // eight defaults + the broken project seat
    const correctness = roster.seats.find(
      (s: { name: string }) => s.name === "correctness",
    );
    expect(correctness).toMatchObject({
      source: "default",
      valid: true,
      dose: "standard",
      stage: "review",
    });
    const interrogation = roster.seats.find(
      (s: { name: string }) => s.name === "interrogation",
    );
    expect(interrogation).toMatchObject({
      source: "default",
      valid: true,
      dose: "full",
      stage: "plan",
    });
    const ux = roster.seats.find((s: { name: string }) => s.name === "ux");
    expect(ux).toMatchObject({
      source: "default",
      valid: true,
      dose: "minimal",
      stage: "review",
      signals: ["touches-ui"],
    });
    const lean = roster.seats.find((s: { name: string }) => s.name === "lean");
    expect(lean).toMatchObject({
      source: "default",
      valid: true,
      dose: "minimal",
      stage: "review",
      signals: ["diff-large", "touches-server"],
    });
    expect(correctness.lens).toContain("logic errors");
    expect(Array.isArray(correctness.categories)).toBe(true);
    expect(Array.isArray(correctness.signals)).toBe(true);
    const broken = roster.seats.find(
      (s: { name: string }) => s.name === "broken",
    );
    expect(broken.valid).toBe(false);
    expect(broken.note).toContain("lens");
    await client.close();
  });

  // Regression pin — the fold-never-stack promise, machine-checked: with no
  // project seats and no seats config block, the REVIEW-STAGE roster consumed
  // over MCP (stage review|any — review's panel filter) opens with review's
  // five axes, in review's order, with review's category coverage — and
  // ONLY signal-gated default seats (ux on touches-ui, lean on diff-large or
  // touches-server) sit after them, so the five always lead and every seat
  // behind them has a gate (ADR 0010, amendment 2026-10-14). The plan-stage
  // interrogation seat rides the roster but never this panel. If this test
  // moves, review's default behavior moved with it.
  it("no-config review panel is review's five axes first, in order, then ux, then lean (byte-identical pin)", async () => {
    const server = buildServer({
      projectDir: makeProject(),
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "seat_roster", arguments: {} });
    const roster = JSON.parse(
      (res.content as Array<{ text: string }>)[0].text,
    ) as {
      seats: Array<{
        name: string;
        categories: string[];
        signals: string[];
        source: string;
        valid: boolean;
        stage: string;
      }>;
      notes?: string[];
    };

    // Review's panel filter over the wire shape: stage review or any.
    const panel = roster.seats.filter(
      (s) => s.valid && (s.stage === "review" || s.stage === "any"),
    );

    // The five review axes, in their order, FIRST — byte-identical.
    expect(panel.slice(0, 5).map((s) => s.name)).toEqual([
      "correctness",
      "clarity",
      "architecture",
      "security",
      "tests",
    ]);
    // Then only the signal-gated defaults: ux, then lean, and nothing else.
    // Any seat sitting here must declare at least one signal, or it would
    // fire on every pass and break the unconfigured-projects promise.
    expect(panel.slice(5).map((s) => s.name)).toEqual(["ux", "lean"]);
    for (const s of panel.slice(5)) {
      expect(s.signals.length, `${s.name} must be signal-gated`).toBeGreaterThan(0);
    }
    expect(
      roster.seats.every((s) => s.valid && s.source === "default"),
    ).toBe(true);
    expect(roster.notes).toBeUndefined();

    // Today's category coverage per axis — the rubric didn't drift either.
    const byName = Object.fromEntries(
      panel.map((s) => [s.name, s.categories]),
    );
    expect(byName.correctness).toEqual([
      "logic",
      "edge-cases",
      "off-by-ones",
      "state-drift",
    ]);
    expect(byName.clarity).toEqual(["naming", "intent", "comments"]);
    expect(byName.architecture).toEqual(["layering", "coupling", "reuse"]);
    expect(byName.security).toEqual([
      "injection",
      "auth",
      "secrets",
      "trust-boundaries",
    ]);
    expect(byName.tests).toEqual(["coverage", "failability"]);
    expect(byName.ux).toEqual([
      "states",
      "accessibility",
      "responsiveness",
      "interaction",
    ]);
    expect(byName.lean).toEqual([
      "necessity",
      "reuse",
      "dependencies",
      "abstraction",
    ]);
    await client.close();
  });
});

describe("wave-brief composition (composeBrief)", () => {
  // A validated seat + body straight through the real parser, so the
  // brief tests exercise the same shape the roster hands out.
  function makeSeat(over: Record<string, string | undefined> = {}) {
    return parseSeatDoc(seatDoc(over), "test-seat.md");
  }

  const BASE = {
    issue: "#160 — wave-brief templates\nBriefs compose from seat templates.",
    planExcerpt: "Wave 2 task: briefs = seat template + issue + PLAN.",
    rules: "Expected base: abc1234. Run `npm ci` in server/ first.",
  };

  // Section headings, in order — the structural fingerprint of a brief.
  function headings(text: string): string[] {
    return text.split("\n").filter((l) => l.startsWith("## "));
  }

  it("seatless: generic brief with every standing section, no leftovers", () => {
    const brief = composeBrief(BASE);
    // Invariants LAST — the recency end is the attention peak, so the
    // standing rules sit after the issue and plan content, not before.
    expect(headings(brief)).toEqual([
      "## Task",
      "## Plan excerpt",
      "## Report",
      "## Standing rules",
    ]);
    expect(brief.trimEnd().endsWith(BASE.rules)).toBe(true);
    expect(brief).toContain(BASE.issue);
    expect(brief).toContain(BASE.planExcerpt);
    expect(brief).toContain(BASE.rules);
    expect(brief).toContain("git merge --ff-only main");
    expect(brief).toContain("Leak-guard discipline");
    expect(brief).not.toContain("## Seat:");
    expect(brief).not.toContain("{{");
    expect(brief).not.toContain("\n\n\n");
  });

  it("with a seat: framing section leads, same structure otherwise", () => {
    const { seat, body } = makeSeat();
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    const [first, ...rest] = headings(brief);
    expect(first).toBe("## Seat: correctness");
    expect(rest).toEqual(headings(composeBrief(BASE)));
    // Standard dose: lens + categories + honesty line, quoted verbatim.
    expect(brief).toContain("Lens: logic errors and drifting state");
    expect(brief).toContain("Categories: logic, edge-cases");
    expect(brief).toContain("Honesty: unscored beats invented");
    expect(brief).not.toContain("Anchors:");
    expect(brief).not.toContain("The lens prose body.");
  });

  it("minimal dose: lens only", () => {
    const { seat, body } = makeSeat({ dose: "minimal" });
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    expect(brief).toContain("Lens: logic errors and drifting state");
    expect(brief).not.toContain("Categories:");
    expect(brief).not.toContain("Honesty:");
    expect(brief).not.toContain("Anchors:");
  });

  it("full dose: anchors and the lens prose body ride along", () => {
    const { seat, body } = makeSeat({ dose: "full" });
    const brief = composeBrief({ ...BASE, seat, seatBody: body });
    expect(brief).toContain("Categories: logic, edge-cases");
    expect(brief).toContain(
      "Anchors: 10 — every path traced and sound; " +
        "5 — happy path sound, an edge unexamined; " +
        "0 — a reachable logic error is present",
    );
    expect(brief).toContain("The lens prose body.");
  });

  it("roleCards: 'what this seat remembers' rides below the plan excerpt", () => {
    const { seat, body } = makeSeat();
    const brief = composeBrief({
      ...BASE,
      seat,
      seatBody: body,
      roleCards: [
        {
          body: "prefer typed errors over\nraw throws here",
          confidence: "high",
          created: "2026-09-01",
          stale: false,
        },
        { body: "the auth layer moved once already", created: "2026-08-15", stale: false },
      ],
    });
    // Dated lines never belong in the cacheable prefix: memory renders in
    // its own slot below the plan excerpt, above the report + invariants.
    expect(headings(brief)).toEqual([
      "## Seat: correctness",
      "## Task",
      "## Plan excerpt",
      "## What this seat remembers",
      "## Report",
      "## Standing rules",
    ]);
    // one line per card: created + optional confidence, body flattened
    expect(brief).toContain(
      "- (2026-09-01; confidence high) prefer typed errors over raw throws here",
    );
    expect(brief).toContain("- (2026-08-15) the auth layer moved once already");
    expect(brief).not.toContain("STALE");
    expect(brief).not.toContain("\n\n\n");
  });

  it("a stale roleCard is marked as such in its rendered line", () => {
    const { seat, body } = makeSeat();
    const brief = composeBrief({
      ...BASE,
      seat,
      seatBody: body,
      roleCards: [
        {
          body: "helper lives in utils/",
          confidence: "low",
          created: "2026-07-01",
          stale: true,
        },
      ],
    });
    expect(brief).toContain(
      "- (2026-07-01; confidence low; STALE — verify before leaning on it) " +
        "helper lives in utils/",
    );
  });

  it("roleCards absent or empty: byte-identical to today's output (pin)", () => {
    const { seat, body } = makeSeat();
    const withSeat = composeBrief({ ...BASE, seat, seatBody: body });
    // empty array === field absent === pre-roleCards output, byte for byte
    expect(composeBrief({ ...BASE, seat, seatBody: body, roleCards: [] }))
      .toBe(withSeat);
    expect(composeBrief({ ...BASE, roleCards: [] })).toBe(composeBrief(BASE));
    expect(withSeat).not.toContain("What this seat remembers");
    expect(composeBrief(BASE)).not.toContain("What this seat remembers");
  });

  it("the cacheable prefix is the same bytes with or without memory", () => {
    const { seat, body } = makeSeat();
    // Everything above ## Task is what a provider's prefix cache holds
    // across a wave — dated card lines must never churn it.
    const prefix = (t: string) => t.slice(0, t.indexOf("## Task"));
    const bare = composeBrief({ ...BASE, seat, seatBody: body });
    const remembering = composeBrief({
      ...BASE,
      seat,
      seatBody: body,
      roleCards: [{ body: "auth moved once", created: "2026-08-15", stale: true }],
    });
    expect(prefix(remembering)).toBe(prefix(bare));
    expect(remembering).toContain("auth moved once");
  });

  it("model (#406): one line after the standing rules, before {{rules}}; absent says the worker inherits", () => {
    // Per-task content, so it rides at the bottom beside the rules and
    // never in the prefix; the wave's rules block still ends the brief.
    const prefix = (t: string) => t.slice(0, t.indexOf("## Task"));
    const bare = composeBrief(BASE);
    const inherit = "Model: the session model, inherited — no routing was resolved for this task.";
    expect(bare).toContain(inherit);
    expect(bare.indexOf(inherit)).toBeGreaterThan(bare.indexOf("## Standing rules"));
    expect(bare.indexOf(inherit)).toBeLessThan(bare.indexOf(BASE.rules));
    expect(bare.trimEnd().endsWith(BASE.rules)).toBe(true);

    const routed = composeBrief({ ...BASE, model: { model: "haiku", by: "rubric", workClass: "mechanical" } });
    expect(routed).toContain("Model: haiku — mechanical work, by the routing rubric. " +
      "Any subagent you spawn runs at or below this tier.");
    expect(routed).not.toContain(inherit);
    expect(prefix(routed)).toBe(prefix(bare));
    expect(composeBrief({ ...BASE, model: { model: "opus", by: "annotation" } }))
      .toContain("Model: opus — the task's `model:` annotation.");
    expect(composeBrief({ ...BASE, model: { model: "sonnet", by: "pin" } }))
      .toContain("Model: sonnet — pinned by agents.model.");
    expect(composeBrief({ ...BASE, model: { by: "pin" } }))
      .toContain("Model: the session model — agents.model is inherit.");
    expect(composeBrief({ ...BASE, model: { by: "inherit" } }))
      .toContain("Model: the session model, inherited — the task could not be classified.");
    expect(routed).not.toContain("{{model}}");
    expect(routed).not.toContain("\n\n\n");
  });

  it("rules omitted: slot renders empty, never a dangling marker", () => {
    const brief = composeBrief({
      issue: BASE.issue,
      planExcerpt: BASE.planExcerpt,
    });
    expect(brief).not.toContain("{{rules}}");
    expect(brief).not.toContain("\n\n\n");
  });

  it("missing template: typed NOT_FOUND naming the expected path", () => {
    const d = mkdtempSync(join(tmpdir(), "cairn-brief-"));
    try {
      composeBrief({ ...BASE, rootDir: d });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("NOT_FOUND");
      expect((e as CairnError).nextAction).toContain(
        join("templates", "wave-brief.md"),
      );
    }
  });
});

describe("signal derivation (deriveSignals)", () => {
  // Path-derived table — one representative diff per standard signal.
  const mid = { insertions: 100, deletions: 100 }; // neither small nor large
  const cases: Array<[string, string[], string[]]> = [
    ["server code", ["server/src/index.ts"], ["touches-server"]],
    ["docs by extension", ["README.md"], ["touches-docs"]],
    ["docs by segment", ["docs/guide.md"], ["touches-docs"]],
    ["tests", ["server/test/mcp.test.ts"], ["touches-server", "touches-tests"]],
    ["config", ["cairn.json"], ["touches-config"]],
    ["ci workflow", [".github/workflows/ci.yml"], ["touches-ci", "touches-config"]],
    ["scripts", ["scripts/deploy.sh"], ["touches-scripts"]],
    ["auth-shaped path", ["server/src/auth/login.ts"], ["touches-auth", "touches-server"]],
  ];
  for (const [label, files, expected] of cases) {
    it(`derives ${label} → [${expected.join(", ")}]`, () => {
      expect(deriveSignals({ files, ...mid })).toEqual(expected);
    });
  }

  // touches-ui — every listed extension and path segment, one at a time, so
  // dropping any single rule fails exactly one case. Paths are kept free of
  // the other vocabularies' triggers so the assertion is the ux gate alone.
  const UI_EXTS = ["css", "scss", "less", "tsx", "jsx", "vue", "svelte", "html"];
  for (const ext of UI_EXTS) {
    it(`touches-ui fires on a .${ext} file`, () => {
      expect(deriveSignals({ files: [`web/widget.${ext}`], ...mid }))
        .toEqual(["touches-ui"]);
    });
  }
  const UI_SEGS = ["components", "ui", "pages", "views", "layouts"];
  for (const seg of UI_SEGS) {
    it(`touches-ui fires on a ${seg}/ path segment`, () => {
      expect(deriveSignals({ files: [`web/${seg}/thing.ts`], ...mid }))
        .toEqual(["touches-ui"]);
    });
  }

  it("touches-ui matches case-insensitively and rides alongside other signals", () => {
    expect(deriveSignals({ files: ["server/src/Components/Table.TSX"], ...mid }))
      .toEqual(["touches-server", "touches-ui"]);
  });

  it("touches-ui does NOT fire on a server-only diff", () => {
    const s = deriveSignals({
      files: [
        "server/src/index.ts",
        "server/src/seats/signals.ts",
        "server/test/seats.test.ts",
        "server/package.json",
        "scripts/check-surface.mjs",
        "docs/ARCHITECTURE.md",
      ],
      ...mid,
    });
    expect(s).not.toContain("touches-ui");
    // a .ts file or a "uitools" folder is not a UI file — exact segments only
    expect(deriveSignals({ files: ["server/src/uitools/build.ts"], ...mid }))
      .not.toContain("touches-ui");
  });

  it("size signals: strict bounds, mid-size diffs emit neither", () => {
    expect(deriveSignals({ files: ["a.txt"], insertions: 10, deletions: 5 }))
      .toEqual(["diff-small"]);
    expect(deriveSignals({ files: ["a.txt"], insertions: 600, deletions: 0 }))
      .toEqual(["diff-large"]);
    expect(deriveSignals({ files: ["a.txt"], insertions: 250, deletions: 250 }))
      .toEqual([]);
    // exactly at the bounds: 50 is not small, 500 is not large
    expect(deriveSignals({ files: ["a.txt"], insertions: 50, deletions: 0 }))
      .toEqual([]);
    expect(deriveSignals({ files: ["a.txt"], insertions: 500, deletions: 0 }))
      .toEqual([]);
  });

  it("output is deduped and sorted; garbage line counts clamp to 0", () => {
    const s = deriveSignals({
      files: ["docs/a.md", "docs/b.md", "server/x.ts"],
      insertions: -5,
      deletions: -5,
    });
    expect(s).toEqual([...new Set(s)].sort());
    expect(s).toContain("diff-small"); // clamped total 0 < 50
    expect(s.filter((x) => x === "touches-docs")).toHaveLength(1);
  });

  it("emits only the standard vocabulary — custom seat signals never derive", () => {
    const s = deriveSignals({
      files: ["server/a.ts", "docs/b.md", "cairn.json", "scripts/c.sh"],
      insertions: 600,
      deletions: 600,
    });
    for (const sig of s) {
      expect(sig).toMatch(
        /^(touches-(auth|server|docs|tests|config|ci|scripts|ui)|diff-(small|large))$/,
      );
    }
  });
});

describe("seat selection (selectSeats)", () => {
  it("dial off (the default): the full roster fires, nothing gated", () => {
    const roster = loadRoster(makeProject());
    const sel = selectSeats(roster, [], { dial: "off" });
    expect(sel.effectiveDial).toBe("off");
    expect(sel.fired.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    expect(sel.gated).toEqual([]);
  });

  it("auto: docs-only diff seats clarity, gates the rest with notes", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = deriveSignals({
      files: ["docs/guide.md"], insertions: 10, deletions: 0,
    });
    const sel = selectSeats(roster, signals, { dial: "auto" });
    expect(sel.effectiveDial).toBe("auto");
    expect(sel.fired.map((s) => s.name)).toEqual(["clarity"]);
    expect(sel.gated.map((g) => g.name)).toEqual([
      "correctness", "architecture", "security", "tests", "ux", "lean",
    ]);
    for (const g of sel.gated) {
      expect(g.reason).toBe("no-matching-signals");
      expect(g.note).toContain("no matching signals");
    }
  });

  it("auto: a server-code diff fires the five axes plus lean; ux sits out on touches-ui", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = deriveSignals({
      files: ["server/src/a.ts"], insertions: 100, deletions: 100,
    });
    expect(signals).toContain("touches-server");
    expect(signals).not.toContain("diff-large"); // 200 lines — lean seats on touches-server alone
    const sel = selectSeats(roster, signals, { dial: "auto" });
    // the ADR 0010 amendment, machine-checked: the five axes lead, in their
    // order; lean joins behind them on touches-server; ux sits out
    expect(sel.fired.map((s) => s.name)).toEqual([...REVIEW_PANEL_NAMES, "lean"]);
    expect(sel.gated).toEqual([
      expect.objectContaining({ name: "ux", reason: "no-matching-signals" }),
    ]);
  });

  it("auto: a small docs-only diff seats neither ux nor lean", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = deriveSignals({
      files: ["docs/ARCHITECTURE.md", "README.md"], insertions: 12, deletions: 4,
    });
    expect(signals).not.toContain("touches-server");
    expect(signals).not.toContain("diff-large");
    expect(signals).not.toContain("touches-ui");
    const sel = selectSeats(roster, signals, { dial: "auto" });
    expect(sel.fired.map((s) => s.name)).not.toContain("ux");
    expect(sel.fired.map((s) => s.name)).not.toContain("lean");
    expect(sel.gated).toContainEqual(
      expect.objectContaining({ name: "ux", reason: "no-matching-signals" }),
    );
    expect(sel.gated).toContainEqual(
      expect.objectContaining({ name: "lean", reason: "no-matching-signals" }),
    );
  });

  it("auto: a large diff seats lean on diff-large alone", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = deriveSignals({
      files: ["docs/guide.md"], insertions: 400, deletions: 200,
    });
    expect(signals).toContain("diff-large");
    expect(signals).not.toContain("touches-server");
    const sel = selectSeats(roster, signals, { dial: "auto" });
    expect(sel.fired.map((s) => s.name)).toContain("lean");
    expect(sel.gated.map((g) => g.name)).not.toContain("lean");
  });

  it("auto: a diff that touches UI files seats ux alongside the axes it also fires", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = deriveSignals({
      files: ["src/components/Table.tsx", "src/styles/table.css"],
      insertions: 100, deletions: 100,
    });
    expect(signals).toContain("touches-ui");
    const sel = selectSeats(roster, signals, { dial: "auto" });
    const fired = sel.fired.map((s) => s.name);
    expect(fired).toContain("ux");
    // roster order: ux after the axes, lean (src/ fires touches-server) last
    expect(fired.indexOf("ux")).toBeGreaterThan(fired.indexOf("tests"));
    expect(fired.at(-1)).toBe("lean");
    expect(sel.gated.map((g) => g.name)).not.toContain("ux");
  });

  it("auto: ux is yield-gated like any non-security seat", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = ["touches-ui"];
    const yields: Record<string, YieldCounters> = {
      ux: { dispatched: 10, findingsRaised: 2, findingsSurvived: 0 },
    };
    const sel = selectSeats(roster, signals, { dial: "auto", yields });
    expect(sel.fired.map((s) => s.name)).not.toContain("ux");
    expect(sel.gated).toContainEqual(
      expect.objectContaining({ name: "ux", reason: "low-yield" }),
    );
  });

  it("a seat declaring NO signals always fires — gating is opt-in", () => {
    const roster = reviewPanel(loadRoster(makeProject({
      roles: { "10-vibes.md": seatDoc({ name: "vibes", signals: "[]" }) },
    })));
    const sel = selectSeats(roster, [], { dial: "auto" });
    expect(sel.fired.map((s) => s.name)).toEqual(["vibes"]);
    expect(sel.gated).toHaveLength(REVIEW_STAGE_NAMES.length);
  });

  it("inherit follows cairn.json seats.dispatch; absent resolves to auto, off is the opt-in (#345)", () => {
    const off = loadRoster(makeProject({ seats: { dispatch: "off" } }));
    expect(off.dispatch).toBe("off");
    const full = selectSeats(off, [], { dial: "inherit" });
    expect(full.effectiveDial).toBe("off");
    expect(full.fired.map((s) => s.name)).toEqual(DEFAULT_NAMES);

    // no seats block at all, and a seats block with no dispatch key: both auto
    for (const unset of [loadRoster(makeProject()), loadRoster(makeProject({ seats: {} }))]) {
      expect(unset.dispatch).toBe("auto");
      expect(selectSeats(unset, [], { dial: "inherit" }).effectiveDial).toBe("auto");
    }
  });

  it("auto: low-yield seat gates on evidence, with the explicit note", () => {
    const roster = reviewPanel(loadRoster(makeProject()));
    const signals = ["touches-server"];
    const yields: Record<string, YieldCounters> = {
      correctness: { dispatched: 10, findingsRaised: 3, findingsSurvived: 0 },
    };
    const sel = selectSeats(roster, signals, { dial: "auto", yields });
    expect(sel.fired.map((s) => s.name)).toEqual([
      "clarity", "architecture", "security", "tests", "lean",
    ]);
    expect(sel.gated).toEqual([
      expect.objectContaining({ name: "correctness", reason: "low-yield" }),
      expect.objectContaining({ name: "ux", reason: "no-matching-signals" }),
    ]);
    expect(sel.gated[0].note).toContain("low yield");
  });

  it("yield floor: security and dose-full seats are never yield-gated", () => {
    const roster = loadRoster(makeProject({
      roles: {
        "10-style.md": seatDoc({
          name: "style", dose: "full", signals: "[touches-server]",
        }),
      },
    }));
    const dead: YieldCounters = {
      dispatched: 50, findingsRaised: 0, findingsSurvived: 0,
    };
    const sel = selectSeats(roster, ["touches-server"], {
      dial: "auto",
      yields: { security: dead, style: dead },
    });
    expect(sel.fired.map((s) => s.name)).toContain("security");
    expect(sel.fired.map((s) => s.name)).toContain("style");
    // nothing gated on YIELD — ux sits out here only because touches-ui
    // did not fire, which is the signal rule, not the yield floor; lean
    // fires on touches-server
    expect(sel.gated.filter((g) => g.reason === "low-yield")).toEqual([]);
    expect(sel.gated.map((g) => g.name)).toEqual(["ux"]);
  });

  it("yield gate needs history and a strictly-low rate", () => {
    const roster = loadRoster(makeProject());
    const fired = (yields: Record<string, YieldCounters>) =>
      selectSeats(roster, ["touches-server"], { dial: "auto", yields })
        .fired.map((s) => s.name);
    // one under YIELD_MIN_DISPATCHES — sample too small to prune on
    expect(fired({
      correctness: {
        dispatched: YIELD_MIN_DISPATCHES - 1,
        findingsRaised: 0,
        findingsSurvived: 0,
      },
    })).toContain("correctness");
    // rate exactly AT the gate line does not gate (strict <)
    expect(fired({
      correctness: { dispatched: 10, findingsRaised: 1, findingsSurvived: 1 },
    })).toContain("correctness");
  });

  it("yield stats are consulted ONLY in auto — off ignores them", () => {
    const roster = loadRoster(makeProject());
    const sel = selectSeats(roster, [], {
      dial: "off",
      yields: {
        correctness: { dispatched: 99, findingsRaised: 0, findingsSurvived: 0 },
      },
    });
    expect(sel.fired.map((s) => s.name)).toEqual(DEFAULT_NAMES);
    expect(sel.gated).toEqual([]);
  });

  it("pins the documented thresholds", () => {
    expect(YIELD_MIN_DISPATCHES).toBe(10);
    expect(YIELD_GATE_RATE).toBe(0.1);
  });
});

describe("yield store (loadYield / recordYield)", () => {
  it("round-trips and accumulates deltas per project file", () => {
    const base = mkdtempSync(join(tmpdir(), "cairn-yield-"));
    const project = makeProject();
    recordYield(project, [
      { seat: "correctness", dispatched: 1, findingsRaised: 2, findingsSurvived: 1 },
    ], base);
    recordYield(project, [
      { seat: "correctness", dispatched: 1 },
      { seat: "security", dispatched: 1, findingsRaised: 1 },
    ], base);
    const { state, note } = loadYield(project, base);
    expect(note).toBeUndefined();
    expect(state.version).toBe(1);
    expect(state.seats.correctness).toEqual({
      dispatched: 2, findingsRaised: 2, findingsSurvived: 1,
    });
    expect(state.seats.security).toEqual({
      dispatched: 1, findingsRaised: 1, findingsSurvived: 0,
    });
  });

  it("isolates projects — same base dir, separate files and counters", () => {
    const base = mkdtempSync(join(tmpdir(), "cairn-yield-"));
    const a = makeProject();
    const b = makeProject();
    expect(yieldStatePath(a, base)).not.toBe(yieldStatePath(b, base));
    recordYield(a, [{ seat: "correctness", dispatched: 3 }], base);
    expect(loadYield(b, base).state.seats).toEqual({});
    expect(loadYield(a, base).state.seats.correctness.dispatched).toBe(3);
  });

  it("a corrupt store loads fresh with a note — advisory evidence never throws", () => {
    const base = mkdtempSync(join(tmpdir(), "cairn-yield-"));
    const project = makeProject();
    const path = yieldStatePath(project, base);
    mkdirSync(join(base, "yield"), { recursive: true });
    writeFileSync(path, "not json{");
    const { state, note } = loadYield(project, base);
    expect(state.seats).toEqual({});
    expect(note).toContain("starting fresh");
    // recordYield over the corpse persists a valid fresh state
    const rec = recordYield(project, [{ seat: "tests", dispatched: 1 }], base);
    expect(rec.note).toContain("starting fresh");
    expect(loadYield(project, base).state.seats.tests.dispatched).toBe(1);
  });

  it("rejects malformed deltas with CONFIG_INVALID", () => {
    const base = mkdtempSync(join(tmpdir(), "cairn-yield-"));
    const project = makeProject();
    for (const bad of [
      [{ seat: "", dispatched: 1 }],
      [{ seat: "x", dispatched: -1 }],
      [{ seat: "x", findingsRaised: 1.5 }],
    ]) {
      try {
        recordYield(project, bad, base);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(CairnError);
        expect((e as CairnError).code).toBe("CONFIG_INVALID");
      }
    }
  });

  it("yieldRate: survived per dispatch; null without evidence", () => {
    expect(yieldRate({ dispatched: 0, findingsRaised: 0, findingsSurvived: 0 }))
      .toBeNull();
    expect(yieldRate({ dispatched: 10, findingsRaised: 4, findingsSurvived: 2 }))
      .toBe(0.2);
  });
});

describe("blast-radius model resolution (resolveSeatModel)", () => {
  const seatWith = (model?: string) =>
    parseSeatDoc(seatDoc({ model }), "/x/s.md").seat;

  it("gate work routes to the strongest tier REGARDLESS of seat preference", () => {
    const r = resolveSeatModel(seatWith("haiku"), "gate");
    expect(r.model).toBe("strongest");
    expect(r.overrode).toBe(true);
    expect(r.reason).toContain("gates a lifecycle transition");
    expect(r.reason).toContain("blast-radius");
    // opus is below the strongest tier, so it is overridden too
    const o = resolveSeatModel(seatWith("opus"), "gate");
    expect(o.model).toBe("strongest");
    expect(o.overrode).toBe(true);
  });

  it("gate work with no preference still routes up, without an override flag", () => {
    const r = resolveSeatModel(seatWith(), "gate");
    expect(r.model).toBe("strongest");
    expect(r.overrode).toBe(false);
  });

  it("downgrade only mechanical work: a haiku preference on routine synthesis bumps up", () => {
    const r = resolveSeatModel(seatWith("haiku"), "routine");
    expect(r.model).toBe("sonnet");
    expect(r.overrode).toBe(true);
    const c = resolveSeatModel(seatWith("sonnet"), "complex");
    expect(c.model).toBe("opus");
    expect(c.overrode).toBe(true);
  });

  it("a preference at or above the class floor is honored", () => {
    expect(resolveSeatModel(seatWith("opus"), "routine").model).toBe("opus");
    expect(resolveSeatModel(seatWith("opus"), "complex").model).toBe("opus");
    expect(resolveSeatModel(seatWith("haiku"), "mechanical").model).toBe("haiku");
    expect(resolveSeatModel(seatWith("sonnet"), "mechanical").model).toBe("sonnet");
  });

  it("no preference: the rubric default per work class", () => {
    expect(resolveSeatModel(seatWith(), "mechanical").model).toBe("haiku");
    expect(resolveSeatModel(seatWith(), "routine").model).toBe("sonnet");
    expect(resolveSeatModel(seatWith(), "complex").model).toBe("opus");
    expect(resolveSeatModel(seatWith(), "gate").model).toBe("strongest");
  });

  it("the server-side table equals the cairn-planning SKILL.md table", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const skill = readFileSync(
      join(root, "skills", "cairn-planning", "SKILL.md"),
      "utf8",
    );
    // Rows: | work class | signals | routed model | effort |
    const rows = skill
      .split("\n")
      .map((l) => l.split("|").map((c) => c.trim()))
      .filter((c) => c.length === 6)
      .map((c) => ({
        label: c[1],
        model: c[3].replace(/`/g, ""),
        effort: c[4],
      }));
    const entries = Object.values(ROUTING_TABLE);
    expect(entries.length).toBe(4);
    for (const e of entries) {
      const row = rows.find((r) => r.label === e.label);
      expect(row, `SKILL.md has no row for '${e.label}'`).toBeDefined();
      expect(row!.model).toBe(
        e.model === "strongest" ? "strongest available" : e.model,
      );
      expect(row!.effort).toBe(e.effort);
    }
  });
});

describe("seats dispatch config", () => {
  it("seats.dispatch accepts auto|off and rejects anything else", () => {
    expect(loadConfig(makeProject({ seats: { dispatch: "auto" } }))
      .seats?.dispatch).toBe("auto");
    expect(loadConfig(makeProject({ seats: { dispatch: "off" } }))
      .seats?.dispatch).toBe("off");
    try {
      loadConfig(makeProject({ seats: { dispatch: "always" } }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("seat_roster carries the resolved dispatch over MCP: off when stated, auto when unset (#345)", async () => {
    const server = buildServer({
      projectDir: makeProject({ seats: { dispatch: "off" } }),
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "seat_roster", arguments: {} });
    const roster = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(roster.dispatch).toBe("off");
    await client.close();

    const server2 = buildServer({
      projectDir: makeProject(),
      tracker: new FakeTracker(),
      fetchLatestVersion: async () => "9.9.9",
    });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server2.connect(st2), client2.connect(ct2)]);
    const res2 = await client2.callTool({ name: "seat_roster", arguments: {} });
    const roster2 = JSON.parse(
      (res2.content as Array<{ text: string }>)[0].text,
    );
    // unset is not silence any more: the verb reads the resolved default
    expect(roster2.dispatch).toBe("auto");
    await client2.close();
  });

  it("shipped default signals are drawn from the standard vocabulary", () => {
    // The dispatch story only works if the defaults can actually fire —
    // every declared default signal must be derivable.
    const roster = loadRoster(makeProject());
    const STANDARD = new Set([
      "touches-auth", "touches-server", "touches-docs", "touches-tests",
      "touches-config", "touches-ci", "touches-scripts", "touches-ui",
      "diff-small", "diff-large",
    ]);
    for (const entry of roster.seats) {
      for (const sig of entry.seat?.signals ?? []) {
        expect(STANDARD.has(sig), `${entry.name} declares '${sig}'`).toBe(true);
      }
    }
  });
});
