import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAuditRecords, parseAuditRecord, writeAuditRecord, type AuditFinding } from "../src/audit/record.js";
import { loadYield } from "../src/seats/yield.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-audit-"));
const today = new Date().toISOString().slice(0, 10);
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
/** A temp dir that is a git repo with one commit. */
function freshRepo(): string {
  const dir = fresh();
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "seed", "--no-gpg-sign");
  return dir;
}

describe("writeAuditRecord", () => {
  it("writes scope-date file with frontmatter and finding blocks", () => {
    const dir = fresh();
    const out = writeAuditRecord(dir, "uat-phase-1", "findings", [
      { severity: "critical", title: "checkout flow 500s on empty cart", issue: "GH-9",
        failure_scenario: "POST /checkout with cart=[] → 500 instead of 400",
        panel: [{ seat: "correctness", verdict: "CONFIRMED", evidence: "reproduced with an empty cart" }] },
      { severity: "minor", title: "settings copy stale",
        failure_scenario: "open /settings → footer still says 2025" },
    ]);
    expect(out.path).toBe(join(dir, ".cairn", "audit", `uat-phase-1-${today}.md`));
    expect(out.findings).toBe(2);
    const raw = readFileSync(out.path, "utf8");
    expect(raw).toContain("scope: uat-phase-1");
    expect(raw).toContain("verdict: findings");
    expect(raw).toContain("## finding — critical");
    expect(raw).toContain("scenario: POST /checkout with cart=[] → 500 instead of 400");
    expect(raw).toContain("outcome: confirmed");
    expect(raw).toContain("vote: correctness CONFIRMED — reproduced with an empty cart");
    expect(raw).toContain("issue: GH-9");
    expect(raw).toContain("## finding — minor");
  });

  it("refuses a finding without a typed failure_scenario (a hunch is not a finding)", () => {
    const dir = fresh();
    expect(() => writeAuditRecord(dir, "review-x", "findings",
      [{ severity: "critical", title: "boom" } as never])).toThrow(/failure_scenario/);
    expect(() => writeAuditRecord(dir, "review-x", "findings",
      [{ severity: "important", title: "boom", failure_scenario: "   " }])).toThrow(/hunch/);
    expect(existsSync(join(dir, ".cairn", "audit"))).toBe(false);
    // A clean pass is byte-for-byte the pre-phase-21 record — no findings, no field.
    const out = writeAuditRecord(dir, "review-x", "pass", []);
    expect(readFileSync(out.path, "utf8")).not.toContain("scenario:");
  });

  it("same scope+date overwrites; a different date is never touched", () => {
    const dir = fresh();
    const old = join(dir, ".cairn", "audit", "uat-phase-1-2020-01-01.md");
    writeAuditRecord(dir, "uat-phase-1", "pass", []);
    writeFileSync(old, "immutable history\n");
    writeAuditRecord(dir, "uat-phase-1", "findings",
      [{ severity: "important", title: "second run", failure_scenario: "rerun → new finding",
        panel: [{ seat: "tests", verdict: "PLAUSIBLE", evidence: "could not reproduce either way" }] }]);
    expect(readFileSync(old, "utf8")).toBe("immutable history\n");
    const rerun = readFileSync(join(dir, ".cairn", "audit", `uat-phase-1-${today}.md`), "utf8");
    expect(rerun).toContain("second run");
    expect(rerun).not.toContain("verdict: pass");
  });

  it("rejects an empty scope and a verdict/findings mismatch", () => {
    const dir = fresh();
    expect(() => writeAuditRecord(dir, "", "pass", [])).toThrow(/scope/);
    expect(() => writeAuditRecord(dir, "x", "pass",
      [{ severity: "critical", title: "boom", failure_scenario: "s" }])).toThrow(/verdict/);
  });

  it("stamps commit + dirty from git at write time; no stamp outside a repo", () => {
    const repo = freshRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const clean = writeAuditRecord(repo, "security", "pass", []);
    expect(clean.commit).toBe(head);
    expect(clean.dirty).toBe(false);
    const raw = readFileSync(clean.path, "utf8");
    expect(raw).toContain(`commit: ${head}`);
    expect(raw).toContain("dirty: false");
    expect(listAuditRecords(repo)[0]).toMatchObject({ scope: "security", commit: head, dirty: false });

    // An uncommitted change to a tracked file flips the flag; untracked noise does not.
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "scratch.txt"), "ignored\n");
    expect(writeAuditRecord(repo, "security-21", "pass", []).dirty).toBe(true);
    expect(listAuditRecords(repo).find((r) => r.scope === "security-21")?.dirty).toBe(true);

    // No git → no stamp, and the record still writes (pre-phase-21 shape).
    const plain = writeAuditRecord(fresh(), "review-x", "pass", []);
    expect(plain).not.toHaveProperty("commit");
    expect(readFileSync(plain.path, "utf8")).not.toContain("commit:");
  });

  describe("refutation panel (#196)", () => {
    const vote = (seat: string, verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED") =>
      ({ seat, verdict, evidence: `${seat} checked it` });
    const finding = (over: Partial<import("../src/audit/record.js").AuditFinding> = {}) => ({
      severity: "important" as const, title: "lookup dereferences null",
      failure_scenario: "lookup(undefined) → null → TypeError", ...over,
    });

    it("quorum table: majority REFUTED dies; ties and lone PLAUSIBLE survive as plausible; more CONFIRMED confirms", () => {
      const dir = fresh();
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "dies", panel: [vote("a", "REFUTED"), vote("b", "REFUTED"), vote("c", "CONFIRMED")] }),
        finding({ title: "tie", panel: [vote("a", "REFUTED"), vote("b", "CONFIRMED")] }),
        finding({ title: "lone plausible", panel: [vote("a", "PLAUSIBLE")] }),
        finding({ title: "confirmed", panel: [vote("a", "CONFIRMED"), vote("b", "CONFIRMED"), vote("c", "REFUTED")] }),
        finding({ title: "one refuted of one", panel: [vote("a", "REFUTED")] }),
      ]);
      expect(out.results.map((r) => [r.title, r.outcome, r.survived])).toEqual([
        ["dies", "refuted", false],
        ["tie", "plausible", true],
        ["lone plausible", "plausible", true],
        ["confirmed", "confirmed", true],
        ["one refuted of one", "refuted", false],
      ]);
      expect(out.findings).toBe(5);
      expect(out.survived).toBe(3);
      expect(out.refuted).toBe(2);
      const raw = readFileSync(out.path, "utf8");
      // Refuted findings stay IN the record, marked — the tracker never sees them.
      expect(raw).toContain("dies\nscenario:");
      expect(raw).toContain("refuted: true — not filed to the tracker");
      expect(raw).toContain("outcome: plausible");
    });

    it("critical/important need a panel (two votes on a security scope); minors don't", () => {
      const dir = fresh();
      expect(() => writeAuditRecord(dir, "review-working", "findings", [finding()]))
        .toThrow(/has 0 panel votes; scope 'review-working' needs 1/);
      expect(() => writeAuditRecord(dir, "security-21", "findings",
        [finding({ severity: "critical", panel: [vote("a", "CONFIRMED")] })]))
        .toThrow(/needs 2/);
      const ok = writeAuditRecord(dir, "security-21", "findings", [
        finding({ severity: "critical", panel: [vote("a", "CONFIRMED"), vote("b", "PLAUSIBLE")] }),
        finding({ severity: "minor", title: "nit" }),
      ]);
      expect(ok.results.map((r) => r.outcome)).toEqual(["confirmed", "unpanelled"]);
      expect(ok.survived).toBe(2);
      // A vote missing its evidence is a shape error, not a judgment.
      expect(() => writeAuditRecord(dir, "review-working", "findings",
        [finding({ panel: [{ seat: "a", verdict: "CONFIRMED", evidence: " " }] })])).toThrow(/evidence/);
    });

    it("staged patch (#197): apply-eligible only when survived AND all three claims are true", () => {
      const dir = fresh();
      const verifier = (over: Partial<{ targeted: boolean; no_new_issue: boolean; behavior_unchanged: boolean }> = {}) => ({
        seat: "correctness", evidence: "read the patch against the finding", testsRun: "server suite 1399 passed",
        claims: { targeted: true, no_new_issue: true, behavior_unchanged: true, ...over },
      });
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "clean", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/194.patch", verifier: verifier() } }),
        finding({ title: "not targeted", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/195.patch", verifier: verifier({ targeted: false }) } }),
        finding({ title: "behavior moved", panel: [vote("v", "CONFIRMED")], patch: { path: "fix/r1/196.patch", verifier: verifier({ behavior_unchanged: false }) } }),
        finding({ title: "refuted with a patch", panel: [vote("v", "REFUTED")], patch: { path: "fix/r1/197.patch", verifier: verifier() } }),
        finding({ title: "no patch", panel: [vote("v", "CONFIRMED")] }),
      ]);
      expect(out.results.map((r) => [r.title, r.applyEligible])).toEqual([
        ["clean", true],
        ["not targeted", false],
        ["behavior moved", false],
        ["refuted with a patch", false],
        ["no patch", undefined],
      ]);
      const raw = readFileSync(out.path, "utf8");
      expect(raw).toContain("patch: fix/r1/194.patch");
      expect(raw).toContain("apply: eligible — on the user's choice");
      expect(raw).toContain("apply: blocked — claims not all true");
      expect(raw).toContain("patch verifier: correctness — targeted=false");
      // A patch without its verifier's claims is a shape error.
      expect(() => writeAuditRecord(dir, "review-working", "findings", [
        finding({ panel: [vote("v", "CONFIRMED")],
          patch: { path: "fix/r1/x.patch", verifier: { seat: "c", evidence: "e", testsRun: "t" } } as never }),
      ])).toThrow(/three boolean claims/);
    });

    it("credits raising seats' findingsSurvived only for panelled survivors", () => {
      const dir = fresh();
      const yieldBase = fresh();
      const out = writeAuditRecord(dir, "review-working", "findings", [
        finding({ title: "lives", seats: ["correctness", "security"], panel: [vote("v", "CONFIRMED")] }),
        finding({ title: "dies", seats: ["correctness"], panel: [vote("v", "REFUTED")] }),
        finding({ title: "minor unpanelled", severity: "minor", seats: ["clarity"] }),
      ], { yieldBaseDir: yieldBase });
      expect(out.note).toBeUndefined();
      const { state } = loadYield(dir, yieldBase);
      expect(state.seats.correctness).toEqual({ dispatched: 0, findingsRaised: 0, findingsSurvived: 1 });
      expect(state.seats.security).toEqual({ dispatched: 0, findingsRaised: 0, findingsSurvived: 1 });
      expect(state.seats.clarity).toBeUndefined();
    });
  });

  it("listAuditRecords returns scope/date/verdict sorted by path", () => {
    const dir = fresh();
    writeAuditRecord(dir, "review-diff", "pass", []);
    writeAuditRecord(dir, "uat-phase-1", "findings",
      [{ severity: "minor", title: "t", failure_scenario: "s" }]);
    const all = listAuditRecords(dir);
    expect(all).toHaveLength(2);
    expect(all[0].scope).toBe("review-diff");
    expect(all[1].verdict).toBe("findings");
  });
});

