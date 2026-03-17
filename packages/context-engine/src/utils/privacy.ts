/**
 * Privacy — Strip user-designated private content from context assembly.
 *
 * Content wrapped in <private>...</private> tags is excluded before
 * token counting and injection into context frames. Stripping happens
 * at the assembly layer (edge), so private content never reaches the LLM.
 */

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

/**
 * Remove all `<private>...</private>` blocks from text.
 * Returns the cleaned text with private sections replaced by empty string.
 */
export function stripPrivateTags(text: string): string {
  if (!text) return text;
  return text.replace(PRIVATE_TAG_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
