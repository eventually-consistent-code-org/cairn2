import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  handoffPath, bannerPath, HandoffSchema, HandoffSourceEnum, readHandoff, writeHandoff,
  clearHandoff, waveNotes, waveNextVerb,
} from "../src/core/continuity.js";
import { indexDbPath } from "../src/memory/index-store.js";
import { CairnError } from "../src/errors.js";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cairn-continuity-"));
  dirs.push(d);
  return d;
};
const registered = () => {
  const d = dir();
  writeFileSync(join(d, "cairn.json"),
    JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
  return d;
};

// Every dir() this test creates also produces a real handoff file under
// ~/.cairn/handoff (and possibly ~/.cairn/banner) keyed by that dir's hash --
// track and clean those up too so runs don't leak into the real homedir.
const cleanupHandoffPaths: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const p of cleanupHandoffPaths.splice(0)) rmSync(p, { force: true });
});

describe("handoffPath / bannerPath", () => {
  it("derives a stable path under the home dir, outside the project, matching indexDbPath's hashing", () => {
    const p1 = handoffPath("/tmp/project-a");
    const p2 = handoffPath("/tmp/project-a");
    const p3 = handoffPath("/tmp/project-b");
    expect(p1).toBe(p2);
    expect(p1).not.toBe(p3);
    expect(p1).toContain(".cairn/handoff/");
    expect(p1).toContain("project-a-");
    expect(p1.endsWith(".json")).toBe(true);

    // Same hashing scheme as indexDbPath: sha256(resolve(dir)).slice(0,16), keyed off basename.
    const idxPath = indexDbPath("/tmp/project-a");
    const idxHash = idxPath.match(/project-a-([0-9a-f]{16})\.db$/)?.[1];
    const handoffHash = p1.match(/project-a-([0-9a-f]{16})\.json$/)?.[1];
    expect(handoffHash).toBeTruthy();
    expect(handoffHash).toBe(idxHash);

    const expectedHash = createHash("sha256").update("/tmp/project-a").digest("hex").slice(0, 16);
    expect(handoffHash).toBe(expectedHash);
  });

  it("bannerPath uses the same hash under a different subdir/extension", () => {
    const hp = handoffPath("/tmp/project-a");
    const bp = bannerPath("/tmp/project-a");
    expect(bp).toContain(".cairn/banner/");
    expect(bp.endsWith(".md")).toBe(true);
    const hHash = hp.match(/-([0-9a-f]{16})\.json$/)?.[1];
    const bHash = bp.match(/-([0-9a-f]{16})\.md$/)?.[1];
    expect(bHash).toBe(hHash);
  });
});

describe("HandoffSchema contract vs schema/handoff-v1.json", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const schemaJson = JSON.parse(
    readFileSync(join(testDir, "..", "schema", "handoff-v1.json"), "utf8"),
  );

  const minimalFixture = {
    version: 1,
    created: "2026-07-01T00:00:00.000Z",
    source: "tool",
    project: "cairn2-a0",
    task: { current: "", title: "" },
    tasks_completed: [],
    tasks_remaining: [],
    blockers: [],
    decisions_in_flight: [],
    uncommitted_files: [],
    next_action: "",
    notes: "",
    partial: false,
  };

  const fullFixture = {
    version: 1,
    created: "2026-07-15T12:34:56.000Z",
    source: "waypoint",
    project: "cairn2-a0",
    phase: { number: 3, slug: "continuity" },
    issue: "cairn-42",
    plan: "03-continuity/PLAN.md",
    task: { current: "task-1", title: "core/continuity.ts" },
    tasks_completed: ["task-0-setup"],
    tasks_remaining: ["task-2-wiring", "task-3-ledger"],
    blockers: ["waiting on tracker API rate limit reset"],
    decisions_in_flight: ["use sha256 slice(0,16) for path hashing"],
    uncommitted_files: ["server/src/core/continuity.ts"],
    next_action: "implement writeHandoff skeleton guard",
    notes: "see task-1-brief.md for exact field list",
    partial: false,
  };

  it("minimal fixture parses via HandoffSchema", () => {
    expect(() => HandoffSchema.parse(minimalFixture)).not.toThrow();
  });

  it("full fixture parses via HandoffSchema", () => {
    expect(() => HandoffSchema.parse(fullFixture)).not.toThrow();
  });

  it("minimal fixture's keys match schema/handoff-v1.json's required[] exactly", () => {
    expect(Object.keys(minimalFixture).sort()).toEqual([...schemaJson.required].sort());
  });

  it("full fixture's keys match schema/handoff-v1.json's properties keys exactly", () => {
    expect(Object.keys(fullFixture).sort()).toEqual(Object.keys(schemaJson.properties).sort());
  });
});

