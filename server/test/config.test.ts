import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeConfigPatch } from "../src/config.js";
import { CairnError } from "../src/errors.js";
import { labOfModel, peerLab } from "../src/peers/run.js";

const dir = () => mkdtempSync(join(tmpdir(), "cairn-"));

// Makes a temp project dir with a cairn.json seeded from obj — mirrors the
// dir() + writeFileSync idiom above, just bundled for the writeConfigPatch tests.
function writeTmpConfig(obj: Record<string, unknown>): string {
  const d = dir();
  writeFileSync(join(d, "cairn.json"), JSON.stringify(obj));
  return d;
}

describe("loadConfig", () => {
  it("loads a valid github config with default agents.model=auto", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const cfg = loadConfig(d);
    expect(cfg.tracker.type).toBe("github");
    expect(cfg.agents.model).toBe("auto");
  });

  it("throws CONFIG_MISSING when cairn.json absent", () => {
    expect(() => loadConfig(dir())).toThrowError(
      expect.objectContaining({ code: "CONFIG_MISSING" }));
  });

  it("throws CONFIG_INVALID on bad tracker type", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "trello", config: {} } }));
    expect(() => loadConfig(d)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("memory.tokenThreshold defaults to 150000 when omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    expect(loadConfig(d).memory.tokenThreshold).toBe(150000);
  });

  it("memory.tokenThreshold respects an explicit override", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      memory: { tokenThreshold: 50000 },
    }));
    expect(loadConfig(d).memory.tokenThreshold).toBe(50000);
  });

  it("seats.dispatch defaults to auto inside a seats block; off is kept when stated (#345)", () => {
    const base = { tracker: { type: "github", config: { repo: "o/r" } } };
    expect(loadConfig(writeTmpConfig({ ...base, seats: {} })).seats?.dispatch).toBe("auto");
    expect(loadConfig(writeTmpConfig({ ...base, seats: { enabled: ["correctness"] } }))
      .seats?.dispatch).toBe("auto");
    expect(loadConfig(writeTmpConfig({ ...base, seats: { dispatch: "off" } }))
      .seats?.dispatch).toBe("off");
    // no seats block: the config stays silent and the roster resolves auto
    expect(loadConfig(writeTmpConfig(base)).seats).toBeUndefined();
  });

  it("user is optional and absent by default", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    expect(loadConfig(d).user).toBeUndefined();
  });

  it("user.handle round-trips when provided", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      user: { handle: "jsreed" },
    }));
    expect(loadConfig(d).user).toEqual({ handle: "jsreed" });
  });

  it("accepts user.mode engineer and vibe, rejects others", () => {
    const d = dir();
    const base = { tracker: { type: "github", config: { repo: "o/r" } }, user: { handle: "jr", mode: "engineer" } };
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(loadConfig(d).user?.mode).toBe("engineer");
    base.user.mode = "vibe";
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(loadConfig(d).user?.mode).toBe("vibe");
    base.user.mode = "yolo" as never;
    writeFileSync(join(d, "cairn.json"), JSON.stringify(base));
    expect(() => loadConfig(d)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("user.mode is optional", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      user: { handle: "jr" },
    }));
    expect(loadConfig(d).user?.mode).toBeUndefined();
  });

  it("continuity defaults apply when omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"),
      JSON.stringify({ tracker: { type: "github", config: { repo: "o/r" } } }));
    const cfg = loadConfig(d);
    expect(cfg.continuity).toEqual({
      resume: "prompt",
      checkpoint: true,
      wipCommits: false,
      recallIndex: { enabled: true, maxCards: 20 },
    });
  });

  it("continuity respects explicit overrides", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: {
        resume: "auto",
        checkpoint: false,
        wipCommits: true,
        recallIndex: { enabled: false, maxCards: 5 },
      },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity).toEqual({
      resume: "auto",
      checkpoint: false,
      wipCommits: true,
      recallIndex: { enabled: false, maxCards: 5 },
    });
  });

  it("continuity.recallIndex defaults apply when continuity block is present but recallIndex omitted", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "github", config: { repo: "o/r" } },
      continuity: { resume: "off" },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity.resume).toBe("off");
    expect(cfg.continuity.checkpoint).toBe(true);
    expect(cfg.continuity.recallIndex).toEqual({ enabled: true, maxCards: 20 });
  });

  it("an existing fixture config without a continuity block still parses (backward compatible)", () => {
    const d = dir();
    writeFileSync(join(d, "cairn.json"), JSON.stringify({
      tracker: { type: "jira", config: { baseUrl: "https://x.atlassian.net", projectKey: "PROJ" } },
      agents: { model: "sonnet" },
      memory: { tokenThreshold: 90000 },
      user: { handle: "jsreed" },
    }));
    const cfg = loadConfig(d);
    expect(cfg.continuity.resume).toBe("prompt");
    expect(cfg.agents.model).toBe("sonnet");
  });
});

