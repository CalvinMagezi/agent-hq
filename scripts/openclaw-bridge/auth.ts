/**
 * Token validation and config hot-reload for the OpenClaw Bridge.
 *
 * Reads the bearer token from _config.md frontmatter, cached for 30s.
 * The OpenClawAdapter handles the actual config caching.
 */

import type { OpenClawAdapter } from "@repo/vault-client/openclaw-adapter";

/** Extract bearer token from Authorization header */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/** Validate a request's auth and access status. Returns null if OK, or error info. */
export function validateRequest(
  adapter: OpenClawAdapter,
  authHeader: string | null,
): { status: number; error: string } | null {
  // Check token
  const token = extractBearerToken(authHeader);
  if (!token) {
    return { status: 401, error: "Missing or malformed Authorization header" };
  }

  if (!adapter.validateToken(token)) {
    return { status: 401, error: "Invalid token" };
  }

  // Check access (enabled + circuit breaker)
  const access = adapter.checkAccess();
  if (!access.allowed) {
    return { status: 503, error: `Service unavailable: ${access.reason}` };
  }

  // Check rate limit
  const rateLimit = adapter.checkRateLimit();
  if (!rateLimit.allowed) {
    return {
      status: 429,
      error: `Rate limit exceeded (${rateLimit.minuteCount}/min, ${rateLimit.hourCount}/hr)`,
    };
  }

  return null; // All checks passed
}