describe("readHandoff", () => {
  it("returns null when no handoff file exists", () => {
    const d = dir();
    cleanupHandoffPaths.push(handoffPath(d));
    expect(readHandoff(d)).toBeNull();
  });

  it("throws HANDOFF_INVALID on invalid JSON", () => {
    const d = dir();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ not valid json");
    expect(() => readHandoff(d)).toThrowError(
      expect.objectContaining({ code: "HANDOFF_INVALID" }));
  });

  it("throws HANDOFF_INVALID (with nextAction) on schema-invalid JSON", () => {
    const d = dir();
    writeHandoff(d, { source: "tool" }); // creates parent dirs + a valid file first
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeFileSync(p, JSON.stringify({ version: 1, source: "not-a-real-source" }));
    expect(() => readHandoff(d)).toThrowError(
      expect.objectContaining({ code: "HANDOFF_INVALID" }));
    try {
      readHandoff(d);
    } catch (e) {
      expect((e as CairnError).nextAction).toContain("~/.cairn/handoff/");
    }
  });

  it("returns stale:false for a freshly created handoff", () => {
    const d = registered();
    writeHandoff(d, { source: "tool", next_action: "keep going" });
    cleanupHandoffPaths.push(handoffPath(d));
    const result = readHandoff(d);
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(false);
  });

  it("returns stale:true when created is older than 14 days (injected)", () => {
    const d = registered();
    writeHandoff(d, { source: "tool", next_action: "keep going" });
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    const stored = JSON.parse(readFileSync(p, "utf8"));
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(p, JSON.stringify({ ...stored, created: old }));
    const result = readHandoff(d);
    expect(result!.stale).toBe(true);
    expect(result!.handoff.next_action).toBe("keep going"); // never errors the session for staleness
  });

  it("returns stale:false when created is just under 14 days old", () => {
    const d = registered();
    writeHandoff(d, { source: "tool" });
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    const stored = JSON.parse(readFileSync(p, "utf8"));
    const recent = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(p, JSON.stringify({ ...stored, created: recent }));
    expect(readHandoff(d)!.stale).toBe(false);
  });
});

describe("writeHandoff", () => {
  it("writes a new handoff, stamping version=1 and a fresh created timestamp", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    const before = Date.now();
    writeHandoff(d, { source: "waypoint", next_action: "ship it" });
    const result = readHandoff(d)!;
    expect(result.handoff.version).toBe(1);
    expect(result.handoff.source).toBe("waypoint");
    expect(result.handoff.next_action).toBe("ship it");
    expect(new Date(result.handoff.created).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("merges a patch over the existing handoff", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, { source: "tool", task: { current: "t1", title: "first" }, notes: "n1" });
    writeHandoff(d, { source: "posttooluse", notes: "n2" });
    const result = readHandoff(d)!;
    expect(result.handoff.task).toEqual({ current: "t1", title: "first" }); // preserved
    expect(result.handoff.notes).toBe("n2"); // overwritten
    expect(result.handoff.source).toBe("posttooluse"); // overwritten
  });

  it("derives project from basename(resolve(projectDir)) when not supplied in patch", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, { source: "tool" });
    const result = readHandoff(d)!;
    expect(result.handoff.project.length).toBeGreaterThan(0);
  });

  it("skeleton guard: keeps a rich handoff when a later empty write would clear it", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, {
      source: "waypoint",
      task: { current: "important-task", title: "Important" },
      next_action: "finish the important task",
    });
    // A later, less-informed write with both task.current and next_action empty
    // must not clobber the richer file.
    writeHandoff(d, { source: "posttooluse", task: { current: "", title: "" }, next_action: "" });
    const result = readHandoff(d)!;
    expect(result.handoff.task.current).toBe("important-task");
    expect(result.handoff.next_action).toBe("finish the important task");
  });

  it("skeleton guard does not block a write that keeps richness (only one of task.current/next_action empty)", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, {
      source: "waypoint",
      task: { current: "important-task", title: "Important" },
      next_action: "finish it",
    });
    writeHandoff(d, { source: "tool", next_action: "still finishing it" });
    const result = readHandoff(d)!;
    expect(result.handoff.next_action).toBe("still finishing it");
  });

  it("unregistered guard: no cairn.json means no write and no throw", () => {
    const d = dir(); // no cairn.json written
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    expect(() => writeHandoff(d, { source: "tool", next_action: "x" })).not.toThrow();
    expect(readHandoff(d)).toBeNull();
  });

  it("propagates non-CONFIG_MISSING config errors (e.g. CONFIG_INVALID)", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({ tracker: { type: "trello", config: {} } }));
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    expect(() => writeHandoff(d, { source: "tool" })).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("recovers from a corrupt existing handoff instead of throwing (safe on hot paths)", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ corrupt garbage from a crashed session");
    expect(() => writeHandoff(d, { source: "posttooluse", next_action: "carry on" })).not.toThrow();
    const result = readHandoff(d)!; // file must now be valid again
    expect(result.handoff.next_action).toBe("carry on");
    expect(result.handoff.version).toBe(1);
  });

  it("recovers from a schema-invalid (but valid-JSON) existing handoff as well", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 99, source: "bogus" }));
    expect(() => writeHandoff(d, { source: "tool" })).not.toThrow();
    expect(readHandoff(d)!.handoff.version).toBe(1);
  });

  it("atomic write leaves no .tmp residue", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, { source: "tool", next_action: "check tmp" });
    const files = readdirSync(dirname(p));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(files).toContain(p.split("/").pop());
  });
});

