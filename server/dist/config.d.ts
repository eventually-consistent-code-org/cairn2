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
export declare function loadConfig(projectDir: string): CairnConfig;
export declare function writeConfigPatch(projectDir: string, patch: Record<string, unknown>): CairnConfig;
