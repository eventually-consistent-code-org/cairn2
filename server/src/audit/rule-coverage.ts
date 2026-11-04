/**
 * Purpose: the mechanical half of `audit security --surface`'s
 *   rule-to-control coverage check (#207). Finds every imperative rule line
 *   ("never", "do not", "must", "always") in the prose an agent is told to
 *   obey — CLAUDE.md, AGENTS.md, verb files, hook prose — and enumerates
 *   every deterministic control that exists to back one: registered hooks,
 *   permission deny/ask rules, server-side refusals, guard scripts, git
 *   hooks, CI workflows. Then it pairs each rule with its candidate controls
 *   by token overlap and names the control type that would most plausibly
 *   back it.
 *
 *   It never decides that a control ACTUALLY backs a rule — that is the
 *   auditing agent's judgment, made in the verb prose. A rule with no
 *   candidate is reported `uncovered`; a rule with candidates is reported
 *   `candidate` for the agent to confirm or reject.
 *
 *   Pure library, no tool surface (same precedent as dedupFindings): the
 *   verb runs it via node against dist. Read-only and deterministic: it
 *   reads a fixed set of paths under the scanned root, never follows a
 *   symlink out of that root, skips oversized files, and treats everything
 *   it reads as data — rule text is quoted back, never interpreted.
 * Author(s): John Reed
 */

// Imports
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";


// Constants

// Anything bigger than this isn't hand-written rule prose or config — skip
// it rather than read it (a vendored blob, or someone being clever).
export const MAX_FILE_BYTES = 512 * 1024;

// Rule text is quoted back into the audit record; a whole table row is not
// a rule, so clip it.
export const MAX_RULE_CHARS = 240;

// How many candidate controls a rule carries, and how many distinct shared
// tokens make a control a candidate at all. Two keeps "never" + one stray
// common word from pairing everything with everything.
export const MAX_CANDIDATES = 3;
export const MIN_SHARED_TOKENS = 2;

// The imperative markers. Prohibitions first so "must not" wins over "must".
const PROHIBITION_RE = /\b(never|do not|don['’]t|must not|mustn['’]t|may not|shall not)\b/i;
const OBLIGATION_RE = /\b(always|must|shall|required to)\b/i;

// Tokens too common in rule prose to count as evidence a control matches.
const STOPWORDS = new Set([
  "never", "always", "must", "shall", "dont", "don't", "not", "the", "and", "for", "that",
  "this", "with", "from", "into", "when", "what", "where", "which", "while", "every",
  "each", "only", "then", "than", "them", "they", "their", "there", "here", "have", "has",
  "been", "being", "were", "will", "would", "could", "should", "does", "doing", "done",
  "any", "all", "one", "its", "it's", "you", "your", "our", "are", "was", "but", "via",
  "same", "other", "more", "most", "some", "such", "just", "also", "like", "over",
  "under", "before", "after", "without", "within", "about", "else", "even", "ever",
  "make", "made", "keep", "need", "needs", "used", "use", "uses", "using", "run", "runs",
  "file", "files", "line", "lines", "cairn", "agent", "verb", "rule", "rules",
  "against", "below", "above", "own", "still", "per", "off", "see", "new", "set", "full",
  "true", "false", "means", "isn", "aren", "can", "way", "out", "yes", "now", "two", "three",
]);

// The rule → control-type heuristic. First match wins, so the order is the
// policy: secrets and git actions want an interceptor before anything else.
const NEAREST_TYPE: Array<{ re: RegExp; type: ControlType }> = [
  { re: /\b(secret|secrets|credential|credentials|token|tokens|password|api[- ]?key|private key|email)\b/i, type: "hook" },
  { re: /\b(commit|commits|push|pushes|stage|staged|rebase|force|tag|git)\b/i, type: "hook" },
  { re: /\b(edit|edits|write|writes|modify|delete|remove|touch|hand-edit|hand-edited)\b/i, type: "permission-deny" },
  { re: /\b(curl|wget|rm|sudo|install|network|fetch|execute|shell|bash|command)\b/i, type: "permission-deny" },
  { re: /\b(test|tests|build|dist|version|versions|count|counts|lint|pin|pins|generated|regenerate)\b/i, type: "guard-script" },
  { re: /\b(tracker|issue|issues|state|tool|tools|server|record|ledger|close|transition|refuse|refuses)\b/i, type: "server-gate" },
];


