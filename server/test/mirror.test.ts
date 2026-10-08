import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTracker } from "../src/tracker/fake.js";
import { writeAuditRecord } from "../src/audit/record.js";
import { scaffoldPhase, scaffoldProject, writePlanIssues } from "../src/planning/artifacts.js";
import {
  canonicalPhaseName, ensurePhase, driftReport, roadmapRowDrift,
  staleAuditDrift, staleBranchDrift,
} from "../src/planning/mirror.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-mirror-"));
const git = (d: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: d, encoding: "utf8" }).trim();
function commit(d: string, file: string, msg: string): void {
  mkdirSync(join(d, file, ".."), { recursive: true });
  writeFileSync(join(d, file), `${msg}\n`);
  git(d, "add", file); git(d, "commit", "-q", "-m", msg, "--no-gpg-sign");
}
/** Temp git repo with one seed commit and a scaffolded phase. */
function repo(): string {
  const d = dir();
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  commit(d, "src/a.ts", "seed");
  return d;
}

describe("ensurePhase", () => {
  it("creates once, then returns the same phase (idempotent)", async () => {
    const t = new FakeTracker();
    const a = await ensurePhase(t, 2, "Planning Engine");
    const b = await ensurePhase(t, 2, "Planning Engine");
    expect(a.name).toBe(canonicalPhaseName(2, "Planning Engine"));
    expect(b.id).toBe(a.id);
    expect((await t.listPhases()).length).toBe(1);
  });

  it("rejects trackers without phase support", async () => {
    const t = new FakeTracker();
    Object.defineProperty(t, "capabilities", {
      value: { ...t.capabilities, hasPhases: false },
    });
    await expect(ensurePhase(t, 1, "X"))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("driftReport", () => {
  it("flags missing and closed-in-unverified-phase, passes open", async () => {
    const t = new FakeTracker();
    const open = await t.createIssue({ title: "open one" });
    const closed = await t.createIssue({ title: "closed one" });
    await t.closeIssue(closed.id);

    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core"); // no VERIFICATION.md
    writePlanIssues(d, pd, [open.id, closed.id, "FAKE-999"]);

    const report = await driftReport(t, d);
    expect(report.ok).toEqual([open.id]);
    expect(report.flagged).toEqual(expect.arrayContaining([
      { issueId: closed.id, phase: 1, reason: "closed" },
      { issueId: "FAKE-999", phase: 1, reason: "missing" },
    ]));
  });

  it("an in-progress issue nobody has touched for the window is stale work", async () => {
    const t = new FakeTracker();
    const held = await t.createIssue({ title: "held open" });
    await t.updateIssue(held.id, { state: "in_progress" });
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [held.id]);

    // Look at the same repo from eight days in the future rather than
    // back-dating the tracker: the fake stamps updatedAt as "now".
    const future = Date.now() + 8 * 86_400_000;
    const report = await driftReport(t, d, { staleDays: 5, now: future });
    const stale = report.flagged.find((f) => f.reason === "stale-issue");
    expect(stale).toMatchObject({ reason: "stale-issue", ref: held.id, idleDays: 8 });
    expect(stale?.detail).toContain("8 days");
    // Still a tracked, un-drifted issue — stale is advisory, not an error.
    expect(report.ok).toEqual([held.id]);
  });

  it("recent activity on either side clears it", async () => {
    const t = new FakeTracker();
    const held = await t.createIssue({ title: "held open" });
    await t.updateIssue(held.id, { state: "in_progress" });
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [held.id]);

    // Inside the window: the tracker stamp alone is a sign of life.
    const soon = Date.now() + 2 * 86_400_000;
    expect((await driftReport(t, d, { staleDays: 5, now: soon }))
      .flagged.filter((f) => f.reason === "stale-issue")).toEqual([]);
  });

  it("only in-progress issues go stale — open backlog is not forgotten work", async () => {
    const t = new FakeTracker();
    const backlog = await t.createIssue({ title: "someday" });
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [backlog.id]);
    const future = Date.now() + 90 * 86_400_000;
    expect((await driftReport(t, d, { staleDays: 5, now: future }))
      .flagged.filter((f) => f.reason === "stale-issue")).toEqual([]);
  });

  it("closed issues in a VERIFIED phase are not drift", async () => {
    const t = new FakeTracker();
    const done = await t.createIssue({ title: "done" });
    await t.closeIssue(done.id);
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writePlanIssues(d, pd, [done.id]);
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    const report = await driftReport(t, d);
    expect(report.flagged).toEqual([]);
    expect(report.ok).toEqual([done.id]);
  });
});

describe("roadmapRowDrift (#185)", () => {
  const roadmapPath = (d: string) => join(d, ".cairn/plans/roadmap.md");
  const roadmap = (d: string) => readFileSync(roadmapPath(d), "utf8");

  /** A project whose roadmap table carries the given rows. */
  function project(...rows: string[]): string {
    const d = dir();
    scaffoldProject(d, "proj");
    writeFileSync(roadmapPath(d), roadmap(d) + rows.join("\n") + "\n");
    return d;
  }

  it("flips a verified phase's planned row and reports the repair", () => {
    const d = project("| 1 | core | planned |");
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");

    const items = roadmapRowDrift(d);
    expect(items).toEqual([{
      reason: "roadmap-row", phase: 1, from: "planned", to: "verified",
      detail: expect.stringContaining("VERIFICATION.md"),
    }]);
    expect(roadmap(d)).toContain("| 1 | core | verified |");
    // Self-healing means the second pass has nothing left to say.
    expect(roadmapRowDrift(d)).toEqual([]);
  });

  it("leaves an unverified phase's row planned", () => {
    const d = project("| 1 | core | planned |");
    scaffoldPhase(d, 1, "Core"); // no VERIFICATION.md
    expect(roadmapRowDrift(d)).toEqual([]);
    expect(roadmap(d)).toContain("| 1 | core | planned |");
  });

  it("never overwrites a human's wording, only the literal 'planned'", () => {
    const d = project("| 1 | core | blocked on #99 |", "| 2 | polish | shipped (v7) |");
    for (const n of [1, 2]) {
      const { dir: pd } = scaffoldPhase(d, n, n === 1 ? "Core" : "Polish");
      writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    }
    expect(roadmapRowDrift(d)).toEqual([]);
    expect(roadmap(d)).toContain("| 1 | core | blocked on #99 |");
    expect(roadmap(d)).toContain("| 2 | polish | shipped (v7) |");
  });

  it("does not invent a row for a phase the table never listed", () => {
    const d = project("| 1 | core | planned |");
    const { dir: pd } = scaffoldPhase(d, 3, "Unlisted");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    expect(roadmapRowDrift(d)).toEqual([]);
    expect(roadmap(d)).not.toContain("| 3 |");
  });

  it("matches decimal phases to their own row", () => {
    const d = project("| 1 | core | planned |", "| 1.5 | slice | planned |");
    const { dir: pd } = scaffoldPhase(d, 1.5, "Slice");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    expect(roadmapRowDrift(d).map((i) => i.phase)).toEqual([1.5]);
    expect(roadmap(d)).toContain("| 1 | core | planned |");
    expect(roadmap(d)).toContain("| 1.5 | slice | verified |");
  });

  it("a project with no roadmap.md is not an error", () => {
    const d = dir();
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    expect(roadmapRowDrift(d)).toEqual([]);
  });

  it("the full drift report carries the repair", async () => {
    const d = project("| 1 | core | planned |");
    const { dir: pd } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn/plans/phases", pd, "VERIFICATION.md"), "# ok");
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged).toEqual([expect.objectContaining({
      reason: "roadmap-row", phase: 1, to: "verified",
    })]);
  });
});

