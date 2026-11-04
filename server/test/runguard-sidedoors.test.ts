/**
 * Purpose: #484 -- the side-door matrix for the push action (Greenberg,
 *   "Your Agent Has a Side Door": start from the action, list every route
 *   to it, try every route). Table one: every route the run guard reads
 *   refuses under both push gates -- no ship-gate stamp onto the default
 *   branch, and a live run without its push grant -- from the repository
 *   root and a nested folder, and its read twin passes in both. Table two:
 *   the routes the guard cannot read exit 0, and each is named, with its
 *   service-side control, in the run guard's "Not seen" block (#483) --
 *   the inventory as a test, so the list can't drift from the prose and a
 *   deleted line is red. Commands and tool calls are only ever fed to the
 *   hook as JSON on stdin; nothing here runs them.
 * Author(s): John Reed
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectKey } from "../src/planning/run-manifest.js";

// Constants

const RUNGUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..",
  "hooks", "scripts", "pretooluse-runguard.mjs");

const MERGE = "https://api.github.com/repos/o/r/pulls/1/merge";

// A live run that granted no push authority (#252): the second refusal condition.
const LIVE = {
  version: 1, runId: "run-x", status: "running", phases: [{ number: 3, name: "p3" }],
  pushAuth: { granted: false, scope: "manifest-phases" },
};

const GIT_IDENT = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

// Variables

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const git = (proj: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: proj, encoding: "utf8", env: { ...process.env, ...GIT_IDENT } }).trim();

/**
 * A committed repo on `main`, a nested folder in it, and an isolated cairn
 * home: `stamped` writes the clean ship-gate stamp at HEAD, `live` the
 * running manifest with no push grant. The two refusal conditions are
 * (false, false) and (true, true): the first meets the ship gate, the
 * second passes it and meets the live run.
 */
function fixture(stamped: boolean, live: boolean): { proj: string; home: string; sub: string } {
  const proj = freshDir("cairn-sidedoors-proj-");
  git(proj, "init", "-q", "-b", "main");
  writeFileSync(join(proj, "seed.txt"), "seed\n");
  git(proj, "add", "seed.txt");
  git(proj, "commit", "-q", "-m", "init", "--no-gpg-sign");
  const sub = join(proj, "sub");
  mkdirSync(sub);
  const home = freshDir("cairn-sidedoors-home-");
  if (stamped) {
    mkdirSync(join(home, "ship-gate"), { recursive: true });
    writeFileSync(join(home, "ship-gate", `${projectKey(proj)}.json`),
      JSON.stringify({ head: git(proj, "rev-parse", "HEAD"), clean: true, at: "2026-11-04T00:00:00Z" }));
  }
  if (live) {
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(join(home, "runs", `${projectKey(proj)}-run-x.json`), JSON.stringify(LIVE));
  }
  return { proj, home, sub };
}