describe("clearHandoff", () => {
  it("returns false and does nothing when no handoff exists", () => {
    const d = registered();
    cleanupHandoffPaths.push(handoffPath(d));
    expect(clearHandoff(d)).toBe(false);
  });

  it("removes an existing handoff and returns true", () => {
    const d = registered();
    const p = handoffPath(d);
    cleanupHandoffPaths.push(p);
    writeHandoff(d, { source: "tool", next_action: "x" });
    expect(clearHandoff(d)).toBe(true);
    expect(readHandoff(d)).toBeNull();
    expect(clearHandoff(d)).toBe(false); // idempotent second call
  });
});

describe("HandoffSourceEnum and the wave strings (#370)", () => {
  const minimal = {
    version: 1,
    created: "2026-07-01T00:00:00.000Z",
    project: "cairn2-a0",
    task: { current: "", title: "" },
    tasks_completed: [],
    tasks_remaining: [],
    blockers: [],
    decisions_in_flight: [],
    uncommitted_files: [],
    next_action: "",
    notes: "",
    partial: false,
  };

  it("is the one definition: HandoffSchema's source accepts exactly its four values", () => {
    expect(HandoffSourceEnum.options).toEqual(["tool", "posttooluse", "precompact", "waypoint"]);
    for (const source of HandoffSourceEnum.options) {
      expect(HandoffSchema.safeParse({ ...minimal, source }).success).toBe(true);
    }
    // "auto" is what a verb might reach for; it is not a source and never was.
    expect(HandoffSchema.safeParse({ ...minimal, source: "auto" }).success).toBe(false);
  });

  it("waveNotes and waveNextVerb are composed from the same {phase, runId}", () => {
    const wave = { phase: 28, runId: "wf_b4c7d847" };
    expect(waveNotes(wave)).toBe("wave 28 run wf_b4c7d847");
    expect(waveNextVerb(wave)).toBe("work 28 --wave — resume run wf_b4c7d847");
    // decimal phases ride through unchanged
    expect(waveNotes({ phase: 1.5, runId: "r" })).toBe("wave 1.5 run r");
  });

  it("a wave checkpoint written through writeHandoff reads back with the run id in notes", () => {
    const d = registered();
    cleanupHandoffPaths.push(handoffPath(d));
    const wave = { phase: 28, runId: "wf_b4c7d847" };
    writeHandoff(d, { source: "tool", notes: waveNotes(wave) });
    const result = readHandoff(d)!;
    expect(result.handoff.notes).toBe("wave 28 run wf_b4c7d847");
    expect(result.handoff.source).toBe("tool");
  });
});
