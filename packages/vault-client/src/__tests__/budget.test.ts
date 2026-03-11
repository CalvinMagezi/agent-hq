/**
 * Tests for BudgetGuard — per-agent monthly budget enforcement.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BudgetGuard } from "../budgetGuard";

// ── Helpers ────────────────────────────────────────────────────────────────

function createTestVault(): { vaultPath: string; budgetGuard: BudgetGuard } {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
  fs.mkdirSync(path.join(vaultPath, "_usage", "daily"), { recursive: true });

  // Write minimal budget.md
  const budgetContent = `---
noteType: system-file
monthlyBudgetUsd: 50.00
agentBudgets:
  feature-coder: 10
  security-auditor: 2
  default: 1
---

# Budget
`;
  fs.writeFileSync(path.join(vaultPath, "_usage", "budget.md"), budgetContent, "utf-8");

  return { vaultPath, budgetGuard: new BudgetGuard(vaultPath) };
}

function cleanupVault(vaultPath: string): void {
  fs.rmSync(vaultPath, { recursive: true, force: true });
}

/** Write a fake daily log entry attributed to an agent */
function writeSpendEntry(
  vaultPath: string,
  date: string,
  agentName: string,
  costUsd: number,
): void {
  const dailyPath = path.join(vaultPath, "_usage", "daily", `${date}.md`);
  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(dailyPath, `# Usage Log — ${date}\n\n`, "utf-8");
  }
  const line = `- ${date}T10:00:00.000Z | test-model | in:100 out:200 | $${costUsd.toFixed(6)} | task:test-task | agent:${agentName}\n`;
  fs.appendFileSync(dailyPath, line, "utf-8");
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("BudgetGuard", () => {
  let vaultPath: string;
  let guard: BudgetGuard;

  beforeEach(() => {
    const result = createTestVault();
    vaultPath = result.vaultPath;
    guard = result.budgetGuard;
  });

  afterEach(() => {
    cleanupVault(vaultPath);
  });

  it("allows job when no spend recorded", async () => {
    const result = await guard.checkBudget("feature-coder");
    expect(result.allowed).toBe(true);
    expect(result.spent).toBe(0);
    expect(result.budgetUsd).toBe(10);
    expect(result.remaining).toBe(10);
    expect(result.warning).toBeUndefined();
  });

  it("allows job when spend is well under budget", async () => {
    const today = new Date().toISOString().split("T")[0];
    writeSpendEntry(vaultPath, today, "feature-coder", 2.5);

    const result = await guard.checkBudget("feature-coder");
    expect(result.allowed).toBe(true);
    expect(result.spent).toBeCloseTo(2.5, 4);
    expect(result.remaining).toBeCloseTo(7.5, 4);
    expect(result.warning).toBeUndefined();
  });

  it("fires warning at 80% usage", async () => {
    const today = new Date().toISOString().split("T")[0];
    writeSpendEntry(vaultPath, today, "feature-coder", 8.5); // 85% of $10

    const result = await guard.checkBudget("feature-coder");
    expect(result.allowed).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("feature-coder");
  });

  it("blocks job when budget is exhausted", async () => {
    const today = new Date().toISOString().split("T")[0];
    writeSpendEntry(vaultPath, today, "feature-coder", 10.5); // Over $10 budget

    const result = await guard.checkBudget("feature-coder");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.warning).toContain("exhausted");
  });

  it("uses default budget for unknown agents", async () => {
    const result = await guard.checkBudget("unknown-agent");
    expect(result.budgetUsd).toBe(1); // default: 1
    expect(result.allowed).toBe(true);
  });

  it("agent budgets are independent (feature-coder vs security-auditor)", async () => {
    const today = new Date().toISOString().split("T")[0];
    // Security-auditor is over budget (>$2)
    writeSpendEntry(vaultPath, today, "security-auditor", 3.0);

    const featureCoderResult = await guard.checkBudget("feature-coder");
    const securityAuditorResult = await guard.checkBudget("security-auditor");

    expect(featureCoderResult.allowed).toBe(true); // $10 budget, $0 spent
    expect(securityAuditorResult.allowed).toBe(false); // $2 budget, $3 spent
  });

  it("only counts current month's spend", async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    const lastMonthDate = lastMonth.toISOString().split("T")[0];
    const today = now.toISOString().split("T")[0];

    // Spend from last month
    writeSpendEntry(vaultPath, lastMonthDate, "feature-coder", 50.0);
    // Small spend this month
    writeSpendEntry(vaultPath, today, "feature-coder", 1.0);

    const result = await guard.checkBudget("feature-coder");
    expect(result.spent).toBeCloseTo(1.0, 4); // Only this month's spend
    expect(result.allowed).toBe(true);
  });

  it("recordSpend writes tagged entry to daily log", async () => {
    await guard.recordSpend("feature-coder", 0.0042, "test-job-123");

    const spent = guard.getAgentSpend("feature-coder");
    expect(spent).toBeCloseTo(0.0042, 4);
  });

  it("getAgentSpend sums across multiple days in current month", async () => {
    const now = new Date();
    const day1 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const day2 = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-02`;

    writeSpendEntry(vaultPath, day1, "feature-coder", 2.0);
    writeSpendEntry(vaultPath, day2, "feature-coder", 3.0);

    const spent = guard.getAgentSpend("feature-coder");
    expect(spent).toBeCloseTo(5.0, 4);
  });

  it("handles missing budget.md gracefully (unlimited budget)", async () => {
    // Remove budget.md
    fs.unlinkSync(path.join(vaultPath, "_usage", "budget.md"));

    const result = await guard.checkBudget("feature-coder");
    // No budget file → Infinity budget → always allowed
    expect(result.allowed).toBe(true);
    expect(result.budgetUsd).toBe(Infinity);
  });

  it("handles missing daily directory gracefully (no spend)", () => {
    fs.rmSync(path.join(vaultPath, "_usage", "daily"), { recursive: true });
    const spent = guard.getAgentSpend("feature-coder");
    expect(spent).toBe(0);
  });
});
