/**
 * Authentication — API key validation and session token management.
 */

import type { RelayServerConfig } from "./config";

export interface Session {
  sessionToken: string;
  clientId: string;
  clientType: string;
  createdAt: number;
}

export class AuthManager {
  private sessions = new Map<string, Session>();
  private config: RelayServerConfig;

  constructor(config: RelayServerConfig) {
    this.config = config;
  }

  /**
   * Validate an API key. Returns a session token if valid.
   */
  validateApiKey(apiKey: string, clientId?: string, clientType?: string): string | null {
    // If no API key is configured, allow all local connections
    if (!this.config.apiKey) {
      return this.createSession(clientId ?? "anonymous", clientType ?? "unknown");
    }

    if (apiKey !== this.config.apiKey) {
      return null;
    }

    return this.createSession(clientId ?? "anonymous", clientType ?? "unknown");
  }

  /**
   * Validate a session token.
   */
  validateSession(token: string): Session | null {
    return this.sessions.get(token) ?? null;
  }

  /**
   * Validate a Bearer token from an HTTP Authorization header.
   */
  validateBearer(authHeader: string | null): boolean {
    if (!this.config.apiKey) return true; // No key configured = open
    if (!authHeader) return false;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const token = match[1];
    // Accept either the raw API key or a session token
    return token === this.config.apiKey || this.sessions.has(token);
  }

  /**
   * Remove a session on disconnect.
   */
  removeSession(token: string): void {
    this.sessions.delete(token);
  }

  private createSession(clientId: string, clientType: string): string {
    const token = `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.sessions.set(token, {
      sessionToken: token,
      clientId,
      clientType,
      createdAt: Date.now(),
    });
    return token;
  }
}
