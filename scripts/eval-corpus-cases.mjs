#!/usr/bin/env node

// Review-corpus case generator (issue #334). Writes one self-contained
// eval case per corpus item per arm under evals-corpus/ from
// evals-corpus/corpus.json -- both on the orphan branch `evals-archive`
// (#403), checked out beside this repo's root as evals-archive/ or wherever
// CAIRN_EVALS_ARCHIVE points. The fixtures come from THIS repo's git
// history; the cases land in THAT checkout.
//
//   evals-corpus/NN-<slug>/seats/    case.yaml (prompt: /cairn:review corpus/NN-<slug>)
//   evals-corpus/NN-<slug>/native/   case.yaml (prompt: /code-review corpus/NN-<slug> high --max-findings all)
//     graders/   k-NN.md (the known defect is named) + precision.md (no defect invented;
//                correctness axis only -- clarity/style notes are ignored)
//     fixture/   the files the fix touched, as the FIX left them (tests excluded)
//     revert.patch   the fix reversed -- the defect, reintroduced
//     scaffold.sh    builds the workspace repo: main = fix state, corpus/NN-<slug> = +revert,
//                    both commits with neutral messages -- the ground truth lives in the
//                    graders only, never where the reviewer can read it
//
// The harness runs each case in an empty sandboxed workspace that cannot
// read this repo, so the diff under review travels with the case: the
// scaffold (run with --scaffold) commits the fixture as `main`, then the
// patch on branch corpus/NN-<slug>, so `git diff main...corpus/NN-<slug>`
// is exactly the defect the fix removed, at the point in history where it
// lived. Reverting a fix on top of its own state always applies.
//
// Also refreshes evals-corpus/mocks as a copy of evals/mocks (the harness
// rejects a symlink there), with the corpus's own audit_record answer
// written over the copy. Idempotent -- rerun after editing corpus.json
// or the mocks; committed output, like the command shims.
//
// Author(s): John Reed

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";


// Constants

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The evals-archive checkout: `git worktree add evals-archive evals-archive`
// from the repo root (gitignored), or CAIRN_EVALS_ARCHIVE for another path.
const ARCHIVE = process.env.CAIRN_EVALS_ARCHIVE ?? join(ROOT, "evals-archive");
const DIR = join(ARCHIVE, "evals-corpus");
const CORPUS = join(DIR, "corpus.json");
const MOCKS_SRC = join(ARCHIVE, "evals", "mocks");
const MOCKS_DST = join(DIR, "mocks");
// Left out of every fixture: tests (the branch reintroduces the bug, not the
// absence of its proof) and the count-carrying docs a fix refreshes in
// passing, which would hand the reviewer a hint the real diff never had.
const EXCLUDED = ["server/test/", "evals/", "evals-corpus/", "README.md", "server/README.md", "CHANGELOG.md", "docs/comparison.md"];
const TOOLS_SEATS = ["Read", "Glob", "Grep", "Bash", "Skill", "ToolSearch", "AskUserQuestion", "Agent", "mcp__plugin_cairn_cairn__*"];
const TOOLS_NATIVE = ["Read", "Glob", "Grep", "Bash", "Skill", "ToolSearch", "Agent", "ReportFindings"];
// Corpus-own mock answers, written over the copied main-suite mocks (see the
// copy step in main). `{{input.x}}` interpolates the call's own arguments.
const CORPUS_MOCKS = {
  audit_record: JSON.stringify({
    path: ".cairn/audit/{{input.scope}}-2026-10-14.md",
    recorded: true,
    verdict: "{{input.verdict}}",
    findings: "as submitted",
    note: "eval mock: the record was accepted exactly as sent; no server-side quorum ran, so the surviving set is the findings you submitted -- file from those",
  }),
};


function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** A YAML block scalar: the text carries colons and quotes, which a plain scalar cannot. */
function block(text, indent = "  ") {
  return ">-\n" + text.replace(/\s+/g, " ").trim().match(/.{1,78}(\s|$)/g).map((l) => `${indent}${l.trim()}`).join("\n");
}

/** A YAML literal block: the prompt's line breaks are the slash command's argument boundary. */
function literal(text, indent = "    ") {
  return "|-\n" + text.split("\n").map((l) => (l ? `${indent}${l}` : "")).join("\n");
}

function yamlList(items) {
  return `[${items.join(", ")}]`;
}

function caseYaml(name, tools, promptText) {
  return `schema_version: "1.1"
name: ${name}
tags: [review, corpus, capability]
runs: 1
context:
  scaffold_script: scaffold.sh
execution:
  max_turns: 80
  timeout_seconds: 900
  allowed_tools: ${yamlList(tools)}
  prompt: ${literal(promptText)}
`;
}

function knownGrader(item) {
  const branch = `corpus/${item.id}-${item.slug}`;
  const criteria = `The review of branch ${branch} against main raised, as a finding, this defect: ${item.finding} (in ${item.file}). The finding may be worded differently but must identify the same file and the same mechanism; a review that lists other findings but misses this one fails, and a review that says the diff is clean fails.`;
  return `---
type: llm
focus: last_message
criteria: ${block(criteria)}
---
The review raised the known defect in ${item.file}: ${item.finding}.
`;
}

