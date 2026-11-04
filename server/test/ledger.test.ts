import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { execFileSync } from "node:child_process";
import { appendLedger, checkLedgerEntry, declaredVerifyFor } from "../src/planning/ledger.js";
import { declaredVerifyIn, isPlainShellLine, planCheck, verifyClauseOf } from "../src/planning/check.js";
import { distillManifest, parseLedger } from "../src/planning/distill-manifest.js";
import { CairnError } from "../src/errors.js";
import {
  actualsSegment, receiptsDir, recordClaim, takeReceipt, writeReceipt, type CloseReceipt,
} from "../src/planning/close-receipt.js";
import { minimalEnv, observeDeclaredVerify } from "../src/planning/verify-rerun.js";
import { approvalsDir, approvePlan, readPlanApproval } from "../src/planning/plan-approval.js";
import { classifyLine } from "../src/planning/line-effects.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-ledger-"));

const entry = {
  taskRef: "task-3",
  summary: "wire adapter retries",
  baseCommit: "a1b2c3d4e5f6",
  headCommit: "d4e5f6a1b2c3",
  issueId: "PROJ-105",
  closedDate: "2026-07-14",
  evidence: { command: "npm test", result: "12 passed" },
};
// The exact segments the fixture renders to — every pinned line below
// carries them between the commit range and the issue id. No close ran in
// these fixtures, so there is no receipt and the actuals segment says so.
const EV = "evidence npm test => 12 passed — actuals wall=none degraded=no_receipt — ";

function ledgerPath(d: string, phaseDir: string): string {
  return join(d, ".cairn", "plans", "phases", phaseDir, "LEDGER.md");
}

describe("ledger ordering is a merge artifact (#361)", () => {
  it("two interleavings of the same lines parse to the same closures", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");
    const a = { ...entry, taskRef: "task-1", issueId: "PROJ-1" };
    const b = { ...entry, taskRef: "task-2", issueId: "PROJ-2" };
    const c = { ...entry, taskRef: "task-3", issueId: "PROJ-3" };
    const closures = (order: typeof a[]): string[] => {
      rmSync(ledgerPath(d, phaseDir), { force: true });
      for (const e of order) appendLedger(d, phaseDir, e);
      const base = join(d, ".cairn", "plans", "phases", phaseDir);
      return parseLedger(base).entries.map((r) => `${r.issueId}|${r.taskRef}`).sort();
    };
    const one = closures([a, b, c]);
    expect(one).toHaveLength(3);
    expect(closures([c, a, b])).toEqual(one);
  });
});

