/**
 * Audit logging for the OpenClaw Bridge.
 *
 * Writes daily audit files to _external/openclaw/_audit/YYYY-MM-DD.md
 * Each file has a frontmatter summary and append-only log entries.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { AuditEntry } from "./types";

export class AuditLogger {
  private auditPath: string;

  constructor(auditPath: string) {
    this.auditPath = auditPath;
    if (!fs.existsSync(this.auditPath)) {
      fs.mkdirSync(this.auditPath, { recursive: true });
    }
  }

  /** Log an audit entry for today */
  log(entry: AuditEntry): void {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const filePath = path.join(this.auditPath, `${today}.md`);

    const time = new Date().toTimeString().split(" ")[0]; // HH:MM:SS
    const logLine = [
      `\n## ${time} - ${entry.action}`,
      ...Object.entries(entry.details).map(
        ([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
      ),
      `- status: ${entry.status}`,
      "",
    ].join("\n");

    if (fs.existsSync(filePath)) {
      // Append to existing file and update frontmatter counters
      const raw = fs.readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);
      data.totalRequests = (data.totalRequests ?? 0) + 1;
      if (entry.status === "blocked" || entry.status === "rejected") {
        data.blockedRequests = (data.blockedRequests ?? 0) + 1;
      }
      if (entry.action === "capability_request") {
        data.capabilityRequests = (data.capabilityRequests ?? 0) + 1;
      }

      const output = matter.stringify(
        "\n" + content.trim() + "\n" + logLine + "\n",
        data,
      );
      fs.writeFileSync(filePath, output, "utf-8");
    } else {
      // Create new daily file
      const frontmatter: Record<string, unknown> = {
        date: today,
        totalRequests: 1,
        blockedRequests:
          entry.status === "blocked" || entry.status === "rejected" ? 1 : 0,
        capabilityRequests: entry.action === "capability_request" ? 1 : 0,
      };

      const output = matter.stringify("\n" + logLine + "\n", frontmatter);
      fs.writeFileSync(filePath, output, "utf-8");
    }
  }

  /** Get recent audit entries (for watchdog analysis) */
  getRecentEntries(minutesBack: number): AuditEntry[] {
    const entries: AuditEntry[] = [];
    const cutoff = Date.now() - minutesBack * 60_000;

    // Read today's and possibly yesterday's audit files
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .split("T")[0];

    for (const date of [yesterday, today]) {
      const filePath = path.join(this.auditPath, `${date}.md`);
      if (!fs.existsSync(filePath)) continue;

      const raw = fs.readFileSync(filePath, "utf-8");
      const { content } = matter(raw);

      // Parse log entries from markdown
      const sections = content.split(/^## /m).filter(Boolean);
      for (const section of sections) {
        const lines = section.trim().split("\n");
        const headerMatch = lines[0]?.match(
          /^(\d{2}:\d{2}:\d{2}) - (.+)$/,
        );
        if (!headerMatch) continue;

        const [, time, action] = headerMatch;
        const entryTime = new Date(`${date}T${time}`).getTime();
        if (entryTime < cutoff) continue;

        const details: Record<string, unknown> = {};
        let status: AuditEntry["status"] = "accepted";

        for (const line of lines.slice(1)) {
          const kvMatch = line.match(/^- (\w+): (.+)$/);
          if (kvMatch) {
            const [, key, value] = kvMatch;
            if (key === "status") {
              status = value as AuditEntry["status"];
            } else {
              details[key] = value;
            }
          }
        }

        entries.push({
          timestamp: `${date}T${time}`,
          action,
          details,
          status,
        });
      }
    }

    return entries;
  }
}
