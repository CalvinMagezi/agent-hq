/**
 * BudgetGuard — per-agent monthly budget enforcement.
 *
 * Reads agentBudgets from `.vault/_usage/budget.md` frontmatter and
 * scans current-month daily logs to compute month-to-date spend per agent.
 *
 * Inspired by Paperclip's atomic budget enforcement, implemented vault-natively.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;
  spent: number;
  budgetUsd: number;
  warning?: string;
}

const WARNING_THRESHOLD = 0.8; // Fire warning at 80% usage

export class BudgetGuard {
  private readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
  }

  private get budgetFile(): string {
    return path.join(this.vaultPath, "_usage", "budget.md");
  }

  private get dailyDir(): string {
    return path.join(this.vaultPath, "_usage", "daily");
  }

  /** Read agent budget limits from budget.md frontmatter */
  private readAgentBudgets(): Record<string, number> {
    if (!fs.existsSync(this.budgetFile)) return {};
    try {
      const { data } = matter(fs.readFileSync(this.budgetFile, "utf-8"));
      return (data.agentBudgets as Record<string, number>) ?? {};
    } catch {
      return {};
    }
  }

  /** Get per-agent budget limit in USD. Falls back to default, then no-limit (Infinity) */
  private getAgentBudgetUsd(agentName: string): number {
    const budgets = this.readAgentBudgets();
    return budgets[agentName] ?? budgets["default"] ?? Infinity;
  }

  /**
   * Scan current month's daily log files and sum spend attributed to agentName.
   * Lines with format: `- <timestamp> | <model> | ... | $<cost> | task:<taskId>[ | agent:<agentName>]`
   * Also counts untagged lines toward "default" agent.
   */
  getAgentSpend(agentName: string): number {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    if (!fs.existsSync(this.dailyDir)) return 0;

    let totalUsd = 0;

    const files = fs.readdirSync(this.dailyDir)
      .filter(f => f.endsWith(".md") && f.startsWith(yearMonth));

    for (const file of files) {
      const filePath = path.join(this.dailyDir, file);
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.startsWith("- ")) continue;

          // Extract cost: `$0.001234`
          const costMatch = line.match(/\|\s*\$(\d+\.\d+)/);
          if (!costMatch) continue;
          const cost = parseFloat(costMatch[1]);

          // Extract agent tag: `| agent:<agentName>`
          const agentMatch = line.match(/\|\s*agent:(\S+)/);
          const lineAgent = agentMatch ? agentMatch[1] : "default";

          if (lineAgent === agentName) {
            totalUsd += cost;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return totalUsd;
  }

  /**
   * Check whether agentName is allowed to run a job.
   * Call BEFORE job execution.
   */
  async checkBudget(agentName: string): Promise<BudgetCheckResult> {
    const budgetUsd = this.getAgentBudgetUsd(agentName);
    const spent = this.getAgentSpend(agentName);
    const remaining = budgetUsd - spent;
    const allowed = remaining > 0;

    let warning: string | undefined;
    const budgetStr = isFinite(budgetUsd) ? `$${budgetUsd.toFixed(2)}` : "unlimited";
    if (allowed && isFinite(budgetUsd) && spent / budgetUsd >= WARNING_THRESHOLD) {
      warning = `⚠️ Agent "${agentName}" has used ${(spent / budgetUsd * 100).toFixed(0)}% of monthly budget ($${spent.toFixed(4)} / ${budgetStr})`;
    }
    if (!allowed) {
      warning = `🚫 Agent "${agentName}" monthly budget exhausted ($${spent.toFixed(4)} >= ${budgetStr})`;
    }

    return { allowed, remaining: Math.max(0, remaining), spent, budgetUsd, warning };
  }

  /**
   * Record spend for agentName in today's daily log.
   * Call AFTER job completion to tag cost to the right agent.
   */
  async recordSpend(agentName: string, costUsd: number, taskId?: string): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const filePath = path.join(this.dailyDir, `${today}.md`);

    if (!fs.existsSync(this.dailyDir)) {
      fs.mkdirSync(this.dailyDir, { recursive: true });
    }

    try {
      fs.writeFileSync(filePath, `# Usage Log — ${today}\n\n`, { encoding: "utf-8", flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }

    const timestamp = new Date().toISOString();
    const line = `- ${timestamp} | agent-budget-record | in:0 out:0 | $${costUsd.toFixed(6)} | task:${taskId ?? "unknown"} | agent:${agentName}\n`;
    fs.appendFileSync(filePath, line, "utf-8");
  }
}