// Types

export type RulePolarity = "prohibition" | "obligation";

export type RuleSourceKind = "instructions" | "verb" | "hook-prose";

/** One imperative sentence an agent is told to obey. */
export interface RuleLine {
  /** Root-relative POSIX path. */
  file: string;
  /** 1-based line the imperative keyword sits on. */
  line: number;
  /** The sentence, whitespace-collapsed and clipped. */
  text: string;
  /** The keyword that made it a rule (lowercased). */
  keyword: string;
  polarity: RulePolarity;
  sourceKind: RuleSourceKind;
}

export type ControlType =
  | "hook"
  | "permission-deny"
  | "permission-ask"
  | "server-gate"
  | "guard-script"
  | "git-hook"
  | "ci-workflow";

/** One deterministic mechanism that can refuse or fail something. */
export interface Control {
  type: ControlType;
  /** Stable, human-readable id (e.g. `PreToolUse[Bash] pretooluse-leakguard.mjs`). */
  id: string;
  /** Root-relative POSIX path of the file that declares it. */
  source: string;
  /** What it does, as best the declaration says (matcher + command, deny rule, error codes). */
  detail: string;
  /** Lowercased tokens the matcher pairs rules against. */
  tokens: string[];
}

export interface RuleCandidate {
  controlId: string;
  type: ControlType;
  /** Distinct tokens the rule and the control share. */
  shared: string[];
}

export interface RuleCoverage {
  rule: RuleLine;
  /** `uncovered`: no control shares enough vocabulary to even be a candidate. */
  status: "uncovered" | "candidate";
  candidates: RuleCandidate[];
  /** The control type that would most plausibly back this rule. */
  nearestControlType: ControlType;
}

export interface SkippedPath {
  path: string;
  reason: "too-large" | "outside-root" | "unparseable" | "unreadable";
}

export interface RuleCoverageReport {
  root: string;
  rules: RuleLine[];
  controls: Control[];
  coverage: RuleCoverage[];
  skipped: SkippedPath[];
  summary: {
    rules: number;
    controls: number;
    uncovered: number;
    candidate: number;
    controlsByType: Partial<Record<ControlType, number>>;
  };
}


// Safe file access — every read goes through here

/**
 * Reads a file under `root` as text, or returns null and records why not.
 * Refuses a path whose real location is outside the root (a symlinked
 * CLAUDE.md pointing at ~/.ssh does not get its lines quoted into an
 * audit record) and anything over MAX_FILE_BYTES.
 */
function readUnderRoot(root: string, rel: string, skipped: SkippedPath[]): string | null {
  const abs = join(root, rel);
  try {
    if (!existsSync(abs)) return null;
    const real = realpathSync(abs);
    if (real !== root && !real.startsWith(root + sep)) {
      skipped.push({ path: toPosix(rel), reason: "outside-root" });
      return null;
    }
    const st = statSync(real);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) {
      skipped.push({ path: toPosix(rel), reason: "too-large" });
      return null;
    }
    return readFileSync(real, "utf8");
  } catch {
    skipped.push({ path: toPosix(rel), reason: "unreadable" });
    return null;
  }
}

/** Lists plain entries of a directory under root (no recursion, no symlinked dirs out). */
function listDir(root: string, rel: string): string[] {
  const abs = join(root, rel);
  try {
    if (!existsSync(abs) || lstatSync(abs).isSymbolicLink() || !statSync(abs).isDirectory()) return [];
    return readdirSync(abs).sort();
  } catch {
    return [];
  }
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}


