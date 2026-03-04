/**
 * MediaHandler — process and manage media for Telegram messages.
 *
 * Handles:
 * - AI vision for image description via OpenRouter
 * - Document text extraction
 * - Temp file management with periodic cleanup
 *
 * Note: File downloads are handled by TelegramBridge (not here).
 * This handler receives buffers directly.
 */

import fs from "node:fs";
import path from "node:path";

export interface MediaHandlerConfig {
  /** OpenRouter API key for AI vision. */
  openRouterApiKey?: string;
  /** Vision model ID (default: google/gemini-2.5-flash-preview-05-20). */
  visionModel?: string;
  /** Temp directory for media files. */
  tempDir?: string;
  /** Max age for temp files in ms (default: 1 hour). */
  tempMaxAge?: number;
}

export class MediaHandler {
  private openRouterApiKey: string | null;
  private visionModel: string;
  private tempDir: string;
  private tempMaxAge: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

  /**
   * Describe an image using AI vision via OpenRouter.
   */
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

  /**
   * Extract text content from a document buffer based on mimetype.
   * Returns first ~2000 chars for context.
   */
  extractDocumentText(buffer: Buffer, mimetype: string): string {
    if (mimetype === "text/plain" || mimetype === "text/csv") {
      const text = buffer.toString("utf-8");
      return text.length > 2000 ? text.substring(0, 2000) + "..." : text;
    }

    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
    return `(Binary document: ${sizeMB}MB, type: ${mimetype})`;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Save a buffer to temp directory. Returns the temp file path.
   */
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

function detectImageMime(buffer: Buffer): string {
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