/** The hook, fed one tool call as the harness would, with no owner escape in its environment. */
function call(f: { proj: string; home: string }, payload: { tool_name: string; tool_input: Record<string, unknown> },
  cwd: string = f.proj): { status: number | null; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: f.proj, CAIRN_HOME: f.home };
  for (const k of ["CAIRN_ALLOW_DESTRUCTIVE_GIT", "CAIRN_ALLOW_UNSHIPPED_PUSH", "GIT_DIR", "GIT_WORK_TREE"]) delete env[k];
  const r = spawnSync(process.execPath, [RUNGUARD], {
    cwd, env, encoding: "utf8", timeout: 5000, input: JSON.stringify({ ...payload, cwd }),
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

// Main

describe("side-door matrix, table one: every route to the push action refuses under both gates (#484)", () => {
  // Each row: the route, the words its refusal must name, and its read
  // twin -- the same program and target with nothing moved. `always`
  // marks a route refused in every session (a force push discards work,
  // #250), whose refusal names no run.
  type Row = { route: string; names: string[]; twin: string; always?: boolean };
  const rows: Row[] = [
    { route: "git push origin main", names: ["moves-shared-ref, from `push origin main`"], twin: "git ls-remote --heads origin" },
    { route: "git push --force", names: ["`git push --force`", "refused in every session"], twin: "git ls-remote --heads origin",
      always: true },
    { route: "gh pr merge 1 --merge", names: ["`gh pr merge` is a push", "moves-shared-ref, from `gh pr merge`"], twin: "gh pr view 1" },
    { route: "gh api -X PUT repos/o/r/pulls/1/merge", names: ["a `gh api` pull request merge is a push", "PUT /repos/o/r/pulls/1/merge"],
      twin: "gh api repos/o/r/pulls/1/merge" },
    { route: "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=0123abc",
      names: ["a `gh api` ref write is a push", "PATCH /repos/o/r/git/refs/heads/main"], twin: "gh api repos/o/r/git/refs/heads/main" },
    { route: `curl -X PUT ${MERGE} -H "Authorization: token x"`, names: ["a `curl` pull request merge is a push"],
      twin: `curl ${MERGE} -H "Authorization: token x"` },
    { route: "gh alias set m 'pr merge' && gh m 1", names: ["`gh pr merge` is a push", "via gh alias `m`"],
      twin: "gh alias set v 'pr view' && gh v 1" },
  ];

  it("no stamp onto the default branch: each route refuses naming itself, from the root and a nested folder; its twin passes", () => {
    const f = fixture(false, false);
    for (const row of rows) {
      for (const cwd of [f.proj, f.sub]) {
        const where = cwd === f.sub ? "sub" : "root";
        const r = call(f, bash(row.route), cwd);
        expect(r.status, `${row.route} from ${where}\n${r.stderr}`).toBe(2);
        for (const name of row.names) expect(r.stderr, row.route).toContain(name);
        if (!row.always) expect(r.stderr, row.route).toContain("/cairn:ship");
        const t = call(f, bash(row.twin), cwd);
        expect(t.status, `${row.twin} from ${where}\n${t.stderr}`).toBe(0);
      }
    }
  });

  it("a live run without its push grant: each route refuses naming the run, from the root and a nested folder; its twin passes", () => {
    const f = fixture(true, true);
    for (const row of rows) {
      for (const cwd of [f.proj, f.sub]) {
        const where = cwd === f.sub ? "sub" : "root";
        const r = call(f, bash(row.route), cwd);
        expect(r.status, `${row.route} from ${where}\n${r.stderr}`).toBe(2);
        for (const name of row.names) expect(r.stderr, row.route).toContain(name);
        if (!row.always) expect(r.stderr, row.route).toContain("run-x");
        const t = call(f, bash(row.twin), cwd);
        expect(t.status, `${row.twin} from ${where}\n${t.stderr}`).toBe(0);
      }
    }
  });

  it("with the stamp and no run every route but the force push passes: the gates, not the programs, are what refuse", () => {
    const f = fixture(true, false);
    for (const row of rows) {
      const r = call(f, bash(row.route));
      expect(r.status, `${row.route}\n${r.stderr}`).toBe(row.always ? 2 : 0);
    }
  });
});

describe("side-door matrix, table two: the routes the guard does not see are an inventory it pins (#484)", () => {
  // Each row: a route the guard can't read -- the call exits 0 under both
  // conditions, which documents the gap rather than asserts safety -- the
  // phrase its line in the run guard's Not seen block carries, and the
  // service-side control that line names. Deleting the line fails the row.
  type Row = { label: string; payload: { tool_name: string; tool_input: Record<string, unknown> }; line: string; control: string };
  const rows: Row[] = [
    { label: "python -c with requests",
      payload: bash(`python -c "import requests; requests.put('${MERGE}', headers={'Authorization': 'token x'})"`),
      line: "`python -c` with requests", control: "the token's" },
    { label: "node -e with fetch",
      payload: bash(`node -e "fetch('${MERGE}', {method: 'PUT', headers: {Authorization: 'token x'}})"`),
      line: "`node -e` with fetch", control: "the token's" },
    { label: "a Composio GitHub tool call",
      payload: { tool_name: "mcp__composio__GITHUB_MERGE_PULL_REQUEST", tool_input: { owner: "o", repo: "r", pull_number: 1 } },
      line: "Composio's GitHub tools", control: "token's scope" },
    { label: "an MCP tool with the owner's token",
      payload: { tool_name: "mcp__github__merge_pull_request", tool_input: { owner: "o", repo: "r", pullNumber: 1 } },
      line: "any MCP tool that reaches GitHub with the", control: "token's scope" },
    { label: "a browser navigate to the pull request",
      payload: { tool_name: "mcp__claude-in-chrome__navigate", tool_input: { url: "https://github.com/o/r/pull/1" } },
      line: "a browser tool (claude-in-chrome, playwright, chrome-devtools)", control: "branch protection" },
    { label: "a browser click on the merge button",
      payload: { tool_name: "mcp__playwright__browser_click", tool_input: { element: "Merge pull request", ref: "e12" } },
      line: "the merge button as the signed-in user", control: "branch protection" },
    { label: "a gh alias configured outside the line", payload: bash("gh m 1"),
      line: "a gh alias or extension configured outside the line", control: "branch" },
    { label: "a gh extension", payload: bash("gh merge-it 1"),
      line: "a gh-NAME on PATH", control: "branch" },
    { label: "a token from the environment handed to a script",
      payload: bash("GH_TOKEN=$(cat ~/.token) python3 merge.py o/r 1"),
      line: "a token read from the environment", control: "the service's log" },
  ];

  const source = readFileSync(RUNGUARD, "utf8");
  const MARK = " *   Not seen, dated 2026-11-04 (#483";

  /** The block: from its dated opening line to the blank comment line that ends it. */
  function notSeenBlock(): string {
    const start = source.indexOf(MARK);
    expect(start, "the run guard's Not seen block opens with its date and issue").toBeGreaterThan(-1);
    return source.slice(start).split("\n *\n")[0];
  }

  it("each unseen route exits 0 under both conditions -- the gap, documented", () => {
    const cold = fixture(false, false);
    const hot = fixture(true, true);
    for (const row of rows) {
      for (const f of [cold, hot]) {
        for (const cwd of [f.proj, f.sub]) {
          const r = call(f, row.payload, cwd);
          expect(r.status, `${row.label}\n${r.stderr}`).toBe(0);
        }
      }
    }
  });

  it("each unseen route is named in the run guard's Not seen block beside its service-side control -- a deleted line is red here", () => {
    const block = notSeenBlock();
    for (const row of rows) {
      expect(block, row.label).toContain(row.line);
      expect(block, `${row.label}: its control`).toContain(row.control);
    }
  });

  it("the block is dated, closes by decision, cites the service-side issue on every control, and its line count is the pin", () => {
    const block = notSeenBlock();
    expect(block).toContain("by decision");
    expect(block).toContain("signed-in");
    expect(block.match(/#485/g)?.length ?? 0, "#485 on the opening and each control that names it").toBeGreaterThanOrEqual(4);
    expect(block).toContain('runguard-sidedoors.test.ts "Not seen"');
    // the line count is the pin: a route added or removed moves it, on purpose, in the same change
    expect(block.split("\n").length, block).toBe(19);
  });

  it("the rules cite this file beside the table it pins, and the History names the issue", () => {
    expect(source).toContain("runguard-sidedoors.test.ts (#484");
    expect(source).toMatch(/\*\s+#483\s+the push action by another route/);
  });
});
