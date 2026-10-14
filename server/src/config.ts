import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CairnError } from "./errors.js";
import { PROVIDERS } from "./peers/providers.js";

export const ConfigSchema = z.object({
  tracker: z.object({
    type: z.enum([
      "github",
      "gitlab",
      "jira",
      "asana",
      "azure-boards",
      "clickup",
      "linear",
      "local",
    ]),
    config: z.record(z.string(), z.unknown()),
  }),
  // Documentation connectors publish repo docs outward (Confluence first);
  // same two-level shape as tracker — deep validation lives in the adapter.
  docs: z
    .object({
      connector: z.enum(["confluence", "docusaurus"]),
      config: z.record(z.string(), z.unknown()),
    })
    .optional(),
  // Deliberate .default (not .prefault) on the next two blocks — the default
  // value is already complete, so zod 4's short-circuit returns exactly what
  // parse-through would (#95).
  agents: z
    .object({ model: z.enum(["auto", "inherit", "haiku", "sonnet", "opus"]) })
    .default({ model: "auto" }),
  // observationWarnThreshold (#173): unreviewed rows in the observation
  // buffer before the session banner says "run retro". The block's default
  // object stays complete — see the .default note above.
  memory: z
    .object({
      tokenThreshold: z.number().int().positive(),
      observationWarnThreshold: z.number().int().positive().default(25),
    })
    .default({ tokenThreshold: 150000, observationWarnThreshold: 25 }),
  user: z
    .object({
      handle: z.string().min(1),
      mode: z.enum(["vibe", "engineer"]).optional(),
    })
    .optional(),
  continuity: z
    .object({
      resume: z.enum(["prompt", "auto", "off"]).default("prompt"),
      checkpoint: z.boolean().default(true),
      wipCommits: z.boolean().default(false),
      recallIndex: z
        .object({
          enabled: z.boolean().default(true),
          maxCards: z.number().int().positive().default(20),
        })
        .prefault({}),
    })
    .prefault({}),
  leakGuard: z
    .object({
      enabled: z.boolean().default(true),
      allow: z.array(z.string()).default([]),
      extraPatterns: z.array(z.string()).default([]),
    })
    .prefault({}),
  // Confirm-before-push gate on the ship verb (#76) — adopted at the
  // 2026-08-12 product council (REC-5), accepted by the project owner over
  // cairn's no-action recommendation. Default on; confirm: false restores
  // the silent push flow.
  ship: z.object({ confirm: z.boolean().default(true) }).prefault({}),
  // Days of silence before plan_drift calls work stale (#218) — an issue
  // held in progress with no tracker update and no commit naming it, or a
  // branch nobody has pushed to. Advisory only; ship never blocks on it.
  drift: z
    .object({ staleDays: z.number().int().min(1).default(5) })
    .prefault({}),
  // Per-provider peer CLI settings (Tier F2 #997) — absent provider or
  // absent field means enabled with defaults; unknown provider keys are
  // rejected by the enum-keyed record below.
  peers: z
    .partialRecord(
      z.enum(PROVIDERS),
      z.object({
        enabled: z.boolean().optional(),
        maxInputChars: z.number().int().positive().optional(),
        // Config-declared trust decision (#67): the user explicitly marks
        // which external CLI may execute the product during functionality
        // review. Default false when absent — never runtime-probed.
        execCapable: z.boolean().optional(),
        // Model pin for seats whose CLI takes a model flag (#338, copilot
        // today); absent = the template default. A claude-* id is refused
        // below: the adjudicator's own family shares its blind spots.
        model: z.string().min(1).optional(),
      }),
    )
    .superRefine((peers, ctx) => {
      for (const [provider, entry] of Object.entries(peers ?? {})) {
        const model = (entry as { model?: string } | undefined)?.model;
        if (model && /^claude[-_]/i.test(model)) {
          ctx.addIssue({
            code: "custom",
            path: [provider, "model"],
            message: `'${model}' is a Claude model — the ${provider} seat may not run the adjudicator's own family; pin an OpenAI or Google model id instead`,
          });
        } else if (model && /^auto$/i.test(model)) {
          // "auto" lets the CLI pick, and Copilot's documented default pick
          // is a Claude model -- so it is not a pin at all (verified live
          // 2026-10-14: `--model auto` runs, every catalog id did not).
          ctx.addIssue({
            code: "custom",
            path: [provider, "model"],
            message: `'auto' is not a pin — the ${provider} seat must name one non-Claude model id, because auto may route to the adjudicator's own family`,
          });
        }
      }
    })
    .optional(),
  // Fan-out throttle (#75) — lives in its own top-level block instead of
  // inside `peers` because that record is enum-keyed by provider name: a
  // run-wide key like maxConcurrent would be rejected as an unknown
  // provider, and per-provider concurrency makes no sense anyway (the
  // budget guards the HOST, not any one CLI). Absent = the resource-aware
  // heuristic in peers/throttle.ts decides; set = the user's call wins.
  peerFanout: z
    .object({ maxConcurrent: z.number().int().positive() })
    .optional(),
  // Seat roster control (phase 19) — peers-shaped: optional, absent block =
  // every shipped default seat enabled (today's behavior), unknown keys
  // rejected by strictObject. This block only picks and orders seats; the
  // definitions themselves are files (.cairn/roles/ over templates/seats/),
  // never config. Internal seats are framing lenses — cheap, same-model;
  // peers (above) remain the genuinely adversarial external council.
  seats: z
    .strictObject({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
      // Project-level dispatch dial (phase 19): what a verb's `inherit`
      // dial resolves to. "auto" (the default since #345 -- absent here,
      // or the whole block absent, resolves to it in the roster) =
      // signal/yield selection picks the seats that fire; "off" is the
      // explicit opt-in for the full roster on every pass.
      dispatch: z.enum(["auto", "off"]).default("auto"),
    })
    .optional(),
  contextEconomy: z
    .object({
      /** Desired CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; null leaves the harness default. */
      autocompactPct: z.number().min(0.05).max(1).nullable().default(null),
    })
    .optional(),
});
export type CairnConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(projectDir: string): CairnConfig {
  let raw: string;
  try {
    raw = readFileSync(join(projectDir, "cairn.json"), "utf8");
  } catch {
    throw new CairnError(
      "CONFIG_MISSING",
      `no cairn.json in ${projectDir}`,
      "create cairn.json — see templates/cairn.json.example",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CairnError(
      "CONFIG_INVALID",
      `cairn.json is not valid JSON: ${e}`,
    );
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new CairnError(
      "CONFIG_INVALID",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  return result.data;
}

const SECRET_KEY_RE = /^(token|apiToken|api_key|apikey|password|secret|pat)$/i;
const SECRET_VALUE_RE = /^(ATATT|ghp_|github_pat_|glpat-|xoxb-|sk-)/;

function assertNoSecrets(patch: unknown, path: string[] = []): void {
  if (patch === null || typeof patch !== "object") {
    if (typeof patch === "string" && SECRET_VALUE_RE.test(patch)) {
      throw new CairnError(
        "CONFIG_INVALID",
        `value at ${path.join(".")} looks like a credential — secrets do not belong in cairn.json`,
        "put credentials in env vars (see each adapter's *Env config keys)",
      );
    }
    return;
  }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new CairnError(
        "CONFIG_INVALID",
        `key '${[...path, k].join(".")}' — secrets do not belong in cairn.json`,
        "put credentials in env vars (see each adapter's *Env config keys)",
      );
    }
    assertNoSecrets(v, [...path, k]);
  }
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof out[k] === "object" &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(
        out[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function writeConfigPatch(
  projectDir: string,
  patch: Record<string, unknown>,
): CairnConfig {
  assertNoSecrets(patch);
  const path = join(projectDir, "cairn.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new CairnError(
      "CONFIG_MISSING",
      `cannot read cairn.json: ${e}`,
      "create cairn.json — see templates/cairn.json.example",
    );
  }
  const merged = deepMerge(raw, patch);
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new CairnError(
      "CONFIG_INVALID",
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return result.data;
}
