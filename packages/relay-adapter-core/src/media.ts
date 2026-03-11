/**
 * MediaHandler — shared media processing for relay adapters.
 *
 * Handles:
 * - AI vision for image description via OpenRouter
 * - Document text extraction (rich format support)
 * - Temp file management with periodic cleanup
 *
 * Platform-specific features (Baileys media download, sticker conversion)
 * remain in their respective adapter packages.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface MediaHandlerConfig {
  openRouterApiKey?: string;
  visionModel?: string;
  tempDir?: string;
  tempMaxAge?: number;
}

export class MediaHandler {
  protected openRouterApiKey: string | null;
  protected visionModel: string;
  protected tempDir: string;
  protected tempMaxAge: number;
  protected cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: MediaHandlerConfig = {}) {
    this.openRouterApiKey = config.openRouterApiKey ?? null;
    this.visionModel = config.visionModel ?? "google/gemini-2.5-flash-preview-05-20";
    this.tempDir = config.tempDir ?? path.join(process.cwd(), ".media-temp");
    this.tempMaxAge = config.tempMaxAge ?? 60 * 60 * 1000;

    fs.mkdirSync(this.tempDir, { recursive: true });
    this.cleanupInterval = setInterval(() => this.cleanupTemp(), 30 * 60 * 1000);
  }

  get canDescribe(): boolean {
    return !!this.openRouterApiKey;
  }

  async describeImage(buffer: Buffer, prompt?: string): Promise<string> {
    if (!this.openRouterApiKey) {
      return "(AI vision not available — set OPENROUTER_API_KEY)";
    }

    const base64 = buffer.toString("base64");
    const mimeGuess = detectImageMime(buffer);

    const systemPrompt = "You are a helpful assistant. Describe what you see in the image concisely.";
    const userPrompt = prompt ?? "What is in this image? Be concise but thorough.";

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://agent-hq.local",
        },
        body: JSON.stringify({
          model: this.visionModel,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userPrompt },
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeGuess};base64,${base64}` },
                },
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
    } catch (err) {
      console.error("[media] Vision API call failed:", err);
      return `(Vision failed: ${err instanceof Error ? err.message : String(err)})`;
    }
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