// Rule extraction

/**
 * Pulls imperative sentences out of markdown-ish text. Fenced code is
 * skipped (a `rm -rf` example isn't a rule); list items, table rows and
 * headings each start a new block so a sentence never spans two bullets;
 * wrapped prose lines join into one block so a rule split across lines is
 * still one rule, reported at the line its keyword sits on.
 */
export function extractRules(text: string, file: string, sourceKind: RuleSourceKind): RuleLine[] {
  const lines = text.split(/\r?\n/);
  const out: RuleLine[] = [];
  let inFence = false;
  let block: Array<{ line: number; text: string }> = [];

  const flush = () => {
    if (block.length) out.push(...rulesFromBlock(block, file, sourceKind));
    block = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed || /^\|?\s*:?-{3,}/.test(trimmed)) {
      flush();
      continue;
    }
    if (/^([-*+]\s|\d+[.)]\s|\||#{1,6}\s|>)/.test(trimmed)) flush();
    block.push({ line: i + 1, text: trimmed });
  }
  flush();
  return out;
}

/** Splits one block into sentences and keeps the imperative ones. */
function rulesFromBlock(
  block: Array<{ line: number; text: string }>,
  file: string,
  sourceKind: RuleSourceKind,
): RuleLine[] {
  // Join with single spaces, remembering where each source line starts so a
  // sentence can be traced back to the line its keyword sits on.
  let joined = "";
  const starts: Array<{ offset: number; line: number }> = [];
  for (const b of block) {
    if (joined) joined += " ";
    starts.push({ offset: joined.length, line: b.line });
    joined += b.text;
  }
  const lineAt = (offset: number) => {
    let line = starts[0].line;
    for (const s of starts) if (s.offset <= offset) line = s.line;
    return line;
  };

  const out: RuleLine[] = [];
  // A sentence ends at . ! or ? followed by whitespace — "hooks.json" and
  // "e.g" stay inside their sentence.
  const sentenceRe = /(?:[^.!?]|[.!?](?=\S))+(?:[.!?]+(?=\s|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(joined)) !== null) {
    const sentence = m[0];
    const pro = PROHIBITION_RE.exec(sentence);
    const obl = pro ? null : OBLIGATION_RE.exec(sentence);
    const hit = pro ?? obl;
    if (!hit) continue;
    const text = clean(sentence);
    if (!text) continue;
    out.push({
      file: toPosix(file),
      line: lineAt(m.index + hit.index),
      text,
      keyword: hit[1].toLowerCase().replace("’", "'"),
      polarity: pro ? "prohibition" : "obligation",
      sourceKind,
    });
  }
  return out;
}

