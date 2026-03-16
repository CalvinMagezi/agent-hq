/**
 * MediaHandler — shared media processing for relay adapters.
 *
 * Handles:
 * - AI vision for image description (supports Gemini, OpenRouter, Anthropic)
 * - Document text extraction (rich format support)
 * - Temp file management with periodic cleanup
 *
 * Platform-specific features (Baileys media download, sticker conversion)
 * remain in their respective adapter packages.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { resolveVisionProvider, type ChatProviderConfig } from "@repo/vault-client";

export interface MediaHandlerConfig {
  /** @deprecated Use auto-detection or set env vars (GEMINI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY) */
  openRouterApiKey?: string;
  visionModel?: string;
  tempDir?: string;
  tempMaxAge?: number;
}

export class MediaHandler {
  protected visionProvider: ChatProviderConfig;
  protected tempDir: string;
  protected tempMaxAge: number;
  protected cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: MediaHandlerConfig = {}) {
    // Auto-detect vision provider from env vars
    this.visionProvider = resolveVisionProvider();

    // Legacy backward compat: if explicit key was passed and no provider was detected, use it
    if (config.openRouterApiKey && this.visionProvider.type === "none") {
      this.visionProvider = {
        type: "openrouter",
        apiKey: config.openRouterApiKey,
        baseUrl: "https://openrouter.ai/api/v1",
        model: config.visionModel ?? "google/gemini-2.5-flash-preview-05-20",
      };
    }
    if (config.visionModel && this.visionProvider.type !== "none") {
      this.visionProvider = { ...this.visionProvider, model: config.visionModel };
    }

    this.tempDir = config.tempDir ?? path.join(process.cwd(), ".media-temp");
    this.tempMaxAge = config.tempMaxAge ?? 60 * 60 * 1000;

    fs.mkdirSync(this.tempDir, { recursive: true });
    this.cleanupInterval = setInterval(() => this.cleanupTemp(), 30 * 60 * 1000);
  }

  get canDescribe(): boolean {
    return this.visionProvider.type !== "none";
  }

  async describeImage(buffer: Buffer, prompt?: string): Promise<string> {
    if (this.visionProvider.type === "none") {
      return "(AI vision not available — set GEMINI_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY)";
    }

    const base64 = buffer.toString("base64");
    const mimeGuess = detectImageMime(buffer);
    const systemPrompt = "You are a helpful assistant. Describe what you see in the image concisely.";
    const userPrompt = prompt ?? "What is in this image? Be concise but thorough.";

    try {
      if (this.visionProvider.type === "gemini") {
        return await this.describeViaGemini(base64, mimeGuess, systemPrompt, userPrompt);
      }
      if (this.visionProvider.type === "anthropic") {
        return await this.describeViaAnthropic(base64, mimeGuess, systemPrompt, userPrompt);
      }
      // OpenRouter (default)
      return await this.describeViaOpenAI(base64, mimeGuess, systemPrompt, userPrompt);
    } catch (err) {
      console.error("[media] Vision API call failed:", err);
      return `(Vision failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  }

  private async describeViaOpenAI(
    base64: string, mime: string, system: string, user: string,
  ): Promise<string> {
    const response = await fetch(`${this.visionProvider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.visionProvider.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agent-hq.local",
      },
      body: JSON.stringify({
        model: this.visionProvider.model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[media] Vision API error (${response.status}):`, err);
      return `(Vision API error: ${response.status})`;
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content?.trim() ?? "(No description generated)";
  }

  private async describeViaGemini(
    base64: string, mime: string, system: string, user: string,
  ): Promise<string> {
    const url = `${this.visionProvider.baseUrl}/models/${this.visionProvider.model}:generateContent?key=${this.visionProvider.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          parts: [
            { text: user },
            { inlineData: { mimeType: mime, data: base64 } },
          ],
        }],
        generationConfig: { maxOutputTokens: 500 },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[media] Gemini Vision error (${response.status}):`, err);
      return `(Vision API error: ${response.status})`;
    }

    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "(No description generated)";
  }

  private async describeViaAnthropic(
    base64: string, mime: string, system: string, user: string,
  ): Promise<string> {
    const response = await fetch(`${this.visionProvider.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.visionProvider.apiKey!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.visionProvider.model,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
            { type: "text", text: user },
          ],
        }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[media] Anthropic Vision error (${response.status}):`, err);
      return `(Vision API error: ${response.status})`;
    }

    const json = (await response.json()) as {
      content?: { type: string; text?: string }[];
    };
    return json.content?.find((b) => b.type === "text")?.text?.trim() ?? "(No description generated)";
  }

  extractDocumentText(buffer: Buffer, mimetype: string, filename?: string): string {
    const ext = filename ? filename.split(".").pop()?.toLowerCase() ?? "" : "";

    // Plain text types
    if (
      mimetype === "text/plain" ||
      mimetype === "text/csv" ||
      mimetype.startsWith("text/x-typescript") ||
      mimetype === "text/typescript" ||
      mimetype === "text/javascript" ||
      mimetype === "application/javascript" ||
      mimetype === "text/x-python" ||
      mimetype === "application/x-python" ||
      mimetype === "text/x-sh" ||
      mimetype === "application/x-sh" ||
      mimetype === "text/x-shellscript" ||
      mimetype === "text/markdown" ||
      mimetype === "text/x-markdown" ||
      mimetype === "application/yaml" ||
      mimetype === "text/yaml" ||
      mimetype === "text/x-yaml" ||
      (mimetype === "application/octet-stream" &&
        ["ts", "tsx", "js", "jsx", "py", "sh", "bash", "md", "mdx", "yaml", "yml", "json", "toml"].includes(ext))
    ) {
      const text = buffer.toString("utf-8");
      const limit = 3000;
      return text.length > limit ? text.substring(0, limit) + "\n... [truncated]" : text;
    }

    // JSON
    if (mimetype === "application/json" || ext === "json") {
      try {
        const parsed = JSON.parse(buffer.toString("utf-8"));
        const pretty = JSON.stringify(parsed, null, 2);
        return pretty.length > 3000 ? pretty.substring(0, 3000) + "\n... [truncated]" : pretty;
      } catch {
        const raw = buffer.toString("utf-8");
        return raw.length > 3000 ? raw.substring(0, 3000) + "\n... [truncated]" : raw;
      }
    }

    // HTML
    if (mimetype === "text/html" || ext === "html" || ext === "htm") {
      const raw = buffer.toString("utf-8");
      const stripped = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      return stripped.length > 2000 ? stripped.substring(0, 2000) + "\n... [truncated]" : stripped;
    }

    // PDF via pdftotext
    if (mimetype === "application/pdf" || ext === "pdf") {
      try {
        const result = execSync("pdftotext - -", {
          input: buffer,
          timeout: 10_000,
          encoding: "utf-8",
        }) as string;
        if (result && result.trim()) {
          return result.length > 3000 ? result.substring(0, 3000) + "\n... [truncated]" : result.trim();
        }
      } catch {
        // pdftotext not available — fall through
      }
      const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
      return `(Binary PDF: ${sizeMB}MB — install Poppler/pdftotext for text extraction)`;
    }

    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
    return `(Binary document: ${sizeMB}MB, type: ${mimetype})`;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  saveTempFile(buffer: Buffer, filename: string): string {
    const tempPath = path.join(this.tempDir, filename);
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
  }

  cleanupTemp(): void {
    if (!fs.existsSync(this.tempDir)) return;

    const now = Date.now();
    let cleaned = 0;

    try {
      for (const file of fs.readdirSync(this.tempDir)) {
        const filePath = path.join(this.tempDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > this.tempMaxAge) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        console.log(`[media] Cleaned up ${cleaned} temp files`);
      }
    } catch (err) {
      console.error("[media] Temp cleanup error:", err);
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export function detectImageMime(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer.length > 11 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "image/webp";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  return "image/jpeg";
}
