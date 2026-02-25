/**
 * Custom Command Loader
 *
 * Dynamically loads custom commands from `custom-commands/` at startup.
 * This directory is gitignored — commands placed here are private and local-only.
 *
 * Each file should export a `register()` function returning CustomCommandDef[].
 */
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { BaseHarness } from "./harnesses/base.js";
import type { ConvexAPI } from "./vaultApi.js";

export interface CustomCommandContext {
    arg: string;
    channelId: string;
    harness: BaseHarness;
    convex: ConvexAPI | null;
}

export interface CustomCommandResult {
    handled: boolean;
    response?: string;
    file?: { name: string; buffer: Buffer };
}

export interface CustomCommandDef {
    /** Command names including the `!` prefix, e.g. ["!my-cmd", "!mc"] */
    names: string[];
    /** Short description shown in !help output */
    description: string;
    /** The command handler function */
    handler: (ctx: CustomCommandContext) => Promise<CustomCommandResult>;
}

/** Registry of loaded custom commands (command name → handler) */
const registry = new Map<string, CustomCommandDef>();

/** Load all custom commands from the custom-commands directory */
export async function loadCustomCommands(): Promise<number> {
    registry.clear();

    const customDir = resolve(
        import.meta.dir ?? __dirname,
        "..",
        "custom-commands",
    );

    if (!existsSync(customDir)) {
        return 0;
    }

    const files = readdirSync(customDir).filter(
        (f) => f.endsWith(".ts") || f.endsWith(".js"),
    );

    let count = 0;
    for (const file of files) {
        try {
            const mod = await import(join(customDir, file));
            if (typeof mod.register !== "function") {
                console.warn(`[custom-commands] ${file}: no register() export, skipping`);
                continue;
            }

            const defs: CustomCommandDef[] = mod.register();
            for (const def of defs) {
                for (const name of def.names) {
                    const normalized = name.toLowerCase();
                    registry.set(normalized, def);
                    count++;
                }
            }
            console.log(
                `[custom-commands] Loaded ${file}: ${defs.map((d) => d.names.join(", ")).join("; ")}`,
            );
        } catch (err) {
            console.error(`[custom-commands] Failed to load ${file}:`, err);
        }
    }

    return count;
}

/**
 * Try to handle a command via custom commands.
 * Returns null if no custom command matched.
 */
export async function handleCustomCommand(
    command: string,
    ctx: CustomCommandContext,
): Promise<CustomCommandResult | null> {
    const def = registry.get(command.toLowerCase());
    if (!def) return null;

    try {
        return await def.handler(ctx);
    } catch (err: any) {
        return {
            handled: true,
            response: `❌ Custom command error: ${err.message}`,
        };
    }
}

/** Get all loaded custom command definitions (for !help output) */
export function getCustomCommands(): CustomCommandDef[] {
    // Deduplicate — same def can be under multiple names
    return [...new Set(registry.values())];
}
