/**
 * Custom Command Loader
 *
 * Dynamically loads custom commands from a configurable directory at startup.
 * Each file should export a `register()` function returning CustomCommandDef[].
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { CommandResult } from "../types.js";

export interface CustomCommandContext {
  arg: string;
  channelId: string;
  /** Consumer-specific data — consumers cast as needed */
  [key: string]: unknown;
}

export interface CustomCommandDef {
  /** Command names including the `!` prefix, e.g. ["!my-cmd", "!mc"] */
  names: string[];
  /** Short description shown in help output */
  description: string;
  /** The command handler function */
  handler: (ctx: CustomCommandContext) => Promise<CommandResult>;
}

/** Registry of loaded custom commands (command name -> handler) */
const registry = new Map<string, CustomCommandDef>();

/**
 * Load all custom commands from the specified directory.
 * @param customDir - Absolute path to the custom commands directory
 */
export async function loadCustomCommands(customDir: string): Promise<number> {
  registry.clear();

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
): Promise<CommandResult | null> {
  const def = registry.get(command.toLowerCase());
  if (!def) return null;

  try {
    return await def.handler(ctx);
  } catch (err: any) {
    return {
      handled: true,
      response: `Custom command error: ${err.message}`,
    };
  }
}

/** Get all loaded custom command definitions (for help output). */
export function getCustomCommands(): CustomCommandDef[] {
  return [...new Set(registry.values())];
}
