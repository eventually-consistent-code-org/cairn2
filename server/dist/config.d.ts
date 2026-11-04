import { z } from "zod";
export declare const ConfigSchema: z.ZodObject<{
    tracker: z.ZodObject<{
        type: z.ZodEnum<{
            github: "github";
            gitlab: "gitlab";
            jira: "jira";
            asana: "asana";
            "azure-boards": "azure-boards";
            clickup: "clickup";
            linear: "linear";
            local: "local";
        }>;
        config: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strip>;
    docs: z.ZodOptional<z.ZodObject<{
        connector: z.ZodEnum<{
            confluence: "confluence";
            docusaurus: "docusaurus";
        }>;
        config: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, z.core.$strip>>;
    agents: z.ZodDefault<z.ZodObject<{
        model: z.ZodEnum<{
            auto: "auto";
            inherit: "inherit";
            haiku: "haiku";
            sonnet: "sonnet";
            opus: "opus";
        }>;
    }, z.core.$strip>>;
    memory: z.ZodDefault<z.ZodObject<{
        tokenThreshold: z.ZodNumber;
        observationWarnThreshold: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    user: z.ZodOptional<z.ZodObject<{
        handle: z.ZodString;
        mode: z.ZodOptional<z.ZodEnum<{
            vibe: "vibe";
            engineer: "engineer";
        }>>;
    }, z.core.$strip>>;
    continuity: z.ZodPrefault<z.ZodObject<{
        resume: z.ZodDefault<z.ZodEnum<{
            auto: "auto";
            prompt: "prompt";
            off: "off";
        }>>;
        checkpoint: z.ZodDefault<z.ZodBoolean>;
        wipCommits: z.ZodDefault<z.ZodBoolean>;
        recallIndex: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            maxCards: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    leakGuard: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
        extraPatterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    ship: z.ZodPrefault<z.ZodObject<{
        confirm: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    drift: z.ZodPrefault<z.ZodObject<{
        staleDays: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    audit: z.ZodPrefault<z.ZodObject<{
        debt: z.ZodPrefault<z.ZodObject<{
            markers: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    verify: z.ZodPrefault<z.ZodObject<{
        rerun: z.ZodDefault<z.ZodBoolean>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    auto: z.ZodPrefault<z.ZodObject<{
        breaker: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    guards: z.ZodOptional<z.ZodObject<{
        writers: z.ZodOptional<z.ZodObject<{
            readOnly: z.ZodOptional<z.ZodArray<z.ZodString>>;
            paths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    peers: z.ZodOptional<z.ZodRecord<z.ZodEnum<{
        codex: "codex";
        opencode: "opencode";
        antigravity: "antigravity";
        grok: "grok";
        copilot: "copilot";
    }> & z.core.$partial, z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        maxInputChars: z.ZodOptional<z.ZodNumber>;
        execCapable: z.ZodOptional<z.ZodBoolean>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    peerFanout: z.ZodOptional<z.ZodObject<{
        maxConcurrent: z.ZodNumber;
    }, z.core.$strip>>;
    seats: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodArray<z.ZodString>>;
        disabled: z.ZodOptional<z.ZodArray<z.ZodString>>;
        dispatch: z.ZodDefault<z.ZodEnum<{
            auto: "auto";
            off: "off";
        }>>;
    }, z.core.$strict>>;
    contextEconomy: z.ZodOptional<z.ZodObject<{
        autocompactPct: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type CairnConfig = z.infer<typeof ConfigSchema>;
export declare const OWNER_ONLY_KEYS: readonly ["leakGuard.enabled", "ship.confirm", "auto.breaker", "peers.*.execCapable", "guards.writers"];
export type OwnerOnlyKey = (typeof OWNER_ONLY_KEYS)[number];
export declare const OWNER_ONLY_SAFE: Readonly<Partial<Record<OwnerOnlyKey, unknown>>>;
/**
 * The owner-only keys a patch sets away from their safe value (#281), as
 * the dotted paths it names, in list order -- `peers.codex.execCapable`,
 * not the pattern. Empty when the patch touches none, sets one to its
 * safe value, or deletes one.
 */
export declare function ownerOnlyKeysIn(patch: unknown): string[];
/**
 * Refuses a patch that sets an owner-only key away from its safe value
 * (#281) unless the session carries the owner's escape, CAIRN_HARNESS_EDIT
 * set to exactly 1 -- the same escape the harness guard honours, so the
 * tool route and the file route open with one act. The typed code names
 * the keys and the owner's ways in; the agent is never taught a prefix.
 */
export declare function assertOwnerOnly(patch: unknown, env?: NodeJS.ProcessEnv): void;
export declare function loadConfig(projectDir: string): CairnConfig;
export declare function writeConfigPatch(projectDir: string, patch: Record<string, unknown>): CairnConfig;
