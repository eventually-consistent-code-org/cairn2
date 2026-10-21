import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldProject, scaffoldPhase } from "../src/planning/artifacts.js";
import { execFileSync } from "node:child_process";
import { appendLedger, checkLedgerEntry, declaredVerifyFor } from "../src/planning/ledger.js";
import { declaredVerifyIn, isPlainShellLine, planCheck, verifyClauseOf } from "../src/planning/check.js";
import { distillManifest } from "../src/planning/distill-manifest.js";
import { CairnError } from "../src/errors.js";
import {
  actualsSegment, receiptsDir, takeReceipt, writeReceipt, type CloseReceipt,
} from "../src/planning/close-receipt.js";

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
   * given. Returns the commit the plan landed in -- the claim's base.
   */
  function rerunProject(declared: string, verify: Record<string, unknown> | undefined,
    opts: { track?: boolean } = {}): { d: string; phaseDir: string; base: string } {
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
    }
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

  it("a declared line edited since the claim's base is reported, not run", () => {
    const { d, phaseDir, base } = rerunProject("echo planned", { rerun: true });
    const plan = join(d, ".cairn", "plans", "phases", phaseDir, "PLAN.md");
    writeFileSync(plan, readFileSync(plan, "utf8").replace("echo planned", "touch hostile.marker"));
    const r = appendLedger(d, phaseDir, closeOn(base, "touch hostile.marker"));
    expect(r.observed).toMatchObject({ skipped: "declared-changed" });
    expect(existsSync(join(d, "hostile.marker"))).toBe(false);
    // committed after the base, the same edit is still refused
    gitIn(d, "commit", "-qam", "edit", "--no-gpg-sign");
    expect(appendLedger(d, phaseDir, closeOn(base, "touch hostile.marker")).observed)
      .toMatchObject({ skipped: "declared-changed" });
    expect(existsSync(join(d, "hostile.marker"))).toBe(false);
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
});
