import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { repositoryPath } from "../planning/run-manifest.js";
import { bindingsError, classifyBindingFailure, isBindingsFailure, loadSqlite, } from "./native.js";
/** ~/.cairn/index/<projectKey>.db -- one FTS index per repository (#362), so
 *  a linked worktree searches the memory the main checkout built. */
export function indexDbPath(projectDir) {
    return repositoryPath(projectDir, "index", ".db");
}
export class MemoryIndex {
    db;
    constructor(dbPath, load = loadSqlite) {
        // Lazy native load (#108): better-sqlite3 is required here, per
        // construction, instead of at module import -- a missing compiled
        // binding (fresh plugin cache + newer node ABI) surfaces as a typed
        // NATIVE_MODULE_BROKEN with the rebuild command, only on the index
        // tools that actually touch sqlite. Card tools never come through here.
        // The catch below translates bindings-looking failures even when the
        // loader itself didn't (defense in depth -- some ABI mismatches throw
        // at construction rather than require).
        let Sqlite;
        try {
            Sqlite = load();
            mkdirSync(join(dbPath, ".."), { recursive: true });
            this.db = new Sqlite(dbPath);
        }
        catch (e) {
            if (isBindingsFailure(e))
                throw bindingsError(classifyBindingFailure(e));
            throw e;
        }
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
      content, source UNINDEXED, phase UNINDEXED, issue_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
    )`);
        // Pre-scopeRole databases (#165): FTS5 has no ALTER ... ADD COLUMN, so an
        // existing table without `role` gets rebuilt in place -- rename, recreate
        // with the column, copy rows across with role NULL, drop the old table.
        const cols = this.db.prepare("PRAGMA table_info(chunks)")
            .all();
        if (!cols.some((c) => c.name === "role")) {
            this.db.exec(`
        ALTER TABLE chunks RENAME TO chunks_pre_role;
        CREATE VIRTUAL TABLE chunks USING fts5(
          content, source UNINDEXED, phase UNINDEXED, issue_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
        );
        INSERT INTO chunks (content, source, phase, issue_id, role, created_at)
          SELECT content, source, phase, issue_id, NULL, created_at FROM chunks_pre_role;
        DROP TABLE chunks_pre_role;
      `);
        }
    }
    index(chunk) {
        this.db.prepare("INSERT INTO chunks (content, source, phase, issue_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(chunk.content, chunk.source, chunk.phase, chunk.issueId, chunk.role ?? null, chunk.createdAt);
    }
    search(query, filter = {}, limit = 10) {
        // FTS5 has its own query grammar (apostrophes, leading hyphens, unbalanced
        // quotes/parens all mean something special). Wrap the raw agent-supplied
        // query as a quoted phrase so it's treated as literal text instead of
        // FTS5 syntax -- doubling internal quotes escapes them per FTS5 rules.
        const safeQuery = `"${query.replace(/"/g, '""')}"`;
        const conditions = ["chunks MATCH ?"];
        const params = [safeQuery];
        if (filter.phase !== undefined) {
            conditions.push("phase = ?");
            params.push(filter.phase);
        }
        if (filter.issueId !== undefined) {
            conditions.push("issue_id = ?");
            params.push(filter.issueId);
        }
        if (filter.role !== undefined) {
            conditions.push("role = ?");
            params.push(filter.role);
        }
        params.push(limit);
        return this.db.prepare(`SELECT content, source, phase, issue_id as issueId, role, created_at as createdAt
       FROM chunks WHERE ${conditions.join(" AND ")} ORDER BY rank LIMIT ?`).all(...params);
    }
    /** createdAt of the earliest-indexed chunk for `source`, or undefined if none exists. */
    sourceCreatedAt(source) {
        const row = this.db.prepare("SELECT created_at as createdAt FROM chunks WHERE source = ? ORDER BY created_at ASC LIMIT 1").get(source);
        return row?.createdAt;
    }
    /**
     * Chronologically adjacent index chunks around `anchorCreatedAt` -- up to
     * `before` chunks strictly earlier (closest first reversed to ascending)
     * and up to `after` chunks strictly later, concatenated ascending. Ties
     * on the exact anchor timestamp are excluded (that's the anchor itself,
     * or a same-millisecond collision -- neither belongs in its own neighbor
     * list).
     */
    timeline(anchorCreatedAt, before, after) {
        const beforeRows = before > 0 ? this.db.prepare(`SELECT content, source, phase, issue_id as issueId, role, created_at as createdAt
       FROM chunks WHERE created_at < ? ORDER BY created_at DESC, source DESC LIMIT ?`).all(anchorCreatedAt, before) : [];
        const afterRows = after > 0 ? this.db.prepare(`SELECT content, source, phase, issue_id as issueId, role, created_at as createdAt
       FROM chunks WHERE created_at > ? ORDER BY created_at ASC, source ASC LIMIT ?`).all(anchorCreatedAt, after) : [];
        return [...beforeRows.reverse(), ...afterRows];
    }
    stats() {
        const row = this.db.prepare("SELECT COUNT(*) as chunkCount, COALESCE(SUM(LENGTH(content)), 0) as approxBytes FROM chunks").get();
        return { ...row, approxTokens: Math.ceil(row.approxBytes / 4) };
    }
    close() {
        this.db.close();
    }
}