describe("sweep manifest + baseline delta (#215)", () => {
  const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  const minor = (title: string, failure_scenario: string): AuditFinding =>
    ({ severity: "minor", title, failure_scenario });
  const NULL_DEREF = minor("lookup dereferences null", "lookup(undefined) returns null then the caller crashes with TypeError");
  const STALE_FOOTER = minor("settings footer is stale", "open /settings and the footer still says 2025");
  const RETRY_LOOP = minor("retry loop never backs off", "tracker 429 makes the client retry with zero delay forever");
  const commitCode = (repo: string, file: string) => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", file); git(repo, "commit", "-q", "-m", `code ${file}`, "--no-gpg-sign");
  };
  /** Writes the two leg records, then a manifest over them. */
  function sweep(repo: string, date: string, sec: AuditFinding[], rev: AuditFinding[]) {
    const s = writeAuditRecord(repo, "security-25", sec.length ? "findings" : "pass", sec);
    const r = writeAuditRecord(repo, "review-working", rev.length ? "findings" : "pass", rev);
    const all = [...sec, ...rev];
    return writeAuditRecord(repo, `sweep-${date}`, all.length ? "findings" : "pass", all, {
      legs: [{ scope: "security-25", path: s.path }, { scope: "review-working", path: r.path }],
    });
  }

  it("first sweep: cairn + commit stamped, legs indexed, findings carry their leg, delta null", () => {
    const repo = freshRepo();
    const out = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    expect(out.delta).toBeNull();
    const raw = readFileSync(out.path, "utf8");
    expect(raw).toContain(`cairn: ${VERSION}`);
    expect(raw).toContain(`commit: ${git(repo, "rev-parse", "HEAD")}`);
    expect(raw).toMatch(/^leg: security-25 => .*security-25-.*\.md$/m);
    expect(raw).toMatch(/^leg: review-working => .*review-working-.*\.md$/m);
    expect(raw).toContain("first baseline");
    expect(raw).toMatch(/lookup dereferences null\nscenario: [^\n]*\nsource leg: security-25/);
    expect(raw).toMatch(/settings footer is stale\nscenario: [^\n]*\nsource leg: review-working/);
  });

  it("two sweeps across a code commit: new / persisting (title and scenario) / fixed; a third re-raise is regressed", () => {
    const repo = freshRepo();
    const first = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    commitCode(repo, "b.ts");

    // Same null-deref under a new headline + paraphrased scenario; footer gone; retry loop arrives.
    const renamed = minor("caller crashes on missing key",
      "lookup(undefined) returns null and the caller crashes with a TypeError");
    const second = sweep(repo, "2026-01-02", [renamed, RETRY_LOOP], []);
    const d2 = second.delta!;
    expect(d2.baseline).toMatchObject({ path: first.path, commit: first.commit, cairn: VERSION, created: today });
    expect(d2.codeCommitsSince).toBe(1);
    expect(d2.persisting.map((f) => f.title)).toEqual(["caller crashes on missing key"]);
    expect(d2.new.map((f) => f.title)).toEqual(["retry loop never backs off"]);
    expect(d2.fixed.map((f) => [f.title, f.leg])).toEqual([["settings footer is stale", "review-working"]]);
    expect(d2.regressed).toEqual([]);
    const raw2 = readFileSync(second.path, "utf8");
    expect(raw2).toContain(`## delta vs sweep-2026-01-01-${today}`);
    expect(raw2).toContain("code commits since: 1");
    expect(raw2).toContain("- fixed — minor: settings footer is stale\n  scenario: open /settings");

    // The footer comes back: fixed in sweep 2's own delta, present now -> regressed, not new.
    const third = sweep(repo, "2026-01-03", [renamed, RETRY_LOOP], [STALE_FOOTER]);
    const d3 = third.delta!;
    expect(d3.baseline.path).toBe(second.path);
    expect(d3.codeCommitsSince).toBe(0);
    expect(d3.regressed.map((f) => f.title)).toEqual(["settings footer is stale"]);
    expect(d3.new).toEqual([]);
    expect(d3.persisting.map((f) => f.title).sort()).toEqual(
      ["caller crashes on missing key", "retry loop never backs off"]);
    expect(d3.fixed).toEqual([]);
    expect(d3).toMatchObject({ unchecked: [], uncoveredLegs: [] });
    expect(readFileSync(third.path, "utf8")).toContain("- regressed — minor: settings footer is stale");
  });

  describe("the delta claims fixed only for legs it re-checked (#266)", () => {
    const T = minor("tests miss the retry path", "the retry branch in client.ts has no test, so deleting it stays green");
    const D = minor("runbook names a dead flag", "the runbook tells users to pass --legacy, which the CLI rejects");
    /** Writes one record per leg, then a manifest indexing them in the given order. */
    function legged(repo: string, date: string, byLeg: Record<string, AuditFinding[]>) {
      const legs = Object.entries(byLeg).map(([scope, fs]) =>
        ({ scope, path: writeAuditRecord(repo, scope, fs.length ? "findings" : "pass", fs).path }));
      const all = Object.values(byLeg).flat();
      return writeAuditRecord(repo, `sweep-${date}`, all.length ? "findings" : "pass", all, { legs });
    }

    it("a retargeted or skipped leg's findings read unchecked; a later re-raise reads persisting; a re-run settles them", () => {
      const repo = freshRepo();
      legged(repo, "2026-01-01", { "tests-25": [T], "docs-full": [D] });

      // The tests leg moved to the newest phase (clean) and the docs leg was skipped.
      const second = legged(repo, "2026-01-02", { "tests-26": [] });
      const d2 = second.delta!;
      expect(d2.fixed).toEqual([]);
      expect(d2.unchecked.map((f) => [f.title, f.leg])).toEqual([[T.title, "tests-25"], [D.title, "docs-full"]]);
      expect(d2.uncoveredLegs).toEqual(["tests-25", "docs-full"]);
      const raw2 = readFileSync(second.path, "utf8");
      expect(raw2).toContain("counts: new 0, persisting 0, fixed 0, regressed 0, unchecked 2");
      expect(raw2).toContain("uncovered legs: tests-25, docs-full");
      expect(raw2).toContain(`- unchecked — minor: ${T.title}\n  scenario: ${T.failure_scenario}\n  leg: tests-25`);
      expect(parseAuditRecord(second.path).deltaUnchecked).toEqual([
        { title: T.title, severity: "minor", failure_scenario: T.failure_scenario, leg: "tests-25" },
        { title: D.title, severity: "minor", failure_scenario: D.failure_scenario, leg: "docs-full" },
      ]);

      // The docs leg comes back and raises D again: persisting, not new and not regressed.
      // tests-25 is still not re-run, so T is carried forward as unchecked again.
      const d3 = legged(repo, "2026-01-03", { "docs-full": [D] }).delta!;
      expect(d3.persisting.map((f) => f.title)).toEqual([D.title]);
      expect(d3).toMatchObject({ new: [], regressed: [], fixed: [] });
      expect(d3.unchecked.map((f) => f.title)).toEqual([T.title]);
      expect(d3.uncoveredLegs).toEqual(["tests-26", "tests-25"]);

      // Both legs re-run clean over their old targets: now, and only now, both are fixed.
      const d4 = legged(repo, "2026-01-04", { "tests-25": [], "docs-full": [] }).delta!;
      expect(d4.fixed.map((f) => [f.title, f.leg])).toEqual([[D.title, "docs-full"], [T.title, "tests-25"]]);
      expect(d4).toMatchObject({ unchecked: [], uncoveredLegs: [] });
    });

    it("a mislabelled leg covers nothing — an index entry must point at a record written under its scope", () => {
      const repo = freshRepo();
      legged(repo, "2026-01-01", { "security-25": [NULL_DEREF] });
      const next = writeAuditRecord(repo, "security-26", "pass", []);
      const d = writeAuditRecord(repo, "sweep-2026-01-02", "pass", [],
        { legs: [{ scope: "security-25", path: next.path }] }).delta!;
      expect(d.fixed).toEqual([]);
      expect(d.unchecked.map((f) => f.title)).toEqual([NULL_DEREF.title]);
      expect(d.uncoveredLegs).toEqual(["security-25"]);
    });

    it("a manifest written before unchecked existed still serves as a baseline", () => {
      const repo = freshRepo();
      const audit = join(repo, ".cairn", "audit");
      mkdirSync(audit, { recursive: true });
      // The shape the 2.8.x writer produced: four classes, no uncovered-legs line.
      const old = join(audit, "sweep-2026-01-01-2026-01-01.md");
      writeFileSync(old, [
        "---", "scope: sweep-2026-01-01", "verdict: findings", "created: 2026-01-01",
        "commit: 0000000000000000000000000000000000000000", "dirty: false", "cairn: 2.8.1", "---",
        "# Audit: sweep-2026-01-01", "",
        `leg: tests-25 => ${join(audit, "tests-25-2026-01-01.md")}`,
        `leg: docs-full => ${join(audit, "docs-full-2026-01-01.md")}`, "",
        "## delta vs sweep-2025-12-01-2025-12-01",
        "baseline: /elsewhere/sweep-2025-12-01-2025-12-01.md @ 1111111 (cairn 2.8.0), 2025-12-01",
        "code commits since: 3",
        "counts: new 1, persisting 0, fixed 1, regressed 0",
        `- new — minor: ${T.title}`, `  scenario: ${T.failure_scenario}`, "  leg: tests-25",
        `- fixed — minor: ${D.title}`, `  scenario: ${D.failure_scenario}`, "  leg: docs-full", "",
        "## finding — minor", T.title, `scenario: ${T.failure_scenario}`, "source leg: tests-25", "",
      ].join("\n"));
      const back = parseAuditRecord(old);
      expect(back.findings.map((f) => [f.title, f.leg])).toEqual([[T.title, "tests-25"]]);
      expect(back.deltaFixed.map((f) => [f.title, f.leg])).toEqual([[D.title, "docs-full"]]);
      expect(back.deltaUnchecked).toEqual([]);

      const d = legged(repo, "2026-01-02", { "tests-25": [T], "docs-full": [D] }).delta!;
      expect(d.baseline.path).toBe(old);
      expect(d.persisting.map((f) => f.title)).toEqual([T.title]);
      expect(d.regressed.map((f) => f.title)).toEqual([D.title]);
      expect(d).toMatchObject({ new: [], fixed: [], unchecked: [], uncoveredLegs: [] });
    });
  });

  it("refuted findings are neither carried nor compared; a non-sweep scope has no delta and refuses legs", () => {
    const repo = freshRepo();
    const killed: AuditFinding = { severity: "important", title: "phantom race",
      failure_scenario: "two writers interleave and lose an update",
      panel: [{ seat: "v", verdict: "REFUTED", evidence: "single writer by construction" }] };
    writeAuditRecord(repo, "sweep-2026-01-01", "findings", [killed, NULL_DEREF]);
    const second = writeAuditRecord(repo, "sweep-2026-01-02", "findings", [NULL_DEREF]);
    expect(second.delta).toMatchObject({ new: [], fixed: [], regressed: [] });
    expect(second.delta!.persisting.map((f) => f.title)).toEqual(["lookup dereferences null"]);

    const plain = writeAuditRecord(repo, "review-working", "pass", []);
    expect(plain).not.toHaveProperty("delta");
    expect(readFileSync(plain.path, "utf8")).not.toContain("cairn:");
    expect(() => writeAuditRecord(repo, "review-working", "pass", [],
      { legs: [{ scope: "x", path: "y.md" }] })).toThrow(/not sweep-/);
  });

  it("a finding this sweep's panel refuted lands in no delta class", () => {
    const repo = freshRepo();
    writeAuditRecord(repo, "sweep-2026-01-01", "findings", [NULL_DEREF]);
    const killed: AuditFinding = { severity: "important", title: "phantom race",
      failure_scenario: "two writers interleave and lose an update",
      panel: [{ seat: "v", verdict: "REFUTED", evidence: "single writer by construction" }] };
    const second = writeAuditRecord(repo, "sweep-2026-01-02", "findings", [NULL_DEREF, killed]);
    const d = second.delta!;
    const classed = [...d.new, ...d.persisting, ...d.fixed, ...d.regressed, ...d.unchecked].map((f) => f.title);
    expect(classed).toEqual(["lookup dereferences null"]);
    expect(d.persisting.map((f) => f.title)).toEqual(["lookup dereferences null"]);
    // Still in the record, marked — just never in the delta section.
    const raw = readFileSync(second.path, "utf8");
    expect(raw).toContain("refuted: true — not filed to the tracker");
    expect(raw).not.toMatch(/^- \w+ — important: phantom race$/m);
  });

  it("matching is one-to-one, exact titles first — a fuzzy match never steals a title's prior", () => {
    const repo = freshRepo();
    const STALE_NODE = minor("cache returns stale node", "map_get after map_set returns the pre-write node");
    writeAuditRecord(repo, "sweep-2026-01-01", "findings", [STALE_NODE, RETRY_LOOP, NULL_DEREF]);
    const fuzzy = minor("map read is stale after write", "map_get after map_set returns the pre-write node from cache");
    const titled = minor("cache returns stale node", "the outlook board shows yesterday's counts after a refresh");
    // Two paraphrases of one prior null-deref: only one may claim it.
    const para1 = minor("caller crashes on missing key", "lookup(undefined) returns null and the caller crashes with a TypeError");
    const para2 = minor("lookup crash on undefined", "lookup(undefined) returns null so the caller crashes with TypeError");
    const d = writeAuditRecord(repo, "sweep-2026-01-02", "findings", [fuzzy, titled, para1, para2]).delta!;
    expect(d.persisting.map((f) => f.title)).toEqual(["cache returns stale node", "caller crashes on missing key"]);
    expect(d.new.map((f) => f.title)).toEqual(["map read is stale after write", "lookup crash on undefined"]);
    // No leg index on either side: nothing was re-checked, so the unmatched prior is unchecked, not fixed (#266).
    expect(d.fixed).toEqual([]);
    expect(d.unchecked.map((f) => f.title)).toEqual(["retry loop never backs off"]);
  });

  it("the baseline is the latest manifest dated no later than this one — never a later date, never the file being rewritten", () => {
    const repo = freshRepo();
    const late = writeAuditRecord(repo, "sweep-2026-01-05", "findings", [NULL_DEREF]);
    // A backdated sweep has no baseline: the only other manifest is later.
    const early = writeAuditRecord(repo, "sweep-2026-01-03", "findings", [STALE_FOOTER]);
    expect(early.delta).toBeNull();
    // Same-day rerun of the 01-05 sweep overwrites its own file; it diffs
    // against 01-03, not against the copy it is replacing.
    const rerun = writeAuditRecord(repo, "sweep-2026-01-05", "findings", [NULL_DEREF, RETRY_LOOP]);
    expect(rerun.path).toBe(late.path);
    const d = rerun.delta!;
    expect(d.baseline.path).toBe(early.path);
    expect(d.persisting).toEqual([]);
    expect(d.new.map((f) => f.title)).toEqual(["lookup dereferences null", "retry loop never backs off"]);
    expect(d.fixed).toEqual([]);
    expect(d.unchecked.map((f) => f.title)).toEqual(["settings footer is stale"]);
  });

  it("a sweep manifest credits no seat yield — its legs already did (#255)", () => {
    const repo = freshRepo();
    const yieldBase = fresh();
    const carried: AuditFinding = { severity: "important", title: "lookup dereferences null",
      failure_scenario: "lookup(undefined) returns null then the caller crashes with TypeError",
      seats: ["correctness"], panel: [{ seat: "v", verdict: "CONFIRMED", evidence: "reproduced" }] };
    const leg = writeAuditRecord(repo, "review-working", "findings", [carried], { yieldBaseDir: yieldBase });
    expect(loadYield(repo, yieldBase).state.seats.correctness?.findingsSurvived).toBe(1);
    const manifest = writeAuditRecord(repo, "sweep-2026-01-01", "findings", [carried],
      { yieldBaseDir: yieldBase, legs: [{ scope: "review-working", path: leg.path }] });
    expect(manifest.survived).toBe(1);
    expect(loadYield(repo, yieldBase).state.seats.correctness?.findingsSurvived).toBe(1);
  });

  describe("the manifest honours its legs' outcomes (#248)", () => {
    const vote = (seat: string, verdict: "CONFIRMED" | "PLAUSIBLE" | "REFUTED") =>
      ({ seat, verdict, evidence: `${seat} checked it` });
    const TOKEN_LEAK: AuditFinding = { severity: "critical", title: "Token leak",
      failure_scenario: "GITHUB_TOKEN echoed into the tracker comment body on adapter error",
      panel: [vote("a", "REFUTED"), vote("b", "REFUTED"), vote("c", "CONFIRMED")] };
    const SECRET_LOG: AuditFinding = { severity: "critical", title: "Secret in debug log",
      failure_scenario: "CAIRN debug logging prints the bearer header on a 401",
      panel: [vote("a", "CONFIRMED"), vote("b", "PLAUSIBLE")] };
    const STALE_CACHE: AuditFinding = { severity: "important", title: "Stale map cache",
      failure_scenario: "map_get after map_set returns the pre-write node",
      panel: [vote("a", "CONFIRMED")] };
    function legs(repo: string) {
      const s = writeAuditRecord(repo, "security-25", "findings", [TOKEN_LEAK, SECRET_LOG]);
      const r = writeAuditRecord(repo, "review-working", "findings", [STALE_CACHE]);
      return [{ scope: "security-25", path: s.path }, { scope: "review-working", path: r.path }];
    }

    it("refuses a finding its leg refuted, whatever panel the manifest carries", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...TOKEN_LEAK, panel: [vote("a", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/'Token leak' was refuted in leg 'security-25'/);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...TOKEN_LEAK, panel: [vote("a", "CONFIRMED"), vote("b", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/refuted in leg/);
      expect(listAuditRecords(repo).some((r) => r.scope.startsWith("sweep-"))).toBe(false);
    });

    it("a security leg's two-vote bar travels with its findings; other legs keep theirs", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...SECRET_LOG, panel: [vote("a", "CONFIRMED")] }], { legs: idx }))
        .toThrow(/has 1 panel vote; its leg 'security-25' needs 2/);
      // A leg mislabelled in the index still answers to its record's own scope.
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "findings",
        [{ ...SECRET_LOG, panel: [vote("a", "CONFIRMED")] }],
        { legs: [{ scope: "review-working", path: idx[0].path }] })).toThrow(/needs 2/);
      // Verbatim survivors — 2 votes from the security leg, 1 from review — are accepted.
      const ok = writeAuditRecord(repo, "sweep-2026-01-01", "findings", [SECRET_LOG, STALE_CACHE], { legs: idx });
      expect(ok.results.map((r) => [r.title, r.survived])).toEqual(
        [["Secret in debug log", true], ["Stale map cache", true]]);
      expect(readFileSync(ok.path, "utf8")).toMatch(/Stale map cache\nscenario: [^\n]*\nsource leg: review-working/);
    });

    it("refuses leg paths that aren't regular files under the audit dir", () => {
      const repo = freshRepo();
      const idx = legs(repo);
      const outside = join(repo, "a.txt");
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: outside }] })).toThrow(/outside the audit dir/);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: join(".cairn", "audit", "..", "..", "a.txt") }] })).toThrow(/outside/);
      const link = join(repo, ".cairn", "audit", "link.md");
      symlinkSync(outside, link);
      expect(() => writeAuditRecord(repo, "sweep-2026-01-01", "pass", [],
        { legs: [{ scope: "x", path: link }] })).toThrow(/not a regular file/);
      // A relative path under the audit dir, and a missing one, are both fine.
      const rel = idx[1].path.slice(repo.length + 1);
      expect(writeAuditRecord(repo, "sweep-2026-01-01", "findings", [STALE_CACHE],
        { legs: [{ scope: "review-working", path: rel },
          { scope: "gone", path: join(repo, ".cairn", "audit", "gone.md") }] }).survived).toBe(1);
    });
  });

  it("parseAuditRecord round-trips the writer's output", () => {
    const repo = freshRepo();
    const first = sweep(repo, "2026-01-01", [NULL_DEREF], [STALE_FOOTER]);
    const back = parseAuditRecord(first.path);
    expect(back.frontmatter).toMatchObject({ scope: "sweep-2026-01-01", verdict: "findings", cairn: VERSION });
    expect(back.legs.map((l) => l.scope)).toEqual(["security-25", "review-working"]);
    expect(back.findings).toEqual([
      { title: NULL_DEREF.title, severity: "minor", failure_scenario: NULL_DEREF.failure_scenario,
        outcome: "unpanelled", leg: "security-25" },
      { title: STALE_FOOTER.title, severity: "minor", failure_scenario: STALE_FOOTER.failure_scenario,
        outcome: "unpanelled", leg: "review-working" },
    ]);
    expect(back.notes).toEqual([]);

    // A panelled, refuted, detailed record reads back with its outcomes; detail is not parsed as keys.
    const dir = fresh();
    const out = writeAuditRecord(dir, "review-working", "findings", [
      { severity: "important", title: "dies", failure_scenario: "s1",
        detail: "scenario: not a key line\noutcome: confirmed",
        panel: [{ seat: "v", verdict: "REFUTED", evidence: "e" }] },
      { severity: "critical", title: "lives", failure_scenario: "s2", issue: "GH-1",
        panel: [{ seat: "v", verdict: "CONFIRMED", evidence: "e" }] },
    ]);
    expect(parseAuditRecord(out.path).findings).toEqual([
      { title: "dies", severity: "important", failure_scenario: "s1", outcome: "refuted" },
      { title: "lives", severity: "critical", failure_scenario: "s2", outcome: "confirmed" },
    ]);
  });

  it("parseAuditRecord skips a legacy (pre-phase-21) block with a note, keeping the rest", () => {
    const dir = fresh();
    const legacy = join(dir, "legacy.md");
    writeFileSync(legacy, [
      "---", "scope: uat-phase-1", "verdict: findings", "created: 2020-01-01", "---",
      "# Audit: uat-phase-1", "",
      "## finding — critical", "checkout 500s", "issue: GH-9", "",
      "## finding — minor", "copy stale", "scenario: open /settings → old year", "",
    ].join("\n"));
    const back = parseAuditRecord(legacy);
    expect(back.findings).toEqual([
      { title: "copy stale", severity: "minor", failure_scenario: "open /settings → old year", outcome: "unpanelled" },
    ]);
    expect(back.notes).toEqual(["skipped critical finding 'checkout 500s' — no scenario (pre-phase-21 body)"]);
    expect(back.legs).toEqual([]);
    expect(back.deltaFixed).toEqual([]);
    expect(back.deltaUnchecked).toEqual([]);
  });
});