/** Strips list/table/heading/emphasis markup and clips to MAX_RULE_CHARS. */
function clean(sentence: string): string {
  const s = sentence
    .replace(/^(?:[\s|>#*+-]+|\d+[.)]\s+)+/, "")
    .replace(/`|\*\*/g, "")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > MAX_RULE_CHARS ? s.slice(0, MAX_RULE_CHARS - 1) + "…" : s;
}

/**
 * The header comment of a script — the `/** ... *\/` block or the run of
 * `//` / `#` comment lines at the top, after any shebang — with markers
 * stripped. Every other line is blanked so line numbers stay true.
 */
export function headerProse(text: string): string {
  const lines = text.split(/\r?\n/);
  const out = lines.map(() => "");
  let i = 0;
  if (lines[0]?.startsWith("#!")) i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim().startsWith("/*")) {
    for (; i < lines.length; i++) {
      const done = lines[i].includes("*/");
      out[i] = lines[i].replace(/^\s*\/\*+|\*+\/\s*$|^\s*\*\s?/g, "").trim();
      if (done) break;
    }
  } else {
    for (; i < lines.length && /^\s*(\/\/|#)/.test(lines[i]); i++) {
      out[i] = lines[i].replace(/^\s*(\/\/+|#+)\s?/, "").replace(/#+\s*$/, "").trim();
    }
  }
  return out.join("\n");
}


// Control enumeration

/** Lowercased content words, deduplicated, stopwords dropped. */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].sort();
}

/** Settings-shaped files a project or plugin declares hooks/permissions in. */
const SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];
/** Where cairn-setup --git-hooks puts the pre-push hook (#456), in the planning folder. */
const CAIRN_GITHOOKS = [".cairn", "githooks"].join("/");
const HOOK_MANIFESTS = ["hooks/hooks.json", ...SETTINGS_FILES];

interface HookEntry { type?: unknown; command?: unknown }
interface HookGroup { matcher?: unknown; hooks?: unknown }

/** Hooks registered in a plugin hooks.json or a settings file. */
function hookControls(root: string, skipped: SkippedPath[]): Control[] {
  const out: Control[] = [];
  for (const rel of HOOK_MANIFESTS) {
    const parsed = readJson(root, rel, skipped);
    const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
    if (!hooks || typeof hooks !== "object") continue;
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as HookGroup[]) {
        const matcher = typeof g?.matcher === "string" && g.matcher ? g.matcher : "*";
        if (!Array.isArray(g?.hooks)) continue;
        for (const h of g.hooks as HookEntry[]) {
          if (typeof h?.command !== "string") continue;
          const script = scriptPath(h.command);
          const name = script ? script.split("/").pop()! : h.command.slice(0, 60);
          const prose = script ? readUnderRoot(root, script, skipped) : null;
          out.push({
            type: "hook",
            id: `${event}[${matcher}] ${name}`,
            source: rel,
            detail: `${event} hook on ${matcher}: ${h.command}`,
            tokens: tokenize(`${event} ${matcher} ${name} ${prose ? headerProse(prose) : ""}`),
          });
        }
      }
    }
  }
  return out;
}

/**
 * The root-relative script a hook command runs, when it names one under
 * the plugin/project root variables or a relative path. Absolute paths and
 * anything that climbs out with `..` resolve to null — we don't read them.
 */
function scriptPath(command: string): string | null {
  const m = command.match(/(?:\$\{?CLAUDE_(?:PLUGIN_ROOT|PROJECT_DIR)\}?\/)?([\w./-]+\.(?:mjs|cjs|js|ts|sh|py))/);
  if (!m) return null;
  const p = m[1].replace(/^\.\//, "");
  if (isAbsolute(p) || p.split("/").includes("..")) return null;
  return p;
}

/** Permission deny/ask rules in the settings files. Allow rules back nothing. */
function permissionControls(root: string, skipped: SkippedPath[]): Control[] {
  const out: Control[] = [];
  for (const rel of SETTINGS_FILES) {
    const parsed = readJson(root, rel, skipped) as { permissions?: { deny?: unknown; ask?: unknown } } | null;
    const perms = parsed?.permissions;
    if (!perms) continue;
    for (const [key, type] of [["deny", "permission-deny"], ["ask", "permission-ask"]] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      for (const rule of list) {
        if (typeof rule !== "string") continue;
        out.push({ type, id: `${key} ${rule}`, source: rel, detail: `permissions.${key}: ${rule}`, tokens: tokenize(rule) });
      }
    }
  }
  return out;
}

/** scripts/check-*.mjs style guards — a script whose job is to fail a build. */
function guardScriptControls(root: string, skipped: SkippedPath[]): Control[] {
  const out: Control[] = [];
  for (const name of listDir(root, "scripts")) {
    if (!/^(check|guard|lint|verify)[-_].+\.(mjs|cjs|js|ts|sh|py)$/.test(name)) continue;
    const rel = `scripts/${name}`;
    const text = readUnderRoot(root, rel, skipped);
    if (text === null) continue;
    out.push({ type: "guard-script", id: name, source: rel, detail: firstProseLine(text), tokens: tokenize(`${name} ${headerProse(text)}`) });
  }
  return out;
}

/** Files under server/src that refuse with a typed CairnError — one control per file. */
function serverGateControls(root: string, skipped: SkippedPath[]): Control[] {
  const out: Control[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 6) return;
    for (const name of listDir(root, rel)) {
      const child = `${rel}/${name}`;
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(join(root, child)); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { walk(child, depth + 1); continue; }
      if (!name.endsWith(".ts")) continue;
      const text = readUnderRoot(root, child, skipped);
      if (text === null) continue;
      const codes = new Set<string>();
      const messages: string[] = [];
      const re = /new CairnError\(\s*"([A-Z_]+)"\s*,\s*[`"']([^`"']{0,200})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) { codes.add(m[1]); messages.push(m[2]); }
      if (!codes.size) continue;
      out.push({
        type: "server-gate",
        id: child.replace(/^server\/src\//, ""),
        source: child,
        detail: `refuses with ${[...codes].sort().join(", ")}`,
        tokens: tokenize(`${child.replace(/[/.]/g, " ")} ${messages.join(" ")}`),
      });
    }
  };
  walk("server/src", 0);
  return out;
}

/** Git hooks (husky, lefthook, pre-commit) and CI workflows. */
function gitAndCiControls(root: string, skipped: SkippedPath[]): Control[] {
  const out: Control[] = [];
  for (const name of listDir(root, ".husky")) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const rel = `.husky/${name}`;
    const text = readUnderRoot(root, rel, skipped);
    if (text === null) continue;
    out.push({ type: "git-hook", id: `husky ${name}`, source: rel, detail: firstProseLine(text), tokens: tokenize(`${name} ${text}`) });
  }
  for (const rel of [".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml"]) {
    const text = readUnderRoot(root, rel, skipped);
    if (text === null) continue;
    out.push({ type: "git-hook", id: rel, source: rel, detail: "git hook manager config", tokens: tokenize(text) });
  }
  // The hooks `cairn-setup --git-hooks` installs (#456): the git layer of
  // the ship gate, so a default-branch "never" pairs with two controls on a
  // project that installed it. Only a file carrying the cairn marker counts.
  for (const name of listDir(root, CAIRN_GITHOOKS)) {
    if (name.startsWith(".")) continue;
    const rel = `${CAIRN_GITHOOKS}/${name}`;
    const text = readUnderRoot(root, rel, skipped);
    if (text === null || !text.includes("# cairn:begin")) continue;
    out.push({ type: "git-hook", id: `cairn ${name}`, source: rel, detail: firstProseLine(text), tokens: tokenize(`${name} ${text}`) });
  }
  for (const name of listDir(root, ".github/workflows")) {
    if (!/\.ya?ml$/.test(name)) continue;
    const rel = `.github/workflows/${name}`;
    const text = readUnderRoot(root, rel, skipped);
    if (text === null) continue;
    // Only the step names and run lines — a workflow's whole YAML is mostly
    // boilerplate vocabulary that would pair it with every rule.
    const steps = text.split(/\r?\n/).filter((l) => /^\s*(-\s*)?(name|run):/.test(l)).join(" ");
    out.push({ type: "ci-workflow", id: name, source: rel, detail: firstProseLine(text), tokens: tokenize(`${name} ${steps}`) });
  }
  return out;
}

function firstProseLine(text: string): string {
  const prose = headerProse(text).split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return (prose ?? "").replace(/^Purpose:\s*/i, "").slice(0, MAX_RULE_CHARS);
}

function readJson(root: string, rel: string, skipped: SkippedPath[]): unknown {
  const text = readUnderRoot(root, rel, skipped);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    skipped.push({ path: rel, reason: "unparseable" });
    return null;
  }
}

/** Every deterministic control the root declares, in a stable order. */
export function enumerateControls(root: string, skipped: SkippedPath[] = []): Control[] {
  const realRoot = realpathSync(resolve(root));
  return [
    ...hookControls(realRoot, skipped),
    ...permissionControls(realRoot, skipped),
    ...serverGateControls(realRoot, skipped),
    ...guardScriptControls(realRoot, skipped),
    ...gitAndCiControls(realRoot, skipped),
  ];
}


// Rule sources

/** Every rule the root's agent-facing prose states, in a stable order. */
export function collectRules(root: string, skipped: SkippedPath[] = []): RuleLine[] {
  const realRoot = realpathSync(resolve(root));
  const out: RuleLine[] = [];
  const add = (rel: string, kind: RuleSourceKind, transform?: (t: string) => string) => {
    const text = readUnderRoot(realRoot, rel, skipped);
    if (text !== null) out.push(...extractRules(transform ? transform(text) : text, rel, kind));
  };

  // Instruction files, root and project-scoped.
  for (const rel of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md"]) add(rel, "instructions");

  // Verb files — cairn's own layout (skills/<skill>/verbs/*.md).
  for (const skill of listDir(realRoot, "skills")) {
    for (const name of listDir(realRoot, `skills/${skill}/verbs`)) {
      if (name.endsWith(".md")) add(`skills/${skill}/verbs/${name}`, "verb");
    }
  }

  // Hook prose — the manifest's description strings and each hook script's header.
  for (const rel of HOOK_MANIFESTS) add(rel, "hook-prose", jsonDescriptions);
  for (const dir of ["hooks/scripts", ".claude/hooks"]) {
    for (const name of listDir(realRoot, dir)) {
      if (/\.(mjs|cjs|js|ts|sh|py)$/.test(name)) add(`${dir}/${name}`, "hook-prose", headerProse);
    }
  }
  return out;
}

/** Keeps only the `"description": "..."` values of a JSON file, line numbers intact. */
function jsonDescriptions(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*"description"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "")
    .join("\n");
}


// Pairing

/** The control type that would most plausibly back a rule, by its vocabulary. */
export function nearestControlType(text: string): ControlType {
  for (const { re, type } of NEAREST_TYPE) if (re.test(text)) return type;
  return "hook";
}

/** Pairs one rule with its candidate controls by shared tokens. */
export function pairRule(rule: RuleLine, controls: Control[]): RuleCoverage {
  const ruleTokens = new Set(tokenize(rule.text));
  const candidates = controls
    .map((c) => ({ controlId: c.id, type: c.type, shared: c.tokens.filter((t) => ruleTokens.has(t)) }))
    .filter((c) => c.shared.length >= MIN_SHARED_TOKENS)
    .sort((a, b) => b.shared.length - a.shared.length || a.controlId.localeCompare(b.controlId))
    .slice(0, MAX_CANDIDATES);
  return {
    rule,
    status: candidates.length ? "candidate" : "uncovered",
    candidates,
    nearestControlType: nearestControlType(rule.text),
  };
}


// Main

/**
 * The whole scan: rules, controls, pairing, summary. `root` is the repo
 * being audited — cairn itself or a user project; whatever isn't there
 * simply contributes nothing.
 */
export function scanRuleCoverage(root: string): RuleCoverageReport {
  const realRoot = realpathSync(resolve(root));
  const skipped: SkippedPath[] = [];
  const rules = collectRules(realRoot, skipped);
  const controls = enumerateControls(realRoot, skipped);
  const coverage = rules.map((r) => pairRule(r, controls));
  const controlsByType: Partial<Record<ControlType, number>> = {};
  for (const c of controls) controlsByType[c.type] = (controlsByType[c.type] ?? 0) + 1;
  const uncovered = coverage.filter((c) => c.status === "uncovered").length;
  return {
    root: realRoot,
    rules,
    controls,
    coverage,
    skipped,
    summary: { rules: rules.length, controls: controls.length, uncovered, candidate: coverage.length - uncovered, controlsByType },
  };
}
