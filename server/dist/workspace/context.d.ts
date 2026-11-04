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
/**
 * Walks up from `launchDir` looking for `cairn-workspace.json`, stopping at the
 * filesystem root (no `.git` requirement — see spec). Returns null when none is
 * found. A workspace file that exists but is malformed (bad JSON or missing the
 * expected shape) is NEVER treated as "no workspace" — that would silently fall
 * back to single-project behavior on a typo'd file, which is the trap this spec
 * calls out explicitly. It throws CONFIG_INVALID naming the file instead.
 */
export declare function findWorkspace(launchDir: string): WorkspaceInfo | null;
/**
 * Sets (or clears, with `project: null`) the workspace focus. Validates the
 * target is a real, configured member before writing — an unconfigured or
 * unknown member is rejected with CONFIG_INVALID naming the member and the fix,
 * never silently accepted. Write is atomic (tmp + rename).
 */
export declare function setFocus(launchDir: string, project: string | null): {
    focus: string | null;
    projectDir: string;
    focusApplied: boolean;
};
/** What a tool call's project dir resolved to, and why — the #487 fields. */
export interface ResolvedProject {
    launchDir: string;
    resolvedProject: string;
    focusApplied: boolean;
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
export declare function resolveProject(launchDir: string): ResolvedProject;
/** The project dir alone — what every tool call keys its stores and tracker on. */
export declare function resolveProjectDir(launchDir: string): string;
