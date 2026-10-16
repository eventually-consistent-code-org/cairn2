import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OutlookSnapshotSchema, emitOutlook, metricsPathFor, outlookAggregate,
  outlookArtifactPath, outlookLocalPath, outlookMirrorPath, readOutlook,
  waveCheckpoint, waveTracker,
} from "../src/core/outlook.js";
import { handoffPath, readHandoff } from "../src/core/continuity.js";

const dirs: string[] = [];
const dir = (prefix = "cairn-outlook-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** A registered cairn project with one planned + one verified phase. */
const project = () => {
  const d = dir("cairn-outlook-proj-");
  writeFileSync(join(d, "cairn.json"),
    JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
  const p1 = join(d, ".cairn", "plans", "phases", "01-first");
  const p2 = join(d, ".cairn", "plans", "phases", "02-second");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  writeFileSync(join(p1, "PLAN.md"), "---\nissues: [1, 2]\n---\n# plan\n");
  writeFileSync(join(p1, "VERIFICATION.md"), "# verified\n");
  writeFileSync(join(p2, "PLAN.md"), "---\nissues: [3]\n---\n# plan\n");
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("emitOutlook", () => {
  it("dual-writes schema-valid snapshots (mirror + in-repo), phases derived from plan artifacts", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, undefined, home);

    const mirror = outlookMirrorPath(proj, home);
    const local = outlookLocalPath(proj);
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(local)).toBe(true);

    const snap = OutlookSnapshotSchema.parse(JSON.parse(readFileSync(mirror, "utf8")));
    expect(JSON.parse(readFileSync(local, "utf8"))).toEqual(snap);
    expect(snap.name).toBe(proj.split("/").pop());
    expect(snap.path).toBe(proj);
    expect(snap.phases).toEqual([
      { number: 1, name: "first", planned: true, verified: true, issueCount: 2 },
      { number: 2, name: "second", planned: true, verified: false, issueCount: 1 },
    ]);
    expect(snap.sessions).toEqual({ trace: 0, probe: 0, draft: 0, thread: 0 });
  });

  it("records the git HEAD when the project is a repo, omits it when not", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, undefined, home);
    expect(readOutlook(proj, home)?.head).toBeUndefined();

    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "x"], { cwd: proj });
    emitOutlook(proj, undefined, home);
    expect(readOutlook(proj, home)?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("verb-supplied tracker block carries forward through plain emits, replaced by newer patches", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, { tracker: { open: 4, nextVerb: "work 2", asOf: "2026-08-14" } }, home);
    emitOutlook(proj, undefined, home); // plain emit must not erase it
    expect(readOutlook(proj, home)?.tracker).toEqual({ open: 4, nextVerb: "work 2", asOf: "2026-08-14" });

    emitOutlook(proj, { tracker: { open: 1, asOf: "2026-08-15" } }, home);
    expect(readOutlook(proj, home)?.tracker).toEqual({ open: 1, asOf: "2026-08-15" });
  });

  it("skips silently for a non-cairn directory", () => {
    const home = dir();
    const plain = dir("cairn-outlook-plain-");
    emitOutlook(plain, undefined, home);
    expect(existsSync(outlookMirrorPath(plain, home))).toBe(false);
    expect(existsSync(outlookLocalPath(plain))).toBe(false);
  });

  it("a corrupt mirror is replaced, not fatal", () => {
    const home = dir();
    const proj = project();
    const mirror = outlookMirrorPath(proj, home);
    mkdirSync(join(home, ".cairn", "outlook"), { recursive: true });
    writeFileSync(mirror, "{corrupt");

    emitOutlook(proj, undefined, home);
    expect(OutlookSnapshotSchema.safeParse(JSON.parse(readFileSync(mirror, "utf8"))).success).toBe(true);
  });
});