describe("staleAuditDrift (#195)", () => {
  it("a security audit stamped at HEAD is current; docs-only commits keep it current", async () => {
    const d = repo();
    writeAuditRecord(d, "security-1", "pass", []);
    expect(staleAuditDrift(d)).toBeNull();
    commit(d, "docs/guide.md", "docs only");
    expect(staleAuditDrift(d)).toBeNull();
    // ...and the full report carries nothing but the (empty) issue side.
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged).toEqual([]);
  });

  it("readme, changelog and license commits keep it current; CLAUDE.md stales it (#279)", () => {
    const d = repo();
    writeAuditRecord(d, "security-1", "pass", []);
    commit(d, "README.md", "readme only");
    commit(d, "server/README.md", "nested readme only");
    commit(d, "CHANGELOG.md", "release notes only");
    commit(d, "LICENSE", "license only");
    expect(staleAuditDrift(d)).toBeNull();
    commit(d, "CLAUDE.md", "agent instructions are code");
    expect(staleAuditDrift(d)).toMatchObject({ cause: "code-moved", codeCommitsSince: 1 });
  });

  it("code commits after the stamp flag the LATEST security record as stale", async () => {
    const d = repo();
    writeAuditRecord(d, "security-1", "pass", []);
    commit(d, "src/b.ts", "code moved");
    commit(d, "src/c.ts", "code moved again");
    const flag = staleAuditDrift(d);
    expect(flag).toMatchObject({ reason: "stale-audit", scope: "security-1",
      cause: "code-moved", codeCommitsSince: 2 });
    expect(flag?.detail).toMatch(/predates 2 code commits — re-run \/cairn:audit security/);
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged).toHaveLength(1);
    expect(report.flagged[0].reason).toBe("stale-audit");
  });

  it("a record written over a dirty tree is stale on its own", () => {
    const d = repo();
    writeFileSync(join(d, "src/a.ts"), "edited, not committed\n");
    writeAuditRecord(d, "security", "pass", []);
    expect(staleAuditDrift(d)).toMatchObject({ cause: "dirty", scope: "security" });
  });

  it("non-security scopes, unstamped legacy records, and non-git dirs never flag", () => {
    const d = repo();
    writeAuditRecord(d, "review-working", "pass", []);
    commit(d, "src/b.ts", "code moved");
    expect(staleAuditDrift(d)).toBeNull();
    // Legacy: a security record with no stamp (hand-written pre-phase-21 shape).
    writeFileSync(join(d, ".cairn", "audit", "security-2020-01-01.md"),
      "---\nscope: security\nverdict: pass\ncreated: 2020-01-01\n---\n# Audit: security\n");
    expect(staleAuditDrift(d)).toBeNull();
    expect(staleAuditDrift(dir())).toBeNull();
  });
});

