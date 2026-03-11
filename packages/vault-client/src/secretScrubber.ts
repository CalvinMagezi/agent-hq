/**
 * Scans text for common secret patterns (API keys, tokens, basic auth)
 * and redacts them to prevent leaking sensitive credentials outside the boundary.
 */
export function scrubSecrets(text: string): string {
    if (!text) return text;

    let scrubbed = text;

    // 1. sk-... keys (OpenAI, Anthropic, Stripe, etc.)
    scrubbed = scrubbed.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED_SECRET_KEY]");

    // 2. Bearer tokens (JWT or long random strings)
    scrubbed = scrubbed.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED_TOKEN]");

    // 3. AWS Access Keys (AKIA...)
    scrubbed = scrubbed.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");

    // 4. Basic Auth credentials in URLs (e.g., https://user:pass@domain.com)
    scrubbed = scrubbed.replace(/(https?:\/\/)([^:\/\s]+):([^@\/\s]+)@/gi, "$1***:***@");

    // Add extra project-specific keys if necessary 
    // e.g. Github tokens (ghp_...)
    scrubbed = scrubbed.replace(/\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g, "[REDACTED_GITHUB_TOKEN]");

    return scrubbed;
}