describe("outlookAggregate", () => {
  const register = (home: string, proj: string) => {
    mkdirSync(join(home, ".cairn"), { recursive: true });
    const regPath = join(home, ".cairn", "registry.json");
    const existing = existsSync(regPath)
      ? JSON.parse(readFileSync(regPath, "utf8"))
      : { version: 1, projects: [] };
    existing.projects.push({
      name: proj.split("/").pop(), path: proj,
      firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z",
    });
    writeFileSync(regPath, JSON.stringify(existing));
  };

  it("empty registry aggregates to zero cards", () => {
    expect(outlookAggregate(dir()).projects).toEqual([]);
  });

  it("a registered project with no snapshot gets a card with the guidance error, not an omission", () => {
    const home = dir();
    const proj = project();
    register(home, proj);
    const { projects } = outlookAggregate(home);
    expect(projects).toHaveLength(1);
    expect(projects[0].snapshot).toBeUndefined();
    expect(projects[0].error).toMatch(/no snapshot yet/);
  });

  it("fresh snapshot in a repo is stale:false; a new commit flips it stale with a reason", () => {
    const home = dir();
    const proj = project();
    execFileSync("git", ["init", "-q"], { cwd: proj });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "one"], { cwd: proj });
    register(home, proj);
    emitOutlook(proj, undefined, home);
    expect(outlookAggregate(home).projects[0].stale).toBe(false);

    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "-q", "--allow-empty", "-m", "two"], { cwd: proj });
    const card = outlookAggregate(home).projects[0];
    expect(card.stale).toBe(true);
    expect(card.staleReason).toMatch(/repo moved since snapshot/);
  });

  it("one corrupt project cannot take down the board", () => {
    const home = dir();
    const good = project();
    execFileSync("git", ["init", "-q"], { cwd: good });
    register(home, good);
    register(home, join(good, "does-not-exist-anymore"));
    emitOutlook(good, undefined, home);

    const { projects } = outlookAggregate(home);
    expect(projects).toHaveLength(2);
    expect(projects.find((p) => p.name === good.split("/").pop())?.snapshot).toBeTruthy();
    expect(projects.find((p) => p.name === "does-not-exist-anymore")?.error).toBeTruthy();
  });

  it("a snapshot recording a malformed commit id is flagged stale, no shell-out", () => {
    const home = dir();
    const proj = project();
    register(home, proj);
    emitOutlook(proj, undefined, home);
    const mirror = outlookMirrorPath(proj, home);
    const snap = JSON.parse(readFileSync(mirror, "utf8"));
    snap.head = "$(rm -rf /)"; // hostile frontmatter-adjacent data
    writeFileSync(mirror, JSON.stringify(snap));

    const card = outlookAggregate(home).projects[0];
    expect(card.stale).toBe(true);
    expect(card.staleReason).toMatch(/invalid commit id/);
  });
});