describe("staleAuditDrift and sweep manifests (#215)", () => {
  it("a sweep-* manifest never raises stale-audit, even behind code commits or over a dirty tree", async () => {
    const d = repo();
    writeAuditRecord(d, "sweep-2026-01-01", "pass", []);
    commit(d, "src/b.ts", "code moved");
    expect(staleAuditDrift(d)).toBeNull();
    writeFileSync(join(d, "src/a.ts"), "edited, not committed\n");
    writeAuditRecord(d, "sweep-2026-01-02", "pass", []);
    expect(staleAuditDrift(d)).toBeNull();
    const report = await driftReport(new FakeTracker(), d);
    expect(report.flagged.filter((f) => f.reason === "stale-audit")).toEqual([]);
  });
});

describe("staleBranchDrift (#218)", () => {
  /** Commits a file on a new branch with a back-dated committer date. */
  function branchAt(d: string, name: string, daysAgo: number): void {
    const when = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    execFileSync("git", ["checkout", "-q", "-b", name], { cwd: d });
    writeFileSync(join(d, `${name.replace(/\//g, "-")}.txt`), "work\n");
    execFileSync("git", ["add", "-A"], { cwd: d });
    execFileSync("git", ["commit", "-q", "-m", `work on ${name}`, "--no-gpg-sign"],
      { cwd: d, env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: d });
  }

  /** repo() seeds on whatever the default branch is called; normalise to main. */
  function repoOnMain(): string {
    const d = repo();
    execFileSync("git", ["branch", "-M", "main"], { cwd: d });
    return d;
  }

  it("flags a branch that has gone quiet, naming the age", () => {
    const d = repoOnMain();
    branchAt(d, "feature/old-thing", 9);
    const flags = staleBranchDrift(d, 5);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ reason: "stale-branch", ref: "feature/old-thing" });
    expect(flags[0].idleDays).toBeGreaterThanOrEqual(9);
    expect(flags[0].detail).toContain("feature/old-thing");
  });

  it("leaves recent branches, the default branch, and the checked-out branch alone", () => {
    const d = repoOnMain();
    branchAt(d, "feature/fresh", 1);
    branchAt(d, "feature/old", 9);
    execFileSync("git", ["checkout", "-q", "feature/old"], { cwd: d });
    // Standing on it means it is not forgotten, however old the commit is.
    expect(staleBranchDrift(d, 5)).toEqual([]);
    execFileSync("git", ["checkout", "-q", "main"], { cwd: d });
    expect(staleBranchDrift(d, 5).map((f) => f.ref)).toEqual(["feature/old"]);
  });

  it("orders by how long the silence has run", () => {
    const d = repoOnMain();
    branchAt(d, "feature/a", 7);
    branchAt(d, "feature/b", 30);
    expect(staleBranchDrift(d, 5).map((f) => f.ref)).toEqual(["feature/b", "feature/a"]);
  });

  it("the threshold is respected, not hardcoded", () => {
    const d = repoOnMain();
    branchAt(d, "feature/week-old", 7);
    expect(staleBranchDrift(d, 30)).toEqual([]);
    expect(staleBranchDrift(d, 5).map((f) => f.ref)).toEqual(["feature/week-old"]);
  });

  it("a directory that is not a git repo says nothing rather than throwing", () => {
    expect(staleBranchDrift(dir(), 5)).toEqual([]);
  });
});
