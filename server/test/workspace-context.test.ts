import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CairnError } from "../src/errors.js";
import { findWorkspace, resolveProject, resolveProjectDir, setFocus } from "../src/workspace/context.js";

const fresh = () => mkdtempSync(join(tmpdir(), "cairn-workspace-"));

function writeWorkspace(root: string, workspace: string, members: Array<{ name: string; path: string }>): void {
  writeFileSync(join(root, "cairn-workspace.json"), JSON.stringify({ workspace, members }, null, 2));
}

function configureMember(root: string, relPath: string): void {
  const dir = join(root, relPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: {} } }));
}

describe("findWorkspace", () => {
  it("finds a workspace at the launch dir itself", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const info = findWorkspace(root);
    expect(info?.workspace).toBe("acme");
    expect(info?.root).toBe(root);
    expect(info?.members).toEqual([{ name: "api", path: "api", absPath: join(root, "api"), configured: true }]);
    expect(info?.focus).toBeNull();
  });

  it("walks up two levels to find the workspace root", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const nested = join(root, "api", "src", "deep");
    mkdirSync(nested, { recursive: true });
    const info = findWorkspace(nested);
    expect(info?.root).toBe(root);
    expect(info?.workspace).toBe("acme");
  });

  it("returns null when no workspace file exists up to the filesystem root", () => {
    const dir = fresh();
    expect(findWorkspace(dir)).toBeNull();
  });

  it("lists a member without cairn.json as unconfigured", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "web", path: "web" }]);
    mkdirSync(join(root, "web"), { recursive: true });
    const info = findWorkspace(root)!;
    expect(info.members[0]).toEqual({ name: "web", path: "web", absPath: join(root, "web"), configured: false });
  });

  it("throws CONFIG_INVALID for malformed workspace JSON rather than falling back to no-workspace", () => {
    const root = fresh();
    writeFileSync(join(root, "cairn-workspace.json"), "{ not valid json");
    expect(() => findWorkspace(root)).toThrow(CairnError);
    try {
      findWorkspace(root);
      throw new Error("expected findWorkspace to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("cairn-workspace.json");
    }
  });

  it("throws CONFIG_INVALID when workspace JSON is missing required fields", () => {
    const root = fresh();
    writeFileSync(join(root, "cairn-workspace.json"), JSON.stringify({ foo: "bar" }));
    expect(() => findWorkspace(root)).toThrow(CairnError);
    try {
      findWorkspace(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });
});

describe("setFocus + resolveProjectDir", () => {
  it("round-trips: setFocus writes focus, resolveProjectDir follows it", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const result = setFocus(root, "api");
    expect(result).toEqual({ focus: "api", projectDir: join(root, "api"), focusApplied: true });
    expect(resolveProjectDir(root)).toBe(join(root, "api"));
  });

  it("rejects focusing an unconfigured member, naming it and the fix", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "web", path: "web" }]);
    mkdirSync(join(root, "web"), { recursive: true });
    try {
      setFocus(root, "web");
      throw new Error("expected setFocus to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("web");
      expect((e as CairnError).nextAction ?? "").toContain("cairn.json");
    }
  });

  it("rejects focusing a name that is not a member", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    try {
      setFocus(root, "ghost");
      throw new Error("expected setFocus to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CairnError);
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
      expect((e as CairnError).message).toContain("not a member");
      expect((e as CairnError).message).toContain("acme");
    }
  });

  it("clears focus with null; resolution falls back to the launch dir", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    const cleared = setFocus(root, null);
    expect(cleared).toEqual({ focus: null, projectDir: root, focusApplied: false });
    expect(resolveProjectDir(root)).toBe(root);
  });

  it("resolves to the launch dir when there is no workspace at all (compat path)", () => {
    const dir = fresh();
    expect(resolveProjectDir(dir)).toBe(dir);
  });

  it("resolves to the launch dir when a workspace exists but no focus is set", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    expect(resolveProjectDir(root)).toBe(root);
  });

  it("resolves to the exact launch dir (not the workspace root) when unfocused, even nested inside a member", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    const nested = join(root, "api", "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectDir(nested)).toBe(nested);
  });

  it("throws CONFIG_INVALID when the focused member is removed from the workspace file (stale focus)", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    writeWorkspace(root, "acme", []);
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
    try {
      resolveProjectDir(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("throws CONFIG_INVALID when the focused member becomes unconfigured (cairn.json removed)", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    rmSync(join(root, "api", "cairn.json"));
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
    try {
      resolveProjectDir(root);
    } catch (e) {
      expect((e as CairnError).code).toBe("CONFIG_INVALID");
    }
  });

  it("writes the focus file atomically under .cairn/basecamp/focus.json at the workspace root", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "api", path: "api" }]);
    configureMember(root, "api");
    setFocus(root, "api");
    const info = findWorkspace(root);
    expect(info?.focus).toBe("api");
  });
});

