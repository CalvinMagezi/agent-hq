import type { Message } from "discord.js";
import { chunkMessage } from "./chunker.js";

/**
 * Progressive message editor for streaming AI responses.
 * Sends an initial "Thinking..." reply, then edits it periodically
 * as chunks arrive, and does a final edit with the complete response.
 */
export class StreamingReply {
  private reply: Message | null = null;
  private buffer = "";
  private lastEditContent = "";
  private editTimer: ReturnType<typeof setInterval> | null = null;
  private sourceMessage: Message;
  private finished = false;

  /** Minimum interval between message edits (Discord rate-limit safe) */
  private static readonly EDIT_INTERVAL_MS = 1500;
  private static readonly MAX_DISPLAY = 1900; // leave room for "..." suffix

  constructor(sourceMessage: Message) {
    this.sourceMessage = sourceMessage;
  }

  /** Send the initial placeholder reply and start the edit interval. */
  async start(): Promise<void> {
    this.reply = await this.sourceMessage.reply("*Thinking...*");
    this.editTimer = setInterval(() => this.flush(), StreamingReply.EDIT_INTERVAL_MS);
  }

  /** Append a chunk of streamed text. */
  append(chunk: string): void {
    this.buffer += chunk;
  }

  /** Edit the reply with current buffer contents. */
  private async flush(): Promise<void> {
    if (!this.reply || this.finished) return;
    if (this.buffer === this.lastEditContent) return;
    // If buffer is empty, show processing indicator
    if (!this.buffer.trim()) return;

    let display = this.buffer;
    if (display.length > StreamingReply.MAX_DISPLAY) {
      // Show the most recent content so the user sees progress
      display = "..." + display.slice(-StreamingReply.MAX_DISPLAY);
    }

    try {
      await this.reply.edit(display);
      this.lastEditContent = this.buffer;
    } catch {
      // Rate-limited or message deleted — ignore
    }
  }

  /**
   * Finalize with the complete response text.
   * If the response fits in one message, edits the reply in place.
   * If >2000 chars, edits the first chunk into the reply and sends additional messages.
   */
  async finish(finalText: string): Promise<Message[]> {
    if (this.finished) return this.reply ? [this.reply] : [];
    this.finished = true;
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }

    if (!this.reply) {
      // Fallback: start() was never called
      const chunks = chunkMessage(finalText, 2000);
      const messages: Message[] = [];
      for (const chunk of chunks) {
        messages.push(await this.sourceMessage.reply(chunk));
      }
      return messages;
    }

    const chunks = chunkMessage(finalText, 2000);
    const messages: Message[] = [];

    // Edit the first chunk into the existing reply
    try {
      await this.reply.edit(chunks[0]);
      messages.push(this.reply);
    } catch {
      // If edit fails (deleted?), send as new message
      messages.push(await this.sourceMessage.reply(chunks[0]));
    }

    // Send any additional chunks as follow-up replies
    for (let i = 1; i < chunks.length; i++) {
      messages.push(await this.sourceMessage.reply(chunks[i]));
    }

    return messages;
  }

  /** Edit the reply with an error message and clean up. */
  async error(errorText: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }

    if (this.reply) {
      try {
        await this.reply.edit(errorText);
      } catch {
        await this.sourceMessage.reply(errorText).catch(() => {});
      }
    } else {
      await this.sourceMessage.reply(errorText).catch(() => {});
    }
  }

  /** Clean up timers (call if aborting before finish). */
  dispose(): void {
    this.finished = true;
    if (this.editTimer) {
      clearInterval(this.editTimer);
      this.editTimer = null;
    }
  }
}
