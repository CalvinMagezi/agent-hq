import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ModelRegistry, resetDefaultRegistry } from "../models/registry.js";

describe("ModelRegistry", () => {
  beforeEach(() => {
    resetDefaultRegistry();
  });

  // ─── Exact match ──────────────────────────────────────────

  test("exact match returns correct spec", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("claude-opus-4-6");
    expect(spec.id).toBe("claude-opus-4-6");
    expect(spec.contextWindow).toBe(1_000_000);
    expect(spec.tier).toBe("pro");
    expect(spec.provider).toBe("anthropic");
  });

  test("exact match for Gemini model", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("gemini-2.5-flash");
    expect(spec.contextWindow).toBe(1_000_000);
    expect(spec.tier).toBe("flash");
  });

  test("exact match for GPT model", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("gpt-4o");
    expect(spec.contextWindow).toBe(128_000);
  });

  // ─── Alias resolution ────────────────────────────────────

  test("resolves short alias 'sonnet'", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("sonnet");
    expect(spec.id).toBe("claude-sonnet-4-6");
    expect(spec.contextWindow).toBe(1_000_000);
  });

  test("resolves short alias 'opus'", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("opus");
    expect(spec.id).toBe("claude-opus-4-6");
  });

  test("resolves short alias 'haiku'", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("haiku");
    expect(spec.id).toBe("claude-haiku-4-5-20251001");
  });

  test("alias resolution is case-insensitive", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("Sonnet");
    expect(spec.id).toBe("claude-sonnet-4-6");
  });

  test("resolves alias 'kimi'", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("kimi");
    expect(spec.id).toBe("moonshotai/kimi");
  });

  // ─── Prefix matching ─────────────────────────────────────

  test("prefix match for claude-sonnet-4-6-20260315", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("claude-sonnet-4-6-20260315");
    expect(spec.id).toBe("claude-sonnet-4-6");
    expect(spec.contextWindow).toBe(1_000_000);
  });

  test("prefix match for OpenRouter path google/gemini-2.5-flash-latest", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("google/gemini-2.5-flash-latest");
    // Should match "google/gemini" or "gemini-2.5-flash" via prefix
    expect(spec.contextWindow).toBeGreaterThanOrEqual(1_000_000);
  });

  test("prefix match for anthropic/claude-sonnet-4-6", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("anthropic/claude-sonnet-4-6");
    expect(spec.contextWindow).toBe(1_000_000);
  });

  // ─── Fallback ─────────────────────────────────────────────

  test("unknown model gets conservative defaults", () => {
    const reg = new ModelRegistry();
    const spec = reg.getSpec("totally-unknown-model-xyz");
    expect(spec.contextWindow).toBe(128_000);
    expect(spec.tier).toBe("standard");
    expect(spec.provider).toBe("other");
  });

  // ─── getContextWindow shortcut ────────────────────────────

  test("getContextWindow returns correct value", () => {
    const reg = new ModelRegistry();
    expect(reg.getContextWindow("claude-opus-4-6")).toBe(1_000_000);
    expect(reg.getContextWindow("gpt-4o")).toBe(128_000);
    expect(reg.getContextWindow("gemini-1.5-pro")).toBe(2_000_000);
  });

  // ─── isLargeContext ───────────────────────────────────────

  test("isLargeContext for 1M model", () => {
    const reg = new ModelRegistry();
    expect(reg.isLargeContext("claude-opus-4-6")).toBe(true);
    expect(reg.isLargeContext("gemini-2.5-flash")).toBe(true);
  });

  test("isLargeContext for small model", () => {
    const reg = new ModelRegistry();
    expect(reg.isLargeContext("gpt-4o")).toBe(false);
    expect(reg.isLargeContext("ollama/")).toBe(false);
  });

  // ─── getCheckpointConfig ──────────────────────────────────

  test("checkpoint config for small model (≤128K)", () => {
    const reg = new ModelRegistry();
    const config = reg.getCheckpointConfig("gpt-4o"); // 128K
    expect(config.thresholdPct).toBe(70);
    expect(config.summaryTargetTokens).toBe(300);
    expect(config.maxChainDepth).toBe(3);
  });

  test("checkpoint config for medium model (200K)", () => {
    const reg = new ModelRegistry();
    const config = reg.getCheckpointConfig("gpt-5"); // 200K
    expect(config.thresholdPct).toBe(75);
    expect(config.summaryTargetTokens).toBe(500);
    expect(config.maxChainDepth).toBe(5);
  });

  test("checkpoint config for large model (1M)", () => {
    const reg = new ModelRegistry();
    const config = reg.getCheckpointConfig("claude-opus-4-6"); // 1M
    expect(config.thresholdPct).toBe(85);
    expect(config.summaryTargetTokens).toBe(800);
    expect(config.maxChainDepth).toBe(10);
  });

  test("checkpoint config for huge model (2M)", () => {
    const reg = new ModelRegistry();
    const config = reg.getCheckpointConfig("gemini-1.5-pro"); // 2M
    expect(config.thresholdPct).toBe(90);
    expect(config.summaryTargetTokens).toBe(1000);
    expect(config.maxChainDepth).toBe(10);
  });

  // ─── listModels ───────────────────────────────────────────

  test("listModels returns all specs", () => {
    const reg = new ModelRegistry();
    const models = reg.listModels();
    expect(models.length).toBeGreaterThan(10);
    expect(models.some((m) => m.id === "claude-opus-4-6")).toBe(true);
    expect(models.some((m) => m.id === "gemini-2.5-flash")).toBe(true);
  });

  // ─── updateSpecs ──────────────────────────────────────────

  test("updateSpecs overrides existing model", () => {
    const reg = new ModelRegistry();
    expect(reg.getContextWindow("gpt-4o")).toBe(128_000);

    reg.updateSpecs([
      {
        id: "gpt-4o",
        provider: "openai",
        contextWindow: 256_000,
        maxOutputTokens: 32_000,
        tier: "standard",
      },
    ]);

    expect(reg.getContextWindow("gpt-4o")).toBe(256_000);
  });

  test("updateSpecs adds new model", () => {
    const reg = new ModelRegistry();
    reg.updateSpecs([
      {
        id: "new-model-2026",
        provider: "other",
        contextWindow: 500_000,
        maxOutputTokens: 16_000,
        tier: "pro",
        aliases: ["newmodel"],
      },
    ]);

    expect(reg.getContextWindow("new-model-2026")).toBe(500_000);
    expect(reg.getSpec("newmodel").id).toBe("new-model-2026");
  });

  // ─── extraSpecs in constructor ────────────────────────────

  test("constructor extraSpecs are merged", () => {
    const reg = new ModelRegistry({
      extraSpecs: [
        {
          id: "custom-local-model",
          provider: "ollama",
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          tier: "flash",
          aliases: ["custom"],
        },
      ],
    });

    expect(reg.getContextWindow("custom-local-model")).toBe(64_000);
    expect(reg.getSpec("custom").id).toBe("custom-local-model");
  });

  // ─── Vault overrides ─────────────────────────────────────

  describe("vault overrides", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-test-"));
      fs.mkdirSync(path.join(tmpDir, "_system"), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("loads overrides from vault file", () => {
      const registryFile = path.join(tmpDir, "_system", "MODEL-REGISTRY.md");
      fs.writeFileSync(
        registryFile,
        `---
updatedAt: 2026-03-17T00:00:00Z
source: test
---
# Model Registry Overrides

| id | contextWindow | maxOutputTokens | tier | aliases |
|----|---------------|-----------------|------|---------|
| gpt-4o | 256000 | 32000 | standard | |
| brand-new-model | 750000 | 24000 | pro | bnm, newbie |
`,
        "utf-8"
      );

      const reg = new ModelRegistry({ vaultPath: tmpDir });

      // Overridden model
      expect(reg.getContextWindow("gpt-4o")).toBe(256_000);

      // New model from vault
      expect(reg.getContextWindow("brand-new-model")).toBe(750_000);
      expect(reg.getSpec("bnm").id).toBe("brand-new-model");
      expect(reg.getSpec("newbie").id).toBe("brand-new-model");
    });

    test("gracefully handles missing vault file", () => {
      const reg = new ModelRegistry({ vaultPath: tmpDir });
      // Should still have defaults
      expect(reg.getContextWindow("claude-opus-4-6")).toBe(1_000_000);
    });

    test("gracefully handles malformed vault file", () => {
      const registryFile = path.join(tmpDir, "_system", "MODEL-REGISTRY.md");
      fs.writeFileSync(registryFile, "this is not a valid table at all\n\nrandom content", "utf-8");

      const reg = new ModelRegistry({ vaultPath: tmpDir });
      // Should still have defaults
      expect(reg.getContextWindow("claude-opus-4-6")).toBe(1_000_000);
    });
  });
});