// #487 -- a session launched inside a member project is never redirected by
// the workspace focus. The focus file is one file under the workspace root,
// shared by every session beneath it; before this block a sibling session's
// `basecamp focus` silently repointed every other session's writes.
describe("resolveProjectDir: a member launch is never redirected (#487)", () => {
  function twoMembers(): string {
    const root = fresh();
    writeWorkspace(root, "acme", [{ name: "a", path: "a" }, { name: "b", path: "b" }]);
    configureMember(root, "a");
    configureMember(root, "b");
    return root;
  }

  it("launched in member b, focus set to a from another handle: b still resolves to b", () => {
    const root = twoMembers();
    // the "other handle" is a second session that set the focus from the root
    setFocus(root, "a");
    expect(resolveProjectDir(join(root, "b"))).toBe(join(root, "b"));
  });

  it("launched at the workspace root, the focus wins", () => {
    const root = twoMembers();
    setFocus(root, "a");
    expect(resolveProjectDir(root)).toBe(join(root, "a"));
  });

  it("nested cwd: launched deep inside member b, still b's tree, never a", () => {
    const root = twoMembers();
    setFocus(root, "a");
    const nested = join(root, "b", "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectDir(nested)).toBe(nested);
  });

  it("launched in a non-member folder under the root, the focus applies", () => {
    const root = twoMembers();
    setFocus(root, "a");
    const scratch = join(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    expect(resolveProjectDir(scratch)).toBe(join(root, "a"));
  });

  it("hostile twin: a sibling whose name merely starts with a member's path is not that member", () => {
    const root = twoMembers();
    setFocus(root, "a");
    // `b-other` shares the prefix `b` -- a startsWith check would call it member b
    const lookalike = join(root, "b-other");
    mkdirSync(lookalike, { recursive: true });
    expect(resolveProjectDir(lookalike)).toBe(join(root, "a"));
  });

  it("hostile twin: a `..` climb spelled to look like a member launch is resolved first", () => {
    const root = twoMembers();
    setFocus(root, "a");
    const scratch = join(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    // spelled as if inside b, but the path walks straight back out of it
    expect(resolveProjectDir(`${join(root, "b")}/../scratch`)).toBe(join(root, "a"));
  });

  it("a stale focus never blocks a member launch -- the focus is not its business", () => {
    const root = twoMembers();
    setFocus(root, "a");
    rmSync(join(root, "a", "cairn.json"));
    expect(resolveProjectDir(join(root, "b"))).toBe(join(root, "b"));
    // launched at the root the stale focus still refuses, as before
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
  });

  it("resolveProject says whether the focus moved the session: launchDir, resolvedProject, focusApplied", () => {
    const root = twoMembers();
    setFocus(root, "a");
    expect(resolveProject(join(root, "b"))).toEqual({
      launchDir: join(root, "b"), resolvedProject: join(root, "b"), focusApplied: false,
    });
    expect(resolveProject(root)).toEqual({
      launchDir: root, resolvedProject: join(root, "a"), focusApplied: true,
    });
    // no focus at all: the same three fields, nothing applied
    setFocus(root, null);
    expect(resolveProject(root)).toEqual({ launchDir: root, resolvedProject: root, focusApplied: false });
  });

  it("setFocus from a member launch writes the focus but reports it did not move this session", () => {
    const root = twoMembers();
    const result = setFocus(join(root, "b"), "a");
    expect(result).toEqual({ focus: "a", projectDir: join(root, "b"), focusApplied: false });
    // the file was written for the workspace -- a root launch sees it
    expect(findWorkspace(root)?.focus).toBe("a");
    expect(resolveProjectDir(root)).toBe(join(root, "a"));
  });
});
