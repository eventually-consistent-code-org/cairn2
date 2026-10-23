#!/usr/bin/env node

/**
 * Purpose: the readers leg of gen-agents --check (#398). The drift check
 *   used to ask only whether the spine's COPY matched its sources; this asks
 *   whether every harness can READ it. Two parts:
 *     mechanism -- every harness cairn-setup knows has a readers row, and
 *       running that target in a scratch project writes the row's load file
 *       with the fragment reachable from it (a scratch CLAUDE.md seeded first,
 *       since a project with both files is the case that failed);
 *     project -- in the checkout the check runs in, every load file that
 *       exists reaches a fresh copy of the fragment. An absent one is "not
 *       installed here", never red.
 *   An empty table, an empty harness list, or a harness with no row is red.
 * Author(s): John Reed
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reachFrom } from "../../setup/spine-reach.mjs";

// Constants
const CLAUDE_VIA_IMPORT = { harness: "claude", loadFile: "CLAUDE.md", via: "import", path: "CLAUDE.md → @AGENTS.md → fragment" };

/** The harness list cairn-setup accepts, parsed from its source.
 *  :returns [] when the literal is not found -- the caller treats that as red */
export function parseHarnesses(setupSrc) {
  const m = /const HARNESSES = \[([^\]]*)\]/.exec(setupSrc);
  if (!m) return [];
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
}

/** Mechanism leg: run each setup target in a scratch project and home.
 *  :param table readers rows; harnesses: what setup accepts; setupPath: the script
 *  :returns {rows: [{harness, loadFile, path, ok, detail}], failures: [string]} */
export function mechanismLeg({ table, harnesses, setupPath }) {
  const rows = [];
  const failures = [];
  if (table.length === 0) failures.push("readers table is empty");
  if (harnesses.length === 0) failures.push("no harness list parsed from setup/cairn-setup.mjs");

  for (const row of table) {
    if (!harnesses.includes(row.harness)) {
      failures.push(`${row.harness}: readers row for a harness cairn-setup does not know`);
    }
  }

  for (const h of harnesses) {
    const row = table.find((r) => r.harness === h);
    if (!row) {
      rows.push({ harness: h, loadFile: "-", path: "-", ok: false, detail: "no readers row" });
      failures.push(`${h}: no readers row — add one naming the file ${h} loads at session start`);
      continue;
    }

    // Scratch project with its own home, so codex/copilot/gemini home writes stay in it
    const scratch = mkdtempSync(join(tmpdir(), "cairn-readers-"));
    try {
      const proj = join(scratch, "project");
      const home = join(scratch, "home");
      mkdirSync(proj, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(proj, "CLAUDE.md"), "# scratch project\n");
      const r = spawnSync(process.execPath, [setupPath, h, "--project", proj], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home, CAIRN_SETUP_OFFLINE: "1" },
      });
      if (r.status !== 0) {
        const why = (r.stderr || r.stdout || "").trim().split("\n").at(-1) ?? "";
        rows.push({ ...row, ok: false, detail: `setup ${h} failed: ${why}` });
        failures.push(`${h}: setup ${h} exited ${r.status} — ${why}`);
        continue;
      }

      const own = reachFrom(proj, row, { top: true });
      const claude = reachFrom(proj, CLAUDE_VIA_IMPORT, { top: true });
      if (own.state !== "reaches") {
        const detail = own.state === "absent"
          ? `setup ${h} never writes ${row.loadFile}`
          : `after setup ${h}: ${own.detail}`;
        rows.push({ ...row, ok: false, detail });
        failures.push(`${h}: ${detail}`);
      } else if (claude.state !== "reaches") {
        const detail = `after setup ${h}, Claude Code in the same project misses the spine: ${claude.detail}`;
        rows.push({ ...row, ok: false, detail });
        failures.push(`${h}: ${detail}`);
      } else {
        rows.push({ ...row, ok: true, detail: "setup writes it" });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { rows, failures };
}

/** Project leg: the checkout's own load files, against a fresh fragment.
 *  :returns {rows: [{harness, loadFile, path, state, detail}], failures} */
export function projectLeg({ table, projectDir, fragment }) {
  const rows = [];
  const failures = [];
  if (table.length === 0) failures.push("readers table is empty");
  for (const row of table) {
    const r = reachFrom(projectDir, row, { fragment, top: true });
    rows.push({ ...row, state: r.state, detail: r.detail });
    if (r.state === "broken") failures.push(`${row.harness}: ${r.detail}`);
  }
  return { rows, failures };
}

/** One printed line per harness: harness, load file, path, status. */
export function formatReaders(mech, proj) {
  const lines = [];
  for (const m of mech.rows) {
    const p = proj.rows.find((r) => r.harness === m.harness);
    const setup = m.ok ? "setup ok" : `setup RED (${m.detail})`;
    let here = "here: -";
    if (p) {
      if (p.state === "reaches") here = `here: reaches (${p.detail})`;
      else if (p.state === "absent") here = "here: not installed here";
      else here = `here: RED (${p.detail})`;
    }
    lines.push(`  ${m.harness.padEnd(9)}${m.loadFile.padEnd(33)}${m.path.padEnd(44)}${setup}; ${here}`);
  }
  return lines;
}
