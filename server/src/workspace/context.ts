import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CairnError } from "../errors.js";

export interface WorkspaceMember {
  name: string;
  path: string;
  configured: boolean;
  absPath: string;
}

export interface WorkspaceInfo {
  workspace: string;
  root: string;
  members: WorkspaceMember[];
  focus: string | null;
}

const WORKSPACE_FILE = "cairn-workspace.json";
const focusPath = (root: string) => join(root, ".cairn", "basecamp", "focus.json");

/** Reads the workspace-root focus file. Absent file means no focus (never an error). */
function readFocus(root: string): string | null {
  const path = focusPath(root);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} is not valid JSON: ${e}`,
      "inspect or delete .cairn/basecamp/focus.json");
  }
  const focus = (parsed as { focus?: unknown } | null)?.focus;
  return typeof focus === "string" ? focus : null;
}

function writeFocus(root: string, focus: string | null): void {
  const path = focusPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ focus }, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Walks up from `launchDir` looking for `cairn-workspace.json`, stopping at the
 * filesystem root (no `.git` requirement — see spec). Returns null when none is
 * found. A workspace file that exists but is malformed (bad JSON or missing the
 * expected shape) is NEVER treated as "no workspace" — that would silently fall
 * back to single-project behavior on a typo'd file, which is the trap this spec
 * calls out explicitly. It throws CONFIG_INVALID naming the file instead.
 */
export function findWorkspace(launchDir: string): WorkspaceInfo | null {
  let dir = resolve(launchDir);
  for (;;) {
    const path = join(dir, WORKSPACE_FILE);
    if (existsSync(path)) return loadWorkspace(path, dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadWorkspace(path: string, root: string): WorkspaceInfo {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} could not be read: ${e}`,
      `fix or remove ${WORKSPACE_FILE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError("CONFIG_INVALID", `${path} is not valid JSON: ${e}`,
      `fix or remove ${WORKSPACE_FILE}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CairnError("CONFIG_INVALID", `${path} must contain a JSON object`,
      `fix ${WORKSPACE_FILE} — expected { workspace, members }`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.workspace !== "string" || obj.workspace.trim().length === 0 || !Array.isArray(obj.members)) {
    throw new CairnError("CONFIG_INVALID",
      `${path} is missing a 'workspace' name or a 'members' array`,
      `fix ${WORKSPACE_FILE} — expected { workspace: string, members: [{ name, path }] }`);
  }
  const members: WorkspaceMember[] = obj.members.map((raw, i) => {
    if (typeof raw !== "object" || raw === null
      || typeof (raw as Record<string, unknown>).name !== "string"
      || typeof (raw as Record<string, unknown>).path !== "string") {
      throw new CairnError("CONFIG_INVALID", `${path}: member ${i} is missing 'name' or 'path'`,
        `fix ${WORKSPACE_FILE} — every member needs a name and a path`);
    }
    const m = raw as { name: string; path: string };
    const absPath = resolve(root, m.path);
    return { name: m.name, path: m.path, absPath, configured: existsSync(join(absPath, "cairn.json")) };
  });
  return { workspace: obj.workspace, root, members, focus: readFocus(root) };
}

/**
 * Sets (or clears, with `project: null`) the workspace focus. Validates the
 * target is a real, configured member before writing — an unconfigured or
 * unknown member is rejected with CONFIG_INVALID naming the member and the fix,
 * never silently accepted. Write is atomic (tmp + rename).
 */
export function setFocus(launchDir: string, project: string | null):
  { focus: string | null; projectDir: string; focusApplied: boolean } {
  const info = findWorkspace(launchDir);
  if (!info) {
    throw new CairnError("PRECONDITION_FAILED", `no workspace found from ${launchDir}`,
      "run basecamp init");
  }
  if (project === null) {
    writeFocus(info.root, null);
    return { focus: null, projectDir: launchDir, focusApplied: false };
  }
  const member = info.members.find((m) => m.name === project);
  if (!member) {
    throw new CairnError("CONFIG_INVALID", `'${project}' is not a member of workspace '${info.workspace}'`,
      `known members: ${info.members.map((m) => m.name).join(", ") || "(none)"}`);
  }
  if (!member.configured) {
    throw new CairnError("CONFIG_INVALID", `member '${project}' has no cairn.json and cannot be focused`,
      `add a cairn.json to ${member.path}`);
  }
  writeFocus(info.root, project);
  // The focus is written for the workspace; whether it moves THIS session is
  // the launch dir's call (#487) -- a member launch reports focusApplied: false
  // and keeps its own project dir, so the caller learns it on the spot.
  const resolved = resolveProject(launchDir);
  return { focus: project, projectDir: resolved.resolvedProject, focusApplied: resolved.focusApplied };
}

/** What a tool call's project dir resolved to, and why — the #487 fields. */
export interface ResolvedProject {
  launchDir: string;
  resolvedProject: string;
  focusApplied: boolean;
}

/**
 * True when `dir` is a configured member's directory or lies anywhere inside
 * one. Compared segment-wise (never a string prefix): `b-other` is not inside
 * member `b`, and a `..` spelled into the launch dir was resolved before it
 * got here — workspace-context.test.ts, the #487 hostile twins.
 */
function insideConfiguredMember(info: WorkspaceInfo, dir: string): boolean {
  return info.members.some((m) => {
    if (!m.configured) return false;
    const rel = relative(m.absPath, dir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * The one function every tool call resolves its project dir through, with
 * the reasoning beside the answer. No workspace, or a workspace with no focus
 * set, both resolve to `launchDir` itself — the compatibility path that keeps
 * single-project behavior byte-identical.
 *
 * A launch dir that is itself a configured member (or sits inside one) is
 * that member's session and resolves to itself whatever the focus says
 * (#487): the focus file is one file under the workspace root, shared by
 * every session beneath it, and honoring it here let one session's
 * `basecamp focus` silently repoint a sibling session's writes into its own
 * planning folder and tracker. The focus applies only to a session launched
 * at the workspace root or in a folder no member owns — the sessions that
 * have no project of their own. A focus naming a member that has since
 * vanished or lost its cairn.json is a stale-focus error for THOSE sessions,
 * never a silent fallback to launchDir; a member launch is not the stale
 * focus's business and is never blocked by it.
 */
export function resolveProject(launchDir: string): ResolvedProject {
  const self = { launchDir, resolvedProject: launchDir, focusApplied: false };
  const info = findWorkspace(launchDir);
  if (!info || info.focus === null) return self;
  if (insideConfiguredMember(info, resolve(launchDir))) return self;
  const member = info.members.find((m) => m.name === info.focus);
  if (!member || !member.configured) {
    throw new CairnError("CONFIG_INVALID",
      `focus names '${info.focus}' but it is ${member ? "no longer configured (missing cairn.json)"
        : "no longer a member"} of workspace '${info.workspace}'`,
      `clear focus (workspace_focus with project: null) or restore '${info.focus}' as a configured member`);
  }
  return { launchDir, resolvedProject: member.absPath, focusApplied: true };
}

/** The project dir alone — what every tool call keys its stores and tracker on. */
export function resolveProjectDir(launchDir: string): string {
  return resolveProject(launchDir).resolvedProject;
}
