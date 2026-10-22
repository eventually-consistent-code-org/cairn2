// The run manifest (#132): the staging interview's output and the headless
// executor's sole source of authority. These tests cover the store contract —
// round-trip fidelity, the version gate, runId isolation, pushAuth starting
// false until explicitly granted, the one-way status lifecycle, and the
// forward-only phase in flight (#260).

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  composeFreezeComment,
  createRunManifest,
  grantPushAuth,
  isFrozenByBreaker,
  listRunManifests,
  markFreezeCommented,
  readRunManifest,
  readRunManifestWithPath,
  runManifestPath,
  setCurrentPhase,
  setRunStatus,
} from "../src/planning/run-manifest.js";
import type { ManifestPhase } from "../src/planning/run-manifest.js";
import { CairnError } from "../src/errors.js";

// #358 -- the manifest has a second writer, the breaker hook. writeManifestFile
// re-reads the file just before its rename so a freeze landing between the
// server's read and its write is never clobbered. This pass-through lets one
// test land a freeze in exactly that gap: armed, the Nth read of the armed
// path first writes `frozen` to disk with the real fs, as the hook would.
const race = vi.hoisted(() => ({ path: "", onRead: 0, reads: 0, frozen: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (race.path && p === race.path && ++race.reads === race.onRead) actual.writeFileSync(race.path, race.frozen);
    return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const CREATED = "2026-09-01T00:00:00.000Z";

const PHASES: ManifestPhase[] = [
  {
    number: 15,
    name: "headless-build",
    estimate: { low: 400_000, high: 2_100_000, estUsd: { low: 20, high: 525 } },
    waves: 3,
  },
  {
    number: 16,
    name: "cleanup",
    estimate: { low: 100_000, high: 1_000_000, estUsd: { low: 5, high: 250 } },
  },
];

/** Fresh project + injectable base dir per test (budget-ledger convention). */
function setup() {
  const projectDir = tempDir("cairn-manifest-proj-");
  const baseDir = tempDir("cairn-manifest-home-");
  return { projectDir, baseDir };
}

describe("createRunManifest / readRunManifest", () => {
  it("round-trips the full staging payload", () => {
    const { projectDir, baseDir } = setup();
    const written = createRunManifest(projectDir, {
      runId: "run-1",
      phases: PHASES,
      ceiling: { tokens: 5_000_000, usd: 300 },
      answers: [
        { phase: 15, question: "which auth provider?", answer: "keep github" },
      ],
      createdAt: CREATED,
      baseDir,
    });
    const read = readRunManifest(projectDir, "run-1", baseDir);
    expect(read).toEqual(written);
    expect(read.version).toBe(1);
    expect(read.created).toBe(CREATED);
    expect(read.phases).toEqual(PHASES);
    expect(read.ceiling).toEqual({ tokens: 5_000_000, usd: 300 });
    expect(read.answers).toEqual([
      { phase: 15, question: "which auth provider?", answer: "keep github" },
    ]);
    expect(read.status).toBe("staged");
  });

  it("records the effort dial the run was staged under, and omits it when none was given (#332)", () => {
    const { projectDir, baseDir } = setup();
    const dialed = createRunManifest(projectDir, {
      runId: "run-dial", phases: PHASES, effort: "high", createdAt: CREATED, baseDir,
    });
    expect(readRunManifest(projectDir, "run-dial", baseDir).effort).toBe("high");
    expect(dialed.effort).toBe("high");
    const plain = createRunManifest(projectDir, {
      runId: "run-plain", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect("effort" in plain).toBe(false);
    expect(readRunManifest(projectDir, "run-plain", baseDir).effort).toBeUndefined();
  });

  it("read is pure — the file's bytes are identical before and after", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    const path = runManifestPath(projectDir, "run-1", baseDir);
    const before = readFileSync(path, "utf8");
    readRunManifest(projectDir, "run-1", baseDir);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("no ceiling given persists as explicit null (uncapped, on purpose)", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(readRunManifest(projectDir, "run-1", baseDir).ceiling).toBeNull();
  });

  it("refuses to overwrite an existing manifest — one per run", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(() =>
      createRunManifest(projectDir, {
        runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
      }),
    ).toThrowError(CairnError);
  });

  it("refuses an empty phase list — nothing to stage", () => {
    const { projectDir, baseDir } = setup();
    expect(() =>
      createRunManifest(projectDir, {
        runId: "run-1", phases: [], createdAt: CREATED, baseDir,
      }),
    ).toThrowError(/no phases/);
  });

  it("readRunManifestWithPath carries the resolved manifest path (#134)", () => {
    const { projectDir, baseDir } = setup();
    const written = createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    const read = readRunManifestWithPath(projectDir, "run-1", baseDir);
    // the report writer needs the real location -- never a guessed filename
    expect(read.path).toBe(runManifestPath(projectDir, "run-1", baseDir));
    const { path: _path, ...state } = read;
    expect(state).toEqual(written);
  });

  it("reading a never-staged run is NOT_FOUND", () => {
    const { projectDir, baseDir } = setup();
    try {
      readRunManifest(projectDir, "ghost", baseDir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("NOT_FOUND");
    }
  });
});

describe("version gate", () => {
  it("rejects a manifest with a future version instead of guessing", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    const path = runManifestPath(projectDir, "run-1", baseDir);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.version = 2;
    writeFileSync(path, JSON.stringify(doc));
    expect(() => readRunManifest(projectDir, "run-1", baseDir))
      .toThrowError(/schema validation/);
  });

  it("rejects a corrupt (non-JSON) manifest with a human-first error", () => {
    const { projectDir, baseDir } = setup();
    const path = runManifestPath(projectDir, "run-1", baseDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not json {");
    expect(() => readRunManifest(projectDir, "run-1", baseDir))
      .toThrowError(/not valid JSON/);
  });
});

describe("runId isolation", () => {
  it("two runs in one project never see each other's state", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-a", phases: PHASES, createdAt: CREATED, baseDir,
    });
    createRunManifest(projectDir, {
      runId: "run-b", phases: [PHASES[1]], createdAt: CREATED, baseDir,
    });
    grantPushAuth(projectDir, "run-a", { grantedAt: CREATED, baseDir });

    const a = readRunManifest(projectDir, "run-a", baseDir);
    const b = readRunManifest(projectDir, "run-b", baseDir);
    expect(a.phases).toHaveLength(2);
    expect(b.phases).toHaveLength(1);
    expect(a.pushAuth.granted).toBe(true);
    expect(b.pushAuth.granted).toBe(false); // run-a's grant never leaks
  });

  it("runIds that sanitize to the same filename cannot silently merge", () => {
    const { projectDir, baseDir } = setup();
    // 'run/1' and 'run:1' both collapse to 'run-1' on disk
    createRunManifest(projectDir, {
      runId: "run/1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(() => readRunManifest(projectDir, "run:1", baseDir))
      .toThrowError(/belongs to run/);
  });
});

describe("pushAuth", () => {
  it("defaults to granted:false with manifest-phases scope and no grantedAt", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    const m = readRunManifest(projectDir, "run-1", baseDir);
    expect(m.pushAuth).toEqual({ granted: false, scope: "manifest-phases" });
    expect(m.pushAuth.grantedAt).toBeUndefined();
  });

  it("grantPushAuth flips it and stamps grantedAt, persisted", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    grantPushAuth(projectDir, "run-1", { grantedAt: CREATED, baseDir });
    const m = readRunManifest(projectDir, "run-1", baseDir);
    expect(m.pushAuth).toEqual({
      granted: true, scope: "manifest-phases", grantedAt: CREATED,
    });
  });

  it("cannot be granted once the run has left 'staged' — front door only", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    setRunStatus(projectDir, "run-1", "running", baseDir);
    expect(() => grantPushAuth(projectDir, "run-1", { baseDir }))
      .toThrowError(/staging only/);
  });
});

describe("status lifecycle", () => {
  it("walks staged → running → complete", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(setRunStatus(projectDir, "run-1", "running", baseDir).status)
      .toBe("running");
    expect(setRunStatus(projectDir, "run-1", "complete", baseDir).status)
      .toBe("complete");
  });

  it("allows running → stopped and staged → stopped (abandoned run)", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-a", phases: PHASES, createdAt: CREATED, baseDir,
    });
    setRunStatus(projectDir, "run-a", "running", baseDir);
    expect(setRunStatus(projectDir, "run-a", "stopped", baseDir).status)
      .toBe("stopped");

    createRunManifest(projectDir, {
      runId: "run-b", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(setRunStatus(projectDir, "run-b", "stopped", baseDir).status)
      .toBe("stopped");
  });

  it("rejects every illegal move — no skipping, no resurrection", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    // staged cannot jump straight to complete
    expect(() => setRunStatus(projectDir, "run-1", "complete", baseDir))
      .toThrowError(/cannot move/);
    setRunStatus(projectDir, "run-1", "running", baseDir);
    // running cannot go back to staged
    expect(() => setRunStatus(projectDir, "run-1", "staged", baseDir))
      .toThrowError(/cannot move/);
    setRunStatus(projectDir, "run-1", "complete", baseDir);
    // terminal states stay terminal — and the fix hint says so
    try {
      setRunStatus(projectDir, "run-1", "running", baseDir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).message).toMatch(/cannot move/);
      expect((e as CairnError).nextAction).toMatch(/terminal/);
    }
    expect(() => setRunStatus(projectDir, "run-1", "stopped", baseDir))
      .toThrowError(/cannot move/);
  });
});

