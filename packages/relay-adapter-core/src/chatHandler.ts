/**
 * chatHandler — relay chat flow for UnifiedAdapterBot.
 *
 * Sends a `chat:send` message to the relay server, buffers streaming
 * `chat:delta` events, and resolves on `chat:final`. Calls ctx.sendResponse
 * with the final text. Thread ID is saved after the first response.
 */

import type { RelayClient } from "@repo/agent-relay-protocol";
import type { ChatDeltaMessage, ChatFinalMessage } from "@repo/agent-relay-protocol";
import type { PlatformBridge } from "./platformBridge.js";

// ─── Types ────────────────────────────────────────────────────────

export interface ChatContext {
  relay: RelayClient;
  bridge: PlatformBridge;
  getThreadId(): string | null;
  setThreadId(id: string): void;
  getModelOverride(): string | undefined;
  /** Platform-specific: send a (possibly long) response to the user. */
  sendResponse(text: string, replyToId?: string): Promise<void>;
  /** Optional: called per streaming delta when the platform supports streaming. */
  sendDelta?: (delta: string) => void;
  /** Platform-specific: show typing indicator. */
  sendTypingIfEnabled(): Promise<void>;
  clearTyping(): void;
  platformLabel: string;
}

/** Default chat timeout — 10 minutes. Platforms can override via platformConfig. */
const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60 * 1000;

// ─── handleChat ───────────────────────────────────────────────────

/**
 * Execute the relay chat flow.
 *
 * @param content       the enriched message content to send
 * @param ctx           mutable chat context
 * @param replyToId     optional original message ID for reply threading
 * @param timeoutMs     how long to wait before rejecting (default: 10 min)
 * @param images        optional images to pass alongside text (base64 data URIs)
 * @returns the final response text, or null on error
 */
export async function handleChat(
  content: string,
  ctx: ChatContext,
  replyToId?: string,
  timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
  images?: Array<{ url: string; mediaType?: string }>,
): Promise<string | null> {
  const requestId = `chat-${Date.now()}`;
  const { relay, bridge } = ctx;

  console.log(
    `[${ctx.platformLabel}] handleChat: requestId=${requestId}, threadId=${ctx.getThreadId() ?? "new"}`,
  );

  let typingInterval: ReturnType<typeof setInterval> | null = null;

  try {
    await ctx.sendTypingIfEnabled();
    // Keep typing indicator alive while waiting
    const keepAliveMs = 4_000; // safe default — platforms override if needed
    typingInterval = setInterval(async () => {
      try { await ctx.sendTypingIfEnabled(); } catch { /* non-critical */ }
    }, keepAliveMs);
  } catch { /* non-critical */ }

  try {
    let buffer = "";
    let deltaCount = 0;

    const finalMsg = await new Promise<ChatFinalMessage>((resolve, reject) => {
      const unsub1 = relay.on<ChatDeltaMessage>("chat:delta", (deltaMsg) => {
        if (deltaMsg.requestId === requestId) {
          deltaCount++;
          buffer += deltaMsg.delta;
          // Forward to bridge when platform supports streaming (e.g. PWA WebSocket)
          ctx.sendDelta?.(deltaMsg.delta);
          if (deltaCount % 20 === 0) {
            console.log(`[${ctx.platformLabel}] Streaming: ${deltaCount} deltas, ${buffer.length} chars`);
          }
        }
      });

      const unsub2 = relay.on<ChatFinalMessage>("chat:final", (msg) => {
        if (msg.requestId === requestId) {
          unsub1(); unsub2(); unsub3();
          resolve(msg);
        }
      });

      const unsub3 = relay.on("error", (errMsg) => {
        if ((errMsg as any).requestId === requestId) {
          unsub1(); unsub2(); unsub3();
          reject(new Error((errMsg as any).message ?? "Unknown relay error"));
        }
      });

      try {
        relay.send({
          type: "chat:send",
          content,
          threadId: ctx.getThreadId() ?? undefined,
          requestId,
          modelOverride: ctx.getModelOverride(),
          images,
        });
      } catch (sendErr) {
        unsub1(); unsub2(); unsub3();
        reject(sendErr);
        return;
      }

      setTimeout(() => {
        unsub1(); unsub2(); unsub3();
        reject(new Error(`Request timed out (${timeoutMs / 60_000} min)`));
      }, timeoutMs);
    });

    // Persist thread ID after first response
    if (finalMsg.threadId && !ctx.getThreadId()) {
      ctx.setThreadId(finalMsg.threadId);
      console.log(`[${ctx.platformLabel}] Thread ID saved: ${finalMsg.threadId}`);
    }

    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    ctx.clearTyping();

    const responseText = finalMsg.content || buffer;
    console.log(`[${ctx.platformLabel}] Response ready: ${responseText.length} chars`);

    if (responseText.trim()) {
      await ctx.sendResponse(responseText, replyToId);
      return responseText;
    } else {
      console.warn(`[${ctx.platformLabel}] Empty response from relay`);
      await bridge.sendText(
        "(No response from agent — the relay server may not have an active agent or LLM backend configured.)",
      );
      return null;
    }
  } catch (err) {
    if (typingInterval) { clearInterval(typingInterval); }
    ctx.clearTyping();
    console.error(`[${ctx.platformLabel}] Chat error:`, err);
    await bridge.sendText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
