/**
 * Chat handler — streaming chat with context enrichment.
 *
 * Priority order for chat routing:
 * 1. AgentBridge (if connected) — routes to local agent WS for full tool use + streaming
 * 2. OpenRouter fallback — direct LLM call with vault context injection
 *
 * Both paths use ContextEnricher for system prompt building and
 * MemoryProcessor to persist [REMEMBER:]/[GOAL:]/[DONE:] tags.
 */

import type { ServerWebSocket } from "bun";
import type { ClientData } from "../clientRegistry";
import type { VaultBridge } from "../bridges/vaultBridge";
import type { AgentBridge } from "../bridges/agentBridge";
import type { ContextEnricher } from "../bridges/contextEnricher";
import type { MemoryProcessor } from "../bridges/memoryProcessor";
import type { ChatSendMessage, ChatAbortMessage } from "@repo/agent-relay-protocol";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";

export class ChatHandler {
  private bridge: VaultBridge;
  private agentBridge: AgentBridge;
  private enricher: ContextEnricher;
  private memoryProcessor: MemoryProcessor;
  private debug: boolean;

  constructor(
    bridge: VaultBridge,
    agentBridge: AgentBridge,
    enricher: ContextEnricher,
    memoryProcessor: MemoryProcessor,
    debug = false,
  ) {
    this.bridge = bridge;
    this.agentBridge = agentBridge;
    this.enricher = enricher;
    this.memoryProcessor = memoryProcessor;
    this.debug = debug;
  }

  async handleChatSend(
    ws: ServerWebSocket<ClientData>,
    msg: ChatSendMessage,
  ): Promise<void> {
    // Try agent bridge first for real-time streaming
    if (this.agentBridge.isConnected) {
      const routed = this.agentBridge.sendChatMessage(
        msg.content,
        ws.data.sessionToken,
        msg.requestId,
        msg.threadId,
      );
      if (routed) {
        if (this.debug) console.log("[chat-handler] Routed to agent bridge");
        return;
      }
    }

    // Fallback: direct OpenRouter call with vault context
    await this.handleOpenRouterChat(ws, msg);
  }

  handleChatAbort(
    ws: ServerWebSocket<ClientData>,
    _msg: ChatAbortMessage,
  ): void {
    if (this.agentBridge.isConnected) {
      this.agentBridge.abort();
    }
    ws.send(
      JSON.stringify({
        type: "chat:abort",
        requestId: (_msg as any).requestId,
      }),
    );
  }

  private async handleOpenRouterChat(
    ws: ServerWebSocket<ClientData>,
    msg: ChatSendMessage,
  ): Promise<void> {
    if (!OPENROUTER_API_KEY) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "NO_API_KEY",
          message: "OPENROUTER_API_KEY is not configured on the relay server",
          requestId: msg.requestId,
        }),
      );
      return;
    }

    const model = msg.modelOverride ?? DEFAULT_MODEL;

    try {
      // Build enriched system prompt
      const systemPrompt = await this.enricher.buildSystemPrompt({
        userMessage: msg.content,
        threadId: msg.threadId,
        clientType: ws.data.clientType,
      });

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agent-hq.local",
          "X-Title": "Agent HQ Relay",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: msg.content },
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
      }

      if (!response.body) throw new Error("No response body");

      let fullResponse = "";
      let chunkIndex = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

        for (const line of lines) {
          const data = line.substring(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              ws.send(
                JSON.stringify({
                  type: "chat:delta",
                  requestId: msg.requestId,
                  threadId: msg.threadId,
                  delta,
                  index: chunkIndex++,
                }),
              );
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }

      // Process memory tags, clean response
      const cleaned = await this.memoryProcessor.processResponse(fullResponse);

      // Save to thread if threadId provided
      if (msg.threadId) {
        try {
          await this.bridge.client.appendMessage(msg.threadId, "user", msg.content);
          await this.bridge.client.appendMessage(msg.threadId, "assistant", cleaned);
        } catch {
          // Non-fatal
        }
      }

      ws.send(
        JSON.stringify({
          type: "chat:final",
          requestId: msg.requestId,
          threadId: msg.threadId,
          content: cleaned,
        }),
      );

      if (this.debug) {
        console.log(`[chat-handler] OpenRouter response (${cleaned.length} chars)`);
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "CHAT_ERROR",
          message: err instanceof Error ? err.message : "Chat failed",
          requestId: msg.requestId,
        }),
      );
    }
  }
}
