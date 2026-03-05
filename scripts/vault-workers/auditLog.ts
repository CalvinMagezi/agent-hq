/**
 * Vault Workers — Audit Log
 *
 * Append-only daily logs written to _logs/workers/YYYY-MM-DD.md.
 * Each entry records exactly what a worker did, so every created note
 * is traceable and reversible.
 */

import * as fs from "fs";
import * as path from "path";

export interface AuditEntry {
    worker: string;
    action: "created" | "skipped" | "error";
    targetPath?: string;
    details: string;
}

export class AuditLog {
    private vaultPath: string;

    constructor(vaultPath: string) {
        this.vaultPath = vaultPath;
    }

    /**
     * Append one audit entry to today's log file.
     * Format: `- {timestamp} | **{worker}** | {action} | \`{targetPath}\` | {details}`
     */
    append(entry: AuditEntry): void {
        try {
            const today = new Date().toISOString().split("T")[0]!;
            const logDir = path.join(this.vaultPath, "_logs", "workers");
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const logFile = path.join(logDir, `${today}.md`);
            const timestamp = new Date().toISOString();
            const targetStr = entry.targetPath ? ` | \`${entry.targetPath}\`` : "";
            const line = `- ${timestamp} | **${entry.worker}** | ${entry.action}${targetStr} | ${entry.details}\n`;

            if (!fs.existsSync(logFile)) {
                // Create with frontmatter header
                const header = `---\nnoteType: system-file\nfileName: worker-audit-log\ndate: "${today}"\n---\n# Worker Audit Log: ${today}\n\n`;
                fs.writeFileSync(logFile, header + line, "utf-8");
            } else {
                fs.appendFileSync(logFile, line, "utf-8");
            }
        } catch (err) {
            // Audit failures must never crash a worker
            console.error(`[audit] Failed to write log entry:`, err);
        }
    }
}
