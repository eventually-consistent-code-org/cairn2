/**
 * Purpose: every test file gets a scratch cairn home (#358). The guards now
 *   append a row to <cairn home>/refusals/ on every refusal, and the cairn
 *   home is CAIRN_HOME, else ~/.cairn -- so a test that spawns a guard
 *   without naming a home would write the real one. Pointing CAIRN_HOME at
 *   a temp dir here covers every spawn that inherits process.env; a test
 *   that names its own CAIRN_HOME, or its own HOME with CAIRN_HOME stripped,
 *   still decides for itself. The server never reads CAIRN_HOME, so nothing
 *   in-process changes. Wired as a vitest setupFile, so it runs once per
 *   test file, before the file's own imports.
 * Author(s): John Reed
 */

// Imports
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Main
const home = mkdtempSync(join(tmpdir(), "cairn-test-home-"));
process.env.CAIRN_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
