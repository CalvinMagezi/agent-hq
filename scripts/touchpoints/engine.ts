/**
 * TouchPointEngine — the heart of the Touch Points system.
 *
 * Subscribes to the EventBus, debounces events per path/touch-point,
 * wraps each evaluation in a CircuitBreaker, propagates synaptic chains,
 * and writes to the TOUCHPOINT-LOG.md audit trail.
 *
 * Life cycle:
 *   const engine = createTouchPointEngine({ vault, search, memoryIngester, llm, notify, vaultPath });
 *   engine.start(vault);           // subscribe to EventBus
 *   engine.runPeriodic("name");    // called by daemon for periodic touch points
 *   engine.stop();                 // clean up timers + unsubscribe
 */

import * as fs from "fs";
import * as path from "path";
import type { SyncedVaultClient } from "@repo/vault-sync";
import type { VaultEvent } from "@repo/vault-sync";
import type { SearchClient } from "@repo/vault-client/search";
import { CircuitBreaker } from "../sblu/circuitBreaker.js";
import type { TouchPoint, TouchPointContext, TouchPointConfig, MemoryIngester } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { ChannelRouter } from "./channelRouter.js";

// ─── Chain Safety ─────────────────────────────────────────────────────────────

const MAX_CHAIN_DEPTH = 3;
const CHAIN_TIMEOUT_MS = 60_000;

// ─── Vault Pressure ───────────────────────────────────────────────────────────

const PRESSURE_WINDOW_MS = 30_000;
const PRESSURE_THRESHOLD = 50;
const PRESSURE_PAUSE_MS = 5 * 60_000;
const PRESSURE_DEBOUNCE_MULTIPLIER = 3;

// ─── Concurrency Control ─────────────────────────────────────────────────────

