/**
 * harnessRouter — intent-based harness routing for UnifiedAdapterBot.
 *
 * Given the current message content, active harness override, and model
 * override, returns a routing decision: "chat" (relay), "local" (direct
 * CLI harness), or "delegation" (orchestrated relay job).
 */

import { detectIntent } from "./orchestrator.js";
import type { LocalHarnessType } from "./localHarness.js";

// ─── Types ────────────────────────────────────────────────────────

export type ActiveHarness = "auto" | LocalHarnessType;

export type RoutePath = "chat" | "local" | "delegation";

export interface RouteDecision {
  path: RoutePath;
  /** Set when path === "local" or "delegation". */
  harness?: LocalHarnessType | "any";
  /** Role hint for delegation. */
  role?: string;
}

// ─── Routing logic ────────────────────────────────────────────────

/**
 * Route a message to the appropriate handler.
 *
 * @param content        raw message text
 * @param activeHarness  current pinned harness ("auto" = intent routing)
 * @param modelOverride  if set, forces relay chat mode regardless of intent
 */
export function routeMessage(
  content: string,
  activeHarness: ActiveHarness,
  modelOverride: string | undefined,
): RouteDecision {
  // If harness is pinned to a specific CLI, route directly to it
  if (activeHarness !== "auto") {
    return { path: "local", harness: activeHarness };
  }

  // If a model override is active, force relay chat (user picked a model)
  if (modelOverride) {
    return { path: "chat" };
  }

  // Intent-based routing
  const { intent, harness, role } = detectIntent(content);

  if (intent !== "general") {
    return { path: "delegation", harness, role };
  }

  // General intent → route to HQ as the default harness
  return { path: "local", harness: "hq" };
}

// ─── Harness label helpers ─────────────────────────────────────────

export const HARNESS_ALIASES: Record<string, LocalHarnessType> = {
  claude:         "claude-code",
  "claude-code":  "claude-code",
  opencode:       "opencode",
  oc:             "opencode",
  gemini:         "gemini-cli",
  "gemini-cli":   "gemini-cli",
  codex:          "codex-cli",
  "codex-cli":    "codex-cli",
  qwen:           "qwen-code",
  "qwen-code":    "qwen-code",
  vibe:           "mistral-vibe",
  mistral:        "mistral-vibe",
  "mistral-vibe": "mistral-vibe",
  hq:             "hq",
};

export function harnessLabel(h: ActiveHarness): string {
  switch (h) {
    case "claude-code":   return "Claude Code";
    case "opencode":      return "OpenCode";
    case "gemini-cli":    return "Gemini CLI";
    case "codex-cli":     return "Codex CLI";
    case "qwen-code":     return "Qwen Code";
    case "mistral-vibe":  return "Mistral Vibe";
    case "hq":            return "HQ Agent";
    case "auto":          return "Auto (intent-based)";
    default:              return h;
  }
}

export function delegationLabel(harness: string): string {
  switch (harness) {
    case "gemini-cli":    return "Gemini CLI";
    case "claude-code":   return "Claude Code";
    case "opencode":      return "OpenCode";
    case "qwen-code":     return "Qwen Code";
    case "mistral-vibe":  return "Mistral Vibe";
    default:              return "HQ";
  }
}
