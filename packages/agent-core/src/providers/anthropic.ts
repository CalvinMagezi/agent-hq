/**
 * Anthropic provider — native Messages API with tool_use content blocks.
 *
 * Anthropic uses a different tool format from OpenAI:
 * - Tools are defined with input_schema (not parameters)
 * - Tool results are content blocks (not separate messages)
 * - System prompt is a top-level field (not a message)
 */

import type { ModelProvider, ChatRequest, ChatResponse, ProviderConfig, ToolDefinition } from "./base.js";
import type { ToolCall } from "../types.js";
import { ProviderError } from "./openai.js";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      messages: this.formatMessages(request),
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const resp = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new ProviderError(`Anthropic API ${resp.status}: ${text}`, resp.status);
    }

    const data = await resp.json() as any;

    // Extract text content and tool calls from content blocks
    let textContent = "";
    const toolCalls: ToolCall[] = [];

    for (const block of data.content ?? []) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      },
      finishReason: this.mapStopReason(data.stop_reason, toolCalls.length > 0),
    };
  }

  /**
   * Format messages for Anthropic's API.
   *
   * Key differences from OpenAI:
   * - No "system" role in messages (system is top-level)
   * - Tool results are user messages with tool_result content blocks
   * - Assistant messages with tool calls use tool_use content blocks
   */
  private formatMessages(request: ChatRequest): any[] {
    const msgs: any[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        // System messages handled via top-level 'system' field
        continue;
      }

      if (msg.role === "user") {
        msgs.push({ role: "user", content: this.textContent(msg.content) });
      } else if (msg.role === "assistant") {
        const content: any[] = [];

        // Add text content if present
        const text = this.textContent(msg.content);
        if (text) {
          content.push({ type: "text", text });
        }

        // Add tool_use blocks
        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
        }

        if (content.length > 0) {
          msgs.push({ role: "assistant", content });
        }
      } else if (msg.role === "tool") {
        // Tool results become user messages with tool_result content blocks
        msgs.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: this.textContent(msg.content),
            },
          ],
        });
      }
    }

    // Anthropic requires messages to alternate user/assistant.
    // Merge consecutive same-role messages.
    return this.mergeConsecutive(msgs);
  }

  private mergeConsecutive(msgs: any[]): any[] {
    const merged: any[] = [];
    for (const msg of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // Merge content
        const lastContent = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
        const msgContent = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
        last.content = [...lastContent, ...msgContent];
      } else {
        merged.push(msg);
      }
    }
    return merged;
  }

  private textContent(content: string | any[]): string {
    if (typeof content === "string") return content;
    return content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("");
  }

  private mapStopReason(reason: string, hasToolCalls: boolean): ChatResponse["finishReason"] {
    if (hasToolCalls || reason === "tool_use") return "tool_use";
    if (reason === "end_turn" || reason === "stop_sequence") return "stop";
    if (reason === "max_tokens") return "length";
    return "stop";
  }
}
