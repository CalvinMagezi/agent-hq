/**
 * Local file logger with rotation for daemon mode.
 *
 * When the agent runs as a daemon (launchd/systemd), stdout may be
 * redirected or lost. This logger writes structured log lines to
 * ~/.agent-hq/logs/agent.log with automatic rotation.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Configuration ───────────────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), ".agent-hq", "logs");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5; // Keep 5 rotated files (50 MB total max)

// ── Logger Class ────────────────────────────────────────────────────

export class Logger {
  private logFile: string;
  private initialized = false;

  constructor(name: string = "agent") {
    this.logFile = path.join(LOG_DIR, `${name}.log`);
  }

  private ensureDir(): void {
    if (this.initialized) return;
    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }
      this.initialized = true;
    } catch {
      // If we can't create the log dir, silently degrade
    }
  }

  private rotate(): void {
    try {
      if (!fs.existsSync(this.logFile)) return;

      const stats = fs.statSync(this.logFile);
      if (stats.size < MAX_LOG_SIZE) return;

      // Rotate: agent.log → agent.1.log → agent.2.log → ... → agent.5.log (deleted)
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = i === 1 ? this.logFile : `${this.logFile}.${i}`;
        const dst = `${this.logFile}.${i + 1}`;

        if (i === MAX_LOG_FILES - 1) {
          // Delete the oldest
          try {
            fs.unlinkSync(`${this.logFile}.${i}`);
          } catch (_e) {
            // Ignore if file doesn't exist
          }
        }

        if (fs.existsSync(src) && i > 1) {
          fs.renameSync(src, dst);
        }
      }

      // Move current → .1
      fs.renameSync(this.logFile, `${this.logFile}.1`);
    } catch {
      // Rotation failure is non-fatal
    }
  }

  private write(level: string, message: string, meta?: Record<string, any>): void {
    this.ensureDir();
    this.rotate();

    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}\n`;

    try {
      fs.appendFileSync(this.logFile, line);
    } catch {
      // If we can't write, don't crash the agent
    }
  }

  info(message: string, meta?: Record<string, any>): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: Record<string, any>): void {
    this.write("error", message, meta);
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.write("debug", message, meta);
  }
}

// ── Singleton ───────────────────────────────────────────────────────

export const logger = new Logger("agent");
