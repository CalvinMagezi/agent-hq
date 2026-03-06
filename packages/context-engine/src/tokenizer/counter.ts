/**
 * Token counting — tiered approach.
 *
 * Fast path: byte-length heuristic (~10% accuracy for English).
 * Accurate path: js-tiktoken cl100k_base (opt-in, slower).
 */

/** Bytes per token heuristic — works well for English/Latin text */
const BYTES_PER_TOKEN = 3.5;

/**
 * Fast token count using byte-length heuristic.
 * Accurate to ~10% for English text, worse for CJK or code.
 */
export function countTokensFast(text: string): number {
  if (!text) return 0;
  // Use Buffer.byteLength for accurate UTF-8 byte count
  const bytes = Buffer.byteLength(text, "utf-8");
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Cached tiktoken encoder (lazy-loaded) */
let _encoder: any = null;
let _encoderFailed = false;

/**
 * Precise token count using js-tiktoken.
 * Falls back to heuristic if tiktoken is not installed.
 */
export function countTokensPrecise(text: string): number {
  if (!text) return 0;

  if (_encoderFailed) return countTokensFast(text);

  if (!_encoder) {
    try {
      // Dynamic import — js-tiktoken is an optional dependency
      const { encodingForModel } = require("js-tiktoken");
      _encoder = encodingForModel("gpt-4o"); // cl100k_base — close enough for Claude
    } catch {
      _encoderFailed = true;
      return countTokensFast(text);
    }
  }

  try {
    return _encoder.encode(text).length;
  } catch {
    return countTokensFast(text);
  }
}

/**
 * Create a token counter function based on precision preference.
 */
export function createCounter(precision: boolean): (text: string) => number {
  return precision ? countTokensPrecise : countTokensFast;
}

/**
 * Truncate text to approximately `maxTokens` tokens.
 * Preserves word boundaries and adds ellipsis marker.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  counter: (text: string) => number,
  ellipsis = "\n... (truncated)"
): { text: string; truncated: boolean } {
  const current = counter(text);
  if (current <= maxTokens) {
    return { text, truncated: false };
  }

  // Estimate character position for target tokens
  const ratio = maxTokens / current;
  let cutPoint = Math.floor(text.length * ratio);

  // Snap to nearest word boundary
  const spaceIdx = text.lastIndexOf(" ", cutPoint);
  if (spaceIdx > cutPoint * 0.8) {
    cutPoint = spaceIdx;
  }

  // Snap to nearest newline if close
  const newlineIdx = text.lastIndexOf("\n", cutPoint);
  if (newlineIdx > cutPoint * 0.9) {
    cutPoint = newlineIdx;
  }

  const truncated = text.slice(0, cutPoint).trimEnd() + ellipsis;

  // Verify we're actually under budget (heuristic can overshoot)
  if (counter(truncated) > maxTokens * 1.1) {
    // Aggressive fallback — cut more
    const aggressiveCut = Math.floor(cutPoint * 0.85);
    return {
      text: text.slice(0, aggressiveCut).trimEnd() + ellipsis,
      truncated: true,
    };
  }

  return { text: truncated, truncated: true };
}