function precisionGrader(item) {
  const branch = `corpus/${item.id}-${item.slug}`;
  const control = item.control
    ? ` This diff contains no defect at all: a review that raises no defect finding passes, whether or not it adds clarity or style notes; any finding presented as a defect fails.`
    : ` The one known defect is: ${item.finding} (in ${item.file}); raising it is correct.`;
  // Correctness axis only (the issue's scope): the native call cannot see
  // clarity, architecture or test-coverage by design, so a seats-arm
  // clarity note must not count against it as an invented defect. The
  // first full run (2026-10-14) failed precision on exactly that -- a
  // stale-comment minor beside a confirmed, correct finding.
  const criteria = `Judge only the findings the review of branch ${branch} against main presents as defects -- wrong behaviour the code change actually causes (a bug, a regression, broken handling). Each such finding must be a real defect present in that diff, not a style preference, a hypothetical, or a claim about code the diff does not touch.${control} Remarks the review itself labels as clarity, naming, comment, documentation, architecture, test-coverage or style notes are outside the correctness axis this corpus scores and are ignored, as is anything the review says about its own tooling or record-keeping. A review with one or more defect findings that are not real defects in this diff fails.`;
  return `---
type: llm
focus: last_message
criteria: ${block(criteria)}
---
Every finding raised is a real defect in the diff; nothing invented.
`;
}

function scaffold(item) {
  const branch = `corpus/${item.id}-${item.slug}`;
  return `#!/bin/bash

########################
# Script by John Reed  #
# 2026-10-13           #
########################

# Builds the review-corpus workspace for ${branch} (issue #334):
#   main               the fix's state of the files it touched
#   ${branch}   that state with the fix reverted -- the defect, back
# Runs in the harness's empty workspace before the agent starts.

set -euo pipefail
case_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

echo "building corpus workspace for ${branch}..."
git init -q -b main .
cp -R "$case_dir/fixture/." .
git add -A
git -c user.name="cairn corpus" -c user.email="corpus@invalid" commit -q --no-verify -m "baseline"
git checkout -q -b ${branch}
git apply --whitespace=nowarn "$case_dir/revert.patch"
git add -A
git -c user.name="cairn corpus" -c user.email="corpus@invalid" commit -q --no-verify -m "candidate change"
git checkout -q main
echo "corpus workspace ready: main and ${branch}."
`;
}

/** The files the fix touched, minus tests, with their content as the fix left them. */
function fixture(item) {
  const fixSha = git(["rev-parse", item.fix]).trim();
  const files = git(["diff", "--name-only", `${fixSha}^`, fixSha]).split("\n")
    .filter((f) => f && !EXCLUDED.some((p) => f.startsWith(p)));
  const contents = new Map();
  for (const f of files) {
    try { contents.set(f, git(["show", `${fixSha}:${f}`])); } catch { /* deleted by the fix: the patch recreates it */ }
  }
  const patch = git(["diff", "--binary", fixSha, `${fixSha}^`, "--", ...files]);
  return { files, contents, patch };
}

function main() {
  // Fail loud: the corpus is not on main any more, so a missing checkout is
  // the usual first run, not a broken repo.
  if (!existsSync(CORPUS)) {
    console.error(`no corpus at ${CORPUS} -- check the evals-archive branch out first:\n`
      + "  git worktree add evals-archive evals-archive\n"
      + "or point CAIRN_EVALS_ARCHIVE at an existing checkout.");
    process.exit(2);
  }
  const { items } = JSON.parse(readFileSync(CORPUS, "utf8"));
  console.log("generating corpus cases...");
  for (const entry of readdirSync(DIR)) {
    if (/^\d{2}-/.test(entry)) rmSync(join(DIR, entry), { recursive: true, force: true });
  }
  // The harness refuses a symlinked mocks dir, so the main suite's mocks are
  // copied in whole on every run -- one source, never two to keep in step.
  rmSync(MOCKS_DST, { recursive: true, force: true });
  cpSync(MOCKS_SRC, MOCKS_DST, { recursive: true });
  // ...except the mocks the review verb reads back: the main suite's
  // audit_record answer is a canned foreign record (two 2026-09-17 findings,
  // a placeholder commit), and a reviewer handed someone else's results
  // stops and reports the tool instead of filing its own. The corpus
  // accepts the record as sent, so the arm's final message is the review.
  for (const [tool, body] of Object.entries(CORPUS_MOCKS)) {
    writeFileSync(join(MOCKS_DST, "cairn", `${tool}.md`), body + "\n");
  }

  let n = 0;
  for (const item of items) {
    const branch = `corpus/${item.id}-${item.slug}`;
    const fx = fixture(item);
    const note = `The branch carries exactly one commit past its merge-base with main; the diff under review is that commit (\`git diff main...${branch}\`). The workspace holds only the files that diff touches.`;
    const arms = [
      ["seats", `corpus-${item.id}-seats`, TOOLS_SEATS, `/cairn:review ${branch}\n\n${note}`],
      ["native", `corpus-${item.id}-native`, TOOLS_NATIVE, `/code-review ${branch} high --max-findings all\n\n${note}`],
    ];
    for (const [arm, name, tools, promptText] of arms) {
      const dir = join(DIR, `${item.id}-${item.slug}`, arm);
      mkdirSync(join(dir, "graders"), { recursive: true });
      writeFileSync(join(dir, "case.yaml"), caseYaml(name, tools, promptText));
      if (!item.control) writeFileSync(join(dir, "graders", `k-${item.id}.md`), knownGrader(item));
      writeFileSync(join(dir, "graders", "precision.md"), precisionGrader(item));
      for (const [f, body] of fx.contents) {
        mkdirSync(dirname(join(dir, "fixture", f)), { recursive: true });
        writeFileSync(join(dir, "fixture", f), body);
      }
      writeFileSync(join(dir, "revert.patch"), fx.patch);
      const sh = join(dir, "scaffold.sh");
      writeFileSync(sh, scaffold(item));
      chmodSync(sh, 0o755);
      n += 1;
    }
    console.log(`  ${item.id} ${item.slug}: ${fx.files.length} file(s) in the fixture...`);
  }
  console.log(`corpus cases generated -- ${n} cases over ${items.length} items.`);
}

main();
