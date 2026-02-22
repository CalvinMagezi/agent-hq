/**
 * Rule-based intent classifier for Discord messages.
 * Pure function — no async, no LLM calls, no external dependencies.
 * Classifies messages into "instant" (pre-computed response) or "chat" (needs LLM).
 */

export type IntentTier = "instant" | "chat";

export interface ClassificationResult {
    tier: IntentTier;
    /** Pre-computed response for instant tier */
    instantResponse?: string;
    /** Why this classification was chosen (for logging) */
    reason: string;
}

export interface ClassifierContext {
    targetDir: string;
    workerId: string;
    isBusy: boolean;
    currentJobInstruction?: string;
}

type PatternRule = {
    patterns: RegExp[];
    response: (ctx: ClassifierContext) => string;
    reason: string;
};

const INSTANT_RULES: PatternRule[] = [
    {
        patterns: [
            /^ping$/i,
            /^are you there\??$/i,
            /^are you online\??$/i,
            /^are you alive\??$/i,
            /^yo$/i,
        ],
        response: (ctx) => `Online and ready! Working in: \`${ctx.targetDir}\``,
        reason: "ping/presence check",
    },
    {
        patterns: [
            /^(hi|hello|hey|sup|hola|howdy)[\s!.]*$/i,
        ],
        response: (ctx) => `Hey! I'm online and ready to help. Working in: \`${ctx.targetDir}\``,
        reason: "greeting",
    },
    {
        patterns: [
            /where are you/i,
            /what('s| is) your (working )?dir/i,
            /^pwd$/i,
            /^cwd$/i,
            /working directory/i,
            /what dir/i,
        ],
        response: (ctx) => `I'm in: \`${ctx.targetDir}\``,
        reason: "location query",
    },
    {
        patterns: [
            /^status\??$/i,
            /are you busy/i,
            /what are you doing/i,
            /what('s| is) your status/i,
        ],
        response: (ctx) => {
            if (ctx.isBusy && ctx.currentJobInstruction) {
                return `I'm currently working on: "${ctx.currentJobInstruction.substring(0, 100)}${ctx.currentJobInstruction.length > 100 ? "..." : ""}"`;
            }
            return `Online and idle. Working directory: \`${ctx.targetDir}\``;
        },
        reason: "status query",
    },
    {
        patterns: [
            /what time/i,
            /current time/i,
            /what('s| is) the time/i,
        ],
        response: () => `Current time: ${new Date().toLocaleString()}`,
        reason: "time query",
    },
    {
        patterns: [
            /^who are you\??$/i,
            /worker id/i,
        ],
        response: (ctx) => `I'm HQ Agent (Worker: \`${ctx.workerId}\`), working in: \`${ctx.targetDir}\``,
        reason: "identity query",
    },
];

/**
 * Classify a message into instant (pre-computed) or chat (needs LLM).
 */
export function classifyIntent(
    message: string,
    context: ClassifierContext
): ClassificationResult {
    const trimmed = message.trim();

    // Check instant rules
    for (const rule of INSTANT_RULES) {
        for (const pattern of rule.patterns) {
            if (pattern.test(trimmed)) {
                return {
                    tier: "instant",
                    instantResponse: rule.response(context),
                    reason: rule.reason,
                };
            }
        }
    }

    // Everything else goes to the chat session
    return {
        tier: "chat",
        reason: "requires LLM reasoning",
    };
}
