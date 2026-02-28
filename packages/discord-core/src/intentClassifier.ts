import type { IntentRule, ClassificationResult, IntentTier } from "./types.js";

/**
 * Default instant-response rules shared by all consumers.
 * Each consumer can extend with additional rules.
 */
export const DEFAULT_INTENT_RULES: IntentRule[] = [
  {
    patterns: [/^ping$/i, /^are you there\??$/i, /^are you online\??$/i, /^are you alive\??$/i],
    response: "Online and ready!",
    reason: "ping",
  },
  {
    patterns: [/^(hi|hello|hey|sup|yo|hola|howdy)[\s!.]*$/i],
    response: "Hey! How can I help?",
    reason: "greeting",
  },
  {
    patterns: [/^status\??$/i],
    response: "Online via Discord.",
    reason: "status",
  },
  {
    patterns: [/^what time/i, /^current time/i, /what('s| is) the time/i],
    response: () => `Current time: ${new Date().toLocaleString()}`,
    reason: "time",
  },
];

/**
 * Classify a message intent using pattern rules.
 * Supports both static string responses and context-aware functions.
 *
 * @param message - The message to classify
 * @param rules - Array of intent rules (defaults to DEFAULT_INTENT_RULES)
 * @param context - Optional context object passed to response functions
 * @param fallbackTier - Tier to use when no rule matches (default: "chat")
 */
export function classifyIntent(
  message: string,
  rules: IntentRule[] = DEFAULT_INTENT_RULES,
  context: Record<string, unknown> = {},
  fallbackTier: IntentTier = "chat",
): ClassificationResult {
  const trimmed = message.trim();

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) {
        const response = typeof rule.response === "function"
          ? rule.response(context)
          : rule.response;
        return {
          tier: "instant",
          instantResponse: response,
          reason: rule.reason,
        };
      }
    }
  }

  return { tier: fallbackTier, reason: "requires LLM reasoning" };
}
