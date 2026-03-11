/**
 * WhatsApp MediaHandler — extends core with Baileys-specific download and sticker support.
 */

import { downloadMediaMessage, type proto } from "@whiskeysockets/baileys";
import {
  MediaHandler as BaseMediaHandler,
  type MediaHandlerConfig,
} from "@repo/relay-adapter-core/media";
import path from "node:path";
import fs from "node:fs";

export type MediaType = "image" | "video" | "audio" | "document" | "sticker";

export interface MediaFile {
  buffer: Buffer;
  mimetype: string;
  filename: string;
  size: number;
  tempPath: string;
}

export { type MediaHandlerConfig } from "@repo/relay-adapter-core/media";

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

export class MediaHandler extends BaseMediaHandler {
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

    const tempPath = this.saveTempFile(buffer, filename);

    console.log(`[media] Downloaded ${type}: ${filename} (${buffer.length} bytes)`);

    return { buffer, mimetype, filename, size: buffer.length, tempPath };
  }

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
}
