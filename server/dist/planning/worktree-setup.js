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
// Imports
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
// Constants
/**
 * Lockfile → installer, in priority order WITHIN one folder: the first
 * match wins, so a pnpm workspace with a stray package-lock beside it still
 * installs with pnpm, and a uv lock beats the loose pyproject it locks.
 * Every command is the frozen form -- an install that would rewrite the
 * lockfile is the failure this exists to prevent.
 */
const INSTALLERS = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn --immutable"],
    ["go.sum", "go mod download"],
    ["Cargo.lock", "cargo fetch --locked"],
    ["uv.lock", "uv sync --frozen"],
    ["poetry.lock", "poetry install"],
    ["requirements.txt", "pip install -r requirements.txt"],
    ["pyproject.toml", "pip install -e ."],
    ["Gemfile.lock", "bundle install"],
];
const LOCKFILE_NAMES = new Set(INSTALLERS.map(([name]) => name));
/** Folders the walk never enters: dependencies, build output, dot folders. */
const WALK_SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage"]);
/** How deep the non-git walk looks for a package. Three is `apps/web/pkg`. */
const WALK_DEPTH = 3;
/** Git location variables that would make ls-files answer for another repo. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
// Derivation
/**
 * Derives the fresh-worktree setup for a project.
 *
 * :param projectDir: the repo root (any checkout or worktree of it)
 * :returns the installs, include paths, port convention, and brief lines
 */
export function worktreeSetup(projectDir) {
    const root = resolve(projectDir);
    const installs = findInstalls(root);
    const include = readWorktreeInclude(root);
    const port = hasPortConvention(root);
    return { installs, include, port, lines: renderLines(installs, include, port) };
}
/** One install per folder holding a lockfile, root first then by path. */
function findInstalls(root) {
    const files = trackedLockfiles(root) ?? walkedLockfiles(root);
    const byDir = new Map();
    for (const rel of files) {
        const dir = posix.dirname(rel);
        const name = posix.basename(rel);
        if (!byDir.has(dir))
            byDir.set(dir, new Set());
        byDir.get(dir).add(name);
    }
    const installs = [];
    for (const [dir, names] of byDir) {
        // priority order within the folder: the first listed lockfile present wins
        const hit = INSTALLERS.find(([lockfile]) => names.has(lockfile));
        if (hit)
            installs.push({ dir, lockfile: hit[0], command: hit[1] });
    }
    return installs.sort((a, b) => a.dir === "." ? -1 : b.dir === "." ? 1 : a.dir.localeCompare(b.dir));
}
/**
 * The tracked lockfiles, posix-relative to the root, or null when the
 * folder is not a repository (or git is missing) so the walk can stand in.
 * Tracked is the point: a fresh worktree holds exactly these, and a
 * lockfile a stray install wrote in the main checkout is not one of them.
 */
function trackedLockfiles(root) {
    // a checkout has a .git folder, a linked worktree a .git file; neither
    // means this is some other repository's subfolder, so no git call at all
    if (!existsSync(join(root, ".git")))
        return null;
    const env = { ...process.env };
    for (const k of GIT_LOCATION_ENV)
        delete env[k];
    let out;
    try {
        out = execFileSync("git", ["ls-files", "-z", "--", ...LOCKFILE_NAMES, ...[...LOCKFILE_NAMES].map((n) => `**/${n}`)], {
            cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
        });
    }
    catch {
        return null;
    }
    return out.split("\0").filter((rel) => rel && !rel.split("/").some((seg) => WALK_SKIP.has(seg) || seg.startsWith(".")));
}
/** A bounded walk for a folder that is not a repository. */
function walkedLockfiles(root) {
    const found = [];
    const visit = (dir, depth) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.isFile() && LOCKFILE_NAMES.has(e.name)) {
                found.push(posixRelative(root, join(dir, e.name)));
            }
            else if (e.isDirectory() && depth < WALK_DEPTH
                && !WALK_SKIP.has(e.name) && !e.name.startsWith(".")) {
                visit(join(dir, e.name), depth + 1);
            }
        }
    };
    visit(root, 0);
    return found;
}
/** `abs` relative to `root`, forward slashes whatever the platform. */
function posixRelative(root, abs) {
    return abs.slice(root.length + 1).split(sep).join("/");
}
/** The plain paths in `.worktreeinclude`; `#` comments and blanks dropped. */
function readWorktreeInclude(root) {
    const path = join(root, ".worktreeinclude");
    if (!existsSync(path))
        return [];
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
}
/**
 * The port convention: the file at the root, or a `.gitignore` line naming
 * it. The file is per worktree and ignored, so a fresh worktree never has
 * it -- the ignore entry is what a worker can see.
 */
function hasPortConvention(root) {
    if (existsSync(join(root, ".worktree-port")))
        return true;
    const ignore = join(root, ".gitignore");
    if (!existsSync(ignore))
        return false;
    return readFileSync(ignore, "utf8")
        .split(/\r?\n/)
        .some((l) => l.trim().replace(/^\//, "") === ".worktree-port");
}
// Rendering
/**
 * The brief lines, in the order a worker runs them: copies first (an
 * install may read the copied .env), then the installers, then the port.
 * Nothing found renders nothing -- the brief omits the line.
 */
function renderLines(installs, include, port) {
    const lines = [];
    if (include.length) {
        lines.push(`- Before installing, copy, never symlink, the \`.worktreeinclude\` entries from the main checkout `
            + `into the same place here, skipping any that already exist: ${include.map((p) => `\`${p}\``).join(", ")}. `
            + "A `post-checkout` hook (`git config core.hooksPath`) may have done this already; check before doing it twice.");
    }
    if (installs.length) {
        const parts = installs.map((i) => i.dir === "." ? `at the repo root \`${i.command}\`` : `in \`${i.dir}/\` \`${i.command}\``);
        lines.push(`- Setup, derived from the tracked lockfiles (never a bare install that would rewrite one): `
            + `${parts.join("; ")}.`);
    }
    if (port) {
        lines.push("- This repo keeps a `.worktree-port` file at the root: read it before starting anything that listens. "
            + "Absent in a linked worktree, allocate a block of ten (3100, 3110, ...) no other worktree's file claims "
            + "and nothing is listening on, write it there, and keep it out of git; the main checkout keeps 3000.");
    }
    return lines;
}
