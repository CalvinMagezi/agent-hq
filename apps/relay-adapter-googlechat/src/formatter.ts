/**
 * formatter — Convert standard markdown to Google Chat text format.
 *
 * Google Chat text messages support a subset of markdown:
 *   Bold: *text*
 *   Italic: _text_
 *   Strikethrough: ~text~
 *   Inline code: `code`
 *   Code blocks: ```code```
 *   Links: plain URLs are auto-linked
 *
 * Since our LLM responses are already markdown, most formatting passes through
 * unchanged. We only need to handle a few edge cases.
 */

/** Max text length for a single Google Chat message. */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Format text for Google Chat. Mostly a pass-through since Google Chat
 * supports standard markdown formatting.
 */
export function formatForGoogleChat(text: string): string {
  // Strip HTML tags if present (some harnesses output HTML)
  let formatted = text
    .replace(/<b>(.*?)<\/b>/g, "*$1*")
    .replace(/<strong>(.*?)<\/strong>/g, "*$1*")
    .replace(/<i>(.*?)<\/i>/g, "_$1_")
    .replace(/<em>(.*?)<\/em>/g, "_$1_")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/<s>(.*?)<\/s>/g, "~$1~")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/?p>/g, "\n")
    .replace(/<a\s+href="(.*?)".*?>(.*?)<\/a>/g, "$2 ($1)")
    // Remove any remaining HTML tags
    .replace(/<[^>]+>/g, "");

  // Collapse excessive newlines
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted.trim();
}

/**
 * Chunk text into pieces that fit within Google Chat's message limit.
 * Tries to break at newlines or sentence boundaries.
 */
export function chunkText(text: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakAt = maxLen;

    // Try to break at a double newline (paragraph boundary)
    const doubleNl = remaining.lastIndexOf("\n\n", maxLen);
    if (doubleNl > maxLen * 0.5) {
      breakAt = doubleNl + 2;
    } else {
      // Try single newline
      const singleNl = remaining.lastIndexOf("\n", maxLen);
      if (singleNl > maxLen * 0.5) {
        breakAt = singleNl + 1;
      }
    }

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }

  return chunks;
}
