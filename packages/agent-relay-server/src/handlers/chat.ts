/**
 * Chat handler — streaming chat with context enrichment.
 *
 * Priority order for chat routing:
 * 1. AgentBridge (if connected) — routes to local agent WS for full tool use + streaming
 * 2. LLM fallback — direct API call with vault context injection (supports multiple providers)
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
import { resolveChatProvider, type ChatProviderConfig } from "@repo/vault-client";

// Lazy — resolved on first use so env vars are loaded by the time we need them
let _chatProvider: ChatProviderConfig | null = null;
function getChatProvider(): ChatProviderConfig {
  if (!_chatProvider) _chatProvider = resolveChatProvider();
  return _chatProvider;
}

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
    console.log(
      `[chat-handler] chat:send received: requestId=${msg.requestId}, agentBridge=${this.agentBridge.isConnected ? "connected" : "disconnected"}`,
    );

    // Try agent bridge first for real-time streaming
    if (this.agentBridge.isConnected) {
      const routed = this.agentBridge.sendChatMessage(
        msg.content,
        ws.data.sessionToken,
        msg.requestId,
        msg.threadId,
      );
      if (routed) {
        console.log("[chat-handler] Routed to agent bridge — waiting for agent response");
        // Safety timeout: if agent doesn't respond within 30s, fall back to LLM
        setTimeout(async () => {
          if (this.agentBridge.hasPendingRequest(msg.requestId)) {
            console.warn("[chat-handler] Agent bridge timeout (30s) — falling back to LLM");
            this.agentBridge.clearPendingRequest(msg.requestId);
            try {
              await this.handleLLMChat(ws, msg);
            } catch (err) {
              console.error("[chat-handler] LLM fallback also failed:", err);
              ws.send(JSON.stringify({
                type: "error",
                code: "CHAT_TIMEOUT",
                message: "Agent did not respond and LLM fallback failed",
                requestId: msg.requestId,
              }));
            }
          }
        }, 30_000);
        return;
      }
      console.log("[chat-handler] Agent bridge connected but sendChatMessage returned false, falling back to LLM");
    }

    // Fallback: direct LLM call with vault context
    console.log(`[chat-handler] Using LLM fallback (provider: ${getChatProvider().type})`);
    await this.handleLLMChat(ws, msg);
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

  private async handleLLMChat(
    ws: ServerWebSocket<ClientData>,
    msg: ChatSendMessage,
  ): Promise<void> {
    const provider = getChatProvider();

    if (provider.type === "none") {
      console.error("[chat-handler] No LLM provider configured — cannot process chat");
      ws.send(
        JSON.stringify({
          type: "error",
          code: "NO_API_KEY",
          message: "No LLM provider configured. Chat only works when the HQ Agent is connected, or set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY for standalone chat.",
          requestId: msg.requestId,
        }),
      );
      return;
    }

    const model = msg.modelOverride ?? provider.model;
    console.log(`[chat-handler] ${provider.type} call: model=${model}, content="${msg.content.substring(0, 60)}..."`);

    try {
      const systemPrompt = await this.enricher.buildSystemPrompt({
        userMessage: msg.content,
        threadId: msg.threadId,
        clientType: ws.data.clientType,
      });

      const userMessage: any = msg.images && msg.images.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: msg.content },
              ...msg.images.map((img) => ({
                type: "image_url",
                image_url: { url: img.url, detail: "auto" as const },
              })),
            ],
          }
        : { role: "user", content: msg.content };

      const { url, headers, body } = this.buildRequest(provider, model, systemPrompt, userMessage);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${provider.type} API error ${response.status}: ${errorText}`);
      }

      if (!response.body) throw new Error("No response body");

      let fullResponse = "";
      let chunkIndex = 0;

      if (provider.type === "anthropic") {
        // Anthropic uses SSE with different event format
        fullResponse = await this.streamAnthropicResponse(response, ws, msg, chunkIndex);
      } else {
        // OpenRouter and Gemini use OpenAI-compatible SSE
        fullResponse = await this.streamOpenAIResponse(response, ws, msg, chunkIndex);
      }

      const cleaned = await this.memoryProcessor.processResponse(fullResponse);

      if (msg.threadId) {
        try {
          await this.bridge.client.appendMessage(msg.threadId, "user", msg.content);
          await this.bridge.client.appendMessage(msg.threadId, "assistant", cleaned);
        } catch { /* Non-fatal */ }
      }

      ws.send(
        JSON.stringify({
          type: "chat:final",
          requestId: msg.requestId,
          threadId: msg.threadId,
          content: cleaned,
        }),
      );

      console.log(`[chat-handler] ${provider.type} response complete (${cleaned.length} chars)`);
    } catch (err) {
      console.error(`[chat-handler] ${provider.type} error:`, err instanceof Error ? err.message : err);
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

  private buildRequest(
    provider: ChatProviderConfig,
    model: string,
    systemPrompt: string,
    userMessage: any,
  ): { url: string; headers: Record<string, string>; body: any } {
    if (provider.type === "anthropic") {
      return {
        url: `${provider.baseUrl}/messages`,
        headers: {
          "x-api-key": provider.apiKey!,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: {
          model,
          system: systemPrompt,
          messages: [userMessage],
          max_tokens: 4096,
          stream: true,
        },
      };
    }

    if (provider.type === "gemini") {
      // Use OpenAI-compatible endpoint for streaming
      return {
        url: `${provider.baseUrl}/openai/chat/completions`,
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            userMessage,
          ],
          stream: true,
        },
      };
    }

    // OpenRouter (default)
    return {
      url: `${provider.baseUrl}/chat/completions`,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agent-hq.local",
        "X-Title": "Agent HQ Relay",
      },
      body: {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          userMessage,
        ],
        stream: true,
      },
    };
  }

  private async streamOpenAIResponse(
    response: Response,
    ws: ServerWebSocket<ClientData>,
    msg: ChatSendMessage,
    startIndex: number,
  ): Promise<string> {
    let fullResponse = "";
    let chunkIndex = startIndex;
    const reader = response.body!.getReader();
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
        } catch { /* Skip malformed chunks */ }
      }
    }

    return fullResponse;
  }

  private async streamAnthropicResponse(
    response: Response,
    ws: ServerWebSocket<ClientData>,
    msg: ChatSendMessage,
    startIndex: number,
  ): Promise<string> {
    let fullResponse = "";
    let chunkIndex = startIndex;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.substring(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            const delta = parsed.delta.text;
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
        } catch { /* Skip malformed chunks */ }
      }
    }

    return fullResponse;
  }
}