describe("cost rollup on cards (#92)", () => {
  it("sums each session's latest metrics row, split by kind; corrupt lines skipped", () => {
    const home = dir();
    const proj = project();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(join(home, ".cairn", "registry.json"), JSON.stringify({
      version: 1,
      projects: [{ name: proj.split("/").pop(), path: proj,
        firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z" }],
    }));
    emitOutlook(proj, undefined, home);

    const metrics = metricsPathFor(proj, home);
    mkdirSync(join(home, ".cairn", "metrics"), { recursive: true });
    writeFileSync(metrics, [
      JSON.stringify({ session_id: "s1", est_cost_usd: 1.0, kind: "issue" }),
      JSON.stringify({ session_id: "s1", est_cost_usd: 2.5, kind: "issue" }), // cumulative: latest wins
      JSON.stringify({ session_id: "s2", est_cost_usd: 0.75, kind: "probe" }),
      "{corrupt line",
      JSON.stringify({ session_id: "s3", est_cost_usd: 0.25 }), // no kind -> other
    ].join("\n") + "\n");

    const card = outlookAggregate(home).projects[0];
    expect(card.costUsd).toBe(3.5);
    expect(card.costByKind).toEqual({ issue: 2.5, probe: 0.75, other: 0.25 });
  });

  it("counts closed segments, not just the live one (#237)", () => {
    const home = dir();
    const proj = project();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(join(home, ".cairn", "registry.json"), JSON.stringify({
      version: 1,
      projects: [{ name: proj.split("/").pop(), path: proj,
        firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z" }],
    }));
    emitOutlook(proj, undefined, home);

    const metrics = metricsPathFor(proj, home);
    mkdirSync(join(home, ".cairn", "metrics"), { recursive: true });
    const stem = metrics.replace(/\.jsonl$/, "");

    // A session that started in an older segment and picked up a later row in
    // the live one: the merge must REPLACE, not sum, or spend inflates.
    writeFileSync(`${stem}.20260920-143000-01.jsonl`, [
      JSON.stringify({ session_id: "old", est_cost_usd: 4.0, kind: "issue" }),
      JSON.stringify({ session_id: "spanning", est_cost_usd: 1.0, kind: "probe" }),
    ].join("\n") + "\n");
    writeFileSync(`${stem}.20260921-090000-01.jsonl`,
      JSON.stringify({ session_id: "middle", est_cost_usd: 2.0, kind: "issue" }) + "\n");
    writeFileSync(metrics,
      JSON.stringify({ session_id: "spanning", est_cost_usd: 3.0, kind: "probe" }) + "\n");

    const card = outlookAggregate(home).projects[0];
    expect(card.costUsd).toBe(9.0); // 4 + 2 + 3 (spanning's latest, not 1 + 3)
    expect(card.costByKind).toEqual({ issue: 6.0, probe: 3.0 });
  });

  it("no metrics file means no cost fields, not zero", () => {
    const home = dir();
    const proj = project();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(join(home, ".cairn", "registry.json"), JSON.stringify({
      version: 1,
      projects: [{ name: proj.split("/").pop(), path: proj,
        firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z" }],
    }));
    emitOutlook(proj, undefined, home);
    expect(outlookAggregate(home).projects[0].costUsd).toBeUndefined();
  });
});

describe("OUTLOOK.md artifact (#91)", () => {
  it("artifact: true writes the machine-level board matching the returned cards", () => {
    const home = dir();
    const proj = project();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(join(home, ".cairn", "registry.json"), JSON.stringify({
      version: 1,
      projects: [{ name: proj.split("/").pop(), path: proj,
        firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z" }],
    }));
    emitOutlook(proj, { tracker: { open: 2, nextVerb: "work 2" } }, home);

    const out = outlookAggregate(home, { artifact: true });
    expect(out.artifactPath).toBe(outlookArtifactPath(home));
    const md = readFileSync(out.artifactPath!, "utf8");
    expect(md).toContain("# Portfolio outlook");
    expect(md).toContain(`## ${proj.split("/").pop()}`);
    expect(md).toContain("verified through phase 1");
    expect(md).toContain("next up: phase 2 (second, 1 issues)");
    expect(md).toContain("work items: 2 open");
    expect(md).toContain("suggested next: work 2");
    expect(md).toContain("1 project; ");
  });

  it("plain aggregate does not write the artifact", () => {
    const home = dir();
    outlookAggregate(home);
    expect(existsSync(outlookArtifactPath(home))).toBe(false);
  });

  it("unreadable projects render flagged, not hidden", () => {
    const home = dir();
    mkdirSync(join(home, ".cairn"), { recursive: true });
    writeFileSync(join(home, ".cairn", "registry.json"), JSON.stringify({
      version: 1,
      projects: [{ name: "ghost", path: join(home, "gone"),
        firstSeen: "2026-08-14T00:00:00Z", lastSeen: "2026-08-14T00:00:00Z" }],
    }));
    const out = outlookAggregate(home, { artifact: true });
    const md = readFileSync(out.artifactPath!, "utf8");
    expect(md).toContain("## ghost");
    expect(md).toContain("status: unavailable");
    expect(md).toContain("1 unreadable");
  });
});

describe("readOutlook", () => {
  it("missing or corrupt snapshots read as null", () => {
    const home = dir();
    const proj = project();
    expect(readOutlook(proj, home)).toBeNull();

    const mirror = outlookMirrorPath(proj, home);
    mkdirSync(join(home, ".cairn", "outlook"), { recursive: true });
    writeFileSync(mirror, "not json");
    expect(readOutlook(proj, home)).toBeNull();
  });
});

describe("wave checkpoint (#370)", () => {
  // waveCheckpoint writes a real handoff under ~/.cairn/handoff keyed by the
  // temp project's hash -- same cleanup discipline as continuity.test.ts.
  const cleanupHandoffPaths: string[] = [];
  afterEach(() => {
    for (const p of cleanupHandoffPaths.splice(0)) rmSync(p, { force: true });
  });
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it("waveTracker: zeros when nothing is known, previous counts when they are, resume line always", () => {
    const wave = { phase: 28, runId: "wf_b4c7d847" };
    expect(waveTracker(undefined, wave, "2026-10-15T00:00:00.000Z")).toEqual({
      open: 0, inProgress: 0, blocked: 0,
      nextVerb: "work 28 --wave — resume run wf_b4c7d847",
      asOf: "2026-10-15T00:00:00.000Z",
    });
    const previous = { open: 4, inProgress: 2, blocked: 1, nextVerb: "work 28", asOf: "2026-10-01" };
    expect(waveTracker(previous, wave, "2026-10-15T00:00:00.000Z")).toEqual({
      open: 4, inProgress: 2, blocked: 1,
      nextVerb: "work 28 --wave — resume run wf_b4c7d847",
      asOf: "2026-10-15T00:00:00.000Z",
    });
  });

  it("emitOutlook with wave writes the composed tracker block and returns the snapshot it wrote", () => {
    const home = dir();
    const proj = project();
    const returned = emitOutlook(proj, { wave: { phase: 28, runId: "wf_b4c7d847" } }, home);
    const written = readOutlook(proj, home)!;
    expect(returned).toEqual(written);
    expect(written.tracker).toMatchObject({
      open: 0, inProgress: 0, blocked: 0,
      nextVerb: "work 28 --wave — resume run wf_b4c7d847",
    });
    expect(written.tracker?.asOf).toMatch(ISO);

    // a later plain emit carries the wave block forward, as any tracker block
    emitOutlook(proj, undefined, home);
    expect(readOutlook(proj, home)?.tracker).toEqual(written.tracker);
  });

  it("one waveCheckpoint call yields handoff notes and outlook nextVerb both carrying the run id", () => {
    const home = dir();
    const proj = project();
    cleanupHandoffPaths.push(handoffPath(proj));

    const result = waveCheckpoint(
      proj,
      { next_action: "watch the run", notes: "eight workers" },
      { phase: 28, runId: "wf_b4c7d847" },
      home,
    );

    // handoff half: composed line first, the caller's own notes behind it
    expect(result.handoff?.notes).toBe("wave 28 run wf_b4c7d847 — eight workers");
    expect(result.handoff?.source).toBe("tool");
    expect(result.handoff?.next_action).toBe("watch the run");
    expect(result.stale).toBe(false);
    // outlook half: emitted, resume line carries the same id
    expect(result.outlook).toEqual({
      emitted: true,
      tracker: expect.objectContaining({
        open: 0, inProgress: 0, blocked: 0,
        nextVerb: "work 28 --wave — resume run wf_b4c7d847",
      }),
    });
    // both landed on disk, and the two ids are literally the same string
    const onDiskHandoff = readHandoff(proj)!.handoff;
    const onDiskOutlook = readOutlook(proj, home)!;
    const idFromNotes = onDiskHandoff.notes.match(/run (\S+)/)![1];
    expect(onDiskOutlook.tracker!.nextVerb!.endsWith(`resume run ${idFromNotes}`)).toBe(true);
  });

  it("waveCheckpoint with no caller notes writes the bare composed line", () => {
    const home = dir();
    const proj = project();
    cleanupHandoffPaths.push(handoffPath(proj));
    const result = waveCheckpoint(proj, {}, { phase: 2, runId: "r-2" }, home);
    expect(result.handoff?.notes).toBe("wave 2 run r-2");
    expect(result.outlook.tracker?.nextVerb).toBe("work 2 --wave — resume run r-2");
  });

  it("waveCheckpoint on an unregistered directory writes nothing and does not throw", () => {
    const home = dir();
    const plain = dir("cairn-outlook-plain-");
    cleanupHandoffPaths.push(handoffPath(plain));
    const result = waveCheckpoint(plain, {}, { phase: 2, runId: "r-2" }, home);
    expect(result).toEqual({ handoff: null, stale: false, outlook: { emitted: false } });
    expect(existsSync(outlookMirrorPath(plain, home))).toBe(false);
    expect(existsSync(handoffPath(plain))).toBe(false);
  });

  it("omitting wave leaves today's behavior byte for byte: a plain emit reproduces the previous snapshot save its timestamp", () => {
    const home = dir();
    const proj = project();
    emitOutlook(proj, { tracker: { open: 4, nextVerb: "work 2", asOf: "2026-08-14" } }, home);
    const before = readFileSync(outlookMirrorPath(proj, home), "utf8");

    const returned = emitOutlook(proj, undefined, home);
    const after = readFileSync(outlookMirrorPath(proj, home), "utf8");

    const stripTs = (s: string) => s.replace(/"ts": "[^"]+"/, '"ts": "<ts>"');
    expect(stripTs(after)).toBe(stripTs(before));
    // and the returned snapshot is exactly the bytes written
    expect(JSON.stringify(returned, null, 2) + "\n").toBe(after);
    expect(readFileSync(outlookLocalPath(proj), "utf8")).toBe(after);
  });
});
