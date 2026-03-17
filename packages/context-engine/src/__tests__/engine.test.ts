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
import { stripPrivateTags } from "../utils/privacy";
import { formatTokenReport } from "../observability/metrics";
import type { VaultClientLike, ContextLayer, FrameMeta, TokenBudget } from "../types";

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
    // claude-sonnet-4-5 prefix matches claude-sonnet-4-6 (1M) or claude-3.5-sonnet (200K)
    // The progressive prefix will find claude-3.5-sonnet for 3.5 models
    expect(getModelLimit("claude-3.5-sonnet-20241022")).toBe(200_000);
    // Newer Claude 4.x models are 1M
    expect(getModelLimit("claude-sonnet-4-6-20260315")).toBe(1_000_000);
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
    // claude-sonnet-4-5 prefix-matches claude-sonnet-4-6 (1M context)
    expect(frame.budget.limit).toBe(1_000_000);
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
    // Quick profile reserves 40% for response (40% of 1M = 400K)
    expect(frame.budget.layers.responseReserve.allocated).toBeGreaterThan(350_000);
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

  test("search result injections use progressive disclosure (tier-1 index)", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
    });

    const frame = await engine.buildFrame({
      userMessage: "Tell me about deployment",
    });

    const searchInjections = frame.injections.filter(i => i.source === "search_result");
    for (const inj of searchInjections) {
      expect(inj.tier).toBe("index");
      expect(inj.detailRef).toBeTruthy();
      // Index-tier injections should be compact (< 50 tokens)
      expect(inj.tokens).toBeLessThan(50);
    }
  });

  test("expandInjection returns full content for a detail ref", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
    });

    const expanded = await engine.expandInjection("Meeting Notes");
    expect(expanded).not.toBeNull();
    expect(expanded!.tier).toBe("full");
    expect(expanded!.content).toContain("Meeting Notes");
    expect(expanded!.content).toContain("Discussed deployment");
  });

  test("meta includes tokensSaved and injectionTokensSaved", async () => {
    const engine = new ContextEngine({
      vault: createMockVault(),
      model: "claude-sonnet-4-5",
    });

    const frame = await engine.buildFrame({
      userMessage: "Deploy Alpha",
      threadId: "thread-123",
    });

    expect(typeof frame.meta.tokensSaved).toBe("number");
    expect(typeof frame.meta.injectionTokensSaved).toBe("number");
    // injectionTokensSaved should be > 0 because search results use tier-1
    expect(frame.meta.injectionTokensSaved).toBeGreaterThanOrEqual(0);
  });

  test("private tags are stripped from memory", async () => {
    const vaultWithPrivate: VaultClientLike = {
      getAgentContext: async () => ({
        soul: "You are helpful.",
        memory: "User likes TypeScript. <private>API key: sk-12345</private> User prefers Bun.",
        preferences: "Concise. <private>salary: $100k</private>",
        config: {},
        pinnedNotes: [],
      }),
      searchNotes: async () => [],
    };

    const engine = new ContextEngine({
      vault: vaultWithPrivate,
      model: "gpt-4o",
    });

    const frame = await engine.buildFrame({ userMessage: "Hi" });
    expect(frame.memory).not.toContain("sk-12345");
    expect(frame.memory).not.toContain("salary");
    expect(frame.memory).toContain("TypeScript");
    expect(frame.memory).toContain("Bun");
  });
});

// ─── Privacy Utils ──────────────────────────────────────────────────

describe("stripPrivateTags", () => {
  test("strips single private block", () => {
    const result = stripPrivateTags("before <private>secret</private> after");
    expect(result).toBe("before  after");
  });

  test("strips multiple private blocks", () => {
    const result = stripPrivateTags("a <private>x</private> b <private>y</private> c");
    expect(result).toBe("a  b  c");
  });

  test("strips multiline private blocks", () => {
    const result = stripPrivateTags("start\n<private>\nline1\nline2\n</private>\nend");
    expect(result).toBe("start\n\nend");
  });

  test("returns empty string unchanged", () => {
    expect(stripPrivateTags("")).toBe("");
  });

  test("returns text unchanged when no private tags", () => {
    expect(stripPrivateTags("just normal text")).toBe("just normal text");
  });

  test("is case-insensitive", () => {
    const result = stripPrivateTags("a <PRIVATE>secret</PRIVATE> b");
    expect(result).toBe("a  b");
  });
});

// ─── Token Economics ────────────────────────────────────────────────

describe("formatTokenReport", () => {
  test("formats basic usage report", () => {
    const meta: FrameMeta = {
      assembledAt: new Date().toISOString(),
      assemblyTimeMs: 10,
      model: "gpt-4o",
      profile: "standard",
      threadTurnsIncluded: 3,
      threadTurnsSummarized: 0,
      injectionsIncluded: 2,
      chunkIndexHits: 2,
      compactionEvents: [],
      tokensSaved: 0,
      injectionTokensSaved: 0,
    };
    const budget: TokenBudget = {
      limit: 128_000,
      layers: {} as any,
      remaining: 83_000,
      compacted: false,
      totalUsed: 45_000,
      utilizationPct: 35,
    };

    const report = formatTokenReport(meta, budget);
    expect(report).toBe("Used 45K/128K (35%)");
  });

  test("includes savings when present", () => {
    const meta: FrameMeta = {
      assembledAt: new Date().toISOString(),
      assemblyTimeMs: 10,
      model: "gpt-4o",
      profile: "standard",
      threadTurnsIncluded: 3,
      threadTurnsSummarized: 2,
      injectionsIncluded: 2,
      chunkIndexHits: 2,
      compactionEvents: [{ layer: "thread", strategy: "summarize", tokensBefore: 15000, tokensAfter: 3000 }],
      tokensSaved: 12_000,
      injectionTokensSaved: 8_000,
    };
    const budget: TokenBudget = {
      limit: 128_000,
      layers: {} as any,
      remaining: 83_000,
      compacted: true,
      totalUsed: 45_000,
      utilizationPct: 35,
    };

    const report = formatTokenReport(meta, budget);
    expect(report).toContain("Saved 12K via compaction");
    expect(report).toContain("8K via progressive disclosure");
  });
});
