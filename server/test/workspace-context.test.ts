import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CairnError } from "../src/errors.js";
import { buildServer } from "../src/index.js";
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

// #499 -- #487 keyed on `configured`, which left the redirect standing for the
// member that cannot yet defend itself: a fresh clone or a project mid-setup,
// where the owner is most likely to be running `cairn new`. A member listed by
// name is the owner's ground whether or not cairn.json exists yet; the tools
// report the missing config there rather than write into the focused project.
describe("resolveProjectDir: a listed member with no cairn.json is its own session (#499)", () => {
  /** Members a and b are configured, c is listed with its folder but no cairn.json; focus on a. */
  function focusedOnA(): string {
    const root = fresh();
    writeWorkspace(root, "acme", [
      { name: "a", path: "a" }, { name: "b", path: "b" }, { name: "c", path: "c" },
    ]);
    configureMember(root, "a");
    configureMember(root, "b");
    mkdirSync(join(root, "c"));
    setFocus(root, "a");
    return root;
  }

  it("launched in unconfigured member c, focus on a: c resolves to c and says the focus did not move it", () => {
    const root = focusedOnA();
    expect(findWorkspace(root)?.members.find((m) => m.name === "c")?.configured).toBe(false);
    expect(resolveProject(join(root, "c"))).toEqual({
      launchDir: join(root, "c"), resolvedProject: join(root, "c"), focusApplied: false,
    });
  });

  it("twin: a root-launched session and a folder no member owns still follow the focus", () => {
    const root = focusedOnA();
    expect(resolveProject(root)).toEqual({
      launchDir: root, resolvedProject: join(root, "a"), focusApplied: true,
    });
    mkdirSync(join(root, "scratch"));
    expect(resolveProjectDir(join(root, "scratch"))).toBe(join(root, "a"));
  });

  it("nested cwd: launched deep inside c, still c's tree, never a", () => {
    const root = focusedOnA();
    const nested = join(root, "c", "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectDir(nested)).toBe(nested);
  });

  it("a stale focus never blocks the session in c", () => {
    const root = focusedOnA();
    rmSync(join(root, "a", "cairn.json"));
    expect(resolveProjectDir(join(root, "c"))).toBe(join(root, "c"));
    expect(() => resolveProjectDir(root)).toThrow(CairnError);
  });

  it("setFocus from c writes the focus for the workspace but reports it did not move this session", () => {
    const root = focusedOnA();
    expect(setFocus(join(root, "c"), "b")).toEqual({ focus: "b", projectDir: join(root, "c"), focusApplied: false });
    expect(resolveProjectDir(root)).toBe(join(root, "b"));
  });

  it("a member's cairn.json arriving mid-session changes nothing: c was c before and is c after", () => {
    const root = focusedOnA();
    expect(resolveProjectDir(join(root, "c"))).toBe(join(root, "c"));
    configureMember(root, "c");
    expect(resolveProjectDir(join(root, "c"))).toBe(join(root, "c"));
  });

  it("the tools report the missing config in c, and the focused project gets nothing", async () => {
    const root = focusedOnA();
    const local = JSON.stringify({ tracker: { type: "local", config: {} } });
    writeFileSync(join(root, "a", "cairn.json"), local);
    const before = readdirSync(join(root, "a")).sort();
    const server = buildServer({ projectDir: join(root, "c") });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-499", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "issue_create", arguments: { title: "meant for c" } });
    const json = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
    expect(res.isError).toBe(true);
    expect(json.code).toBe("CONFIG_MISSING");
    expect(readdirSync(join(root, "a")).sort()).toEqual(before);
  });

  it("hostile: a member listed as the workspace root, or above it, with no cairn.json does not take the root's focus away", () => {
    for (const path of [".", ".."]) {
      const root = fresh();
      writeWorkspace(root, "acme", [{ name: "a", path: "a" }, { name: "top", path }]);
      configureMember(root, "a");
      setFocus(root, "a");
      expect(resolveProjectDir(root)).toBe(join(root, "a"));
      mkdirSync(join(root, "scratch"));
      expect(resolveProjectDir(join(root, "scratch"))).toBe(join(root, "a"));
    }
  });

  it("hostile: a lookalike sibling and a `..` climb out of c are not c", () => {
    const root = focusedOnA();
    mkdirSync(join(root, "c-other"));
    expect(resolveProjectDir(join(root, "c-other"))).toBe(join(root, "a"));
    expect(resolveProjectDir(`${join(root, "c")}/../c-other`)).toBe(join(root, "a"));
  });

  it("hostile: a folder inside c whose name merely starts with two dots is still inside c", () => {
    const root = focusedOnA();
    const dotted = join(root, "c", "..cache");
    mkdirSync(dotted);
    expect(resolveProjectDir(dotted)).toBe(dotted);
  });

  it("hostile: a member path spelled with a trailing slash or a dot segment is still that member", () => {
    const root = fresh();
    writeWorkspace(root, "acme", [
      { name: "a", path: "a" }, { name: "c", path: "./c/" }, { name: "d", path: "x/../d" },
    ]);
    configureMember(root, "a");
    mkdirSync(join(root, "c"));
    mkdirSync(join(root, "d"));
    setFocus(root, "a");
    expect(resolveProjectDir(join(root, "c"))).toBe(join(root, "c"));
    expect(resolveProjectDir(join(root, "d"))).toBe(join(root, "d"));
  });

  it("sibling: a launch through a symlink into a member keeps its own spelling and is never redirected; a link to a folder no member owns still follows", () => {
    const root = focusedOnA();
    symlinkSync(join(root, "c"), join(root, "link-c"));
    symlinkSync(join(root, "b"), join(root, "link-b"));
    expect(resolveProject(join(root, "link-c"))).toEqual({
      launchDir: join(root, "link-c"), resolvedProject: join(root, "link-c"), focusApplied: false,
    });
    expect(resolveProjectDir(join(root, "link-b"))).toBe(join(root, "link-b"));
    mkdirSync(join(root, "scratch"));
    symlinkSync(join(root, "scratch"), join(root, "link-scratch"));
    expect(resolveProjectDir(join(root, "link-scratch"))).toBe(join(root, "a"));
  });

  it("sibling: an unlisted project holding its own cairn.json, and any folder inside it, is its own session too", () => {
    const root = focusedOnA();
    configureMember(root, "unlisted");
    expect(resolveProject(join(root, "unlisted"))).toEqual({
      launchDir: join(root, "unlisted"), resolvedProject: join(root, "unlisted"), focusApplied: false,
    });
    const nested = join(root, "unlisted", "src");
    mkdirSync(nested);
    expect(resolveProjectDir(nested)).toBe(nested);
  });

  it("twin: a cairn.json at the workspace root does not make the root its own session; the focus still moves it", () => {
    const root = focusedOnA();
    writeFileSync(join(root, "cairn.json"), JSON.stringify({ tracker: { type: "github", config: {} } }));
    expect(resolveProjectDir(root)).toBe(join(root, "a"));
    mkdirSync(join(root, "scratch"));
    expect(resolveProjectDir(join(root, "scratch"))).toBe(join(root, "a"));
  });
});