describe("currentPhase (#260)", () => {
  /** A running manifest over PHASES (15, then 16). */
  function running() {
    const s = setup();
    createRunManifest(s.projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir: s.baseDir,
    });
    setRunStatus(s.projectDir, "run-1", "running", s.baseDir);
    return s;
  }

  it("is absent on a fresh manifest, and an older manifest without it still reads", () => {
    const { projectDir, baseDir } = running();
    expect(readRunManifest(projectDir, "run-1", baseDir).currentPhase).toBeUndefined();
    const path = runManifestPath(projectDir, "run-1", baseDir);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect("currentPhase" in doc).toBe(false);
  });

  it("marks a manifest phase in flight, persisted", () => {
    const { projectDir, baseDir } = running();
    expect(setCurrentPhase(projectDir, "run-1", 15, baseDir).currentPhase).toBe(15);
    expect(readRunManifest(projectDir, "run-1", baseDir).currentPhase).toBe(15);
  });

  it("moves forward in manifest order; re-marking the current phase is a no-op", () => {
    const { projectDir, baseDir } = running();
    setCurrentPhase(projectDir, "run-1", 15, baseDir);
    expect(setCurrentPhase(projectDir, "run-1", 15, baseDir).currentPhase).toBe(15);
    expect(setCurrentPhase(projectDir, "run-1", 16, baseDir).currentPhase).toBe(16);
    expect(() => setCurrentPhase(projectDir, "run-1", 15, baseDir))
      .toThrowError(/comes before it/);
    expect(readRunManifest(projectDir, "run-1", baseDir).currentPhase).toBe(16);
  });

  it("refuses a phase the manifest doesn't stage", () => {
    const { projectDir, baseDir } = running();
    try {
      setCurrentPhase(projectDir, "run-1", 99, baseDir);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("PRECONDITION_FAILED");
      expect((e as CairnError).message).toMatch(/phase 99 is not in run/);
    }
  });

  it("refuses unless the run is running -- staged, complete and stopped have no phase in flight", () => {
    const { projectDir, baseDir } = setup();
    createRunManifest(projectDir, {
      runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir,
    });
    expect(() => setCurrentPhase(projectDir, "run-1", 15, baseDir)).toThrowError(/'staged'/);
    setRunStatus(projectDir, "run-1", "running", baseDir);
    setCurrentPhase(projectDir, "run-1", 15, baseDir);
    setRunStatus(projectDir, "run-1", "complete", baseDir);
    expect(() => setCurrentPhase(projectDir, "run-1", 16, baseDir)).toThrowError(/'complete'/);
  });

  it("a hand-written non-number currentPhase fails the schema instead of passing as a phase", () => {
    const { projectDir, baseDir } = running();
    const path = runManifestPath(projectDir, "run-1", baseDir);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.currentPhase = "15";
    writeFileSync(path, JSON.stringify(doc));
    expect(() => readRunManifest(projectDir, "run-1", baseDir)).toThrowError(/currentPhase/);
  });
});

