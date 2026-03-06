/**
 * Context Engine — Core tests.
 *
 * Tests the budget allocator, token counter, and frame assembly.
 */

import { describe, test, expect, mock } from "bun:test";
import { countTokensFast, truncateToTokens } from "../tokenizer/counter";
import { getModelLimit, isLargeContextModel } from "../tokenizer/models";
import { PROFILES, validateProfile, mergeProfile } from "../budget/profiles";
import { computeAllocations, buildBudget } from "../budget/allocator";
import { ContextEngine } from "../index";
import type { VaultClientLike, ContextLayer } from "../types";

// ─── Token Counter ───────────────────────────────────────────────

describe("countTokensFast", () => {
  test("empty string returns 0", () => {
    expect(countTokensFast("")).toBe(0);
  });

  test("short English text returns reasonable count", () => {
    const count = countTokensFast("Hello, world!");
    // "Hello, world!" is 13 bytes → ~4 tokens
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThan(8);
  });

  test("longer text scales linearly", () => {
    const short = countTokensFast("Hello");
    const long = countTokensFast("Hello ".repeat(100));
    expect(long).toBeGreaterThan(short * 50);
  });
});

describe("truncateToTokens", () => {
  test("returns text unchanged if within budget", () => {
    const result = truncateToTokens("Short text", 100, countTokensFast);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("Short text");
  });

  test("truncates long text and adds ellipsis", () => {
    const long = "word ".repeat(500);
    const result = truncateToTokens(long, 50, countTokensFast);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("truncated");
    expect(countTokensFast(result.text)).toBeLessThan(60); // Allow some overshoot
  });
});

// ─── Model Limits ────────────────────────────────────────────────

describe("getModelLimit", () => {
  test("exact match for known models", () => {
    expect(getModelLimit("gpt-4o")).toBe(128_000);
  });

  test("prefix match for Claude models", () => {
    expect(getModelLimit("claude-sonnet-4-5-20250929")).toBe(200_000);
  });

  test("falls back to default for unknown models", () => {
    expect(getModelLimit("unknown-model-xyz")).toBe(128_000);
  });

  test("recognizes large context models", () => {
    expect(isLargeContextModel("gemini-2.5-flash")).toBe(true);
    expect(isLargeContextModel("gpt-4o")).toBe(false);
  });
});

// ─── Budget Profiles ─────────────────────────────────────────────

describe("profiles", () => {
  test("all profiles sum to 1.0", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      expect(validateProfile(profile)).toBe(true);
    }
  });

  test("mergeProfile normalizes after override", () => {
    const merged = mergeProfile(PROFILES.standard, { thread: 0.50 });
    expect(validateProfile(merged)).toBe(true);
    // Thread should be the largest allocation after merge
    expect(merged.thread).toBeGreaterThan(merged.system);
  });
});

// ─── Budget Allocator ────────────────────────────────────────────

describe("computeAllocations", () => {
  test("allocations sum to approximately total budget", () => {
    const alloc = computeAllocations(200_000, PROFILES.standard);
    const sum = Object.values(alloc.layers).reduce((a, b) => a + b, 0);
    // Floor rounding may lose a few tokens
    expect(sum).toBeGreaterThan(199_900);
    expect(sum).toBeLessThanOrEqual(200_000);
  });
});

describe("buildBudget", () => {
  test("produces correct utilization percentage", () => {
    const alloc = computeAllocations(100_000, PROFILES.standard);
    const usage: Record<ContextLayer, number> = {
      responseReserve: 30_000,
      system: 5_000,
      userMessage: 2_000,
      memory: 1_000,
      thread: 10_000,
      injections: 5_000,
    };
    const compacted: Record<ContextLayer, boolean> = {
      responseReserve: false,
      system: false,
      userMessage: false,
      memory: false,
      thread: false,
      injections: false,
    };

    const budget = buildBudget(100_000, alloc, usage, compacted);
    expect(budget.totalUsed).toBe(53_000);
    expect(budget.utilizationPct).toBe(53);
    expect(budget.remaining).toBe(47_000);
  });
});

// ─── Context Engine (Integration) ────────────────────────────────

describe("ContextEngine", () => {
  function createMockVault(): VaultClientLike {
    return {
      getAgentContext: async () => ({
        soul: "You are a helpful assistant.",
        memory: "User prefers Bun over npm.",
        preferences: "Concise responses preferred.",
        config: {},
        pinnedNotes: [
          { title: "Project Alpha", content: "Alpha is a web app built with Next.js" },
        ],
      }),
      searchNotes: async () => [
        { title: "Meeting Notes", content: "Discussed deployment strategy for Q2", notebook: "Work" },
      ],
      getRecentMessages: async () => [
        { role: "user" as const, content: "What's the status of Project Alpha?" },
        { role: "assistant" as const, content: "Project Alpha is progressing well..." },
        { role: "user" as const, content: "Great, let's discuss deployment." },
      ],
    };
  }

  test("builds a complete frame", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
    });

    const frame = await engine.buildFrame({
      userMessage: "Deploy Alpha to staging",
      threadId: "thread-123",
    });

    expect(frame.frameId).toBeTruthy();
    expect(frame.system).toContain("helpful assistant");
    expect(frame.memory).toContain("Bun");
    expect(frame.turns.length).toBeGreaterThan(0);
    expect(frame.injections.length).toBeGreaterThan(0);
    expect(frame.budget.limit).toBe(200_000);
    expect(frame.budget.totalUsed).toBeGreaterThan(0);
    expect(frame.meta.model).toBe("claude-sonnet-4-5");
  });

  test("flatten produces a readable string", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
    });

    const frame = await engine.buildFrame({
      userMessage: "Hello",
    });

    const flat = engine.flatten(frame);
    expect(flat).toContain("MEMORY:");
    expect(flat).toContain("User: Hello");
  });

  test("respects budget profile", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
      profile: "quick",
    });

    const frame = await engine.buildFrame({ userMessage: "Hi" });
    // Quick profile reserves 40% for response
    expect(frame.budget.layers.responseReserve.allocated).toBeGreaterThan(70_000);
  });

  test("handles missing optional vault methods gracefully", async () => {
    const minimalVault: VaultClientLike = {
      getAgentContext: async () => ({
        soul: "Test",
        memory: "",
        preferences: "",
        config: {},
        pinnedNotes: [],
      }),
      searchNotes: async () => [],
      // No getRecentMessages or getMemoryFacts
    };

    const engine = new ContextEngine({
      vault: minimalVault,
      model: "gpt-4o",
    });

    const frame = await engine.buildFrame({ userMessage: "Test" });
    expect(frame.turns.length).toBe(0);
    expect(frame.budget.limit).toBe(128_000);
  });
});
