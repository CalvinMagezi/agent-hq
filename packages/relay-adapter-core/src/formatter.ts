/**
 * Shared markdown formatting utilities for relay adapters.
 *
 * Each platform has its own format function (formatForTelegram, formatForWhatsApp)
 * but the placeholder extraction/restoration pattern is shared.
 */

export interface PlaceholderResult {
  text: string;
  codeBlocks: string[];
  inlineCodes: string[];
}

/**
 * Extract code blocks and inline code from markdown, replacing with
 * null-byte delimited placeholders that won't be matched by formatting regexes.
 */
export function extractCodePlaceholders(markdown: string): PlaceholderResult {
  let text = markdown;

  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  text = text.replace(/`[^`]+`/g, (match) => {
    inlineCodes.push(match);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  return { text, codeBlocks, inlineCodes };
}

/**
 * Restore code block and inline code placeholders with their original content
 * or with transformed versions.
 */
export function restorePlaceholders(
  text: string,
  codeBlocks: string[],
  inlineCodes: string[],
): string {
  let result = text;
  result = result.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[parseInt(idx)]);
  result = result.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);
  return result;
}
