/**
 * ContextEnricher — Builds enriched system prompts with vault context.
 *
 * Generalized from apps/discord-relay/src/context.ts.
 * Fetches pinned notes, memory facts, semantic search results, and
 * recent conversation history in parallel for rich context injection.
 */

import type { VaultBridge } from "./vaultBridge";

export interface EnrichedPromptOptions {
  /** User message to build context around */
  userMessage: string;
  /** Thread ID for conversation history */
  threadId?: string;
  /** Client type hint for preamble selection */
  clientType?: string;
  /** User name for personalization */
  userName?: string;
  /** Timezone string */
  timezone?: string;
  /** Max pinned notes to include */
  maxPinnedNotes?: number;
  /** Max semantic search results to include */
  maxSearchResults?: number;
  /** Max history messages to include */
  maxHistoryMessages?: number;
}

export class ContextEnricher {
  private bridge: VaultBridge;

  constructor(bridge: VaultBridge) {
    this.bridge = bridge;
  }

  /**
   * Build an enriched system prompt with vault context.
   */
  async buildSystemPrompt(opts: EnrichedPromptOptions): Promise<string> {
    const {
      userMessage,
      threadId,
      clientType,
      userName,
      timezone,
      maxPinnedNotes = 5,
      maxSearchResults = 5,
      maxHistoryMessages = 10,
    } = opts;

    // Fetch context in parallel
    const [ctx, searchResults, recentMessages] = await Promise.all([
      this.bridge.getAgentContext(),
      this.bridge.searchNotes(userMessage, maxSearchResults).catch(() => []),
      threadId ? this.getThreadHistory(threadId, maxHistoryMessages) : Promise.resolve([]),
    ]);

    const now = new Date();
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const parts: string[] = [];

    // System preamble
    parts.push(this.getPreamble(clientType));
    if (userName) parts.push(`You are speaking with ${userName}.`);
    parts.push(`Current time: ${timeStr}`);

    // Soul / identity
    if (ctx.soul) {
      parts.push(`\n## Identity\n${ctx.soul}`);
    }

    // User preferences
    if (ctx.preferences) {
      parts.push(`\n## Preferences\n${ctx.preferences}`);
    }

    // Pinned notes as persistent context
    const pinned = ctx.pinnedNotes.slice(0, maxPinnedNotes);
    if (pinned.length > 0) {
      parts.push("\n## Pinned Notes (always available):");
      for (const note of pinned) {
        parts.push(`- [${note.title}]: ${note.content.substring(0, 300)}`);
      }
    }

    // Memory
    if (ctx.memory) {
      parts.push(`\n## Memory\n${ctx.memory.substring(0, 2000)}`);
    }

    // Semantic search results
    if (searchResults.length > 0) {
      parts.push("\n## Relevant Notes:");
      for (const result of searchResults) {
        const notebook = (result as any).notebook ? ` (${(result as any).notebook})` : "";
        parts.push(`- [${result.title}]${notebook}: ${result.snippet.substring(0, 200)}`);
      }
    }

    // Conversation history
    if (recentMessages.length > 0) {
      parts.push("\n## Recent Conversation:");
      for (const msg of recentMessages) {
        const label = msg.role === "user" ? "User" : "Assistant";
        const body = msg.content.length > 300
          ? msg.content.substring(0, 300) + "..."
          : msg.content;
        parts.push(`${label}: ${body}`);
      }
    }

    // Memory management instructions
    parts.push(
      "\n## Memory Management:\n" +
      "When the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):\n" +
      "[REMEMBER: fact to store]\n" +
      "[GOAL: goal text | DEADLINE: optional date]\n" +
      "[DONE: search text for completed goal]",
    );

    return parts.join("\n");
  }

  private getPreamble(clientType?: string): string {
    const defaultModel = process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";

    switch (clientType) {
      case "discord":
        return (
          "You are a personal AI assistant responding via Discord. " +
          "Keep responses concise and conversational. Use markdown formatting compatible with Discord."
        );
      case "whatsapp":
        return (
          `You are a personal AI assistant (model: ${defaultModel}) responding via WhatsApp. ` +
          "Keep responses concise and use plain text — WhatsApp renders *bold* and _italic_ but not complex markdown. " +
          "You have access to the user's knowledge vault (notes, projects, tasks, goals). " +
          "\n\nCAPABILITIES GUIDANCE:\n" +
          "- For code editing, git, and complex engineering tasks: recommend the Claude bot on Discord.\n" +
          "- For Google Workspace tasks (reading/writing Docs, Drive files, Gmail, Calendar, Sheets): " +
          "recommend the Gemini bot on Discord — it runs the Gemini CLI with full Google Workspace MCP integration and authenticated access.\n" +
          "- To use Gemini's general intelligence in this WhatsApp chat: the user can type !gemini to switch to the Gemini model.\n" +
          "- Note: !gemini in WhatsApp uses Gemini via OpenRouter for general reasoning/research — " +
          "it does NOT have authenticated Google Workspace file access. That requires the Discord Gemini bot."
        );
      case "web":
        return (
          "You are a personal AI assistant. " +
          "Provide clear, well-structured responses with markdown formatting."
        );
      case "mobile":
        return (
          "You are a personal AI assistant. " +
          "Keep responses concise and easy to read on mobile."
        );
      default:
        return (
          "You are a personal AI assistant with access to the user's knowledge base. " +
          "Provide helpful, accurate, and contextually-aware responses."
        );
    }
  }

  private async getThreadHistory(
    threadId: string,
    limit: number,
  ): Promise<Array<{ role: string; content: string }>> {
    try {
      const threads = await this.bridge.listThreads();
      const thread = (threads as any[]).find(
        (t) => t.threadId === threadId || t._id === threadId,
      );
      if (!thread?.messages) return [];
      return thread.messages.slice(-limit);
    } catch {
      return [];
    }
  }
}
