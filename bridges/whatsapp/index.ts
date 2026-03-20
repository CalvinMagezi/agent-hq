/**
 * HQ WhatsApp Bridge — thin Baileys wrapper that pipes messages
 * to the Rust HQ relay via HTTP.
 *
 * Architecture:
 *   WhatsApp ←→ Baileys ←→ this bridge ←→ HQ Rust (port 5678)
 *
 * Security: owner-only (WHATSAPP_OWNER_JID). Only self-chat messages
 * are processed. Group messages are silently ignored.
 *
 * Media: downloaded, saved to vault, path included in message text.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers,
  type WASocket,
  type proto,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";

// ─── Config ─────────────────────────────────────────────────────

const OWNER_JID = process.env.WHATSAPP_OWNER_JID;
if (!OWNER_JID) {
  console.error("FATAL: WHATSAPP_OWNER_JID not set");
  process.exit(1);
}

const VAULT_PATH = process.env.VAULT_PATH
  ?? process.env.HQ_VAULT_PATH
  ?? path.resolve(process.cwd(), ".vault");

const HQ_API = process.env.HQ_API_URL ?? "http://localhost:5678";
const AUTH_DIR = path.join(VAULT_PATH, "_whatsapp-auth");
const MEDIA_DIR = path.join(VAULT_PATH, "_media");

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const logger = pino({ level: "warn" });

// ─── Media Helpers ──────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "video/mp4": "mp4", "audio/ogg; codecs=opus": "ogg",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
};

function todayDir(): string {
  const d = new Date().toISOString().slice(0, 10);
  const dir = path.join(MEDIA_DIR, d);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveMedia(
  msg: proto.IWebMessageInfo,
  type: "image" | "video" | "audio" | "document" | "sticker",
): Promise<{ path: string; mime: string; size: number } | null> {
  try {
    const buffer = (await downloadMediaMessage(msg, "buffer", {})) as Buffer;
    const m = msg.message!;
    let mime = "application/octet-stream";
    let fname = `${type}-${Date.now()}`;

    if (type === "image") {
      mime = m.imageMessage?.mimetype ?? "image/jpeg";
    } else if (type === "video") {
      mime = m.videoMessage?.mimetype ?? "video/mp4";
    } else if (type === "audio") {
      mime = m.audioMessage?.mimetype ?? "audio/ogg";
    } else if (type === "document") {
      mime = m.documentMessage?.mimetype ?? "application/octet-stream";
      fname = m.documentMessage?.fileName ?? fname;
    } else if (type === "sticker") {
      mime = m.stickerMessage?.mimetype ?? "image/webp";
    }

    const ext = MIME_EXT[mime] ?? mime.split("/")[1] ?? "bin";
    if (!fname.includes(".")) fname += `.${ext}`;

    const savePath = path.join(todayDir(), fname);
    fs.writeFileSync(savePath, buffer);

    return { path: savePath, mime, size: buffer.length };
  } catch (err) {
    console.error(`[wa-bridge] Failed to download ${type}:`, err);
    return null;
  }
}

async function transcribeVoice(audioPath: string): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const formData = new FormData();
    formData.append("file", new Blob([fs.readFileSync(audioPath)]), "voice.ogg");
    formData.append("model", "whisper-large-v3");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (resp.ok) {
      const data = await resp.json() as { text: string };
      return data.text;
    }
  } catch (err) {
    console.error("[wa-bridge] Transcription failed:", err);
  }
  return null;
}

// ─── HQ API Communication ───────────────────────────────────────

interface HqRequest {
  text: string;
  chat_id: string;
  platform: "whatsapp";
  reply_to?: string;
}

async function sendToHQ(request: HqRequest): Promise<string> {
  try {
    const resp = await fetch(`${HQ_API}/api/wa-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (resp.ok) {
      const data = await resp.json() as { response: string };
      return data.response;
    }

    // Fallback: call the HQ CLI directly
    return await callHqCli(request.text);
  } catch {
    return await callHqCli(request.text);
  }
}

async function callHqCli(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "--dangerously-skip-permissions", "--output-format", "stream-json",
     "--verbose", "--max-turns", "100", "--model", "opus", "-p", prompt],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  let text = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        // Extract text from assistant messages
        if (json.type === "assistant" && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === "text" && block.text) text += block.text;
          }
        }
        // Extract result
        if (json.type === "result" && json.result && !text) {
          text = json.result;
        }
      } catch {}
    }
  }

  await proc.exited;
  return text || "No response received.";
}

// ─── WhatsApp Connection ────────────────────────────────────────

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version: [number, number, number];
  try {
    const { version: v } = await fetchLatestBaileysVersion();
    version = v;
  } catch {
    version = [2, 3000, 0];
  }

  const sock: WASocket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS("HQ"),
    logger,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n[wa-bridge] Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log(`[wa-bridge] Connected to WhatsApp (owner: ${OWNER_JID})`);
    }

    if (connection === "close") {
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.error("[wa-bridge] Logged out. Delete auth state and re-scan.");
        process.exit(1);
      }
      console.log(`[wa-bridge] Disconnected (${reason}), reconnecting...`);
      setTimeout(startWhatsApp, 3000);
    }
  });

  // Track message IDs we've sent as replies to avoid infinite loops in self-chat
  const sentMessageIds = new Set<string>();

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      // Owner-only guard
      const jid = msg.key.remoteJid;
      if (!jid || jid !== OWNER_JID) continue;

      // Skip status broadcasts
      if (jid === "status@broadcast") continue;

      // Skip messages we sent as bot replies (prevent loops)
      const msgId = msg.key.id;
      if (msgId && sentMessageIds.has(msgId)) continue;

      // Skip protocol/notification messages
      if (msg.message.protocolMessage || msg.message.reactionMessage) continue;

      // Extract text
      let text = msg.message.conversation
        ?? msg.message.extendedTextMessage?.text
        ?? msg.message.imageMessage?.caption
        ?? msg.message.videoMessage?.caption
        ?? msg.message.documentMessage?.caption
        ?? "";

      // Handle media
      if (msg.message.imageMessage) {
        const media = await saveMedia(msg, "image");
        if (media) text = `[Image attached: ${media.path}]\n\n${text}`.trim();
      } else if (msg.message.videoMessage) {
        const media = await saveMedia(msg, "video");
        if (media) text = `[Video attached: ${media.path}]\n\n${text}`.trim();
      } else if (msg.message.documentMessage) {
        const media = await saveMedia(msg, "document");
        if (media) {
          // Try to read text content for text files
          if (media.mime.startsWith("text/") || ["application/json", "application/yaml"].includes(media.mime)) {
            const content = fs.readFileSync(media.path, "utf-8").slice(0, 3000);
            text = `[Document: ${media.path}]\n\`\`\`\n${content}\n\`\`\`\n\n${text}`.trim();
          } else {
            text = `[Document attached: ${media.path} (${media.mime})]\n\n${text}`.trim();
          }
        }
      } else if (msg.message.audioMessage) {
        const isVoice = msg.message.audioMessage.ptt === true;
        const media = await saveMedia(msg, "audio");
        if (media && isVoice) {
          const transcript = await transcribeVoice(media.path);
          if (transcript) {
            text = `[Voice note transcription]: ${transcript}`;
          } else {
            text = `[Voice note attached: ${media.path}]`;
          }
        } else if (media) {
          text = `[Audio attached: ${media.path}]\n\n${text}`.trim();
        }
      } else if (msg.message.stickerMessage) {
        const media = await saveMedia(msg, "sticker");
        if (media) text = `[Sticker: ${media.path}]`;
      }

      if (!text.trim()) continue;

      // Handle commands
      const lower = text.toLowerCase().trim();
      if (lower === "/reset" || lower === "!reset") {
        const s = await sock.sendMessage(jid, { text: "Conversation reset." });
        if (s?.key?.id) sentMessageIds.add(s.key.id);
        continue;
      }
      if (lower === "/status" || lower === "!status") {
        const s = await sock.sendMessage(jid, { text: "Status: WhatsApp bridge connected via HQ (Rust)" });
        if (s?.key?.id) sentMessageIds.add(s.key.id);
        continue;
      }
      if (lower === "/help" || lower === "!help") {
        const s = await sock.sendMessage(jid, {
          text: "HQ WhatsApp Commands\n\n/reset — Clear conversation\n/status — Show status\n/help — This help\n\nSend any message, image, document, or voice note.",
        });
        if (s?.key?.id) sentMessageIds.add(s.key.id);
        continue;
      }

      // Send typing indicator
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate("composing", jid);

      console.log(`[wa-bridge] Message from owner: ${text.slice(0, 80)}...`);

      // Get response from HQ
      const response = await sendToHQ({
        text,
        chat_id: jid,
        platform: "whatsapp",
      });

      await sock.sendPresenceUpdate("paused", jid);

      // Send response — track IDs to prevent self-chat loops
      const MAX_LEN = 4096;
      const trackSent = (sent: any) => {
        if (sent?.key?.id) sentMessageIds.add(sent.key.id);
        // Keep set bounded
        if (sentMessageIds.size > 100) {
          const first = sentMessageIds.values().next().value;
          if (first) sentMessageIds.delete(first);
        }
      };

      if (response.length <= MAX_LEN) {
        const sent = await sock.sendMessage(jid, { text: response }, { quoted: msg });
        trackSent(sent);
      } else {
        // Smart chunking
        const chunks: string[] = [];
        let rem = response;
        while (rem.length > MAX_LEN) {
          let split = rem.lastIndexOf("\n\n", MAX_LEN);
          if (split === -1) split = rem.lastIndexOf("\n", MAX_LEN);
          if (split === -1) split = rem.lastIndexOf(" ", MAX_LEN);
          if (split === -1) split = MAX_LEN;
          chunks.push(rem.slice(0, split));
          rem = rem.slice(split).trim();
        }
        if (rem) chunks.push(rem);

        for (let i = 0; i < chunks.length; i++) {
          const sent = await sock.sendMessage(
            jid,
            { text: chunks[i] },
            i === 0 ? { quoted: msg } : undefined,
          );
          trackSent(sent);
        }
      }

      // React with checkmark
      const reactSent = await sock.sendMessage(jid, {
        react: { text: "✅", key: msg.key },
      });
      trackSent(reactSent);
    }
  });
}

console.log("[wa-bridge] Starting WhatsApp bridge...");
console.log(`[wa-bridge] Owner JID: ${OWNER_JID}`);
console.log(`[wa-bridge] Vault: ${VAULT_PATH}`);
console.log(`[wa-bridge] HQ API: ${HQ_API}`);
startWhatsApp();
