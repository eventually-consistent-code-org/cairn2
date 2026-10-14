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
//   node scripts/eval-corpus-score.mjs <results-dir | aggregate-result.json>... [--json]
//
// Several sources pool into one table: each arm runs as its own
// `claude plugin eval` invocation and lands in its own results/<timestamp>,
// and a rerun of a few cases (a corrected ground truth) lands in another.
// A case named in a later source replaces the same case from an earlier
// one -- give the sources oldest first, and the latest run of each case
// is the one scored. A directory given alone resolves to its latest run.
//
// A run with no grader results is an ERROR, not an absence (#377): since
// Claude Code 2.1.299 a run that ends on an API error scores 0 ungraded
// and fails the suite, and this scorer agrees -- the run is counted as
// `errored` per arm and per case, named in the output, and the exit code
// is 1. Recall and precision keep graded runs as their denominator, and
// the table says "G of M runs graded" so a 100% on one survivor reads as
// what it is. Before this, an errored run vanished from both rates.
//
// Exit 0 when at least one corpus case per arm was found and no run
// errored; 1 when any run errored; 2 on a load error or when an arm has
// no cases in the aggregate (it did not run).
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

/**
 * A run the harness never graded (#377): it carries an `error`, or no
 * grader results at all. The harness writes such a run with score 0 since
 * 2.1.299; before that it could appear with an empty graders list.
 */
function runErrored(run) {
  const graders = run.graders ?? [];
  return Boolean(run.error) || graders.length === 0;
}

/** Recall and precision over one review arm's cases (seats or native). */
function scoreArm(cases) {
  let knownRuns = 0;
  let knownPassed = 0;
  let precisionRuns = 0;
  let precisionPassed = 0;
  let runs = 0;
  let graded = 0;
  const erroredCases = [];
  for (const c of cases) {
    // The plugin arm of the harness is the only arm that can run /cairn:review;
    // for the native case both harness arms run the same command. Score the
    // `with` runs for both, so the two review arms are compared like for like.
    let caseErrored = 0;
    for (const run of c.arms?.with ?? []) {
      runs += 1;
      if (runErrored(run)) { caseErrored += 1; continue; }
      graded += 1;
      const graders = run.graders ?? [];
      const known = graders.find((g) => KNOWN.test(g.name ?? ""));
      if (known) { knownRuns += 1; if (graderPassed(known)) knownPassed += 1; }
      const prec = graders.find((g) => g.name === PRECISION);
      if (prec) { precisionRuns += 1; if (graderPassed(prec)) precisionPassed += 1; }
    }
    if (caseErrored) erroredCases.push({ name: c.name, errored: caseErrored });
  }
  return {
    cases: cases.length,
    runs,
    graded,
    errored: runs - graded,
    erroredCases,
    recall: knownRuns ? knownPassed / knownRuns : null,
    precision: precisionRuns ? precisionPassed / precisionRuns : null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const srcs = args.filter((a) => !a.startsWith("--"));
  if (!srcs.length) {
    console.error("usage: node scripts/eval-corpus-score.mjs <results-dir | aggregate-result.json>... [--json]");
    process.exit(2);
  }

  // Pool the sources, latest-given wins per case name (see the header).
  const sources = [];
  const versions = new Set();
  const byName = new Map();
  try {
    for (const src of srcs) {
      const source = resolveSource(src);
      const aggregate = JSON.parse(readFileSync(source, "utf8"));
      sources.push(source);
      if (aggregate.claudeVersion) versions.add(aggregate.claudeVersion);
      for (const c of aggregate.cases ?? []) {
        if (CASE.test(c.name ?? "")) byName.set(c.name, c);
      }
    }
  } catch (e) {
    console.error(`eval-corpus-score: ${e.message}`);
    process.exit(2);
  }

  const byArm = { seats: [], native: [] };
  for (const c of byName.values()) byArm[CASE.exec(c.name)[2]].push(c);
  const claudeVersion = [...versions].join(", ");
  const source = sources.join(", ");
  const out = { sources, claudeVersion, arms: {} };
  let missing = 0;
  for (const [arm, cases] of Object.entries(byArm)) {
    if (!cases.length) { out.arms[arm] = null; missing += 1; continue; }
    out.arms[arm] = scoreArm(cases);
  }

  const errored = Object.values(out.arms).reduce((n, s) => n + (s?.errored ?? 0), 0);
  out.errored = errored;

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
    console.log(`review corpus (${source}, Claude Code ${claudeVersion || "?"})`);
    for (const [arm, s] of Object.entries(out.arms)) {
      if (!s) { console.log(`  ${arm}: no corpus cases in this aggregate -- the arm did not run`); continue; }
      console.log(`  ${arm}: ${s.cases} case(s), ${s.graded} of ${s.runs} run(s) graded, `
        + `recall ${pct(s.recall)}, precision ${pct(s.precision)}`
        + (s.errored ? ` -- ${s.errored} errored run(s), not in either rate` : ""));
      for (const e of s.erroredCases) {
        console.log(`    errored: ${e.name} (${e.errored} run(s) ended with no grader results -- see ${source})`);
      }
    }
    if (errored) console.log(`  ${errored} errored run(s): rerun those cases before quoting these numbers`);
  }
  process.exit(missing ? 2 : errored ? 1 : 0);
}

main();
