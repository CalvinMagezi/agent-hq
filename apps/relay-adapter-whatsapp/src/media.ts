/**
 * MediaHandler — download, process, and manage media for WhatsApp messages.
 *
 * Handles:
 * - Downloading received media (images, videos, documents, stickers)
 * - AI vision for image description via OpenRouter
 * - Sticker conversion (image → WebP via sharp)
 * - Temp file management with periodic cleanup
 */

import { downloadMediaMessage, type proto } from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";

export type MediaType = "image" | "video" | "audio" | "document" | "sticker";

export interface MediaFile {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  size: number;
  tempPath: string;
}

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

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg; codecs=opus": "ogg",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
};

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
    this.tempMaxAge = config.tempMaxAge ?? 60 * 60 * 1000; // 1 hour

    // Ensure temp dir exists
    fs.mkdirSync(this.tempDir, { recursive: true });

    // Periodic cleanup every 30 minutes
    this.cleanupInterval = setInterval(() => this.cleanupTemp(), 30 * 60 * 1000);
  }

  /** Whether AI vision is available. */
  get canDescribe(): boolean {
    return !!this.openRouterApiKey;
  }

  /**
   * Download media from a WhatsApp message and save to temp.
   */
  async downloadMedia(
    msg: proto.IWebMessageInfo,
    type: MediaType,
  ): Promise<MediaFile> {
    const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;

    const message = msg.message!;
    let mimetype = "application/octet-stream";
    let filename = `media-${Date.now()}`;

    switch (type) {
      case "image":
        mimetype = message.imageMessage?.mimetype ?? "image/jpeg";
        filename = `img-${Date.now()}`;
        break;
      case "video":
        mimetype = message.videoMessage?.mimetype ?? "video/mp4";
        filename = `vid-${Date.now()}`;
        break;
      case "audio":
        mimetype = message.audioMessage?.mimetype ?? "audio/ogg";
        filename = `aud-${Date.now()}`;
        break;
      case "document": {
        mimetype = message.documentMessage?.mimetype ?? "application/octet-stream";
        const docName = message.documentMessage?.fileName;
        // Sanitize filename: strip path separators to prevent traversal
        const rawName = docName ?? `doc-${Date.now()}`;
        filename = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_") || `doc-${Date.now()}`;
        break;
      }
      case "sticker":
        mimetype = message.stickerMessage?.mimetype ?? "image/webp";
        filename = `sticker-${Date.now()}`;
        break;
    }

    const ext = MIME_EXTENSIONS[mimetype] ?? mimetype.split("/")[1] ?? "bin";
    if (!filename.includes(".")) {
      filename = `${filename}.${ext}`;
    }

    const tempPath = path.join(this.tempDir, filename);
    fs.writeFileSync(tempPath, buffer);

    console.log(`[media] Downloaded ${type}: ${filename} (${buffer.length} bytes)`);

    return { buffer, mimetype, filename, size: buffer.length, tempPath };
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
   * Convert an image buffer to a WebP sticker (512x512 max).
   * Requires sharp — returns null if sharp is not available.
   */
  async prepareSticker(imageBuffer: Buffer): Promise<Buffer | null> {
    try {
      const sharp = (await import("sharp")).default;
      return await sharp(imageBuffer)
        .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (err) {
      console.error("[media] Sticker conversion failed (sharp may not be installed):", err);
      return null;
    }
  }

  /**
   * Extract text content from a document buffer based on mimetype.
   * Returns first ~2000 chars for context.
   */
  extractDocumentText(buffer: Buffer, mimetype: string): string {
    // For plain text files, just decode
    if (mimetype === "text/plain" || mimetype === "text/csv") {
      const text = buffer.toString("utf-8");
      return text.length > 2000 ? text.substring(0, 2000) + "..." : text;
    }

    // For binary formats, return metadata only
    const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
    return `(Binary document: ${sizeMB}MB, type: ${mimetype})`;
  }

  /**
   * Format a file size for display.
   */
  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  /**
   * Clean up temp files older than tempMaxAge.
   */
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

  /** Stop the cleanup interval. */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Detect image MIME type from buffer magic bytes.
 */
function detectImageMime(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  // WebP: RIFF header + "WEBP" at bytes 8-11 (distinguishes from WAV which is also RIFF)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 &&
    buffer.length > 11 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "image/webp";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  return "image/jpeg"; // fallback
}
