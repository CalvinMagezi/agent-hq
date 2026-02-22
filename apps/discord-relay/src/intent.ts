export interface ClassificationResult {
  tier: "instant" | "claude";
  instantResponse?: string;
  reason?: string;
}

const INSTANT_RULES: Array<{
  patterns: RegExp[];
  response: string | (() => string);
  reason: string;
}> = [
  {
    patterns: [/^ping$/i, /^are you there\??$/i, /^alive\??$/i],
    response: "Online and ready!",
    reason: "ping",
  },
  {
    patterns: [/^(hi|hello|hey|sup|yo)[\s!.]*$/i],
    response: "Hey! How can I help?",
    reason: "greeting",
  },
  {
    patterns: [/^status\??$/i],
    response: "Online via Discord relay.",
    reason: "status",
  },
  {
    patterns: [/^what time/i, /^current time/i],
    response: () => `Current time: ${new Date().toLocaleString()}`,
    reason: "time",
  },
];

export function classifyIntent(message: string): ClassificationResult {
  const trimmed = message.trim();

  for (const rule of INSTANT_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) {
        return {
          tier: "instant",
          instantResponse:
            typeof rule.response === "function"
              ? rule.response()
              : rule.response,
          reason: rule.reason,
        };
      }
    }
  }

  return { tier: "claude" };
}
