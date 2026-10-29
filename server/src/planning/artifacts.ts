import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "../errors.js";
import { parseFrontmatter, parsePlanDoc, serializeFrontmatter } from "./frontmatter.js";

export const plansRoot = (projectDir: string) => join(projectDir, ".cairn", "plans");

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    throw new CairnError("CONFIG_INVALID", `cannot derive a slug from '${name}'`);
  }
  return slug;
}

// Accepts integers 1..99, or a number with exactly one fractional digit
// .1-.9 whose integer part is 1..98 -- lets a phase slot in (1.5) between
// 1 and 2 without renumbering the rest of the roadmap. A float that just
// happens to equal an integer (1.0) is treated as that integer.
export function isValidPhaseNumber(number: number): boolean {
  if (typeof number !== "number" || !Number.isFinite(number)) return false;
  const scaled = number * 10;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return false; // more than one fractional digit
  const intPart = Math.trunc(rounded / 10);
  const frac = rounded - intPart * 10;
  return frac === 0 ? intPart >= 1 && intPart <= 99 : intPart >= 1 && intPart <= 98;
}

export const PHASE_NUMBER_ERROR = (number: number) =>
  `phase number must be 1..99, or N.1-N.9 with N=1..98, got ${number}`;

// Shared prefix scheme -- pad the integer part to two digits, append the
// fractional digit if present (1.5 -> "01.5-", 3 -> "03-"). phaseDirName
// below is just this prefix plus a slug; any other caller that needs to
// *match* a phase's directory (a filter, a glob) should reuse this instead
// of re-deriving the padding by hand (CRN-40 -- planCheck's filter used to
// do exactly that, and it broke on decimal phases).
export function phaseDirPrefix(number: number): string {
  if (!isValidPhaseNumber(number)) {
    throw new CairnError("CONFIG_INVALID", PHASE_NUMBER_ERROR(number));
  }
  const scaled = Math.round(number * 10);
  const intPart = Math.trunc(scaled / 10);
  const frac = scaled - intPart * 10;
  const padded = String(intPart).padStart(2, "0");
  return frac === 0 ? `${padded}-` : `${padded}.${frac}-`;
}

export function phaseDirName(number: number, slug: string): string {
  return `${phaseDirPrefix(number)}${slug}`;
}

// Round-trips a dir name back to its exact phase number + slug -- the
// counterpart to phaseDirName above. Shared by every caller that recovers a
// phase number from a directory name so a decimal dir (01.5-slug) parses
// back to 1.5, not 1. Returns null (never throws) for anything malformed --
// callers decide whether that's a skip (readdir scan) or a CONFIG_INVALID.
const PHASE_DIR_PATTERN = /^(\d{2})(\.\d)?-([a-z0-9-]+)$/;

export function parsePhaseDirName(dirName: string): { number: number; slug: string } | null {
  const m = PHASE_DIR_PATTERN.exec(dirName);
  if (!m) return null;
  return { number: Number(m[1] + (m[2] ?? "")), slug: m[3] };
}

export const PROJECT_TEMPLATE = (name: string) => `# ${name}

## Vision

<!-- what this project is and why -->

## Requirements

<!-- REQ-01: ... one per line; issues are created in the tracker per requirement -->
`;

export const ROADMAP_TEMPLATE = (name: string) => `# ${name} — Roadmap

| Phase | Name | Status |
|-------|------|--------|
`;

export const CONTEXT_TEMPLATE = (number: number, name: string) =>
  `# Phase ${number}: ${name} — Context

## Locked decisions

<!-- decisions made for this phase; on conflict these WIN over tracker issue text -->

## Approaches considered

<!-- the phase's central fork, as two-plus candidates:
       ### A — <name>   (a line of trade-offs: what it buys, what it costs)
       ### B — <name>
       chosen: <letter> — because <one line>
     plan writes this BEFORE PLAN.md; plan_check flags a planned, non-quick
     phase without it. Left as a comment on purpose: an unfilled skeleton
     must not satisfy the gate. -->
`;

export const PLAN_TEMPLATE = (number: number, name: string) =>
  serializeFrontmatter({ issues: [] }, `# Phase ${number}: ${name} — Plan

## Tasks

<!-- tasks; frontmatter 'issues' lists the tracker ids this plan advances -->
`);

export const RESEARCH_TEMPLATE = (number: number, name: string) =>
  `# Phase ${number}: ${name} — Research

<!-- deep-mode research brief -->
`;

function createIfAbsent(path: string, content: string,
  created: string[], skipped: string[]): void {
  if (existsSync(path)) { skipped.push(path); return; }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  created.push(path);
}

/**
 * The ledger is append-only, so git's union merge driver is correct by
 * construction: two branches that each appended a line keep both. The
 * attribute lives at the planning root, where `**` reaches every phase.
 */
export const LEDGER_UNION_LINE = "**/LEDGER.md merge=union";
const LEDGER_UNION_RE = /^\*\*\/LEDGER\.md\s+(?:\S+\s+)*merge=union(?:\s|$)/;

/** Whether the planning root's .gitattributes already carries the ledger union line. */
export function hasLedgerUnion(projectDir: string): boolean {
  const path = join(plansRoot(projectDir), ".gitattributes");
  return existsSync(path)
    && readFileSync(path, "utf8").split("\n").some((l) => LEDGER_UNION_RE.test(l.trim()));
}