describe("closure-plus-evidence across a union merge reads the same answer in both directions (#445)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const short = (sha: string) => sha.slice(0, 7);

  /**
   * A tracked project (planning dir and its union attribute committed) with
   * one phase planning PROJ-105. Returns the root commit every branch
   * descends from.
   */
  function repo(): { d: string; phaseDir: string; base: string; root: string } {
    const d = dir();
    scaffoldProject(d, "P"); // writes the union attribute (#361)
    const { dir: phaseDir } = scaffoldPhase(d, 1, "Core");
    const base = join(d, ".cairn", "plans", "phases", phaseDir);
    writeFileSync(join(base, "PLAN.md"),
      "---\nissues: [PROJ-105]\n---\n# Phase 1\n\n## Tasks\n- **#PROJ-105 — thing** `verify: npm test`\n");
    git(d, "init", "-q");
    git(d, "config", "user.email", "t@t");
    git(d, "config", "user.name", "t");
    git(d, "add", "-A");
    git(d, "commit", "-qm", "plan", "--no-gpg-sign");
    return { d, phaseDir, base, root: git(d, "rev-parse", "HEAD") };
  }
  /** One code commit on the current branch, so a ledger line has a real head to cite. */
  function work(d: string, name: string): string {
    writeFileSync(join(d, `${name}.txt`), `${name}\n`);
    git(d, "add", "-A");
    git(d, "commit", "-qm", name, "--no-gpg-sign");
    return git(d, "rev-parse", "HEAD");
  }
  const commitLedger = (d: string, msg: string) => {
    git(d, "add", "-A");
    git(d, "commit", "-qm", msg, "--no-gpg-sign");
  };

  /** What every reader says about PROJ-105 and the phase, read off the checked-out ledger. */
  function readers(d: string, base: string) {
    const parsed = parseLedger(base);
    const findings = planCheck(d, 1).findings.filter((f) => f.type === "closure-superseded");
    const m = distillManifest(d, 1);
    return {
      standing: parsed.entries.map((e) => e.issueId),
      superseded: parsed.superseded.map((e) => e.issueId),
      retracted: findings.length > 0,
      range: m.commitRange,
      distillClosed: m.ledgerEntries.map((e) => e.issueId),
    };
  }

  /**
   * Union-merge the two branches both ways on throwaway branches, assert
   * both merges are clean and that the two files really do carry the lines
   * in opposite orders, and hand back what the readers say on each side.
   */
  function bothWays(d: string, base: string) {
    const ledger = join(base, "LEDGER.md");
    const order = (): string[] => readFileSync(ledger, "utf8").split("\n")
      .filter((l) => l.startsWith("- ")).map((l) => l.slice(0, 5));
    git(d, "checkout", "-q", "-b", "m1", "close");
    git(d, "merge", "-q", "--no-edit", "--no-gpg-sign", "fixup"); // clean: no conflict, exit 0
    const first = { lines: order(), ...readers(d, base) };
    git(d, "checkout", "-q", "-b", "m2", "fixup");
    git(d, "merge", "-q", "--no-edit", "--no-gpg-sign", "close");
    const second = { lines: order(), ...readers(d, base) };
    expect(first.lines).toHaveLength(2);
    expect(second.lines).toEqual([...first.lines].reverse());
    return { first, second };
  }

  it("fix-up descends from the close: the task reads retracted on both sides, range head is the fix-up's", () => {
    const { d, phaseDir, base, root } = repo();
    // The close branch lands its work; the fix-up branches from that work
    // (so its head descends from the close's head) and corrects the close
    // before the close's own ledger line exists on its branch. The close
    // line carries the LATER date, so only ancestry can settle this.
    git(d, "checkout", "-q", "-b", "close");
    const closeHead = work(d, "feature");
    git(d, "checkout", "-q", "-b", "fixup");
    const fixHead = work(d, "fix");
    appendLedger(d, phaseDir, {
      ...entry, baseCommit: closeHead, headCommit: fixHead, closedDate: "2026-07-14",
      kind: "evidence", note: "the close claimed a pass the suite did not show",
    });
    commitLedger(d, "ledger: evidence");
    git(d, "checkout", "-q", "close");
    appendLedger(d, phaseDir, { ...entry, baseCommit: root, headCommit: closeHead, closedDate: "2026-07-15" });
    commitLedger(d, "ledger: close");

    const { first, second } = bothWays(d, base);
    for (const side of [first, second]) {
      expect(side.standing).toEqual([]);
      expect(side.superseded).toEqual(["PROJ-105"]);
      expect(side.retracted).toBe(true);
      expect(side.distillClosed).toEqual([]);
      expect(side.range).toEqual({ base: short(root), head: short(fixHead) });
    }
  });

  it("fresh close descends from the fix-up: the task reads closed on both sides, range head is the close's", () => {
    const { d, phaseDir, base, root } = repo();
    // Mirror image: the fix-up's work lands first, the fresh close builds on
    // it, and this time the evidence line carries the later date.
    git(d, "checkout", "-q", "-b", "fixup");
    const fixHead = work(d, "fix");
    git(d, "checkout", "-q", "-b", "close");
    const closeHead = work(d, "feature");
    appendLedger(d, phaseDir, {
      ...entry, baseCommit: fixHead, headCommit: closeHead, closedDate: "2026-07-14",
    });
    commitLedger(d, "ledger: close");
    git(d, "checkout", "-q", "fixup");
    appendLedger(d, phaseDir, {
      ...entry, baseCommit: root, headCommit: fixHead, closedDate: "2026-07-15",
      kind: "evidence", note: "still open",
    });
    commitLedger(d, "ledger: evidence");

    const { first, second } = bothWays(d, base);
    for (const side of [first, second]) {
      expect(side.standing).toEqual(["PROJ-105"]);
      expect(side.superseded).toEqual([]);
      expect(side.retracted).toBe(false);
      expect(side.distillClosed).toEqual(["PROJ-105"]);
      expect(side.range).toEqual({ base: short(root), head: short(closeHead) });
    }
  });

  it("no ancestry to read: the dates on the lines decide, and file order only breaks a dated tie", () => {
    // Fake shas, no repository: git cannot place the heads, so the rule
    // falls through to closedDate, then to position in the file.
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");
    const base = join(d, ".cairn", "plans", "phases", phaseDir);
    const read = () => parseLedger(base);
    // Evidence FIRST in the file but dated later than the close: retracted.
    appendLedger(d, phaseDir, { ...entry, kind: "evidence", closedDate: "2026-07-15" });
    appendLedger(d, phaseDir, { ...entry, closedDate: "2026-07-14" });
    expect(read().entries).toEqual([]);
    expect(read().superseded.map((e) => [e.line, e.supersededBy])).toEqual([[6, 5]]);
    // Evidence LAST in the file but dated earlier than the close: the close stands.
    rmSync(ledgerPath(d, phaseDir), { force: true });
    appendLedger(d, phaseDir, { ...entry, closedDate: "2026-07-14" });
    appendLedger(d, phaseDir, { ...entry, kind: "evidence", closedDate: "2026-07-13" });
    expect(read().entries.map((e) => e.line)).toEqual([5]);
    expect(read().superseded).toEqual([]);
    // Same date: file order, as before -- the later line speaks.
    rmSync(ledgerPath(d, phaseDir), { force: true });
    appendLedger(d, phaseDir, { ...entry, closedDate: "2026-07-14" });
    appendLedger(d, phaseDir, { ...entry, kind: "evidence", closedDate: "2026-07-14" });
    expect(read().entries).toEqual([]);
    expect(read().superseded.map((e) => e.supersededBy)).toEqual([6]);
    // The range is dated the same way: earliest base to latest head.
    expect(read().range).toEqual({ base: "a1b2c3d", head: "d4e5f6a" });
  });
});

