/**
 * Gemini provider — Google's generateContent API with function calling.
 *
 * Gemini uses a different format from both OpenAI and Anthropic:
 * - Tools use functionDeclarations (not tools/input_schema)
 * - Tool calls are functionCall parts
 * - Tool results are functionResponse parts
 * - System prompt is a top-level systemInstruction field
 */

import type { ModelProvider, ChatRequest, ChatResponse, ProviderConfig } from "./base.js";
import type { ToolCall } from "../types.js";
import { ProviderError } from "./openai.js";

export class GeminiProvider implements ModelProvider {
  readonly id = "gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/models/${request.model}:generateContent?key=${this.apiKey}`;

    const body: Record<string, unknown> = {
      contents: this.formatContents(request),
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
    };

    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: this.sanitizeSchema(t.function.parameters),
          })),
        },
      ];
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new ProviderError(`Gemini API ${resp.status}: ${text}`, resp.status);
    }

    const data = await resp.json() as any;
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new ProviderError("Gemini API returned no candidates", 0);
    }

    let textContent = "";
    const toolCalls: ToolCall[] = [];
    let callIndex = 0;

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        textContent += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `call_${callIndex++}`,
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }

    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cacheReadTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
      },
      finishReason: this.mapFinishReason(candidate.finishReason, toolCalls.length > 0),
    };
  }

  /**
   * Format messages as Gemini contents.
   *
   * Gemini uses:
   * - role: "user" | "model" (no "system" or "assistant")
   * - functionCall parts for tool invocations
   * - functionResponse parts for tool results
   */
  private formatContents(request: ChatRequest): any[] {
    const contents: any[] = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        // System messages handled via systemInstruction
        continue;
      }

      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: this.textContent(msg.content) }],
        });
      } else if (msg.role === "assistant") {
        const parts: any[] = [];
        const text = this.textContent(msg.content);
        if (text) parts.push({ text });

        if (msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments),
              },
            });
          }
        }

        if (parts.length > 0) {
          contents.push({ role: "model", parts });
        }
      } else if (msg.role === "tool") {
        // Find the tool name from the corresponding assistant tool_call
        const toolName = msg.name ?? "unknown";
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: toolName,
                response: { result: this.textContent(msg.content) },
              },
            },
          ],
        });
      }
    }

    return contents;
  }

  /**
   * Gemini is strict about JSON Schema — strip unsupported keywords
   * like "additionalProperties" that TypeBox generates.
   */
  private sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };
    delete cleaned.additionalProperties;
    delete cleaned.$schema;

    if (cleaned.properties && typeof cleaned.properties === "object") {
      const props: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(cleaned.properties as Record<string, unknown>)) {
        props[key] = typeof val === "object" && val !== null ? this.sanitizeSchema(val as Record<string, unknown>) : val;
      }
      cleaned.properties = props;
    }

    if (cleaned.items && typeof cleaned.items === "object") {
      cleaned.items = this.sanitizeSchema(cleaned.items as Record<string, unknown>);
    }

    return cleaned;
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
    if (reason === "STOP") return "stop";
    if (reason === "MAX_TOKENS") return "length";
    return "stop";
  }
}