const MAX_CONCURRENT_EVALUATIONS = 3;
const MAX_PENDING_TIMERS = 200;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface TouchPointEngineOptions {
  vault: SyncedVaultClient;
  search: SearchClient;
  llm: (prompt: string, systemPrompt?: string) => Promise<string>;
  memoryIngester: MemoryIngester;
  notify: ChannelRouter;
  vaultPath: string;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class TouchPointEngine {
  private touchPoints = new Map<string, TouchPoint>();
  private breakers = new Map<string, CircuitBreaker>();
  private chainBreakers = new Map<string, CircuitBreaker>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribers: (() => void)[] = [];
  private config: TouchPointConfig = { ...DEFAULT_CONFIG };
  private configPath: string;
  private logPath: string;
  private backupDir: string;
  private opts: TouchPointEngineOptions;

  // Vault pressure tracking
  private recentEventTimes: number[] = [];
  private chainsPausedUntil = 0;

  // Concurrency control — prevents Ollama saturation on bulk adds
  private activeEvaluations = 0;
  private evaluationQueue: Array<() => void> = [];

  constructor(opts: TouchPointEngineOptions) {
    this.opts = opts;
    this.configPath = path.join(opts.vaultPath, "_system", "TOUCHPOINT-CONFIG.md");
    this.logPath = path.join(opts.vaultPath, "_system", "TOUCHPOINT-LOG.md");
    this.backupDir = path.join(opts.vaultPath, "_system", ".touchpoint-backups");
    this.loadConfig(); // eagerly load so isDryRun / isEnabled work before start()
  }

  /** Register a touch point */
  register(tp: TouchPoint): this {
    this.touchPoints.set(tp.name, tp);
    this.breakers.set(tp.name, new CircuitBreaker({
      errorThreshold: 0.05,
      windowMs: 10 * 60_000,
      openDurationMs: 30_000,
      halfOpenSuccessThreshold: 5,
      minCallsBeforeTripCheck: 3,
    }));
    return this;
  }

  /** Subscribe to EventBus and start listening */
  start(vault: SyncedVaultClient): void {
    this.loadConfig();

    for (const tp of this.touchPoints.values()) {
      for (const eventType of tp.triggers) {
        const unsub = vault.on(eventType, (event: VaultEvent) => {
          this.handleEvent(tp, event);
        });
        this.unsubscribers.push(unsub);
      }
    }

    // Reload config when it changes
    const configUnsub = vault.on("system:modified", (event: VaultEvent) => {
      if (event.path.includes("TOUCHPOINT-CONFIG.md")) {
        this.loadConfig();
        console.log("[touch-point-engine] Config reloaded from TOUCHPOINT-CONFIG.md");
      }
    });
    this.unsubscribers.push(configUnsub);

    console.log(`[touch-point-engine] Started with ${this.touchPoints.size} touch point(s)`);
  }

  /** Run a periodic touch point (called directly by the daemon scheduler) */
  async runPeriodic(name: string, data?: Record<string, unknown>): Promise<void> {
    const tp = this.touchPoints.get(name);
    if (!tp) {
      console.warn(`[touch-point-engine] Periodic touch point not found: ${name}`);
      return;
    }
    if (!this.isEnabled(tp)) return;

    // Create a synthetic "periodic" event
    const syntheticEvent: VaultEvent = {
      type: "file:modified",  // generic placeholder
      path: "_periodic",
      timestamp: Date.now(),
    };

    await this.evaluate(tp, syntheticEvent, 0, data);
  }

  /** Stop and clean up */
  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.debounceTimers.clear();
    this.unsubscribers = [];
    // Drain queued evaluations so they don't hang
    for (const resolve of this.evaluationQueue) resolve();
    this.evaluationQueue = [];
    console.log("[touch-point-engine] Stopped");
  }

  /** Safe backup for files that will be modified by a touch point */
  backup(filePath: string): string | null {
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const basename = path.basename(filePath);
      const backupPath = path.join(this.backupDir, `${basename}.${Date.now()}.bak`);
      fs.writeFileSync(backupPath, content, "utf-8");

      // Prune to max 50 backups (FIFO)
      this.pruneBackups();
      return backupPath;
    } catch {
      return null;
    }
  }

  get vaultPath(): string { return this.opts.vaultPath; }
  get isDryRun(): boolean { return this.config.dryRun; }

  // ─── Private ────────────────────────────────────────────────────────────────

  private handleEvent(tp: TouchPoint, event: VaultEvent): void {
    // Track event rate for pressure detection
    this.trackPressure();

    if (!this.isEnabled(tp)) return;

    // Path filter check
    if (tp.pathFilter && !event.path.startsWith(tp.pathFilter)) return;

    // Drop events if too many are already queued (prevents unbounded memory growth)
    if (this.debounceTimers.size >= MAX_PENDING_TIMERS) {
      console.log(`[touch-point-engine] Dropping ${tp.name} event — ${MAX_PENDING_TIMERS} timers pending`);
      return;
    }

    // Under pressure: 3x debounce to spread out evaluations
    const baseDebounceMs = tp.debounceMs ?? 5000;
    const debounceMs = this.isUnderPressure()
      ? baseDebounceMs * PRESSURE_DEBOUNCE_MULTIPLIER
      : baseDebounceMs;

    const key = `${tp.name}:${event.path}`;

    // Debounce per path + touch point
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key)!);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      await this.evaluateThrottled(tp, event, 0);
    }, debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /** Throttled wrapper — limits concurrent evaluations to prevent Ollama saturation */
  private async evaluateThrottled(
    tp: TouchPoint,
    event: VaultEvent,
    depth: number,
    incomingData?: Record<string, unknown>
  ): Promise<void> {
    if (this.activeEvaluations >= MAX_CONCURRENT_EVALUATIONS) {
      // Wait in queue until a slot opens
      await new Promise<void>(resolve => this.evaluationQueue.push(resolve));
    }
    this.activeEvaluations++;
    try {
      await this.evaluate(tp, event, depth, incomingData);
    } finally {
      this.activeEvaluations--;
      // Release next queued evaluation
      const next = this.evaluationQueue.shift();
      if (next) next();
    }
  }

  private async evaluate(
    tp: TouchPoint,
    event: VaultEvent,
    depth: number,
    incomingData?: Record<string, unknown>
  ): Promise<void> {
    if (depth >= MAX_CHAIN_DEPTH) {
      console.warn(`[touch-point-engine] Chain depth limit reached for ${tp.name}`);
      return;
    }

    const breaker = this.breakers.get(tp.name)!;
    if (!breaker.shouldRoute()) {
      console.log(`[touch-point-engine] ${tp.name} skipped — circuit OPEN`);
      return;
    }

    const ctx = this.buildContext();

    try {
      const result = await tp.evaluate(event, ctx, incomingData);

      if (!result) {
        breaker.recordSuccess();
        return;
      }

      breaker.recordSuccess();
      this.appendLog(tp.name, event.path, result);

      // Notify user if meaningful and system is not in dry-run
      if (result.meaningful && !this.config.dryRun) {
        const msg = `<b>Touch Point</b> [${tp.name}]: ${result.observation}`;
        await this.opts.notify.notify(msg, { dedupKey: `tp:${tp.name}:${event.path}` });
      }

      // Chain propagation
      if (result.emit && !this.areChainsUnderPressure()) {
        for (const emitSpec of result.emit) {
          const downstreamTp = this.touchPoints.get(emitSpec.touchPoint);
          if (!downstreamTp) continue;
          if (!this.isEnabled(downstreamTp)) continue;

          // Check chain-level circuit breaker
          const chainKey = `${tp.name}→${emitSpec.touchPoint}`;
          const chainBreaker = this.getChainBreaker(chainKey);
          if (!chainBreaker.shouldRoute()) {
            console.log(`[touch-point-engine] Chain ${chainKey} skipped — circuit OPEN`);
            continue;
          }

          try {
            const chainTimeout = new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Chain timeout")), CHAIN_TIMEOUT_MS)
            );
            const chainExec = this.evaluate(downstreamTp, event, depth + 1, emitSpec.data);
            await Promise.race([chainExec, chainTimeout]);
            chainBreaker.recordSuccess();
          } catch (err) {
            chainBreaker.recordFailure();
            console.warn(`[touch-point-engine] Chain ${chainKey} error:`, err);
          }
        }
      }
    } catch (err) {
      breaker.recordFailure();
      console.error(`[touch-point-engine] ${tp.name} error on ${event.path}:`, err);

      const metrics = breaker.getMetrics();
      if (metrics.state === "OPEN") {
        await this.opts.notify.notify(
          `⚠️ Touch point <code>${tp.name}</code> has been automatically disabled due to errors.`,
          { dedupKey: `tp-open:${tp.name}` }
        );
        this.appendLog(tp.name, "CIRCUIT OPEN", {
          observation: `${metrics.errorRate.toFixed(0)}% error rate`,
          actions: ["auto-disabled"],
          meaningful: false,
        });
      }
    }
  }

  private buildContext(): TouchPointContext {
    return {
      vault: this.opts.vault,
      search: this.opts.search,
      llm: this.opts.llm,
      memoryIngester: this.opts.memoryIngester,
      notify: this.opts.notify,
      vaultPath: this.opts.vaultPath,
      dryRun: this.config.dryRun,
    };
  }

  private isEnabled(tp: TouchPoint): boolean {
    if (!this.config.enabled) return false;
    return this.config.touchPoints[tp.name] !== false;
  }

  private isUnderPressure(): boolean {
    return this.recentEventTimes.length > PRESSURE_THRESHOLD || Date.now() < this.chainsPausedUntil;
  }

  private areChainsUnderPressure(): boolean {
    if (Date.now() < this.chainsPausedUntil) return true;
    return false;
  }

  private trackPressure(): void {
    const now = Date.now();
    this.recentEventTimes = this.recentEventTimes.filter(t => now - t < PRESSURE_WINDOW_MS);
    this.recentEventTimes.push(now);

    if (this.recentEventTimes.length > PRESSURE_THRESHOLD && this.chainsPausedUntil < now) {
      this.chainsPausedUntil = now + PRESSURE_PAUSE_MS;
      console.log("[touch-point-engine] High vault activity detected — chains paused for 5min");
    }
  }

  private getChainBreaker(key: string): CircuitBreaker {
    if (!this.chainBreakers.has(key)) {
      this.chainBreakers.set(key, new CircuitBreaker({
        errorThreshold: 1.0,   // trip after 3 consecutive failures (minCalls=3)
        halfOpenSuccessThreshold: 1,
        minCallsBeforeTripCheck: 3,
      }));
    }
    return this.chainBreakers.get(key)!;
  }

  private loadConfig(): void {
    if (!fs.existsSync(this.configPath)) {
      this.config = { ...DEFAULT_CONFIG };
      return;
    }
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");

      // Parse YAML-like config from the markdown body
      const cfg: TouchPointConfig = {
        enabled: true,
        dryRun: false,
        touchPoints: {},
        chains: {},
      };

      let section: "touchpoints" | "chains" | "global" | null = null;

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("## Enabled Touch Points")) { section = "touchpoints"; continue; }
        if (trimmed.startsWith("## Enabled Chains")) { section = "chains"; continue; }
        if (trimmed.startsWith("## Global")) { section = "global"; continue; }
        if (trimmed.startsWith("#")) { section = null; continue; }

        if (section === "touchpoints" || section === "chains") {
          const m = trimmed.match(/^-\s+([\w-]+):\s*(true|false)$/);
          if (m) {
            const target = section === "touchpoints" ? cfg.touchPoints : cfg.chains;
            target[m[1]] = m[2] === "true";
          }
        }

        if (section === "global") {
          const mEnabled = trimmed.match(/^enabled:\s*(true|false)/);
          if (mEnabled) cfg.enabled = mEnabled[1] === "true";
          const mDryRun = trimmed.match(/^dryRun:\s*(true|false)/);
          if (mDryRun) cfg.dryRun = mDryRun[1] === "true";
        }
      }

      this.config = cfg;
    } catch (err) {
      console.warn("[touch-point-engine] Failed to parse config, using defaults:", err);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  private appendLog(
    tpName: string,
    filePath: string,
    result: { observation: string; actions: string[]; meaningful: boolean; emit?: Array<{ touchPoint: string }> }
  ): void {
    try {
      const timestamp = new Date().toISOString();
      const chainPart = result.emit?.length ? ` | chain→${result.emit.map(e => e.touchPoint).join(",")}` : " | terminal";
      const actionStr = result.actions.join(", ") || result.observation;
      const line = `[${timestamp}] ${tpName} | ${filePath} | ${actionStr}${chainPart}\n`;

      // Rotate daily — if log file is from a previous day, rename it
      if (fs.existsSync(this.logPath)) {
        const stat = fs.statSync(this.logPath);
        const fileDate = stat.mtime.toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        if (fileDate !== today) {
          const archivePath = this.logPath.replace(".md", `-${fileDate}.md`);
          fs.renameSync(this.logPath, archivePath);
        }
      }

      fs.appendFileSync(this.logPath, line, "utf-8");
    } catch {
      // Log failures should never crash the engine
    }
  }

  private pruneBackups(): void {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith(".bak"))
        .map(f => ({ name: f, path: path.join(this.backupDir, f), time: fs.statSync(path.join(this.backupDir, f)).mtimeMs }))
        .sort((a, b) => a.time - b.time);

      while (files.length > 50) {
        const oldest = files.shift()!;
        fs.unlinkSync(oldest.path);
      }
    } catch { /* ignore */ }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTouchPointEngine(opts: TouchPointEngineOptions): TouchPointEngine {
  return new TouchPointEngine(opts);
}