describe("appendLedger", () => {
  it("creates the file with a header on first append", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    appendLedger(d, phaseDir, entry);

    const content = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // header (at least one non-entry line) precedes the single entry line
    expect(lines[lines.length - 1]).toBe(
      `- [x] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-14`,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(content.startsWith("#")).toBe(true);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("second append adds exactly one line, leaving the first untouched", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    appendLedger(d, phaseDir, entry);
    const before = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const beforeLineCount = before.split("\n").filter((l) => l.length > 0).length;

    appendLedger(d, phaseDir, {
      ...entry, taskRef: "task-4", summary: "second task", closedDate: "2026-07-15",
    });

    const after = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const afterLines = after.split("\n").filter((l) => l.length > 0);
    expect(afterLines.length).toBe(beforeLineCount + 1);
    expect(after.startsWith(before.slice(0, before.lastIndexOf("- [x]")))).toBe(true);
    expect(afterLines[afterLines.length - 1]).toBe(
      `- [x] task-4 — second task — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-15`,
    );
  });

  it("sanitizes embedded newlines in entry fields to a single line", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    const { line } = appendLedger(d, phaseDir, {
      ...entry,
      summary: "line one\nline two\n   line three",
    });

    expect(line.split("\n").length).toBe(1);
    expect(line).toBe(
      `- [x] task-3 — line one line two line three — commits a1b2c3d..d4e5f6a — ${EV}PROJ-105 closed 2026-07-14`,
    );

    const content = readFileSync(ledgerPath(d, phaseDir), "utf8");
    const entryLines = content.split("\n").filter((l) => l.startsWith("- [x]"));
    expect(entryLines.length).toBe(1);
  });

  it("throws NOT_FOUND with a nextAction for a phaseDir that doesn't exist", () => {
    const d = dir();
    scaffoldProject(d, "P");

    let caught: unknown;
    try {
      appendLedger(d, "99-nonexistent", entry);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CairnError);
    const err = caught as CairnError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.nextAction).toBeTruthy();
  });

  it("appends a tdd evidence segment when red+green are given", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    const { line } = appendLedger(d, phaseDir, {
      taskRef: "T2", summary: "tdd task", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-2", closedDate: "2026-07-18",
      redCommit: "c".repeat(40), greenCommit: "d".repeat(40),
      evidence: { command: "vitest run t2.test.ts", result: "4 passed" },
    });
    // tdd first, then evidence, then the close — one grammar.
    expect(line).toContain("— tdd ccccccc..ddddddd — evidence vitest run t2.test.ts => 4 passed — actuals wall=none degraded=no_receipt — GH-2 closed");
  });

  it("rejects a lone red or green commit", () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Ledger Phase");

    expect(() => appendLedger(d, phaseDir, {
      taskRef: "T3", summary: "s", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-3", closedDate: "2026-07-18",
      redCommit: "c".repeat(40), evidence: { command: "c", result: "r" },
    })).toThrowError(/both or neither/);
  });

  describe("typed close evidence (phase 23)", () => {
    const base = { taskRef: "T5", summary: "s", baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40), issueId: "GH-5", closedDate: "2026-09-17" };
    const ready = () => {
      const d = dir(); scaffoldProject(d, "P");
      return { d, phaseDir: scaffoldPhase(d, 3, "Ledger Phase").dir };
    };

    it("refuses an entry with neither evidence nor a waiver — the gate", () => {
      const { d, phaseDir } = ready();
      let caught: unknown;
      try { appendLedger(d, phaseDir, base); } catch (e) { caught = e; }
      expect((caught as CairnError).code).toBe("PRECONDITION_FAILED");
      expect((caught as CairnError).message).toMatch(/close evidence missing/);
      expect((caught as CairnError).nextAction).toMatch(/evidenceWaived/);
    });

    it("renders a waiver with its reason; an empty reason or empty evidence field is refused; both is a contradiction", () => {
      const { d, phaseDir } = ready();
      const { line } = appendLedger(d, phaseDir, { ...base, evidenceWaived: "docs only — no runnable change" });
      expect(line).toBe(`- [x] T5 — s — commits aaaaaaa..bbbbbbb — waived docs only - no runnable change — actuals wall=none degraded=no_receipt — GH-5 closed 2026-09-17`);
      expect(() => appendLedger(d, phaseDir, { ...base, evidenceWaived: "  " })).toThrowError(/needs a reason/);
      expect(() => appendLedger(d, phaseDir, { ...base, evidence: { command: "npm test", result: " " } }))
        .toThrowError(/both a command .* and a result/);
      expect(() => appendLedger(d, phaseDir, { ...base, evidence: { command: "c", result: "r" }, evidenceWaived: "w" }))
        .toThrowError(/mutually exclusive/);
    });

    it("strips em dashes and newlines from evidence so the line's separators stay unambiguous", () => {
      const { d, phaseDir } = ready();
      const { line } = appendLedger(d, phaseDir, {
        ...base, evidence: { command: "npm test — full", result: "1408 passed\n0 failed" },
      });
      expect(line).toBe(`- [x] T5 — s — commits aaaaaaa..bbbbbbb — evidence npm test - full => 1408 passed 0 failed — actuals wall=none degraded=no_receipt — GH-5 closed 2026-09-17`);
    });
  });
});

