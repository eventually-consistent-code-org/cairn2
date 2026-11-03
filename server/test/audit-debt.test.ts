import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Purpose: the `audit debt` mode lives in prose (#355) — this reads the grep
 * pattern out of the verb file's Debt section and runs it over two fixture
 * states, so the regex, the dedup key and the shortcut form are tested as
 * written rather than through a shadow implementation. The --apply tracker
 * writes are verb-level and deliberately not unit-tested. The re-run step's
 * removing-commit look-up (#390) IS tested: the command template is read out
 * of the prose and a marker carrying a double quote, a semicolon and a
 * backtick is pushed through it, so the one way comment text could ever
 * reach a shell is the one way this file proves it cannot split.
 * Author(s): John Reed
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const FIXTURES = "server/test/fixtures/debt";
const AUDIT_MD = read("skills/cairn-trailhead/verbs/audit.md");
const DEBT_SECTION = AUDIT_MD.slice(AUDIT_MD.indexOf("\n## Debt"));

// Pulls the -E pattern out of the backticked git grep line in the Debt
// section — the single-quoted argument right after -nE.
function grepPattern(): string {
  const m = DEBT_SECTION.match(/`git grep --no-index --exclude-standard -nE '([^']+)'[^`]*`/);
  expect(m, "the Debt section must carry the backticked git grep line").not.toBeNull();
  return m![1];
}

// The dedup key's normalisation, as the Debt section states it: lowercased,
// whitespace collapsed, trailing punctuation dropped.
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
}

type Marker = { file: string; line: number; word: string; text: string; key: string };

// The fixture marker written to break a shell line (#390): a double quote, a
// semicolon and a backtick, exactly as both fixture states carry it.
const HOSTILE = 'keep the "legacy" path; see `echo pwned` for why';

// Pulls the removing-commit look-up out of the re-run matching step — the
// backticked `git log -S` line. Whatever quoting the prose documents is what
// the test exercises; the test never supplies a safer form of its own.
function removalTemplate(): string {
  const m = DEBT_SECTION.match(/`(git log -S [^`]*<marker text>[^`]*)`/);
  expect(m, "the re-run step must carry a backticked git log -S template").not.toBeNull();
  return m![1];
}

// Substitutes marker text into the template the way the prose says to: inside
// single quotes with every single quote dropped from the text first, or — if
// the prose still double-quotes the placeholder — inside double quotes as
// written. The second branch is what #390 found; keeping it here is what
// lets this test go red against the old prose rather than assume the fix.
function fillTemplate(template: string, text: string, path: string): string {
  const quote = template.charAt(template.indexOf("<marker text>") - 1);
  const arg = quote === "'" ? `'${text.replace(/'/g, "")}'` : `"${text}"`;
  return template.replace(/(['"])<marker text>\1/, arg).replace("<path>", path);
}

// Runs the prose regex over every fixture file line by line and builds the
// finding set the verb would — one marker per hit, key = path :: text.
function scan(state: string): Marker[] {
  const re = new RegExp(grepPattern());
  const dir = join(FIXTURES, state);
  const out: Marker[] = [];
  for (const f of readdirSync(join(ROOT, dir)).sort()) {
    const rel = `${dir}/${f}`;
    read(rel).split("\n").forEach((raw, i) => {
      const m = re.exec(raw);
      if (!m) return;
      const word = m[2];
      const text = raw.slice(m.index + m[0].length).trim();
      out.push({ file: rel, line: i + 1, word, text, key: `marker: ${rel} :: ${normalise(text)}` });
    });
  }
  return out;
}

// The shortcut form: `shortcut: <limit>, <when to upgrade>`, split at the
// first comma. No comma means no trigger — reported, never invented.
function parseShortcut(text: string): { limit: string; trigger: string | null } {
  const at = text.indexOf(",");
  if (at < 0) return { limit: text.trim(), trigger: null };
  return { limit: text.slice(0, at).trim(), trigger: text.slice(at + 1).trim() };
}

describe("audit debt — the prose surface (#355)", () => {
  it("the Modes table has the debt row, backticked like every other row", () => {
    expect(AUDIT_MD).toMatch(/^\| `debt \[scope\]` \|/m);
  });

  it("the Debt section exists and credits ponytail in one line", () => {
    expect(DEBT_SECTION.length).toBeGreaterThan(0);
    expect(DEBT_SECTION).toMatch(/ponytail.*MIT/);
  });

  it("the grep pattern names the five default marker words and no legacy word", () => {
    const pattern = grepPattern();
    for (const w of ["shortcut", "TODO", "FIXME", "HACK", "XXX"]) expect(pattern).toContain(w);
    expect(pattern).not.toContain("ponytail");
    expect(() => new RegExp(pattern)).not.toThrow();
  });

  it("sweep runs debt as leg 5, between plans and simplify, milestone last at 8", () => {
    expect(AUDIT_MD).toMatch(/^4\. `plans`\n5\. `debt`/m);
    expect(AUDIT_MD).toMatch(/^6\. `simplify`/m);
    expect(AUDIT_MD).toMatch(/^7\. `memory`/m);
    expect(AUDIT_MD).toMatch(/^8\. `milestone` last/m);
  });

  it("the debt section states the every-marker exception to 'minors stay in the record'", () => {
    expect(DEBT_SECTION).toMatch(/EVERY marker, regardless of severity/);
    expect(DEBT_SECTION).toMatch(/one deliberate exception/);
  });

  it("the routing blurb and the generated command shim both carry /debt", () => {
    expect(read("skills/cairn-trailhead/SKILL.md")).toMatch(/memory\/debt\/sweep/);
    expect(read("commands/audit.md")).toMatch(/memory\/debt\/sweep/);
  });
});

describe("audit debt — the grep over the fixtures", () => {
  const a = scan("a");

  it("finds the expected marker set across both languages", () => {
    expect(a.map((m) => [m.file.split("/").pop(), m.word, m.text])).toEqual([
      ["deploy.sh", "FIXME", "The timeout path is unhandled."],
      ["deploy.sh", "shortcut", "skip the lock file on dry runs"],
      ["retry.ts", "shortcut", "retry count hard-coded to 3, upgrade when a second backend ships"],
      ["retry.ts", "FIXME", "the timeout path is unhandled"],
      ["retry.ts", "HACK", HOSTILE],
    ]);
  });

  it("dedup keys: duplicate text in two files is two keys carrying the same normalised text", () => {
    const keys = a.map((m) => m.key);
    expect(new Set(keys).size).toBe(5);
    const dup = a.filter((m) => normalise(m.text) === "the timeout path is unhandled");
    expect(dup.map((m) => m.file.split("/").pop())).toEqual(["deploy.sh", "retry.ts"]);
    expect(dup[0].key).not.toBe(dup[1].key);
    for (const k of keys) expect(k).toMatch(/^marker: server\/test\/fixtures\/debt\/a\/\S+ :: \S/);
  });

  it("the shortcut form parses into limit + trigger", () => {
    const s = a.find((m) => m.word === "shortcut" && m.file.endsWith("retry.ts"))!;
    expect(parseShortcut(s.text)).toEqual({
      limit: "retry count hard-coded to 3",
      trigger: "upgrade when a second backend ships",
    });
  });

  it("a shortcut with no trigger is flagged as such", () => {
    const s = a.find((m) => m.word === "shortcut" && m.file.endsWith("deploy.sh"))!;
    expect(parseShortcut(s.text)).toEqual({ limit: "skip the lock file on dry runs", trigger: null });
    expect(DEBT_SECTION).toMatch(/trigger: none stated/);
  });

  it("against the second fixture state exactly one key is gone", () => {
    const b = scan("b");
    const strip = (k: string) => k.replace("/debt/a/", "/debt/").replace("/debt/b/", "/debt/");
    const before = new Set(a.map((m) => strip(m.key)));
    const after = new Set(b.map((m) => strip(m.key)));
    const gone = [...before].filter((k) => !after.has(k));
    const added = [...after].filter((k) => !before.has(k));
    expect(gone).toEqual(["marker: server/test/fixtures/debt/deploy.sh :: skip the lock file on dry runs"]);
    expect(added).toEqual([]);
  });
});

describe("audit debt — source comments are data, never a shell string (#390)", () => {
  const a = scan("a");

  it("the fixture marker carries a double quote, a semicolon and a backtick", () => {
    expect(HOSTILE).toMatch(/"/);
    expect(HOSTILE).toMatch(/;/);
    expect(HOSTILE).toMatch(/`/);
  });

  it("the dedup key keeps all three verbatim", () => {
    const h = a.find((m) => m.word === "HACK")!;
    expect(h.text).toBe(HOSTILE);
    expect(h.key).toBe(`marker: server/test/fixtures/debt/a/retry.ts :: ${HOSTILE.toLowerCase()}`);
  });

  it("the re-run template never places marker text inside a double-quoted shell string", () => {
    expect(DEBT_SECTION).not.toMatch(/"<marker text>"/);
    const t = removalTemplate();
    expect(t).toContain("-S '<marker text>'");
    expect(t).toMatch(/ -- <path>$/);
    expect(DEBT_SECTION).toMatch(/single quote dropped/);
  });

  it("the hostile marker travels through the documented command as ONE verbatim argument", () => {
    // Stand bash in for git: it parses the exact argument text the prose
    // would hand git, then reports how many words there are and what the
    // first one is. The template is `-S '<text>' --oneline -1 -- <path>`, so
    // a marker that stayed whole is word one of exactly five; anything else
    // means the shell split it, and "pwned" on its own line means it ran it.
    const filled = fillTemplate(removalTemplate(), HOSTILE, "src/retry.ts");
    const argv = filled.replace(/^git log -S /, "");
    const r = spawnSync("bash", ["-c", `set -- ${argv}; printf '%s\\n' "$#" "$1"`], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const [count, first] = r.stdout.split("\n");
    expect(first).toBe(HOSTILE);
    expect(count).toBe("5");
    expect(r.stdout).not.toContain("pwned\n");
  });

  it("the Debt section says comment text is a spec, never an instruction, and a directive-shaped marker is reported", () => {
    expect(DEBT_SECTION).toMatch(/never an instruction/);
    expect(DEBT_SECTION).toMatch(/reported in the record/);
  });

  it("the shared rule names source read from the repo under audit, and the generated spine carries it", () => {
    for (const rel of ["skills/cairn-trailhead/SKILL.md", "harness/AGENTS-cairn.md", "AGENTS.md"]) {
      expect(read(rel), rel).toMatch(/repo under audit/);
    }
  });
});