describe("writeConfigPatch", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("merges nested keys and returns the validated result", () => {
    const dir = writeTmpConfig(base);
    const out = writeConfigPatch(dir, { continuity: { resume: "auto" } });
    expect(out.continuity.resume).toBe("auto");
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.continuity.resume).toBe("auto");
    expect(raw.tracker.config.repo).toBe("o/r"); // untouched siblings survive
  });

  it("null deletes a key", () => {
    const dir = writeTmpConfig({ ...base, user: { handle: "john" } });
    writeConfigPatch(dir, { user: null });
    const raw = JSON.parse(readFileSync(join(dir, "cairn.json"), "utf8"));
    expect(raw.user).toBeUndefined();
  });

  it("invalid merged config leaves the file untouched", () => {
    const dir = writeTmpConfig(base);
    const before = readFileSync(join(dir, "cairn.json"), "utf8");
    expect(() => writeConfigPatch(dir, { continuity: { resume: "sometimes" } }))
      .toThrowError(/CONFIG|resume/i);
    expect(readFileSync(join(dir, "cairn.json"), "utf8")).toBe(before);
  });

  it("refuses secret-looking keys and values", () => {
    const dir = writeTmpConfig(base);
    expect(() => writeConfigPatch(dir, { tracker: { config: { token: "x" } } }))
      .toThrowError(/secrets do not belong/);
    expect(() => writeConfigPatch(dir, { user: { handle: "ATATT3xFfGF0abc" } }))
      .toThrowError(/secrets do not belong/);
  });

  it("leakGuard defaults land via loadConfig", () => {
    const dir = writeTmpConfig(base);
    const cfg = loadConfig(dir);
    expect(cfg.leakGuard).toEqual({ enabled: true, allow: [], extraPatterns: [] });
  });
});

