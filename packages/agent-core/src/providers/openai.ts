/**
 * OpenAI-compatible provider — covers OpenRouter, Ollama, and native OpenAI.
 *
 * Uses the standard /chat/completions endpoint with function calling.
 * This is the most widely compatible provider format.
 */

import type { ModelProvider, ChatRequest, ChatResponse, ProviderConfig, ToolDefinition } from "./base.js";
import type { ChatMessage, ToolCall } from "../types.js";

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  private apiKey: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(config: ProviderConfig & { extraHeaders?: Record<string, string> }) {
    this.id = "openai";
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://openrouter.ai/api/v1";
    this.extraHeaders = config.extraHeaders ?? {};
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.formatMessages(request);
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = "auto";
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new ProviderError(`OpenAI API ${resp.status}: ${text}`, resp.status);
    }

    const data = await resp.json() as any;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ProviderError("OpenAI API returned empty choices", 0);
    }

    const message = choice.message;
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    return {
      content: message.content ?? "",
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason: this.mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    };
  }

  private formatMessages(request: ChatRequest): any[] {
    const msgs: any[] = [];

    // System prompt as first message
    if (request.systemPrompt) {
      msgs.push({ role: "system", content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === "system") {
        msgs.push({ role: "system", content: this.textContent(msg.content) });
      } else if (msg.role === "user") {
        msgs.push({ role: "user", content: this.textContent(msg.content) });
      } else if (msg.role === "assistant") {
        const formatted: any = { role: "assistant" };
        if (msg.content) formatted.content = this.textContent(msg.content);
        if (msg.tool_calls?.length) {
          formatted.tool_calls = msg.tool_calls.map(tc => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }));
        }
        msgs.push(formatted);
      } else if (msg.role === "tool") {
        msgs.push({
          role: "tool",
          tool_call_id: msg.tool_call_id,
          content: this.textContent(msg.content),
        });
      }
    }

    return msgs;
  }

  private textContent(content: string | any[]): string {
    if (typeof content === "string") return content;
    return content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("");
  }

  private mapFinishReason(reason: string, hasToolCalls: boolean): ChatResponse["finishReason"] {
    if (hasToolCalls) return "tool_use";
    if (reason === "stop") return "stop";
    if (reason === "length") return "length";
    return "stop";
  }
}

export class ProviderError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "ProviderError";
  }

  get isTransient(): boolean {
    return this.statusCode === 429 || this.statusCode >= 500;
  }
}
