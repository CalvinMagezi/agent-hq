/**
 * WhatsApp Message Formatter — converts markdown to WhatsApp-native formatting.
 *
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```monospace```, `inline code`
 * This module converts standard markdown (from LLM responses) to WhatsApp-compatible markup.
 */

/**
 * Convert standard markdown to WhatsApp-native formatting.
 *
 * Conversions:
 * - **bold** or __bold__  → *bold*
 * - *italic* (standalone) → _italic_  (careful not to conflict with bold)
 * - ~~strikethrough~~     → ~strikethrough~
 * - ```code blocks```     → ```code blocks```  (WhatsApp supports this natively)
 * - `inline code`         → `inline code`      (already compatible)
 * - # Heading             → *HEADING*
 * - ## Subheading         → *Subheading*
 * - - bullet / * bullet   → • bullet
 * - 1. numbered           → 1. numbered (kept as-is)
 * - [text](url)           → text (url)
 * - ![alt](url)           → [Image: alt]
 * - > blockquote          → ▎ quote
 * - ---                   → ━━━━━━━━━━
 */
export function formatForWhatsApp(markdown: string): string {
  if (!markdown) return "";

  let result = markdown;

  // Preserve code blocks from being modified
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  // Preserve inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `__INLINECODE_${inlineCodes.length - 1}__`;
  });

  // Headings: # Heading → *HEADING*
  result = result.replace(/^#{1,2}\s+(.+)$/gm, (_, text) => `*${text.toUpperCase()}*`);
  result = result.replace(/^#{3,6}\s+(.+)$/gm, (_, text) => `*${text}*`);

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Images: ![alt](url) → [Image: alt]
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[Image: $1]");

  // Links: [text](url) → text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Blockquotes: > text → ▎ text
  result = result.replace(/^>\s?(.*)$/gm, "▎ $1");

  // Horizontal rules: --- or *** or ___ → ━━━━━━━━━━
  result = result.replace(/^[-*_]{3,}$/gm, "━━━━━━━━━━");

  // Unordered list bullets: - item or * item → • item
  result = result.replace(/^[\t ]*[-*]\s+/gm, "• ");

  // Restore inline code
  result = result.replace(/__INLINECODE_(\d+)__/g, (_, idx) => inlineCodes[parseInt(idx)]);

  // Restore code blocks
  result = result.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return result.trim();
}
