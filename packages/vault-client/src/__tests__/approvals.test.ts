import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createTempVault, cleanupTempVault } from "./helpers";
import type { VaultClient } from "../index";

let vaultPath: string;
let client: VaultClient;

beforeEach(() => {
  const tmp = createTempVault();
  vaultPath = tmp.vaultPath;
  client = tmp.client;
});

afterEach(() => {
  cleanupTempVault(vaultPath);
});

describe("Approvals", () => {
  test("createApproval creates file in pending", async () => {
    const approvalId = await client.createApproval({
      title: "Delete database",
      description: "This will delete all data",
      toolName: "bash",
      toolArgs: { cmd: "rm -rf /data" },
      riskLevel: "critical",
      jobId: "job-abc",
      timeoutMinutes: 5,
    });

    expect(approvalId).toMatch(/^approval-\d+-[a-z0-9]+$/);

    const files = fs.readdirSync(path.join(vaultPath, "_approvals/pending"));
    expect(files.filter((f) => f.endsWith(".md")).length).toBe(1);

    const content = fs.readFileSync(
      path.join(vaultPath, "_approvals/pending", files[0]),
      "utf-8",
    );
    expect(content).toContain("status: pending");
    expect(content).toContain("riskLevel: critical");
    expect(content).toContain("toolName: bash");
    expect(content).toContain("Delete database");
  });

  test("getApproval returns pending approval", async () => {
    const approvalId = await client.createApproval({
      title: "Test approval",
      description: "Test desc",
      toolName: "file_write",
      riskLevel: "low",
    });

    const approval = await client.getApproval(approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("pending");
  });

  test("getApproval returns null for missing approval", async () => {
    const approval = await client.getApproval("nonexistent-id");
    expect(approval).toBeNull();
  });

  test("resolveApproval approved moves to resolved", async () => {
    const approvalId = await client.createApproval({
      title: "Approve me",
      description: "Please approve",
      toolName: "bash",
      riskLevel: "medium",
    });

    await client.resolveApproval(approvalId, "approved", "admin");

    // Should be gone from pending
    const pendingFiles = fs.readdirSync(path.join(vaultPath, "_approvals/pending"));
    expect(pendingFiles.filter((f) => f.endsWith(".md")).length).toBe(0);

    // Should be in resolved
    const resolvedFiles = fs.readdirSync(path.join(vaultPath, "_approvals/resolved"));
    expect(resolvedFiles.filter((f) => f.endsWith(".md")).length).toBe(1);

    // Check status
    const approval = await client.getApproval(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.resolvedBy).toBe("admin");
  });

  test("resolveApproval rejected with reason", async () => {
    const approvalId = await client.createApproval({
      title: "Reject me",
      description: "Too risky",
      toolName: "bash",
      riskLevel: "high",
    });

    await client.resolveApproval(approvalId, "rejected", "security-team", "Too dangerous");

    const approval = await client.getApproval(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.rejectionReason).toBe("Too dangerous");
  });

  test("resolveApproval throws for missing approval", async () => {
    await expect(
      client.resolveApproval("nonexistent", "approved"),
    ).rejects.toThrow("Approval not found");
  });
});