describe("ship config", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  // ship.confirm gates the push behind an explicit user ack (#76) — adopted
  // at the 2026-08-12 product council (REC-5), accepted by the project owner
  // over cairn's own no-action recommendation. Default is confirm on.
  it("ship absent → confirm defaults to true", () => {
    const dir = writeTmpConfig(base);
    const cfg = loadConfig(dir);
    expect(cfg.ship).toEqual({ confirm: true });
  });

  it("ship.confirm false is honored (restores the silent flow)", () => {
    const dir = writeTmpConfig({ ...base, ship: { confirm: false } });
    expect(loadConfig(dir).ship.confirm).toBe(false);
  });

  it("ship.confirm accepts only booleans — wrong type is CONFIG_INVALID", () => {
    const dir = writeTmpConfig({ ...base, ship: { confirm: "yes" } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("audit.debt.markers (#355)", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };
  const DEFAULTS = ["shortcut", "TODO", "FIXME", "HACK", "XXX"];

  // The words `audit debt` greps for. Ponytail's legacy word is deliberately
  // not in the default list — cairn's marker vocabulary is its own.
  it("audit absent → the default marker list is present", () => {
    const cfg = loadConfig(writeTmpConfig(base));
    expect(cfg.audit.debt.markers).toEqual(DEFAULTS);
  });

  it("an override REPLACES the default list — no merge", () => {
    const dir = writeTmpConfig({ ...base, audit: { debt: { markers: ["shortcut", "ponytail"] } } });
    expect(loadConfig(dir).audit.debt.markers).toEqual(["shortcut", "ponytail"]);
  });

  it("an empty list is refused with a one-line reason", () => {
    const dir = writeTmpConfig({ ...base, audit: { debt: { markers: [] } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => loadConfig(dir)).toThrow(/audit\.debt\.markers.*at least one marker word/);
  });

  it("a non-string entry is refused", () => {
    const dir = writeTmpConfig({ ...base, audit: { debt: { markers: ["TODO", 42] } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("an empty-string entry is refused", () => {
    const dir = writeTmpConfig({ ...base, audit: { debt: { markers: ["TODO", ""] } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});

describe("peers config", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("peers is absent by default", () => {
    const dir = writeTmpConfig(base);
    expect(loadConfig(dir).peers).toBeUndefined();
  });

  it("accepts known provider keys with partial fields and applies defaults on read", () => {
    const dir = writeTmpConfig({
      ...base,
      peers: { codex: { enabled: false }, antigravity: { maxInputChars: 900000 } },
    });
    const cfg = loadConfig(dir);
    expect(cfg.peers).toEqual({
      codex: { enabled: false },
      antigravity: { maxInputChars: 900000 },
    });
  });

  // execCapable is a config-declared trust decision (#67) — the user marks
  // which peer CLI may execute the product during review; never runtime-probed.
  it("accepts execCapable true/false on a known provider", () => {
    const dir = writeTmpConfig({
      ...base,
      peers: { codex: { execCapable: true }, grok: { execCapable: false } },
    });
    const cfg = loadConfig(dir);
    expect(cfg.peers).toEqual({
      codex: { execCapable: true },
      grok: { execCapable: false },
    });
  });

  it("loads fine with execCapable absent — existing peer blocks are untouched", () => {
    const dir = writeTmpConfig({ ...base, peers: { opencode: { enabled: true } } });
    const cfg = loadConfig(dir);
    expect(cfg.peers).toEqual({ opencode: { enabled: true } });
    expect(cfg.peers?.opencode).not.toHaveProperty("execCapable");
  });

  it("rejects an unknown provider key", () => {
    const dir = writeTmpConfig({ ...base, peers: { totallyBogus: { enabled: true } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  // gemini left the roster when antigravity replaced it — a leftover
  // peers.gemini block must fail loud (CONFIG_INVALID) so the user removes
  // it, never silently load.
  it("rejects the retired gemini provider key", () => {
    const dir = writeTmpConfig({ ...base, peers: { gemini: { enabled: true } } });
    expect(() => loadConfig(dir)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("config_set-style patching via writeConfigPatch validates the peers block", () => {
    const dir = writeTmpConfig(base);
    const out = writeConfigPatch(dir, { peers: { grok: { enabled: true, maxInputChars: 5000 } } });
    expect(out.peers).toEqual({ grok: { enabled: true, maxInputChars: 5000 } });
    expect(() => writeConfigPatch(dir, { peers: { notAProvider: {} } }))
      .toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});


describe("peers model pin (#338)", () => {
  const base = { tracker: { type: "github", config: { repo: "o/r" } } };

  it("accepts copilot as a provider key and a model pin", () => {
    const dir = writeTmpConfig({ ...base, peers: { copilot: { model: "gpt-5.4", enabled: true } } });
    expect(loadConfig(dir).peers).toEqual({ copilot: { model: "gpt-5.4", enabled: true } });
  });

  it("refuses a claude-* model pin on any seat with a one-line reason naming the family rule", () => {
    const dir = writeTmpConfig({ ...base, peers: { copilot: { model: "claude-sonnet-5.5" } } });
    expect(() => loadConfig(dir)).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(() => loadConfig(dir)).toThrow(/copilot\.model: 'claude-sonnet-5.5' is a Claude model/);
  });

  it("'auto' is accepted as a pin (#395) and reads as an unknown lab, never a voice in the count", () => {
    const dir = writeTmpConfig({ ...base, peers: { copilot: { model: "auto" } } });
    const cfg = loadConfig(dir);
    expect(cfg.peers?.copilot?.model).toBe("auto");
    expect(labOfModel("auto")).toBe("unknown");
    expect(peerLab(cfg, "copilot")).toBe("unknown");
  });

  it("an empty model string is rejected; absent is fine", () => {
    expect(() => loadConfig(writeTmpConfig({ ...base, peers: { copilot: { model: "" } } })))
      .toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
    expect(loadConfig(writeTmpConfig({ ...base, peers: { copilot: {} } })).peers).toEqual({ copilot: {} });
  });
});