describe("the circuit breaker's freeze (#358)", () => {
  /** One refusal row, as hooks/scripts/breaker.mjs logs it. */
  const row = (n: number) => ({
    ts: `2026-10-22T00:0${n}:00.000Z`, guard: "run", tool: "Bash", effect: "discards-work",
    reason: "`git reset --hard`", session_id: "sess-run", run_id: "run-1", input_sha256: "ab".repeat(32),
  });

  /** The doc the breaker writes over a running manifest: stopped, and a stop block. */
  function frozenDoc(path: string): string {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    doc.status = "stopped";
    doc.stop = {
      reason: "breaker", at: "2026-10-22T00:03:00.000Z", limit: 3, count: 3,
      refusals: [row(1), row(2), row(3)], sessions: ["sess-run"],
    };
    return JSON.stringify(doc, null, 2);
  }

  /** A running manifest over PHASES with phase 15 in flight -- then, unless asked not to, frozen. */
  function frozen(freeze = true) {
    const s = setup();
    createRunManifest(s.projectDir, { runId: "run-1", phases: PHASES, createdAt: CREATED, baseDir: s.baseDir });
    setRunStatus(s.projectDir, "run-1", "running", s.baseDir);
    setCurrentPhase(s.projectDir, "run-1", 15, s.baseDir);
    const path = runManifestPath(s.projectDir, "run-1", s.baseDir);
    if (freeze) writeFileSync(path, frozenDoc(path));
    return { ...s, path };
  }

  const expectFrozen = (f: () => unknown) => {
    try {
      f();
      expect.unreachable("should have thrown RUN_FROZEN");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("RUN_FROZEN");
      expect((e as CairnError).message).toMatch(/after 3 guard refusals \(limit 3\)/);
      expect((e as CairnError).nextAction).toMatch(/\/cairn:auto --batch/);
    }
  };

  afterEach(() => {
    race.path = "";
    race.reads = 0;
  });

  it("a stop block the guards write survives the schema, and the run reads frozen", () => {
    const { projectDir, baseDir } = frozen();
    const state = readRunManifest(projectDir, "run-1", baseDir);
    expect(isFrozenByBreaker(state)).toBe(true);
    expect(state.stop?.refusals.map((r) => r.ts)).toEqual([row(1).ts, row(2).ts, row(3).ts]);
    expect(state.stop?.sessions).toEqual(["sess-run"]);
    // a stopped run without the block is an ordinary stop, not a freeze
    const plain = setup();
    createRunManifest(plain.projectDir, { runId: "run-2", phases: PHASES, baseDir: plain.baseDir });
    expect(isFrozenByBreaker(setRunStatus(plain.projectDir, "run-2", "stopped", plain.baseDir))).toBe(false);
  });

  it("every move on a frozen run is RUN_FROZEN, and stopping it again is a no-op", () => {
    const { projectDir, baseDir, path } = frozen();
    const before = readFileSync(path, "utf8");
    expectFrozen(() => setCurrentPhase(projectDir, "run-1", 16, baseDir));
    expectFrozen(() => setRunStatus(projectDir, "run-1", "complete", baseDir));
    expectFrozen(() => setRunStatus(projectDir, "run-1", "running", baseDir));
    expectFrozen(() => grantPushAuth(projectDir, "run-1", { baseDir }));
    // auto's wrap stops a halted run; the breaker already did
    expect(setRunStatus(projectDir, "run-1", "stopped", baseDir).status).toBe("stopped");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("a server write never clobbers a freeze that lands between its read and its rename", () => {
    const { projectDir, baseDir, path } = frozen(false);
    // read 1 is setCurrentPhase's load; read 2 is the re-read just before the rename
    Object.assign(race, { path, onRead: 2, reads: 0, frozen: frozenDoc(path) });
    expectFrozen(() => setCurrentPhase(projectDir, "run-1", 16, baseDir));
    race.path = "";
    const onDisk = readRunManifest(projectDir, "run-1", baseDir);
    expect(isFrozenByBreaker(onDisk)).toBe(true);
    expect(onDisk.currentPhase).toBe(15); // the move that lost the race never landed
  });

  it("the freeze's comment is recorded once, and the listing reads newest first", () => {
    const { projectDir, baseDir } = frozen();
    const first = markFreezeCommented(projectDir, "run-1", { on: "42", at: "2026-10-22T01:00:00.000Z", baseDir });
    expect(first.stop).toMatchObject({ commentedOn: "42", commentedAt: "2026-10-22T01:00:00.000Z" });
    const again = markFreezeCommented(projectDir, "run-1", { on: "43", baseDir });
    expect(again.stop).toMatchObject({ commentedOn: "42" });
    createRunManifest(projectDir, { runId: "run-9", phases: PHASES, createdAt: "2026-10-23T00:00:00.000Z", baseDir });
    expect(listRunManifests(projectDir, baseDir).map((m) => m.runId)).toEqual(["run-9", "run-1"]);
  });

  it("the freeze comment is plain language: the refusals, the owner's way back, no path or command", () => {
    const { projectDir, baseDir } = frozen();
    const text = composeFreezeComment(readRunManifest(projectDir, "run-1", baseDir));
    expect(text).toMatch(/^Batch run run-1 was frozen by cairn's circuit breaker/);
    expect(text).toContain("refused 3 actions since the run started (the limit is 3)");
    expect(text).toContain("- 2026-10-22T00:01:00.000Z — the run guard refused `git reset --hard` (discards-work)");
    expect(text).toContain("re-stage the remaining phases with /cairn:auto --batch");
    expect(text).not.toContain(projectDir);
    expect(text).not.toContain(baseDir);
  });
});