describe("declared verification, reported at close (phase 24.5)", () => {
  /** Project with one phase whose PLAN.md carries the given task lines. */
  function projectWithTasks(tasks: string): { d: string; phaseDir: string } {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md"),
      `---\nissues: [PROJ-105]\n---\n# Phase 1\n\n## Tasks\n${tasks}`);
    return { d, phaseDir };
  }

  it("reads the declaration back out of PLAN.md", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npx vitest run test/adapter.test.ts`\n");
    expect(declaredVerifyFor(d, phaseDir, "PROJ-105"))
      .toBe("npx vitest run test/adapter.test.ts");
  });

  it("returns null when the plan declares nothing, and the append still succeeds", () => {
    const { d, phaseDir } = projectWithTasks("- **#PROJ-105 — thing**\n");
    expect(declaredVerifyFor(d, phaseDir, "PROJ-105")).toBeNull();
    const r = appendLedger(d, phaseDir, entry);
    expect(r.declaredVerify).toBeUndefined();
    expect(r.evidenceCitesDeclared).toBeUndefined();
    expect(r.line).toContain(EV);
  });

  it("reports whether the evidence cites the declaration — it never refuses either way", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npx vitest run test/adapter.test.ts`\n");
    const matched = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "npx vitest run test/adapter.test.ts", result: "12 passed" },
    });
    expect(matched.declaredVerify).toBe("npx vitest run test/adapter.test.ts");
    expect(matched.evidenceCitesDeclared).toBe(true);

    const mismatched = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "node scripts/check-surface.mjs", result: "clean" },
    });
    expect(mismatched.evidenceCitesDeclared).toBe(false);
    // Reported, not enforced: the line is written either way.
    expect(mismatched.line).toContain("evidence node scripts/check-surface.mjs");
  });

  it("shorthand still counts as citing the same check", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npm test`\n");
    // The declaration says "npm test"; what actually gets typed is longer.
    // Failing that honest close would only teach people to pad the field.
    const r = appendLedger(d, phaseDir, {
      ...entry,
      evidence: { command: "npx vitest run --exclude '**/*.live.test.ts'", result: "1452 passed" },
    });
    expect(r.evidenceCitesDeclared).toBe(true);
  });

  it("a waived close reports the declaration and no citation", () => {
    const { d, phaseDir } = projectWithTasks(
      "- **#PROJ-105 — thing** `verify: npm test`\n");
    const r = appendLedger(d, phaseDir, {
      ...entry, evidence: undefined, evidenceWaived: "docs only",
    });
    expect(r.declaredVerify).toBe("npm test");
    expect(r.evidenceCitesDeclared).toBe(false);
    expect(r.line).toContain("waived docs only");
  });
});

describe("close receipt consumed at append (#233)", () => {
  const receipt = (issueId: string): CloseReceipt => ({
    version: 1,
    issueId,
    closedAt: "2026-10-01T12:00:00.000Z",
    claimedAt: null,
    claimedMinutes: 128,
    estimate: { points: 2, pointsSource: "body", minutes: 90, minutesSource: "body" },
    worklog: "unsupported",
  });
  const phase = () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Receipt Phase");
    return { d, phaseDir };
  };
  const receiptFile = (d: string, id: string) =>
    join(receiptsDir(d), `${id}.close.json`);

  it("renders the receipt into the actuals segment and deletes it", () => {
    const { d, phaseDir } = phase();
    expect(writeReceipt(d, receipt("PROJ-105"))).toBe(true);
    const r = appendLedger(d, phaseDir, entry);
    expect(r.line).toContain(
      "— actuals wall=none claimed=128m est=2pt:body,90m:body worklog=unsupported — PROJ-105 closed");
    expect(r.degraded).toBeUndefined();
    expect(existsSync(receiptFile(d, "PROJ-105"))).toBe(false);
  });

  it("checkLedgerEntry raises every append refusal with nothing written or consumed (#365)", () => {
    const { d, phaseDir } = phase();
    writeReceipt(d, receipt("PROJ-105"));
    const refusal = (fn: () => unknown) => {
      try { fn(); } catch (e) { return (e as CairnError).code; }
      return "accepted";
    };
    expect(refusal(() => checkLedgerEntry(d, "09-nowhere", entry))).toBe("NOT_FOUND");
    expect(refusal(() => checkLedgerEntry(d, phaseDir, { ...entry, redCommit: "abc1234" })))
      .toBe("CONFIG_INVALID");
    expect(refusal(() => checkLedgerEntry(d, phaseDir, { ...entry, evidence: undefined })))
      .toBe("PRECONDITION_FAILED");
    expect(checkLedgerEntry(d, phaseDir, entry)).toMatchObject({ number: 3 });
    expect(existsSync(receiptFile(d, "PROJ-105"))).toBe(true);
    expect(existsSync(ledgerPath(d, phaseDir))).toBe(false);
  });

  it("a refused append leaves the receipt for the retry", () => {
    const { d, phaseDir } = phase();
    writeReceipt(d, receipt("PROJ-105"));
    expect(() => appendLedger(d, phaseDir, { ...entry, evidence: undefined }))
      .toThrow(CairnError);
    expect(existsSync(receiptFile(d, "PROJ-105"))).toBe(true);
  });

  it("no receipt: the line is still written and names what was missing", () => {
    const { d, phaseDir } = phase();
    const r = appendLedger(d, phaseDir, entry);
    expect(r.degraded).toEqual(["no_receipt"]);
    expect(r.line).toContain("— actuals wall=none degraded=no_receipt — PROJ-105 closed");
  });

  it("a corrupt receipt degrades, never fails, and is cleared", () => {
    const { d, phaseDir } = phase();
    writeReceipt(d, receipt("PROJ-105"));
    writeFileSync(receiptFile(d, "PROJ-105"), "{ not json");
    const r = appendLedger(d, phaseDir, entry);
    expect(r.degraded).toEqual(["receipt_unreadable"]);
    expect(existsSync(receiptFile(d, "PROJ-105"))).toBe(false);
  });

  it("a receipt written for '233' is found by an append naming '#233'", () => {
    const { d, phaseDir } = phase();
    writeReceipt(d, receipt("233"));
    const r = appendLedger(d, phaseDir, { ...entry, issueId: "#233" });
    expect(r.degraded).toBeUndefined();
    expect(r.line).toContain("actuals wall=none claimed=128m");
  });

  it("the receipts folder ignores itself, so no repo ever commits one", () => {
    const { d } = phase();
    writeReceipt(d, receipt("PROJ-105"));
    expect(readFileSync(join(receiptsDir(d), ".gitignore"), "utf8")).toBe("*\n");
  });

  it("an unwritable state folder makes writeReceipt return false, not throw", () => {
    const { d } = phase();
    writeFileSync(join(d, ".cairn", "state"), "a file where the folder should be");
    expect(writeReceipt(d, receipt("PROJ-105"))).toBe(false);
    expect(takeReceipt(d, "PROJ-105")).toEqual({ degraded: "no_receipt" });
  });

  it("an absent estimate and claim render as none, not as zero", () => {
    expect(actualsSegment({ receipt: {
      ...receipt("X"), claimedMinutes: null,
      estimate: { points: null, pointsSource: null, minutes: null, minutesSource: null },
      worklog: "not_requested",
    }, wall: { minutes: null, source: "none" } }))
      .toBe("actuals wall=none claimed=none est=none worklog=not_requested — ");
  });
});

describe("evidence-only lines (#256)", () => {
  const phase = () => {
    const d = dir();
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 3, "Evidence Phase");
    return { d, phaseDir };
  };

  it("renders with no closure claim: unchecked box, 'evidence for', no 'closed', no actuals", () => {
    const { d, phaseDir } = phase();
    const r = appendLedger(d, phaseDir, { ...entry, kind: "evidence", note: "issue stays open" });
    expect(r.line).toBe(
      "- [ ] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — "
        + "evidence npm test => 12 passed — note issue stays open — evidence for PROJ-105 2026-07-14");
    expect(r.line).not.toMatch(/closed/);
    expect(r.degraded).toBeUndefined();
  });

  it("does not consume a waiting close receipt", () => {
    const { d, phaseDir } = phase();
    writeReceipt(d, {
      version: 1, issueId: "PROJ-105", closedAt: "2026-10-01T12:00:00.000Z",
      claimedAt: null, claimedMinutes: null,
      estimate: { points: null, pointsSource: null, minutes: null, minutesSource: null },
      worklog: "unsupported",
    } as CloseReceipt);
    appendLedger(d, phaseDir, { ...entry, kind: "evidence" });
    expect(existsSync(join(receiptsDir(d), "PROJ-105.close.json"))).toBe(true);
  });

  it("still requires evidence or a waiver; a note on a closure line is refused", () => {
    const { d, phaseDir } = phase();
    expect(() => appendLedger(d, phaseDir, { ...entry, kind: "evidence", evidence: undefined }))
      .toThrowError(/close evidence missing/);
    expect(() => appendLedger(d, phaseDir, { ...entry, note: "x" }))
      .toThrowError(/only written on evidence lines/);
  });

  it("default kind still writes the closure line byte-for-byte as before", () => {
    const { d, phaseDir } = phase();
    const r = appendLedger(d, phaseDir, entry);
    expect(r.line).toBe(
      "- [x] task-3 — wire adapter retries — commits a1b2c3d..d4e5f6a — " + EV + "PROJ-105 closed 2026-07-14");
  });
});

describe("one verify-clause parser (#357)", () => {
  it("prose naming a `verify:` span is never the declaration; the last real clause wins", () => {
    // The 2026-10-18 case: an empty `verify:` span in prose, followed on
    // the same line by another backtick span, read as the declared line.
    const lines = [
      "- **#357 — rerun** (3pt). Two `verify:` parsers already exist (see `check.ts`);",
      "  the old `verify: npm run old` was the wrong check, mid-sentence.",
      "  `verify: npm run first`",
      "  `verify: cd server && npx vitest run test/ledger.test.ts`",
      "- **#358 — next** `verify: npm run other`",
    ];
    expect(declaredVerifyIn(lines, "357")).toBe("cd server && npx vitest run test/ledger.test.ts");
    expect(declaredVerifyIn(lines, "#358")).toBe("npm run other");
    expect(verifyClauseOf("Two `verify:` parsers already exist (see `check.ts`);")).toBeNull();
    expect(verifyClauseOf("- **#7 — thing** `verify: npm test`")).toBe("npm test");
  });

  it("a plain task bullet ends the block, so a task never borrows its neighbour's clause", () => {
    expect(declaredVerifyIn(["- #7 red first", "- #8 docs `verify: npm test`"], "7")).toBeNull();
  });

  it("plain shell lines pass; prose, placeholders and manual checks do not", () => {
    expect(isPlainShellLine("cd server && npx vitest run && ! grep -q x y.md")).toBe(true);
    expect(isPlainShellLine("<command>")).toBe(false);
    expect(isPlainShellLine("manual: eyeball the page")).toBe(false);
    expect(isPlainShellLine("npm test — and read the output")).toBe(false);
    expect(isPlainShellLine("npm test ...")).toBe(false);
  });
});

describe("verify.rerun: the server re-runs the declared verify at close (#357)", () => {
  const gitIn = (d: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: d, encoding: "utf8" }).trim();

  /**
   * A project whose PLAN.md declares `declared` for PROJ-105, committed
   * (tracked) unless `track` is false, with cairn.json's verify block as
   * given, and the owner's approval stamped on the plan (#423) unless
   * `approve` is false. Returns the commit the plan landed in.
   */
  function rerunProject(declared: string, verify: Record<string, unknown> | undefined,
    opts: { track?: boolean; claim?: boolean; approve?: boolean } = {}):
    { d: string; phaseDir: string; base: string } {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "local", config: {} }, ...(verify ? { verify } : {}),
    }));
    scaffoldProject(d, "P");
    const { dir: phaseDir } = scaffoldPhase(d, 1, "Core");
    writeFileSync(join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md"),
      "---\nissues: [PROJ-105]\n---\n# Phase 1\n\n## Tasks\n"
      + `- **#PROJ-105 — thing** (1pt). Wire it.\n  \`verify: ${declared}\`\n`);
    let base = "a1b2c3d4e5f6";
    if (opts.track !== false) {
      gitIn(d, "init", "-q");
      gitIn(d, "config", "user.email", "t@t");
      gitIn(d, "config", "user.name", "t");
      gitIn(d, "add", "-A");
      gitIn(d, "commit", "-qm", "plan", "--no-gpg-sign");
      base = gitIn(d, "rev-parse", "HEAD");
      // The owner's approval of the plan as it reads now (#423): the only
      // provenance the re-run keys on. Tests that want it absent pass
      // approve: false; an untracked project has no git to stamp against.
      if (opts.approve !== false) approvePlan(d, phaseDir);
    }
    // The server's claim stamp (#369) is still the close's duration clock,
    // but since #423 it is no longer the re-run's provenance.
    if (opts.claim !== false) recordClaim(d, "PROJ-105", "2026-07-14T10:00:00.000Z", base);
    return { d, phaseDir, base };
  }
  const closeOn = (base: string, command: string) => ({
    ...entry, baseCommit: base, headCommit: base, evidence: { command, result: "passed" },
  });
  const plain = (base: string) =>
    `- [x] task-3 — wire adapter retries — commits ${base.slice(0, 7)}..${base.slice(0, 7)} — `
    + "evidence touch ran.marker => passed — actuals wall=none degraded=no_receipt — PROJ-105 closed 2026-07-14";

  it("rerun off records nothing new: no observed field, the line byte-identical, nothing run", () => {
    for (const verify of [undefined, { rerun: false }]) {
      const { d, phaseDir, base } = rerunProject("touch ran.marker", verify);
      const r = appendLedger(d, phaseDir, closeOn(base, "touch ran.marker"));
      expect(r.line).toBe(plain(base));
      expect(r.observed).toBeUndefined();
      expect(r.observedMismatch).toBeUndefined();
      expect(existsSync(join(d, "ran.marker"))).toBe(false);
    }
  });

  it("rerun on, evidence equals the declared line, it passes: observed.exit = 0 beside the claim", () => {
    const declared = "echo suite ok && echo 3 passed";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(r.observed).toMatchObject({ exit: 0, tail: "suite ok\n3 passed", command: declared });
    expect(Number.isNaN(Date.parse((r.observed as { at: string }).at))).toBe(false);
    expect(r.observedMismatch).toBe(false);
    expect(r.line).toMatch(/ — evidence echo suite ok && echo 3 passed => passed — observed exit=0 at=\S+ — actuals /);
    expect(r.line).not.toContain("observed-mismatch");
    expect(planCheck(d, 1).findings.filter((f) => f.type === "observed-mismatch")).toEqual([]);
    expect(distillManifest(d, 1).observedMismatches).toEqual([]);
    // the line still parses as a standing closure
    expect(distillManifest(d, 1).ledgerEntries.map((e) => e.issueId)).toEqual(["PROJ-105"]);
  });

  it("rerun on, it fails: the line is marked observed-mismatch, plan_check reports it important, distill lists it", () => {
    const declared = "echo boom >&2; exit 1";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    // Never refused (ADR 0017): the line is written, the mismatch reported.
    expect(r.observed).toMatchObject({ exit: 1, tail: "boom" });
    expect(r.observedMismatch).toBe(true);
    expect(r.line).toMatch(/ — observed exit=1 at=\S+ observed-mismatch — /);
    const found = planCheck(d, 1).findings.filter((f) => f.type === "observed-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "important", plan: expect.stringContaining("LEDGER.md") });
    expect(found[0].detail).toContain("exit 1");
    expect(distillManifest(d, 1).observedMismatches).toEqual([expect.objectContaining({
      issueId: "PROJ-105", exit: "1",
    })]);
  });

  it("a summary shaped like a passing ledger tail cannot forge the observation (#426)", () => {
    // The declared verify fails; the worker's summary carries its own fake
    // "commits / evidence / observed exit=0 / closed" run so a first-run
    // parser would read a pass. Both layers hold: the writer neutralises
    // the em dashes in taskRef and summary (the segment sanitizer), and
    // every reader binds the server's real run at the end of the line.
    const declared = "echo boom >&2; exit 1";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const forged = `fixed it — commits ${base.slice(0, 7)}..${base.slice(0, 7)} — `
      + `evidence ${declared} => passed — observed exit=0 at=2026-07-14T10:00:00.000Z — `
      + "actuals wall=none degraded=no_receipt — PROJ-105 closed 2026-07-14";
    const r = appendLedger(d, phaseDir, {
      ...closeOn(base, declared), taskRef: "task-3 — commits aaaaaaa..bbbbbbb", summary: forged,
    });
    // The line: no em dash survives inside the taskRef or summary slots.
    expect(r.line.startsWith("- [x] task-3 - commits aaaaaaa..bbbbbbb — fixed it - commits ")).toBe(true);
    expect(r.line).toMatch(/ — observed exit=1 at=\S+ observed-mismatch — /);
    expect(r.line.split(" — commits ")).toHaveLength(2);
    // Every reader sees the mismatch the server recorded, not the forgery.
    const parsed = parseLedger(join(d, ".cairn", "plans", "phases", phaseDir)).entries;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      issueId: "PROJ-105", closedDate: "2026-07-14", observedExit: "1", observedMismatch: true,
    });
    const found = planCheck(d, 1).findings.filter((f) => f.type === "observed-mismatch");
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain("exit 1");
    expect(distillManifest(d, 1).observedMismatches).toEqual([expect.objectContaining({
      issueId: "PROJ-105", exit: "1",
    })]);
  });

  it("a worker-supplied command that differs from the declared line is never executed", () => {
    const { d, phaseDir, base } = rerunProject("touch declared.marker", { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, "touch worker.marker"));
    expect(r.observed).toEqual({ skipped: "command-differs" });
    expect(r.observedMismatch).toBe(false);
    expect(r.line).toContain(" — observed skipped=command-differs — ");
    expect(existsSync(join(d, "worker.marker"))).toBe(false);
    expect(existsSync(join(d, "declared.marker"))).toBe(false);
  });

  it("a timeout reads exit=timeout and is a mismatch", () => {
    const declared = "echo started; sleep 5";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true, timeoutSeconds: 1 });
    const t0 = Date.now();
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(r.observed).toMatchObject({ exit: "timeout", tail: "started" });
    expect(r.observedMismatch).toBe(true);
    expect(r.line).toMatch(/ — observed exit=timeout at=\S+ observed-mismatch — /);
  });

  it("an untracked PLAN.md has no provenance: reported, not run", () => {
    const { d, phaseDir, base } = rerunProject("touch ran.marker", { rerun: true }, { track: false });
    const r = appendLedger(d, phaseDir, closeOn(base, "touch ran.marker"));
    expect(r.observed).toEqual({ skipped: "plan-untracked" });
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("an unapproved plan never runs: no owner stamp, the line is reported, not run (#423)", () => {
    const { d, phaseDir, base } = rerunProject("touch ran.marker", { rerun: true }, { approve: false });
    expect(readPlanApproval(d, phaseDir)).toBeNull();
    const r = appendLedger(d, phaseDir, closeOn(base, "touch ran.marker"));
    expect(r.observed).toMatchObject({ skipped: "plan-unapproved" });
    expect(r.line).toContain(" — observed skipped=plan-unapproved — ");
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("the approval stamp is the server's record: blob of the plan as approved, when, and by whom", () => {
    const { d, phaseDir } = rerunProject("echo planned", { rerun: true }, { approve: false });
    const stamp = approvePlan(d, phaseDir, () => new Date("2026-11-03T09:00:00.000Z"));
    const plan = join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md");
    expect(stamp).toEqual({
      version: 1, phaseDir, blob: gitIn(d, "hash-object", "--", plan),
      at: "2026-11-03T09:00:00.000Z", by: "t <t@t>",
    });
    expect(readPlanApproval(d, phaseDir)).toEqual(stamp);
    // the stamp lives in local state, never in git: whoever can commit the
    // plan cannot commit its own approval alongside
    const state = join(".cairn", "state");
    expect(gitIn(d, "status", "--porcelain", "--ignored", "--", state)).toMatch(/^!! /m);
    expect(gitIn(d, "status", "--porcelain", "--", state)).toBe("");
    // a re-approval replaces the stamp: the latest human act wins
    writeFileSync(plan, readFileSync(plan, "utf8").replace("echo planned", "echo replanned"));
    const again = approvePlan(d, phaseDir);
    expect(again.blob).not.toBe(stamp.blob);
    expect(readPlanApproval(d, phaseDir)?.blob).toBe(again.blob);
    // no PLAN.md, no stamp
    expect(() => approvePlan(d, "99-missing")).toThrow(CairnError);
  });

  it("an approved blob that differs from the current declared line never runs", () => {
    const { d, phaseDir, base } = rerunProject("echo planned", { rerun: true });
    const plan = join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md");
    writeFileSync(plan, readFileSync(plan, "utf8").replace("echo planned", "touch hostile.marker"));
    const r = appendLedger(d, phaseDir, closeOn(base, "touch hostile.marker"));
    expect(r.observed).toMatchObject({ skipped: "declared-changed", detail: expect.stringContaining("echo planned") });
    expect(existsSync(join(d, "hostile.marker"))).toBe(false);
    // committed after the approval, the same edit is still refused
    gitIn(d, "commit", "-qam", "edit", "--no-gpg-sign");
    expect(appendLedger(d, phaseDir, closeOn(base, "touch hostile.marker")).observed)
      .toMatchObject({ skipped: "declared-changed" });
    expect(existsSync(join(d, "hostile.marker"))).toBe(false);
  });

  it("the claim's base is no longer provenance: a plan edit committed before the claim is still refused", () => {
    // The gap #357 left open (ADR 0017): an agent commits its edit of the
    // plan and THEN claims, so the line is unchanged since the claim's base.
    // The approval stamp predates the edit, so the line is reported, not run.
    const { d, phaseDir } = rerunProject("echo planned", { rerun: true }, { claim: false });
    const plan = join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md");
    writeFileSync(plan, readFileSync(plan, "utf8").replace("echo planned", "touch hostile.marker"));
    gitIn(d, "commit", "-qam", "hostile", "--no-gpg-sign");
    const hostile = gitIn(d, "rev-parse", "HEAD");
    recordClaim(d, "PROJ-105", "2026-07-14T10:00:00.000Z", hostile);
    const r = appendLedger(d, phaseDir, closeOn(hostile, "touch hostile.marker"));
    expect(r.observed).toMatchObject({ skipped: "declared-changed" });
    expect(existsSync(join(d, "hostile.marker"))).toBe(false);
  });

  it("an approval whose blob git no longer holds is reported, not run", () => {
    const { d, phaseDir, base } = rerunProject("touch ran.marker", { rerun: true });
    const path = join(approvalsDir(d), `${phaseDir}.json`);
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stamp, blob: "0".repeat(40) }));
    const r = appendLedger(d, phaseDir, closeOn(base, "touch ran.marker"));
    expect(r.observed).toMatchObject({ skipped: "approval-unreadable" });
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
    // a stamp that is not a stamp reads as no approval at all
    writeFileSync(path, "{ corrupt");
    expect(appendLedger(d, phaseDir, closeOn(base, "touch ran.marker")).observed)
      .toMatchObject({ skipped: "plan-unapproved" });
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("the declared line runs under a minimal environment: no token the server holds reaches it", () => {
    process.env.CAIRN_TEST_SECRET_PROBE = "leaked";
    try {
      expect(minimalEnv()).not.toHaveProperty("CAIRN_TEST_SECRET_PROBE");
      expect(minimalEnv({ PATH: "/bin", GITHUB_TOKEN: "x", HOME: "/h" })).toEqual({ PATH: "/bin", HOME: "/h" });
      const declared = 'test -z "$CAIRN_TEST_SECRET_PROBE" && test -n "$PATH"';
      const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
      const r = appendLedger(d, phaseDir, closeOn(base, declared));
      expect(r.observed).toMatchObject({ exit: 0 });
    } finally {
      delete process.env.CAIRN_TEST_SECRET_PROBE;
    }
  });

  it("every other way of not running is a named skip", () => {
    const { d, phaseDir, base } = rerunProject("<command>", { rerun: true });
    expect(appendLedger(d, phaseDir, closeOn(base, "<command>")).observed)
      .toEqual({ skipped: "not-plain-shell" });
    expect(appendLedger(d, phaseDir, {
      ...closeOn(base, "x"), evidence: undefined, evidenceWaived: "docs only",
    }).observed).toEqual({ skipped: "evidence-waived" });
    expect(appendLedger(d, phaseDir, { ...closeOn(base, "x"), issueId: "PROJ-999" }).observed)
      .toEqual({ skipped: "no-declared-verify" });
    // an evidence-kind line closes nothing, so it observes nothing either
    expect(appendLedger(d, phaseDir, { ...closeOn(base, "<command>"), kind: "evidence" }).observed)
      .toBeUndefined();
  });

  // #423 -- the declared line is classified before it runs: every git
  // invocation in it goes through the run guard's effect classifier, and a
  // discards-work or moves-shared-ref effect is a named skip, never a run.
  // Fail closed, unlike the hooks: a line the server cannot classify is
  // reported and does not run.
  const rerunOn = { rerun: true, timeoutSeconds: 5 };

  it("a declared line carrying git push --force is skipped with the effect named (#423)", () => {
    const declared = "touch ran.marker && git push --force origin main";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(r.observed).toMatchObject({
      skipped: "effect-refused", effect: "discards-work", detail: expect.stringContaining("git push --force"),
    });
    expect(r.observedMismatch).toBe(false);
    expect(r.line).toContain(" — observed skipped=effect-refused effect=discards-work — ");
    // nothing before the push ran either: the line is refused whole
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("every refused effect, however the line hides it: a plain push, a hard reset, a shell, a runner", () => {
    const effectsOf = (line: string) => {
      const c = classifyLine(line);
      return c.ok ? c.effects.map((e) => `${e.effect} ${e.flag}`) : c;
    };
    expect(effectsOf("npm test && git push origin HEAD")).toEqual(["moves-shared-ref push origin HEAD"]);
    expect(effectsOf("git reset --har && npm test")).toContain("discards-work --har");
    expect(effectsOf("sh -c 'git push -f origin main'")).toContain("discards-work -f");
    expect(effectsOf("sudo -u me git clean -fd")).toEqual(["discards-work clean"]);
    expect(effectsOf("op run -- git push --mirror")).toContain("discards-work --mirror");
    expect(effectsOf("echo $(git push +main)")).toContain("discards-work +main");
    expect(effectsOf("/usr/bin/GIT -C sub push --force-with-lease")).toContain("discards-work --force-with-lease");
    // a mention is not an invocation: quoted text and echo's arguments are data
    expect(effectsOf('echo "git push --force"')).toEqual([]);
    expect(effectsOf("echo git push --force")).toEqual([]);
    expect(effectsOf('git commit -m "explain git reset --hard"')).toEqual([]);
    // the first refused effect on the line is the one the skip names
    const declared = "git push origin HEAD && touch ran.marker";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(r.observed).toMatchObject({ skipped: "effect-refused", effect: "moves-shared-ref" });
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("a plain `npx vitest run` line classifies clean, and a read-only git line still runs", () => {
    const verifyLine = "cd server && npx vitest run test/ledger.test.ts test/measured-duration.test.ts && cd .. "
      + "&& grep -q \"effect-refused\\|plan-unapproved\" server/src/planning/verify-rerun.ts && node scripts/check-surface.mjs";
    expect(classifyLine(verifyLine)).toEqual({ ok: true, effects: [], git: [] });
    expect(classifyLine("npx vitest run")).toEqual({ ok: true, effects: [], git: [] });
    // a read-only git invocation is classified and allowed: READ_ONLY has no row
    expect(classifyLine("git status --short && git log -1")).toEqual({
      ok: true, effects: [], git: ["git status --short", "git log -1"],
    });
    const declared = "git status --short && touch ran.marker";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(r.observed).toMatchObject({ exit: 0, command: declared });
    expect(existsSync(join(d, "ran.marker"))).toBe(true);
  });

  it("fail closed: no classifier beside the server, nothing runs", () => {
    expect(classifyLine("echo x", { hooksDir: null })).toMatchObject({ ok: false, reason: "classifier-unavailable" });
    const declared = "touch ran.marker";
    const { d, phaseDir } = rerunProject(declared, { rerun: true });
    const r = observeDeclaredVerify({
      projectDir: d, phaseDir, issueId: "PROJ-105", evidence: { command: declared }, declared, settings: rerunOn,
      hooksDir: join(d, "nowhere"),
    });
    expect(r).toMatchObject({ skipped: "classifier-unavailable", detail: expect.stringContaining("shell-words.mjs") });
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });

  it("a line the classifier cannot read is reported, not run", () => {
    // a shell running a script file: whatever is in it, the server never saw it
    expect(classifyLine("sh ./verify.sh")).toMatchObject({
      ok: false, reason: "unclassifiable", detail: expect.stringContaining("cannot read"),
    });
    expect(classifyLine("cat checks.txt | bash")).toMatchObject({ ok: false, reason: "unclassifiable" });
    const declared = "sh ./verify.sh";
    const { d, phaseDir, base } = rerunProject(declared, { rerun: true });
    writeFileSync(join(d, "verify.sh"), "touch ran.marker\n");
    const r = appendLedger(d, phaseDir, closeOn(base, declared));
    expect(r.observed).toMatchObject({ skipped: "unclassifiable" });
    expect(r.line).toContain(" — observed skipped=unclassifiable — ");
    expect(existsSync(join(d, "ran.marker"))).toBe(false);
  });
});
