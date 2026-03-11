/**
 * PlatformConfig — per-platform behavior configuration.
 *
 * Controls harness timeouts, notification behavior, and formatting per
 * platform. PLATFORM_DEFAULTS provides sensible starting values; each
 * adapter can override individual fields in its constructor.
 */

import type { PlatformId } from "./platformBridge.js";

// ─── Types ────────────────────────────────────────────────────────

export interface NotificationConfig {
  /** How often to send progress updates (ms). 0 = disabled. */
  progressInterval: number;
  /** Whether to send typing indicators. */
  showTyping: boolean;
  /** How long a typing indicator is valid before needing refresh (ms). */
  typingKeepAliveMs: number;
  /** Whether to react with 👀 on receipt, ✅/❌ on completion. */
  acknowledgeReceipt: boolean;
}

export interface PlatformConfig {
  platformId: PlatformId;

  /** Per-harness timeout overrides (ms). Falls back to defaultTimeout. */
  harnessTimeouts: Record<string, number>;
  /** Default job/delegation timeout (ms). */
  defaultTimeout: number;

  /** Notification behavior for this platform. */
  notifications: NotificationConfig;

  /**
   * Optional auth check. Called with the platform user ID for every message.
   * Return false to silently drop the message.
   * Defaults to allowing all users (guard/middleware handles auth in the bridge).
   */
  authCheck?: (userId: string) => boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────

export const PLATFORM_DEFAULTS: Record<PlatformId, PlatformConfig> = {
  telegram: {
    platformId: "telegram",
    harnessTimeouts: {
      "claude-code": 3_600_000,  // 1 hour
      "opencode":    3_600_000,
      "gemini-cli":  600_000,    // 10 min
      "codex-cli":   600_000,
    },
    defaultTimeout: 600_000, // 10 min
    notifications: {
      progressInterval: 300_000, // every 5 min
      showTyping: true,
      typingKeepAliveMs: 4_000,  // Telegram typing expires ~5s
      acknowledgeReceipt: true,
    },
  },

  whatsapp: {
    platformId: "whatsapp",
    harnessTimeouts: {
      "claude-code": 3_600_000,
      "opencode":    3_600_000,
      "gemini-cli":  600_000,
    },
    defaultTimeout: 600_000,
    notifications: {
      progressInterval: 0,        // WhatsApp typing is noisy, no periodic msgs
      showTyping: true,
      typingKeepAliveMs: 20_000,  // WhatsApp composing indicator lasts longer
      acknowledgeReceipt: true,
    },
  },

  discord: {
    platformId: "discord",
    harnessTimeouts: {
      "claude-code": 300_000, // 5 min (Discord interaction timeout)
      "opencode":    300_000,
      "gemini-cli":  300_000,
    },
    defaultTimeout: 300_000,
    notifications: {
      progressInterval: 0,        // Discord has native streaming / edit-in-place
      showTyping: true,
      typingKeepAliveMs: 8_000,   // Discord typing expires ~10s
      acknowledgeReceipt: false,
    },
  },

  web: {
    platformId: "web",
    harnessTimeouts: {
      "claude-code": 3_600_000,
      "opencode":    3_600_000,
      "gemini-cli":  3_600_000,
    },
    defaultTimeout: 3_600_000,
    notifications: {
      progressInterval: 0,    // Web has native streaming tokens
      showTyping: false,
      typingKeepAliveMs: 0,
      acknowledgeReceipt: false,
    },
  },
};

/** Merge partial config on top of platform defaults. */
export function buildPlatformConfig(
  platformId: PlatformId,
  overrides?: Partial<PlatformConfig>,
): PlatformConfig {
  return {
    ...PLATFORM_DEFAULTS[platformId],
    ...overrides,
    notifications: {
      ...PLATFORM_DEFAULTS[platformId].notifications,
      ...overrides?.notifications,
    },
    harnessTimeouts: {
      ...PLATFORM_DEFAULTS[platformId].harnessTimeouts,
      ...overrides?.harnessTimeouts,
    },
  };
}

/**
 * Load platform config overrides from `.vault/_system/PLATFORM-CONFIG.md`.
 *
 * The file uses YAML frontmatter with per-platform sections:
 * ```yaml
 * ---
 * telegram:
 *   defaultTimeout: 600000
 *   harnessTimeouts:
 *     claude-code: 3600000
 *   notifications:
 *     progressInterval: 300000
 * discord:
 *   defaultTimeout: 300000
 * ---
 * ```
 *
 * Returns the partial config for the requested platform, or null if
 * the file doesn't exist or has no overrides for that platform.
 */
export function loadVaultPlatformConfig(
  vaultRoot: string,
  platformId: PlatformId,
): Partial<PlatformConfig> | null {
  try {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const configPath = join(vaultRoot, "_system", "PLATFORM-CONFIG.md");
    if (!existsSync(configPath)) return null;

    const raw = readFileSync(configPath, "utf-8") as string;
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    // Simple YAML parser for our flat structure (avoids dependency on gray-matter at runtime)
    const yaml = fmMatch[1];
    const platformSection = extractYamlSection(yaml, platformId);
    if (!platformSection) return null;

    const result: Partial<PlatformConfig> = {};

    // Parse top-level numbers
    const defaultTimeout = parseYamlNumber(platformSection, "defaultTimeout");
    if (defaultTimeout !== null) result.defaultTimeout = defaultTimeout;

    // Parse harnessTimeouts sub-section
    const harnessSection = extractYamlSection(platformSection, "harnessTimeouts");
    if (harnessSection) {
      result.harnessTimeouts = {};
      for (const line of harnessSection.split("\n")) {
        const m = line.match(/^\s{4,}([\w-]+):\s*(\d+)/);
        if (m) result.harnessTimeouts[m[1]] = parseInt(m[2], 10);
      }
    }

    // Parse notifications sub-section
    const notifSection = extractYamlSection(platformSection, "notifications");
    if (notifSection) {
      const partial: Partial<NotificationConfig> = {};
      const pi = parseYamlNumber(notifSection, "progressInterval");
      if (pi !== null) partial.progressInterval = pi;
      const tk = parseYamlNumber(notifSection, "typingKeepAliveMs");
      if (tk !== null) partial.typingKeepAliveMs = tk;
      const st = parseYamlBool(notifSection, "showTyping");
      if (st !== null) partial.showTyping = st;
      const ar = parseYamlBool(notifSection, "acknowledgeReceipt");
      if (ar !== null) partial.acknowledgeReceipt = ar;
      if (Object.keys(partial).length > 0) result.notifications = partial as NotificationConfig;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Extract indented block under a top-level key from YAML text. */
function extractYamlSection(yaml: string, key: string): string | null {
  const lines = yaml.split("\n");
  let capturing = false;
  const captured: string[] = [];
  for (const line of lines) {
    if (!capturing) {
      if (line.match(new RegExp(`^\\s*${key}:\\s*$`)) || line.match(new RegExp(`^${key}:\\s*$`))) {
        capturing = true;
      }
    } else {
      if (line.match(/^\S/) && !line.match(/^\s/)) break; // next top-level key
      captured.push(line);
    }
  }
  return captured.length > 0 ? captured.join("\n") : null;
}

function parseYamlNumber(section: string, key: string): number | null {
  const m = section.match(new RegExp(`${key}:\\s*(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

function parseYamlBool(section: string, key: string): boolean | null {
  const m = section.match(new RegExp(`${key}:\\s*(true|false)`));
  return m ? m[1] === "true" : null;
}
