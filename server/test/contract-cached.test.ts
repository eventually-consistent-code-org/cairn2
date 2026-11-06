import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { trackerContract } from "./contract.js";
import { CachedTracker } from "../src/tracker/cached.js";
import { FakeTracker } from "../src/tracker/fake.js";
import type { Tracker } from "../src/tracker/types.js";

trackerContract("cached(fake)", async () => new CachedTracker(new FakeTracker()));

// #495: production wraps every tracker in CachedTracker, so a method the wrapper
// does not forward is unreachable on a real server, however green the test that
// injects an adapter past it. Types are erased at runtime, so this reads the SPI
// out of types.ts with the compiler's parser and walks every method it declares.
const TRACKER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tracker");
const parse = (path: string) =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

interface SpiMethod { name: string; optional: boolean; returnsVoid: boolean }

/** Every method the Tracker interface declares. */
function spiMethods(): SpiMethod[] {
  const out: SpiMethod[] = [];
  parse(join(TRACKER_SRC, "types.ts")).forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== "Tracker") return;
    for (const m of node.members) {
      if (!ts.isMethodSignature(m)) continue;
      out.push({
        name: m.name.getText(),
        optional: m.questionToken !== undefined,
        returnsVoid: m.type?.getText() === "Promise<void>",
      });
    }
  });
  return out;
}

/** The public methods an adapter class declares (private, protected and static dropped). */
function publicMethods(path: string): string[] {
  const out: string[] = [];
  parse(path).forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    for (const m of node.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      const hidden = ts.getModifiers(m)?.some((x) =>
        x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword
        || x.kind === ts.SyntaxKind.StaticKeyword);
      if (!hidden) out.push(m.name.getText());
    }
  });
  return out;
}

describe("CachedTracker carries the whole SPI (#495)", () => {
  const spi = spiMethods();
  const optional = spi.filter((m) => m.optional).map((m) => m.name);
  const capabilities = new FakeTracker().capabilities;

  /** An inner tracker whose chosen methods each answer with their own name. */
  const stubbed = (methods: SpiMethod[]) => {
    const fns = Object.fromEntries(methods.map((m) =>
      [m.name, vi.fn(() => (m.returnsVoid ? undefined : { answeredBy: m.name }))]));
    return { fns, inner: { capabilities, ...fns } as unknown as Tracker };
  };

  it("the parser found the interface: an empty method list would pass everything below", () => {
    expect(spi.map((m) => m.name)).toContain("getIssue");
    expect(optional).toContain("branchProtection");
    expect(optional).toContain("stateCategory");
    expect(optional.length).toBeGreaterThanOrEqual(11);
  });

  it("every SPI method on the inner tracker reaches it through the wrapper, and its answer comes back", async () => {
    const { fns, inner } = stubbed(spi);
    const cached = new CachedTracker(inner) as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    expect(spi.map((m) => m.name).filter((n) => typeof cached[n] !== "function")).toEqual([]);
    for (const m of spi) {
      const answer = await cached[m.name]!("x", "y", "z");
      expect(answer).toEqual(m.returnsVoid ? undefined : { answeredBy: m.name });
      expect(fns[m.name]).toHaveBeenCalledTimes(1);
    }
  });

  it("twin: an optional method the inner tracker lacks stays absent, so a caller's presence gate still reads false", () => {
    const cached = new CachedTracker(stubbed(spi.filter((m) => !m.optional)).inner) as unknown as Record<string, unknown>;
    expect(optional.filter((n) => cached[n] !== undefined)).toEqual([]);
  });

  it("every public method on every adapter is in the SPI, so none can land where the wrapper cannot see it", () => {
    const adapters = join(TRACKER_SRC, "adapters");
    const files = readdirSync(adapters).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    const known = new Set(spi.map((m) => m.name));
    const strays: string[] = [];
    let seen = 0;
    for (const file of files) {
      const methods = publicMethods(join(adapters, file));
      seen += methods.length;
      for (const m of methods) if (!known.has(m)) strays.push(`${file}: ${m}`);
    }
    expect(seen).toBeGreaterThan(0);
    expect(strays).toEqual([]);
  });
});
