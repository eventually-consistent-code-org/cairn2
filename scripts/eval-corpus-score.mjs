#!/usr/bin/env node

// Review-corpus scorer (issue #334). ADR 0012's sunset clause names the
// test: one native call producing the panel's merged findings, matched
// against the seats on a recorded corpus. `claude plugin eval` grades a
// case as pass/fail; this post-processor reads the same
// aggregate-result.json and turns the two corpus cases' per-grader
// results into the two numbers the ADR needs, per arm:
//
//   recall     -- share of (item, run) pairs whose `k-NN` grader passed,
//                 over the items that have one (the control has none).
//                 One case per item per arm, named corpus-NN-seats /
//                 corpus-NN-native (evals-corpus/README.md).
//   precision  -- pass rate of the `precision` grader, an LLM judge that
//                 fails a run raising any finding that is not a real
//                 defect in its diff. A proxy, stated as one: the
//                 aggregate keeps no transcript, so the raised count is
//                 not recoverable here.
//
// Usage:
//   node scripts/eval-corpus-score.mjs <results-dir | aggregate-result.json> [--json]
//
// Exit 0 when at least one corpus case per arm was found; 2 on a load
// error or when an arm has no cases in the aggregate (it did not run).
//
// Author(s): John Reed

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";


// Constants

const AGGREGATE = "aggregate-result.json";
const CASE = /^corpus-(\d+)-(seats|native)$/;
const KNOWN = /^k-\d+/;
const PRECISION = "precision";


/** Resolve the CLI argument to an aggregate file (same rule as eval-verdicts). */
function resolveSource(arg) {
  const p = resolve(arg);
  if (!existsSync(p)) throw new Error(`no such file or directory: ${arg}`);
  if (statSync(p).isFile()) return p;
  const direct = join(p, AGGREGATE);
  if (existsSync(direct)) return direct;
  const runs = readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(p, d.name, AGGREGATE)))
    .map((d) => d.name)
    .sort();
  if (runs.length === 0) throw new Error(`no ${AGGREGATE} in ${arg} or any subdirectory`);
  return join(p, runs[runs.length - 1], AGGREGATE);
}

/** A grader result's pass flag, whatever the harness calls it. */
function graderPassed(g) {
  if (typeof g.passed === "boolean") return g.passed;
  if (typeof g.score === "number") return g.score >= 1;
  return false;
}

/** Recall and precision over one review arm's cases (seats or native). */
function scoreArm(cases) {
  let knownRuns = 0;
  let knownPassed = 0;
  let precisionRuns = 0;
  let precisionPassed = 0;
  let runs = 0;
  for (const c of cases) {
    // The plugin arm of the harness is the only arm that can run /cairn:review;
    // for the native case both harness arms run the same command. Score the
    // `with` runs for both, so the two review arms are compared like for like.
    for (const run of c.arms?.with ?? []) {
      runs += 1;
      const graders = run.graders ?? [];
      const known = graders.find((g) => KNOWN.test(g.name ?? ""));
      if (known) { knownRuns += 1; if (graderPassed(known)) knownPassed += 1; }
      const prec = graders.find((g) => g.name === PRECISION);
      if (prec) { precisionRuns += 1; if (graderPassed(prec)) precisionPassed += 1; }
    }
  }
  return {
    cases: cases.length,
    runs,
    recall: knownRuns ? knownPassed / knownRuns : null,
    precision: precisionRuns ? precisionPassed / precisionRuns : null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const src = args.find((a) => !a.startsWith("--"));
  if (!src) {
    console.error("usage: node scripts/eval-corpus-score.mjs <results-dir | aggregate-result.json> [--json]");
    process.exit(2);
  }

  let aggregate;
  let source;
  try {
    source = resolveSource(src);
    aggregate = JSON.parse(readFileSync(source, "utf8"));
  } catch (e) {
    console.error(`eval-corpus-score: ${e.message}`);
    process.exit(2);
  }

  const byArm = { seats: [], native: [] };
  for (const c of aggregate.cases ?? []) {
    const m = CASE.exec(c.name ?? "");
    if (m) byArm[m[2]].push(c);
  }
  const out = { source, claudeVersion: aggregate.claudeVersion, arms: {} };
  let missing = 0;
  for (const [arm, cases] of Object.entries(byArm)) {
    if (!cases.length) { out.arms[arm] = null; missing += 1; continue; }
    out.arms[arm] = scoreArm(cases);
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
    console.log(`review corpus (${source}, Claude Code ${aggregate.claudeVersion ?? "?"})`);
    for (const [arm, s] of Object.entries(out.arms)) {
      if (!s) { console.log(`  ${arm}: no corpus cases in this aggregate -- the arm did not run`); continue; }
      console.log(`  ${arm}: ${s.cases} case(s), ${s.runs} run(s), recall ${pct(s.recall)}, precision ${pct(s.precision)}`);
    }
  }
  process.exit(missing ? 2 : 0);
}

main();
