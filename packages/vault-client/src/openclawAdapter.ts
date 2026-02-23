/**
 * OpenClawAdapter — Sandboxed vault access for the OpenClaw integration.
 *
 * This adapter does NOT extend VaultClient. It uses direct fs operations
 * with strict path validation to ensure OpenClaw can only access its
 * designated namespace (_external/openclaw/).
 *
 * Security features:
 * - Path traversal prevention via resolve() + startsWith()
 * - Whitelist/blocklist for vault paths
 * - Input sanitization (YAML, wikilinks, template syntax)
 * - Sliding window rate limiting
 * - Payload size enforcement
 * - Concurrent capability request cap
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { HarnessType, DelegatedTask } from "./types";

// ─── Errors ────────────────────────────────────────────────────────

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ─── Types ─────────────────────────────────────────────────────────

export interface OpenClawConfig {
  enabled: boolean;
  token: string;
  rateLimit: {
    perMinute: number;
    perHour: number;
  };
  maxPayloadBytes: number;
  maxConcurrentCapabilities: number;
  allowedCapabilities: string[];
  circuitBreaker: {
    status: "closed" | "open" | "half-open";
    openedAt: string | null;
    reason: string | null;
    cooldownMinutes: number;
  };
}

export interface CapabilityRequest {
  requestId: string;
  capability: string;
  instruction: string;
  priority?: number;
}

export interface CapabilityResult {
  requestId: string;
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  result?: string;
  error?: string;
}

export interface OpenClawNote {
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  _filePath: string;
}

// ─── Capability Routing ────────────────────────────────────────────

const CAPABILITY_ROUTING: Record<string, HarnessType> = {
  "google-drive": "gemini-cli",
  "google-docs": "gemini-cli",
  "google-sheets": "gemini-cli",
  "gmail": "gemini-cli",
  "google-calendar": "gemini-cli",
  "research": "any",
  "code-edit": "claude-code",
  "code-review": "claude-code",
  "git-operations": "claude-code",
  "debugging": "claude-code",
  "multi-model": "opencode",
  "code-generation": "opencode",
  "general": "any",
};

// ─── Rate Limiter ──────────────────────────────────────────────────

class SlidingWindowRateLimiter {
  private minuteWindow: number[] = [];
  private hourWindow: number[] = [];

  check(perMinute: number, perHour: number): boolean {
    const now = Date.now();
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
    this.hourWindow = this.hourWindow.filter((t) => now - t < 3_600_000);
    return (
      this.minuteWindow.length < perMinute && this.hourWindow.length < perHour
    );
  }

  record(): void {
    const now = Date.now();
    this.minuteWindow.push(now);
    this.hourWindow.push(now);
  }

  getMinuteCount(): number {
    const now = Date.now();
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000);
    return this.minuteWindow.length;
  }

  getHourCount(): number {
    const now = Date.now();
    this.hourWindow = this.hourWindow.filter((t) => now - t < 3_600_000);
    return this.hourWindow.length;
  }
}

// ─── Input Sanitization ────────────────────────────────────────────

/** Strip YAML frontmatter delimiters, wikilinks, and template syntax from content */
export function sanitizeContent(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf-8") > maxBytes) {
    // Truncate to maxBytes (approximate via substring)
    while (Buffer.byteLength(content, "utf-8") > maxBytes) {
      content = content.substring(0, content.length - 100);
    }
  }
  // Strip YAML frontmatter delimiters that could inject fake frontmatter
  content = content.replace(/^---\s*$/gm, "\\---");
  // Strip wikilink injection
  content = content.replace(/\[\[/g, "\\[\\[");
  // Strip template injection
  content = content.replace(/\{\{/g, "\\{\\{");
  return content;
}

/** Sanitize a value used in YAML frontmatter */
export function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[:\n\r|>*&!%@`]/g, "_");
}

/** Sanitize a filename (alphanumeric, hyphens, underscores, dots) */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 200);
}

// ─── Blocked Paths ─────────────────────────────────────────────────

const BLOCKED_PREFIXES = [
  "_system",
  "_jobs",
  "_delegation",
  "_agent-sessions",
  "_approvals",
  "_usage",
  "_embeddings",
  "_threads",
  "_logs",
  "_moc",
  "Notebooks",
];

// ─── Adapter ───────────────────────────────────────────────────────

export class OpenClawAdapter {
  readonly vaultPath: string;
  readonly namespacePath: string;
  readonly notesPath: string;
  readonly healthPath: string;
  readonly auditPath: string;
  readonly configPath: string;

  private rateLimiter = new SlidingWindowRateLimiter();
  private activeCaps = new Set<string>();

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    this.namespacePath = path.join(this.vaultPath, "_external", "openclaw");
    this.notesPath = path.join(this.namespacePath, "notes");
    this.healthPath = path.join(this.namespacePath, "_health");
    this.auditPath = path.join(this.namespacePath, "_audit");
    this.configPath = path.join(this.namespacePath, "_config.md");
  }

  // ─── Init ──────────────────────────────────────────────────────

  /** Ensure all required directories exist */
  ensureDirectories(): void {
    for (const dir of [
      this.namespacePath,
      this.notesPath,
      this.healthPath,
      this.auditPath,
    ]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // ─── Config ────────────────────────────────────────────────────

  private _configCache: { config: OpenClawConfig; loadedAt: number } | null =
    null;
  private static CONFIG_CACHE_MS = 30_000;

  /** Read config from vault, cached for 30s */
  getConfig(): OpenClawConfig {
    const now = Date.now();
    if (
      this._configCache &&
      now - this._configCache.loadedAt < OpenClawAdapter.CONFIG_CACHE_MS
    ) {
      return this._configCache.config;
    }

    if (!fs.existsSync(this.configPath)) {
      // Return safe defaults (disabled)
      return {
        enabled: false,
        token: "",
        rateLimit: { perMinute: 60, perHour: 500 },
        maxPayloadBytes: 65536,
        maxConcurrentCapabilities: 10,
        allowedCapabilities: [],
        circuitBreaker: {
          status: "closed",
          openedAt: null,
          reason: null,
          cooldownMinutes: 30,
        },
      };
    }

    const raw = fs.readFileSync(this.configPath, "utf-8");
    const { data } = matter(raw);

    const config: OpenClawConfig = {
      enabled: data.enabled ?? false,
      token: data.token ?? "",
      rateLimit: {
        perMinute: data.rateLimit?.perMinute ?? 60,
        perHour: data.rateLimit?.perHour ?? 500,
      },
      maxPayloadBytes: data.maxPayloadBytes ?? 65536,
      maxConcurrentCapabilities: data.maxConcurrentCapabilities ?? 10,
      allowedCapabilities: data.allowedCapabilities ?? [],
      circuitBreaker: {
        status: data.circuitBreaker?.status ?? "closed",
        openedAt: data.circuitBreaker?.openedAt ?? null,
        reason: data.circuitBreaker?.reason ?? null,
        cooldownMinutes: data.circuitBreaker?.cooldownMinutes ?? 30,
      },
    };

    this._configCache = { config, loadedAt: now };
    return config;
  }

  /** Invalidate config cache (after watchdog writes) */
  invalidateConfigCache(): void {
    this._configCache = null;
  }

  // ─── Auth & Guards ─────────────────────────────────────────────

  /** Validate bearer token */
  validateToken(token: string): boolean {
    const config = this.getConfig();
    return config.enabled && config.token.length > 0 && token === config.token;
  }

  /** Check if integration is enabled and circuit breaker allows requests */
  checkAccess(): { allowed: boolean; reason?: string } {
    const config = this.getConfig();

    if (!config.enabled) {
      return { allowed: false, reason: "integration_disabled" };
    }

    const cb = config.circuitBreaker;
    if (cb.status === "open") {
      // Check if cooldown has elapsed → transition to half-open
      if (cb.openedAt) {
        const elapsed = Date.now() - new Date(cb.openedAt).getTime();
        if (elapsed > cb.cooldownMinutes * 60_000) {
          // Auto-transition to half-open (watchdog will confirm)
          return { allowed: true };
        }
      }
      return { allowed: false, reason: `circuit_breaker_open: ${cb.reason}` };
    }

    return { allowed: true };
  }

  /** Check rate limits */
  checkRateLimit(): { allowed: boolean; minuteCount: number; hourCount: number } {
    const config = this.getConfig();
    const allowed = this.rateLimiter.check(
      config.rateLimit.perMinute,
      config.rateLimit.perHour,
    );
    return {
      allowed,
      minuteCount: this.rateLimiter.getMinuteCount(),
      hourCount: this.rateLimiter.getHourCount(),
    };
  }

  /** Record a request for rate limiting */
  recordRequest(): void {
    this.rateLimiter.record();
  }

  // ─── Path Validation ──────────────────────────────────────────

  /** Validate and resolve a path within the OpenClaw namespace */
  private validateNotePath(relativePath: string): string {
    const resolved = path.resolve(this.notesPath, relativePath);

    // Must be within the notes directory
    if (!resolved.startsWith(this.notesPath + path.sep) && resolved !== this.notesPath) {
      throw new SecurityError(
        `Path traversal blocked: ${relativePath} resolves outside namespace`,
      );
    }

    // Double-check: must not reach any blocked prefix
    const relativeToVault = path.relative(this.vaultPath, resolved);
    for (const blocked of BLOCKED_PREFIXES) {
      if (relativeToVault.startsWith(blocked + path.sep) || relativeToVault === blocked) {
        throw new SecurityError(
          `Access to ${blocked}/ is blocked for OpenClaw`,
        );
      }
    }

    return resolved;
  }

  // ─── Notes CRUD ───────────────────────────────────────────────

  /** List notes in OpenClaw's namespace */
  listNotes(): OpenClawNote[] {
    if (!fs.existsSync(this.notesPath)) return [];

    const files = fs
      .readdirSync(this.notesPath)
      .filter((f) => f.endsWith(".md"));

    return files.map((f) => {
      const filePath = path.join(this.notesPath, f);
      const raw = fs.readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);
      return {
        title: data.title ?? path.basename(f, ".md"),
        content: content.trim(),
        tags: data.tags ?? [],
        createdAt: data.createdAt ?? "",
        updatedAt: data.updatedAt ?? undefined,
        _filePath: path.relative(this.vaultPath, filePath),
      };
    });
  }

  /** Read a single note */
  readNote(relativePath: string): OpenClawNote | null {
    const filePath = this.validateNotePath(relativePath);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return {
      title: data.title ?? path.basename(filePath, ".md"),
      content: content.trim(),
      tags: data.tags ?? [],
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt ?? undefined,
      _filePath: path.relative(this.vaultPath, filePath),
    };
  }

  /** Write a note (create or overwrite) */
  writeNote(
    title: string,
    content: string,
    tags?: string[],
  ): string {
    const config = this.getConfig();
    const sanitizedContent = sanitizeContent(content, config.maxPayloadBytes);
    const safeTitle = sanitizeFilename(title);
    const filename = `${safeTitle}.md`;
    const filePath = this.validateNotePath(filename);

    const now = new Date().toISOString();
    const isUpdate = fs.existsSync(filePath);

    const frontmatter: Record<string, unknown> = {
      title: sanitizeFrontmatterValue(title),
      tags: (tags ?? []).map(sanitizeFrontmatterValue),
      originActor: "openclaw",
      createdAt: isUpdate
        ? (matter(fs.readFileSync(filePath, "utf-8")).data.createdAt ?? now)
        : now,
      updatedAt: now,
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const output = matter.stringify("\n" + sanitizedContent + "\n", frontmatter);
    fs.writeFileSync(filePath, output, "utf-8");

    return path.relative(this.vaultPath, filePath);
  }

  /** Delete a note from the namespace */
  deleteNote(relativePath: string): boolean {
    const filePath = this.validateNotePath(relativePath);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  /** Simple text search within OpenClaw's notes */
  searchNotes(query: string, limit = 5): Array<{ title: string; snippet: string; path: string }> {
    const notes = this.listNotes();
    const lowerQuery = query.toLowerCase();

    const results = notes
      .filter(
        (n) =>
          n.title.toLowerCase().includes(lowerQuery) ||
          n.content.toLowerCase().includes(lowerQuery),
      )
      .slice(0, limit)
      .map((n) => {
        // Extract a snippet around the match
        const idx = n.content.toLowerCase().indexOf(lowerQuery);
        const start = Math.max(0, idx - 80);
        const end = Math.min(n.content.length, idx + query.length + 80);
        const snippet =
          idx >= 0
            ? (start > 0 ? "..." : "") +
              n.content.substring(start, end) +
              (end < n.content.length ? "..." : "")
            : n.content.substring(0, 200);

        return {
          title: n.title,
          snippet,
          path: n._filePath,
        };
      });

    return results;
  }

  // ─── Capability Brokering ─────────────────────────────────────

  /** Submit a capability request (creates a delegation task) */
  submitCapabilityRequest(request: CapabilityRequest): void {
    const config = this.getConfig();

    // Validate capability is allowed
    if (!config.allowedCapabilities.includes(request.capability)) {
      throw new SecurityError(
        `Capability "${request.capability}" is not in allowedCapabilities`,
      );
    }

    // Check concurrent cap
    if (this.activeCaps.size >= config.maxConcurrentCapabilities) {
      throw new RateLimitError(
        `Max concurrent capability requests reached (${config.maxConcurrentCapabilities})`,
      );
    }

    // Route to harness type
    const harnessType = CAPABILITY_ROUTING[request.capability];
    if (!harnessType) {
      throw new SecurityError(
        `Unknown capability: ${request.capability}`,
      );
    }

    // Create delegation task via direct filesystem write
    const taskId = `openclaw-${request.requestId}`;
    const jobId = `openclaw-req-${Date.now()}`;
    const filename = `task-${taskId}.md`;
    const filePath = path.join(
      this.vaultPath,
      "_delegation",
      "pending",
      filename,
    );

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sanitizedInstruction = sanitizeContent(
      request.instruction,
      config.maxPayloadBytes,
    );

    const frontmatter: Record<string, unknown> = {
      taskId,
      jobId,
      targetHarnessType: harnessType,
      status: "pending",
      priority: request.priority ?? 50,
      deadlineMs: 600000,
      dependsOn: [],
      modelOverride: null,
      claimedBy: null,
      claimedAt: null,
      originActor: "openclaw",
      createdAt: new Date().toISOString(),
    };

    const output = matter.stringify(
      "\n# Task Instruction\n\n" + sanitizedInstruction + "\n",
      frontmatter,
    );
    fs.writeFileSync(filePath, output, "utf-8");

    this.activeCaps.add(request.requestId);
  }

  /** Check the status/result of a capability request */
  getCapabilityResult(requestId: string): CapabilityResult {
    const taskId = `openclaw-${requestId}`;

    // Check completed first
    const completedDir = path.join(this.vaultPath, "_delegation", "completed");
    if (fs.existsSync(completedDir)) {
      const files = fs
        .readdirSync(completedDir)
        .filter((f) => f.includes(taskId));
      if (files.length > 0) {
        const filePath = path.join(completedDir, files[0]);
        const raw = fs.readFileSync(filePath, "utf-8");
        const { data, content } = matter(raw);

        // Only return results for openclaw-originated tasks
        if (data.originActor !== "openclaw") {
          return { requestId, status: "pending" };
        }

        this.activeCaps.delete(requestId);

        const status = data.status ?? "completed";
        return {
          requestId,
          status,
          result: status === "completed" ? content.trim() : undefined,
          error: data.error ?? undefined,
        };
      }
    }

    // Check claimed
    const claimedDir = path.join(this.vaultPath, "_delegation", "claimed");
    if (fs.existsSync(claimedDir)) {
      const files = fs
        .readdirSync(claimedDir)
        .filter((f) => f.includes(taskId));
      if (files.length > 0) {
        const raw = fs.readFileSync(path.join(claimedDir, files[0]), "utf-8");
        const { data } = matter(raw);
        if (data.originActor !== "openclaw") {
          return { requestId, status: "pending" };
        }
        return { requestId, status: data.status ?? "running" };
      }
    }

    // Check pending
    const pendingDir = path.join(this.vaultPath, "_delegation", "pending");
    if (fs.existsSync(pendingDir)) {
      const files = fs
        .readdirSync(pendingDir)
        .filter((f) => f.includes(taskId));
      if (files.length > 0) {
        return { requestId, status: "pending" };
      }
    }

    // Not found
    return { requestId, status: "failed", error: "Request not found" };
  }

  // ─── Heartbeat ────────────────────────────────────────────────

  /** Record OpenClaw heartbeat */
  writeHeartbeat(metadata?: Record<string, unknown>): void {
    const filePath = path.join(this.healthPath, "heartbeat.md");
    const now = new Date().toISOString();

    const frontmatter: Record<string, unknown> = {
      lastHeartbeat: now,
      status: "online",
      ...metadata,
    };

    const output = matter.stringify(
      "\n# OpenClaw Heartbeat\n\nLast seen: " + now + "\n",
      frontmatter,
    );
    fs.writeFileSync(filePath, output, "utf-8");
  }

  /** Read heartbeat status */
  readHeartbeat(): { lastHeartbeat: string; status: string } | null {
    const filePath = path.join(this.healthPath, "heartbeat.md");
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, "utf-8");
    const { data } = matter(raw);
    return {
      lastHeartbeat: data.lastHeartbeat ?? "",
      status: data.status ?? "unknown",
    };
  }

  // ─── Context ──────────────────────────────────────────────────

  /** Get filtered context (NO soul, memory, keys, or internal data) */
  getFilteredContext(): { currentTime: string; timezone: string } {
    return {
      currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  // ─── Circuit Breaker Management ───────────────────────────────

  /** Trip the circuit breaker (called by watchdog) */
  tripCircuitBreaker(reason: string): void {
    if (!fs.existsSync(this.configPath)) return;

    const raw = fs.readFileSync(this.configPath, "utf-8");
    const { data, content } = matter(raw);

    data.circuitBreaker = {
      ...data.circuitBreaker,
      status: "open",
      openedAt: new Date().toISOString(),
      reason,
    };

    const output = matter.stringify("\n" + content + "\n", data);
    fs.writeFileSync(this.configPath, output, "utf-8");
    this.invalidateConfigCache();
  }

  /** Reset circuit breaker to closed */
  resetCircuitBreaker(): void {
    if (!fs.existsSync(this.configPath)) return;

    const raw = fs.readFileSync(this.configPath, "utf-8");
    const { data, content } = matter(raw);

    data.circuitBreaker = {
      ...data.circuitBreaker,
      status: "closed",
      openedAt: null,
      reason: null,
    };

    const output = matter.stringify("\n" + content + "\n", data);
    fs.writeFileSync(this.configPath, output, "utf-8");
    this.invalidateConfigCache();
  }

  // ─── Rate Limit Stats (for watchdog) ──────────────────────────

  getRateLimitStats(): { minuteCount: number; hourCount: number } {
    return {
      minuteCount: this.rateLimiter.getMinuteCount(),
      hourCount: this.rateLimiter.getHourCount(),
    };
  }

  getActiveCapsCount(): number {
    return this.activeCaps.size;
  }
}
