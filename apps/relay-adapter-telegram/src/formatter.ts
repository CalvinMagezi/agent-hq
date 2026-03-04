/**
 * Telegram Message Formatter — converts markdown to Telegram HTML.
 *
 * Uses HTML parse mode (more reliable than MarkdownV2 which requires
 * escaping many special characters).
 *
 * Supported Telegram HTML tags:
 *   <b>bold</b>, <i>italic</i>, <s>strikethrough</s>,
 *   <code>inline</code>, <pre>block</pre>, <a href="url">link</a>,
 *   <blockquote>quote</blockquote>
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert standard markdown to Telegram HTML formatting.
 */
export function formatForTelegram(markdown: string): string {
  if (!markdown) return "";

  let result = markdown;

  // Preserve code blocks — extract and replace with placeholders
  const codeBlocks: string[] = [];
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Escape remaining HTML entities in the text (but not our placeholders)
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/<(?!\x00)/g, "&lt;");
  result = result.replace(/(?<!\x00)>/g, "&gt;");

  // Headings: # Heading -> <b>HEADING</b>
  result = result.replace(/^#{1,2}\s+(.+)$/gm, (_, text) => `<b>${text.toUpperCase()}</b>`);
  result = result.replace(/^#{3,6}\s+(.+)$/gm, (_, text) => `<b>${text}</b>`);

  // Bold: **text** or __text__ -> <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* -> <i>text</i> (only standalone asterisks, not inside bold)
  result = result.replace(/(?<![*])\*([^*\n]+)\*(?![*])/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ -> <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Images: ![alt](url) -> [Image: alt]
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[Image: $1]");

  // Links: [text](url) -> <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Blockquotes: > text -> <blockquote>text</blockquote>
  // Collapse consecutive blockquote lines into a single block
  result = result.replace(
    /(?:^&gt;\s?(.*)$\n?)+/gm,
    (match) => {
      const lines = match
        .split("\n")
        .map((l) => l.replace(/^&gt;\s?/, "").trim())
        .filter(Boolean);
      return `<blockquote>${lines.join("\n")}</blockquote>`;
    },
  );

  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  // Unordered list bullets: - item or * item -> bullet
  result = result.replace(/^[\t ]*[-*]\s+/gm, "\u2022 ");

  // Restore inline code
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);

  // Restore code blocks
  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return result.trim();
}

/**
 * Strip all HTML tags for fallback plain-text sending.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