/** Idempotent: appends the union line when absent. Reports what it did. */
export function ensureLedgerUnion(projectDir: string): "added" | "present" {
  if (hasLedgerUnion(projectDir)) return "present";
  const path = join(plansRoot(projectDir), ".gitattributes");
  mkdirSync(plansRoot(projectDir), { recursive: true });
  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lead = prior === "" || prior.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${prior}${lead}${LEDGER_UNION_LINE}\n`);
  return "added";
}

export function scaffoldProject(projectDir: string, name: string): {
  created: string[]; skipped: string[]; gitattributes: "added" | "present";
} {
  const root = plansRoot(projectDir);
  const created: string[] = []; const skipped: string[] = [];
  createIfAbsent(join(root, "PROJECT.md"), PROJECT_TEMPLATE(name), created, skipped);
  createIfAbsent(join(root, "roadmap.md"), ROADMAP_TEMPLATE(name), created, skipped);
  return { created, skipped, gitattributes: ensureLedgerUnion(projectDir) };
}

export function scaffoldPhase(projectDir: string, number: number, name: string,
  opts: { research?: boolean } = {}): {
  dir: string; created: string[]; skipped: string[]; gitattributes: "added" | "present";
} {
  const dirName = phaseDirName(number, slugify(name));
  const base = join(plansRoot(projectDir), "phases", dirName);
  const created: string[] = []; const skipped: string[] = [];
  createIfAbsent(join(base, "CONTEXT.md"), CONTEXT_TEMPLATE(number, name), created, skipped);
  createIfAbsent(join(base, "PLAN.md"), PLAN_TEMPLATE(number, name), created, skipped);
  if (opts.research) {
    createIfAbsent(join(base, "RESEARCH.md"), RESEARCH_TEMPLATE(number, name), created, skipped);
  }
  return { dir: dirName, created, skipped, gitattributes: ensureLedgerUnion(projectDir) };
}

export function readPlanIssues(projectDir: string, phaseDir: string): string[] {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) return [];
  return parsePlanDoc(readFileSync(path, "utf8")).frontmatter.issues;
}

const ISSUE_ID_BREAKING_CHARS_RE = /[,[\]\n]/;

export function writePlanIssues(projectDir: string, phaseDir: string,
  issues: string[]): void {
  for (const id of issues) {
    if (ISSUE_ID_BREAKING_CHARS_RE.test(id)) {
      throw new CairnError("CONFIG_INVALID",
        `invalid issue id '${id}': commas, brackets, and newlines are not allowed (breaks frontmatter)`);
    }
  }
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  const raw = existsSync(path) ? readFileSync(path, "utf8") : PLAN_TEMPLATE(0, phaseDir);
  const { data, body } = parseFrontmatter(raw);
  writeFileSync(path, serializeFrontmatter({ ...data, issues }, body));
}

export interface PlanMeta { issues: string[]; waves: string[][]; tdd: string[] }

const WAVE_KEY_RE = /^wave_(\d+)$/;

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function readPlanMeta(projectDir: string, phaseDir: string): PlanMeta {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) return { issues: [], waves: [], tdd: [] };
  const { data } = parseFrontmatter(readFileSync(path, "utf8"));
  const waveKeys = Object.keys(data)
    .map((k) => WAVE_KEY_RE.exec(k)).filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  return {
    issues: asList(data.issues),
    waves: waveKeys.map((m) => asList(data[m[0]])),
    tdd: asList(data.tdd),
  };
}

export function writePlanMeta(projectDir: string, phaseDir: string,
  meta: { waves?: string[][]; tdd?: string[] }): void {
  const path = join(plansRoot(projectDir), "phases", phaseDir, "PLAN.md");
  if (!existsSync(path)) {
    throw new CairnError("NOT_FOUND",
      `no PLAN.md at phaseDir '${phaseDir}' — scaffold it first with plan_scaffold_phase`);
  }
  const raw = readFileSync(path, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const issues = new Set(asList(data.issues));
  const assertKnown = (ids: string[], what: string): void => {
    for (const id of ids) {
      if (!issues.has(id)) {
        throw new CairnError("CONFIG_INVALID",
          `${what} references '${id}' which is not in this plan's issues list`,
          "add it with plan_issues_set first");
      }
    }
  };
  if (meta.waves !== undefined) {
    const seen = new Set<string>();
    for (const [i, wave] of meta.waves.entries()) {
      if (wave.length === 0) {
        throw new CairnError("CONFIG_INVALID", `wave ${i + 1} is empty`);
      }
      assertKnown(wave, `wave ${i + 1}`);
      for (const id of wave) {
        if (seen.has(id)) {
          throw new CairnError("CONFIG_INVALID",
            `issue '${id}' appears in more than one wave`);
        }
        seen.add(id);
      }
    }
    for (const k of Object.keys(data)) if (WAVE_KEY_RE.test(k)) delete data[k];
    meta.waves.forEach((wave, i) => { data[`wave_${i + 1}`] = wave; });
  }
  if (meta.tdd !== undefined) {
    assertKnown(meta.tdd, "tdd");
    data.tdd = meta.tdd;
  }
  writeFileSync(path, serializeFrontmatter(data, body));
}
