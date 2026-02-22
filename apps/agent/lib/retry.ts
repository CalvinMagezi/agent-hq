/**
 * Retry infrastructure with exponential backoff + jitter.
 *
 * Inspired by OpenClaw's src/infra/retry.ts — provides generic retry
 * wrapping for LLM calls and other transient-failure-prone operations.
 */

export interface RetryOptions {
  /** Max number of attempts (default: 3) */
  attempts?: number;
  /** Initial delay in ms (default: 500) */
  minDelayMs?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0–1 (default: 0.1 = ±10%) */
  jitter?: number;
  /** Return true to retry this error, false to bail immediately */
  shouldRetry?: (error: Error) => boolean;
  /** Return delay in ms from provider's retry-after header, or null */
  retryAfterMs?: (error: Error) => number | null;
  /** Called before each retry sleep */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: Error;
}

const DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} as const;

/**
 * Execute `fn` with exponential backoff + jitter on failure.
 *
 * Delay formula:
 *   base = minDelayMs * 2^(attempt-1)
 *   capped = min(base, maxDelayMs)
 *   final = capped + capped * jitter * (random ∈ [-1,1])
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = DEFAULTS.attempts,
    minDelayMs = DEFAULTS.minDelayMs,
    maxDelayMs = DEFAULTS.maxDelayMs,
    jitter = DEFAULTS.jitter,
    shouldRetry = isRetryableError,
    retryAfterMs = parseRetryAfter,
    onRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Last attempt — throw immediately
      if (attempt >= attempts) break;

      // Non-retryable error — throw immediately
      if (!shouldRetry(lastError)) break;

      // Calculate delay: provider retry-after OR exponential backoff
      const providerDelay = retryAfterMs(lastError);
      let delayMs =
        providerDelay != null
          ? Math.max(providerDelay, minDelayMs)
          : minDelayMs * Math.pow(2, attempt - 1);

      // Cap at max
      delayMs = Math.min(delayMs, maxDelayMs);

      // Add jitter: ±(jitter * 100)%
      if (jitter > 0) {
        const offset = delayMs * jitter * (Math.random() * 2 - 1);
        delayMs = Math.max(0, Math.round(delayMs + offset));
      }

      if (onRetry) {
        onRetry({ attempt, maxAttempts: attempts, delayMs, error: lastError });
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError ?? new Error("retryAsync: unknown failure");
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse "retry after Ns" from OpenRouter / OpenAI error messages.
 */
export function parseRetryAfter(error: Error): number | null {
  const msg = error.message;

  // OpenRouter: "Rate limit exceeded. Please retry after 30s"
  const retryMatch = msg.match(/retry after (\d+)s/i);
  if (retryMatch) return parseInt(retryMatch[1], 10) * 1000;

  // Generic Retry-After header leak: "retry-after: 5"
  const headerMatch = msg.match(/retry-after:\s*(\d+)/i);
  if (headerMatch) return parseInt(headerMatch[1], 10) * 1000;

  return null;
}

/**
 * Determines if an error is transient and worth retrying.
 */
export function isRetryableError(error: Error): boolean {
  const msg = error.message.toLowerCase();

  // ── Retryable ─────────────────────────────────────────────────

  // Network errors
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up")
  ) {
    return true;
  }

  // Rate limits
  if (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("too many requests")
  ) {
    return true;
  }

  // Server errors (5xx)
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable")
  ) {
    return true;
  }

  // Transient provider errors
  if (msg.includes("overloaded") || msg.includes("capacity")) {
    return true;
  }

  // ── NOT retryable ─────────────────────────────────────────────

  // Auth errors — will always fail
  if (
    (msg.includes("invalid") && msg.includes("key")) ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return false;
  }

  // Context overflow — needs session reset, not retry
  if (msg.includes("context") && (msg.includes("too large") || msg.includes("exceeded"))) {
    return false;
  }

  // Safety breaker
  if (msg.includes("safety breaker")) {
    return false;
  }

  // Default: don't retry unknown errors
  return false;
}
