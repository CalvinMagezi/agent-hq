/**
 * Result filtering for the OpenClaw Bridge.
 *
 * Strips sensitive data from capability results before returning to OpenClaw:
 * - Absolute file paths (/Users/*, /home/*)
 * - API keys (sk-*, AIzaSy*, Bearer *)
 * - Internal vault references (.vault/_system/*, _jobs/*, etc.)
 * - Truncates to max size
 */

const MAX_RESULT_BYTES = 10_000;

/** Patterns that indicate sensitive data */
const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Absolute file paths
  { pattern: /\/Users\/[^\s"'`]+/g, replacement: "[PATH_REDACTED]" },
  { pattern: /\/home\/[^\s"'`]+/g, replacement: "[PATH_REDACTED]" },

  // API keys
  { pattern: /sk-or-v1-[a-zA-Z0-9]{20,}/g, replacement: "[OPENROUTER_KEY_REDACTED]" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "[API_KEY_REDACTED]" },
  { pattern: /AIzaSy[a-zA-Z0-9_-]{33}/g, replacement: "[GOOGLE_KEY_REDACTED]" },
  { pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g, replacement: "Bearer [REDACTED]" },

  // Discord tokens
  { pattern: /[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, replacement: "[DISCORD_TOKEN_REDACTED]" },

  // Internal vault references
  { pattern: /\.vault\/_system\/[^\s"'`]*/g, replacement: "[INTERNAL_SYSTEM]" },
  { pattern: /\.vault\/_jobs\/[^\s"'`]*/g, replacement: "[INTERNAL_JOBS]" },
  { pattern: /\.vault\/_agent-sessions\/[^\s"'`]*/g, replacement: "[INTERNAL_SESSIONS]" },
  { pattern: /\.vault\/_approvals\/[^\s"'`]*/g, replacement: "[INTERNAL_APPROVALS]" },
  { pattern: /\.vault\/_embeddings\/[^\s"'`]*/g, replacement: "[INTERNAL_EMBEDDINGS]" },
  { pattern: /\.vault\/_threads\/[^\s"'`]*/g, replacement: "[INTERNAL_THREADS]" },
  { pattern: /\.vault\/_logs\/[^\s"'`]*/g, replacement: "[INTERNAL_LOGS]" },

  // Environment variable patterns
  { pattern: /OPENROUTER_API_KEY=[^\s]+/g, replacement: "OPENROUTER_API_KEY=[REDACTED]" },
  { pattern: /GEMINI_API_KEY=[^\s]+/g, replacement: "GEMINI_API_KEY=[REDACTED]" },
  { pattern: /DISCORD_BOT_TOKEN=[^\s]+/g, replacement: "DISCORD_BOT_TOKEN=[REDACTED]" },
];

/**
 * Filter a capability result before returning to OpenClaw.
 * Strips sensitive paths, keys, and internal references. Truncates to max size.
 */
export function filterResult(rawResult: string): string {
  let filtered = rawResult;

  // Apply all redaction patterns
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    filtered = filtered.replace(pattern, replacement);
  }

  // Truncate to max size
  if (Buffer.byteLength(filtered, "utf-8") > MAX_RESULT_BYTES) {
    while (Buffer.byteLength(filtered, "utf-8") > MAX_RESULT_BYTES - 50) {
      filtered = filtered.substring(0, filtered.length - 100);
    }
    filtered += "\n\n[Result truncated to 10KB]";
  }

  return filtered;
}
