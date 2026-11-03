/**
 * Purpose: the setup a fresh worktree needs, derived from the repository
 *   instead of typed (#352). A wave worker lands in a worktree that holds
 *   tracked files only -- no node_modules, no .env, no port -- and the
 *   wave brief used to carry whatever installer the coordinator
 *   remembered: a remembered `npm ci` fails in a pnpm workspace, a
 *   remembered `npm install` writes a stray lockfile. The right installer
 *   is a function of files that exist in the repo, so this answers it:
 *     - the lockfile in each package picks the installer (pnpm-lock.yaml,
 *       bun.lock, package-lock.json, yarn.lock, go.sum, Cargo.lock,
 *       uv.lock, poetry.lock, requirements.txt, pyproject.toml,
 *       Gemfile.lock); a manifest with no lock gets nothing, never a
 *       guessed `npm install`;
 *     - `.worktreeinclude` names the ignored files to COPY (never symlink)
 *       into the worktree before installing;
 *     - `.worktree-port` (the file, or its .gitignore entry -- the file
 *       itself never reaches a fresh worktree) says the port convention
 *       exists and must be read before anything listens.
 *   Inside a repository the tracked files decide (`git ls-files`), so a
 *   lockfile a stray install left behind is not setup; outside one a
 *   bounded walk stands in. `lines` is the rendered brief text the work
 *   verb pastes into {{rules}} verbatim -- empty when nothing was found,
 *   so a repo with none of these gets no setup line rather than an
 *   invented one (asserted by worktree-setup.test.ts).
 *
 * removeWhen: never -- the derivation replaces a memory, not a model
 *   limit; a stronger agent still cannot see a lockfile it was not shown.
 * Author(s): John Reed
 */
export interface SetupInstall {
    /** Package folder relative to the repo root, posix, `.` for the root. */
    dir: string;
    /** The lockfile that picked the command. */
    lockfile: string;
    /** The frozen installer to run in `dir`. */
    command: string;
}
export interface WorktreeSetup {
    /** Root first, then packages by path. Empty: nothing to install. */
    installs: SetupInstall[];
    /** `.worktreeinclude` entries, comments and blanks dropped. Empty: no file. */
    include: string[];
    /** Whether the `.worktree-port` convention exists in this repo. */
    port: boolean;
    /** The brief lines, in order; empty when there is nothing to say. */
    lines: string[];
}
/**
 * Derives the fresh-worktree setup for a project.
 *
 * :param projectDir: the repo root (any checkout or worktree of it)
 * :returns the installs, include paths, port convention, and brief lines
 */
export declare function worktreeSetup(projectDir: string): WorktreeSetup;
