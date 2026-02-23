/**
 * Shared helper for recording workflow run status to _system/WORKFLOW-STATUS.md.
 * Each workflow calls this on success/failure so we can track run history.
 */

import * as fs from "fs";
import * as path from "path";

/** Return an ISO-like timestamp in local time with UTC offset */
function localTimestamp(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) +
    sign + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60)
  );
}

interface WorkflowEntry {
  lastRun: string;
  lastSuccess: string | null;
  lastError: string | null;
  success: boolean;
}

export function recordWorkflowRun(
  vaultPath: string,
  workflowName: string,
  success: boolean,
  details?: string,
): void {
  const statusPath = path.join(vaultPath, "_system/WORKFLOW-STATUS.md");

  try {
    const matter = require("gray-matter");
    const now = localTimestamp();

    let data: Record<string, unknown> = {
      noteType: "system-file",
      fileName: "workflow-status",
    };
    let content = "# Workflow Status\n\nAutomatically updated by scheduled workflows.\n";

    if (fs.existsSync(statusPath)) {
      const parsed = matter(fs.readFileSync(statusPath, "utf-8"));
      data = parsed.data;
      content = parsed.content;
    }

    const workflows = (data.workflows ?? {}) as Record<string, WorkflowEntry>;
    const prev = workflows[workflowName];

    workflows[workflowName] = {
      lastRun: now,
      lastSuccess: success ? now : (prev?.lastSuccess ?? null),
      lastError: success ? null : (details?.substring(0, 200) ?? "unknown error"),
      success,
    };

    data.workflows = workflows;
    data.lastUpdated = now;

    fs.writeFileSync(statusPath, matter.stringify("\n" + content + "\n", data), "utf-8");
  } catch (err) {
    // Don't let status recording crash the workflow
    console.error(`[${workflowName}] Failed to record status:`, err);
  }
}
