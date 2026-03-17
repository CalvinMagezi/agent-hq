/**
 * benchmark_model — HQ Tool
 *
 * Benchmarks an AI model via OpenRouter against Agent-HQ-specific workloads:
 * tool-use accuracy, JSON extraction, code generation, context handling,
 * instruction following, and summarization.
 *
 * User-triggered only — never runs automatically. Callable via:
 *   hq_discover "benchmark" → hq_call { tool: "benchmark_model", input: {...} }
 *
 * Cost controls:
 *   - Pre-flight pricing estimate before running
 *   - Per-test $0.10 budget cap
 *   - Quick/standard/full suite sizes
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { Type, type Static } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

// ── Schema ────────────────────────────────────────────────────────────────

const BenchmarkSchema = Type.Object({
  modelId: Type.String({ description: "OpenRouter model ID to benchmark (e.g., 'mistralai/mistral-small-4')" }),
  compareWith: Type.Optional(Type.String({ description: "Model ID to compare against (defaults to google/gemini-2.5-flash)" })),
  suite: Type.Optional(Type.Union([
    Type.Literal("quick"),
    Type.Literal("standard"),
    Type.Literal("full"),
  ], { description: "Test suite size: 'quick' (3 tests), 'standard' (6 tests), 'full' (10 tests). Default: standard" })),
});

type BenchmarkInput = Static<typeof BenchmarkSchema>;

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_BASELINE = "google/gemini-2.5-flash";
const JUDGE_MODEL = "google/gemini-2.5-flash-lite";
const PER_TEST_BUDGET_CAP = 0.10; // dollars
const OR_BASE = "https://openrouter.ai/api/v1";
const OR_HEADERS = {
  "HTTP-Referer": "https://github.com/CalvinMagezi/agent-hq",
  "X-Title": "Agent-HQ Benchmark",
};

// ── Test Definitions ──────────────────────────────────────────────────────

interface BenchmarkTest {
  name: string;
  category: string;
  system: string;
  user: string;
  /** If provided, a simple check for pass/fail (substring in response) */
  passCheck?: (response: string) => boolean;
  /** Context padding tokens for stress tests */
  contextPadding?: number;
}

const TOOL_USE_TEST: BenchmarkTest = {
  name: "Tool-use accuracy",
  category: "agentic",
  system: `You are an AI assistant with access to three tools:

1. vault_search(query: string) — Search the vault for notes matching a query
2. vault_write_note(folder: string, title: string, content: string) — Write a note to the vault
3. bash(command: string) — Execute a shell command

When you need to use a tool, respond with a JSON object: {"tool": "tool_name", "input": {...}}`,
  user: `Find all notes about "Kolaborate" in the vault.`,
  passCheck: (r) => {
    try {
      const parsed = JSON.parse(r.trim().replace(/^```json\n?/, "").replace(/\n?```$/, ""));
      return parsed.tool === "vault_search" && typeof parsed.input?.query === "string" &&
        parsed.input.query.toLowerCase().includes("kolaborate");
    } catch {
      return false;
    }
  },
};

const JSON_EXTRACTION_TEST: BenchmarkTest = {
  name: "JSON extraction",
  category: "structured-output",
  system: `Extract structured metadata from the given note content. Return ONLY a JSON object with these fields:
- title (string)
- tags (string array, max 4)
- noteType (one of: "project", "meeting", "idea", "reference", "task")
- priority (1-5, where 1 is highest)`,
  user: `# SiteSeer Phase 2 Kickoff

Met with the construction team today to discuss the next phase of SiteSeer deployment.
Key decisions: moving to real-time monitoring with IoT sensors, budget approved for
3 pilot sites in Kampala. Timeline: 6 weeks for MVP. Need to integrate with the
existing health inspection module. Clara will handle sensor procurement.

Action items:
- Order 50 LoRa sensors by Friday
- Set up Grafana dashboard for site telemetry
- Schedule follow-up with Kampala City Council`,
  passCheck: (r) => {
    try {
      const cleaned = r.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
      const parsed = JSON.parse(cleaned);
      return typeof parsed.title === "string" &&
        Array.isArray(parsed.tags) &&
        ["project", "meeting", "idea", "reference", "task"].includes(parsed.noteType) &&
        typeof parsed.priority === "number";
    } catch {
      return false;
    }
  },
};

const CODE_GEN_TEST: BenchmarkTest = {
  name: "Code generation (TypeScript/Bun)",
  category: "coding",
  system: `You are a TypeScript developer using the Bun runtime. Write clean, typed code. No explanations — only the code.`,
  user: `Write a TypeScript function \`parseVaultFrontmatter(content: string): { data: Record<string, unknown>; body: string }\` that:
1. Detects YAML frontmatter between --- delimiters at the start of a string
2. Parses the YAML into a Record<string, unknown>
3. Returns the parsed data and remaining body content
4. If no frontmatter exists, returns empty data and the full content as body
Do not use any external libraries — parse the YAML manually (only need to handle simple key: value pairs and arrays).`,
};

const CONTEXT_STRESS_TEST: BenchmarkTest = {
  name: "Context window stress (50K)",
  category: "context",
  system: `You are a research assistant. Answer the question based ONLY on the provided context. Quote the exact relevant passage.`,
  user: "", // filled dynamically with padding
  contextPadding: 50000,
};

const INSTRUCTION_FOLLOWING_TEST: BenchmarkTest = {
  name: "Instruction following",
  category: "structured-output",
  system: `Follow the instructions EXACTLY. Any deviation is a failure.`,
  user: `Generate a task delegation plan. Requirements:
1. Output must be valid JSON (no markdown, no explanation)
2. The JSON must have exactly these keys: "taskId", "assignee", "steps", "estimatedMinutes"
3. "steps" must be an array of exactly 3 strings
4. "taskId" must start with "TASK-" followed by 4 digits
5. "estimatedMinutes" must be between 15 and 120
6. "assignee" must be "agent-alpha"

The task: Research the latest TypeScript 6.0 features and summarize the top 3 changes.`,
  passCheck: (r) => {
    try {
      const cleaned = r.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
      const parsed = JSON.parse(cleaned);
      return parsed.assignee === "agent-alpha" &&
        /^TASK-\d{4}$/.test(parsed.taskId) &&
        Array.isArray(parsed.steps) && parsed.steps.length === 3 &&
        typeof parsed.estimatedMinutes === "number" &&
        parsed.estimatedMinutes >= 15 && parsed.estimatedMinutes <= 120;
    } catch {
      return false;
    }
  },
};

const SUMMARIZATION_TEST: BenchmarkTest = {
  name: "Project-relevant summarization",
  category: "synthesis",
  system: `You are a daily synthesis engine. Given news headlines and project descriptions, find 2 unexpected connections. Each connection: bold title + 2-3 sentence paragraph. No generic advice.`,
  user: `## Headlines
- Poland surpasses Switzerland as 20th largest economy
- Nvidia unveils DLSS 5 with real-time generative AI filtering
- Kenya agrees to stop Russia recruiting Kenyan citizens for Ukraine war
- Meta announces major AI compute partnership with Nvidia at GTC 2026

## Active Projects
- **Agent-HQ**: Local-first AI agent orchestration hub using OpenRouter
- **Kolaborate**: African talent/BPO platform connecting diaspora professionals
- **SiteSeer**: IoT-based healthcare/construction site monitoring in Uganda`,
};

const MULTI_TURN_TOOL_TEST: BenchmarkTest = {
  name: "Multi-turn tool use",
  category: "agentic",
  system: `You are an AI agent with tools: vault_search(query), vault_read(path), vault_write_note(folder, title, content).
Respond with JSON tool calls. After receiving tool results, continue reasoning.`,
  user: `I need you to:
1. Search the vault for notes about "budget"
2. Based on the search results, I'll give you a file to read
3. Then write a summary note

Let's start with step 1 — search for budget-related notes.

[After you respond, I'll provide: Tool result: vault_search returned ["Notebooks/Projects/Q1-Budget.md", "Notebooks/Projects/Budget-Review.md"]]`,
};

const ERROR_RECOVERY_TEST: BenchmarkTest = {
  name: "Error recovery",
  category: "agentic",
  system: `You are an AI agent. Use JSON tool calls. When a tool fails, try a different approach.`,
  user: `Read the file at Notebooks/Reports/quarterly.md

Tool result: ERROR — File not found: Notebooks/Reports/quarterly.md

What do you do next?`,
  passCheck: (r) => {
    // Should try to search or list, not retry the same path
    const lower = r.toLowerCase();
    return (lower.includes("search") || lower.includes("list") || lower.includes("find") || lower.includes("vault_search")) &&
      !lower.includes("quarterly.md");
  },
};

const MARKDOWN_GEN_TEST: BenchmarkTest = {
  name: "Vault note generation",
  category: "structured-output",
  system: `Generate a complete Obsidian vault note with YAML frontmatter. The frontmatter must include: noteType, tags (array), createdAt (ISO date), and pinned (boolean). The body should use proper markdown with headers, bullet lists, and wikilinks ([[note name]]).`,
  user: `Create a project kickoff note for "CloudSync" — a new feature to sync Agent-HQ vault across devices using CRDTs. Include: objectives, technical approach, risks, and first-week milestones.`,
  passCheck: (r) => {
    return r.includes("---") && r.includes("noteType") && r.includes("tags:") && r.includes("[[");
  },
};

const COST_ROUTING_TEST: BenchmarkTest = {
  name: "Cost-aware routing",
  category: "reasoning",
  system: `You route tasks to execution modes based on complexity. Modes:
- "quick" ($0.001/task): typo fixes, version bumps, simple lookups
- "standard" ($0.05/task): feature implementation, bug fixes, code review
- "thorough" ($0.50/task): architecture redesign, security audits, complex multi-file refactors

Respond with JSON array of objects: [{"task": "...", "mode": "quick|standard|thorough", "reason": "..."}]`,
  user: `Classify these tasks:
1. Fix the typo in README.md line 42
2. Implement OAuth2 PKCE flow for the mobile app
3. Redesign the event sourcing architecture to support multi-tenant isolation
4. Update the package.json version to 1.2.3
5. Add input validation to all public API endpoints`,
  passCheck: (r) => {
    try {
      const cleaned = r.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
      const parsed = JSON.parse(cleaned) as Array<{ task: string; mode: string }>;
      if (!Array.isArray(parsed) || parsed.length !== 5) return false;
      // Check obvious ones
      const modes = parsed.map((p) => p.mode);
      return modes[0] === "quick" && modes[3] === "quick" && modes[2] === "thorough";
    } catch {
      return false;
    }
  },
};

function getTestSuite(suite: "quick" | "standard" | "full"): BenchmarkTest[] {
  const quick = [TOOL_USE_TEST, JSON_EXTRACTION_TEST, CODE_GEN_TEST];
  const standard = [...quick, CONTEXT_STRESS_TEST, INSTRUCTION_FOLLOWING_TEST, SUMMARIZATION_TEST];
  const full = [...standard, MULTI_TURN_TOOL_TEST, ERROR_RECOVERY_TEST, MARKDOWN_GEN_TEST, COST_ROUTING_TEST];

  switch (suite) {
    case "quick": return quick;
    case "standard": return standard;
    case "full": return full;
  }
}

// ── OpenRouter Helpers ────────────────────────────────────────────────────

interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  name: string;
}

async function fetchModelPricing(apiKey: string, modelId: string): Promise<ModelPricing | null> {
  try {
    const response = await fetch(`${OR_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, ...OR_HEADERS },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }> };
    const model = data.data.find((m) => m.id === modelId);
    if (!model) return null;
    return {
      inputPerM: parseFloat(model.pricing.prompt) * 1_000_000,
      outputPerM: parseFloat(model.pricing.completion) * 1_000_000,
      name: model.name,
    };
  } catch {
    return null;
  }
}

interface LLMResult {
  content: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

async function callModel(apiKey: string, modelId: string, system: string, user: string): Promise<LLMResult> {
  const start = Date.now();
  const response = await fetch(`${OR_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...OR_HEADERS,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const latencyMs = Date.now() - start;

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`OpenRouter ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content ?? "",
    latencyMs,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

// ── Judge ─────────────────────────────────────────────────────────────────

interface JudgeScore {
  correctness: number;
  completeness: number;
  format: number;
  notes: string;
}

async function judgeResponse(
  apiKey: string,
  testName: string,
  system: string,
  user: string,
  response: string,
): Promise<JudgeScore> {
  const judgePrompt = `Rate this AI model response on a 1-5 scale for three criteria.

## Task Given to Model
System: ${system.slice(0, 300)}
User: ${user.slice(0, 500)}

## Model's Response
${response.slice(0, 2000)}

## Scoring
- correctness (1-5): Did it produce the right answer/output?
- completeness (1-5): Did it address all parts of the request?
- format (1-5): Did it follow the requested output format?

Respond with ONLY a JSON object: {"correctness": N, "completeness": N, "format": N, "notes": "brief note"}`;

  try {
    const result = await callModel(apiKey, JUDGE_MODEL, "You are a precise AI evaluator. Output only valid JSON.", judgePrompt);
    const cleaned = result.content.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(cleaned) as JudgeScore;
    return {
      correctness: Math.min(5, Math.max(1, parsed.correctness ?? 3)),
      completeness: Math.min(5, Math.max(1, parsed.completeness ?? 3)),
      format: Math.min(5, Math.max(1, parsed.format ?? 3)),
      notes: (parsed.notes ?? "").slice(0, 200),
    };
  } catch {
    return { correctness: 3, completeness: 3, format: 3, notes: "Judge failed — default scores" };
  }
}

// ── Context Padding Generator ─────────────────────────────────────────────

function generateContextPadding(targetChars: number): { padding: string; needle: string } {
  const needle = "The quarterly budget allocation for SiteSeer Phase 2 was confirmed at $47,500 USD on March 3rd.";
  const fillerTopics = [
    "Meeting notes from the design review covered component architecture, state management patterns, and deployment strategies.",
    "The infrastructure team reported 99.7% uptime for the past quarter with only two minor incidents.",
    "Marketing analysis showed a 23% increase in user engagement following the dashboard redesign.",
    "Security audit findings included three low-severity issues related to dependency versions.",
    "The product roadmap for Q2 includes feature flags, A/B testing, and improved onboarding flows.",
    "Database optimization reduced average query time from 45ms to 12ms on the main reporting endpoint.",
    "Customer feedback highlighted the need for better mobile responsiveness and offline support.",
    "The DevOps pipeline migration to GitHub Actions saved approximately 40 minutes per deployment cycle.",
  ];

  const lines: string[] = [];
  let chars = 0;
  let needleInserted = false;
  const insertPoint = targetChars * 0.6; // 60% through

  while (chars < targetChars) {
    if (!needleInserted && chars > insertPoint) {
      lines.push(needle);
      chars += needle.length;
      needleInserted = true;
    }
    const filler = fillerTopics[lines.length % fillerTopics.length];
    lines.push(filler);
    chars += filler.length + 1;
  }

  if (!needleInserted) lines.splice(Math.floor(lines.length * 0.6), 0, needle);

  return { padding: lines.join("\n"), needle };
}

// ── Main Tool ─────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  category: string;
  latencyMs: number;
  cost: number;
  score: JudgeScore;
  passed: boolean | null; // null if no passCheck
}

export const BenchmarkModelTool: HQTool<BenchmarkInput, string> = {
  name: "benchmark_model",
  description:
    "Benchmark an AI model via OpenRouter against Agent-HQ workloads. Tests tool-use, code gen, JSON extraction, reasoning, and context handling. Returns a scored comparison against your current models. User-triggered only — never runs automatically.",
  tags: ["benchmark", "model", "test", "evaluate", "ai", "compare", "openrouter"],
  schema: BenchmarkSchema,
  requiresWriteAccess: true,

  async execute(input: BenchmarkInput, ctx: HQContext): Promise<string> {
    const apiKey = ctx.openrouterApiKey;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not configured — cannot benchmark models");
    }

    const modelId = input.modelId;
    const baselineId = input.compareWith ?? DEFAULT_BASELINE;
    const suite = input.suite ?? "standard";
    const tests = getTestSuite(suite);

    // ── Pre-flight: fetch pricing ───────────────────────────────────────
    const [modelPricing, baselinePricing] = await Promise.all([
      fetchModelPricing(apiKey, modelId),
      fetchModelPricing(apiKey, baselineId),
    ]);

    if (!modelPricing) {
      throw new Error(`Model "${modelId}" not found on OpenRouter. Check the model ID.`);
    }

    const modelName = modelPricing.name;
    const baselineName = baselinePricing?.name ?? baselineId;

    // ── Run tests ───────────────────────────────────────────────────────
    const modelResults: TestResult[] = [];
    const baselineResults: TestResult[] = [];
    let totalCost = 0;

    for (const test of tests) {
      let userPrompt = test.user;

      // Handle context stress test
      if (test.contextPadding) {
        const { padding, needle } = generateContextPadding(test.contextPadding);
        userPrompt = `## Vault Context\n${padding}\n\n## Question\nWhat was the confirmed quarterly budget allocation for SiteSeer Phase 2, and when was it confirmed? Quote the exact passage.`;
        test.passCheck = (r) => r.includes("$47,500") || r.includes("47,500") || r.includes("March 3");
      }

      // Run target model
      try {
        const result = await callModel(apiKey, modelId, test.system, userPrompt);
        const cost = (result.promptTokens * (modelPricing.inputPerM / 1_000_000)) +
          (result.completionTokens * (modelPricing.outputPerM / 1_000_000));

        if (cost > PER_TEST_BUDGET_CAP) {
          modelResults.push({
            name: test.name, category: test.category,
            latencyMs: result.latencyMs, cost,
            score: { correctness: 0, completeness: 0, format: 0, notes: "BUDGET CAP — test aborted" },
            passed: false,
          });
          totalCost += cost;
          continue;
        }

        totalCost += cost;
        const score = await judgeResponse(apiKey, test.name, test.system, userPrompt, result.content);
        const passed = test.passCheck ? test.passCheck(result.content) : null;

        modelResults.push({ name: test.name, category: test.category, latencyMs: result.latencyMs, cost, score, passed });
      } catch (err: any) {
        modelResults.push({
          name: test.name, category: test.category,
          latencyMs: 0, cost: 0,
          score: { correctness: 0, completeness: 0, format: 0, notes: `Error: ${err.message?.slice(0, 100)}` },
          passed: false,
        });
      }

      // Run baseline model (same test)
      try {
        const result = await callModel(apiKey, baselineId, test.system, userPrompt);
        const cost = baselinePricing
          ? (result.promptTokens * (baselinePricing.inputPerM / 1_000_000)) +
            (result.completionTokens * (baselinePricing.outputPerM / 1_000_000))
          : 0;
        totalCost += cost;
        const score = await judgeResponse(apiKey, test.name, test.system, userPrompt, result.content);
        const passed = test.passCheck ? test.passCheck(result.content) : null;
        baselineResults.push({ name: test.name, category: test.category, latencyMs: result.latencyMs, cost, score, passed });
      } catch (err: any) {
        baselineResults.push({
          name: test.name, category: test.category,
          latencyMs: 0, cost: 0,
          score: { correctness: 0, completeness: 0, format: 0, notes: `Error: ${err.message?.slice(0, 100)}` },
          passed: false,
        });
      }
    }

    // ── Compute aggregates ──────────────────────────────────────────────
    const avgScore = (results: TestResult[]) => {
      const valid = results.filter((r) => r.score.correctness > 0);
      if (valid.length === 0) return 0;
      return valid.reduce((s, r) => s + (r.score.correctness + r.score.completeness + r.score.format) / 3, 0) / valid.length;
    };
    const avgLatency = (results: TestResult[]) => {
      const valid = results.filter((r) => r.latencyMs > 0);
      if (valid.length === 0) return 0;
      return Math.round(valid.reduce((s, r) => s + r.latencyMs, 0) / valid.length);
    };

    const modelAvgScore = avgScore(modelResults);
    const baselineAvgScore = avgScore(baselineResults);
    const modelAvgLatency = avgLatency(modelResults);
    const modelTotalCost = modelResults.reduce((s, r) => s + r.cost, 0);

    // ── Generate verdict via LLM ────────────────────────────────────────
    const verdictPrompt = `Compare these benchmark results for Agent-HQ (AI agent orchestration system).

Target: ${modelName} (${modelId}) — avg quality: ${modelAvgScore.toFixed(1)}/5, avg latency: ${modelAvgLatency}ms, cost: $${modelTotalCost.toFixed(4)}
Baseline: ${baselineName} (${baselineId}) — avg quality: ${baselineAvgScore.toFixed(1)}/5, avg latency: ${avgLatency(baselineResults)}ms

Give a 2-sentence verdict: is this model worth adding to Agent-HQ's model stack? If so, which tier (flash/standard/thorough/worker) and what would it replace or complement?`;

    let verdict = "";
    try {
      const vResult = await callModel(apiKey, JUDGE_MODEL, "Be concise and specific. 2 sentences max.", verdictPrompt);
      verdict = vResult.content.trim();
    } catch {
      verdict = `${modelName} scored ${modelAvgScore.toFixed(1)}/5 vs baseline ${baselineAvgScore.toFixed(1)}/5. Manual review recommended.`;
    }

    // ── Build results table ─────────────────────────────────────────────
    const tableRows = modelResults.map((mr, i) => {
      const br = baselineResults[i];
      const mScore = ((mr.score.correctness + mr.score.completeness + mr.score.format) / 3).toFixed(1);
      const bScore = br ? ((br.score.correctness + br.score.completeness + br.score.format) / 3).toFixed(1) : "—";
      const passStr = mr.passed === null ? "" : mr.passed ? " ✅" : " ❌";
      return `| ${mr.name} | ${mScore}/5${passStr} | ${bScore}/5 | ${mr.latencyMs}ms | $${mr.cost.toFixed(4)} | ${mr.score.notes} |`;
    }).join("\n");

    // ── Write report to vault ───────────────────────────────────────────
    const today = new Date().toISOString().split("T")[0];
    const shortName = modelId.split("/").pop() ?? modelId;

    const toolUseResults = modelResults.filter((r) => r.passed !== null);
    const toolUseAccuracy = toolUseResults.length > 0
      ? toolUseResults.filter((r) => r.passed).length / toolUseResults.length
      : null;

    const frontmatterData = {
      noteType: "benchmark-report",
      tags: ["benchmark", "ai-intelligence", "model-eval"],
      model: modelId,
      comparedWith: baselineId,
      suite,
      date: today,
      totalCost: parseFloat(totalCost.toFixed(4)),
      avgQualityScore: parseFloat(modelAvgScore.toFixed(2)),
      avgLatencyMs: modelAvgLatency,
      ...(toolUseAccuracy !== null ? { toolUseAccuracy: parseFloat(toolUseAccuracy.toFixed(2)) } : {}),
    };

    const reportContent = [
      `# Benchmark: ${shortName} vs ${baselineId.split("/").pop()}`,
      "",
      "## Verdict",
      "",
      verdict,
      "",
      "## Results",
      "",
      "| Test | Model Score | Baseline Score | Latency | Cost | Notes |",
      "|------|------------|----------------|---------|------|-------|",
      tableRows,
      "",
      "## Summary",
      "",
      `- **Model**: ${modelName} (\`${modelId}\`)`,
      `- **Baseline**: ${baselineName} (\`${baselineId}\`)`,
      `- **Suite**: ${suite} (${tests.length} tests)`,
      `- **Avg quality**: ${modelAvgScore.toFixed(1)}/5 (baseline: ${baselineAvgScore.toFixed(1)}/5)`,
      `- **Avg latency**: ${modelAvgLatency}ms`,
      `- **Total benchmark cost**: $${totalCost.toFixed(4)}`,
      `- **Pricing**: $${modelPricing.inputPerM.toFixed(2)}/$${modelPricing.outputPerM.toFixed(2)} per M tokens (input/output)`,
      "",
    ].join("\n");

    const reportPath = path.join(ctx.vaultPath, "Notebooks", "AI Intelligence");
    fs.mkdirSync(reportPath, { recursive: true });
    const filePath = path.join(reportPath, `Benchmark — ${shortName} — ${today}.md`);
    fs.writeFileSync(filePath, matter.stringify(reportContent, frontmatterData), "utf-8");

    // ── Return concise summary for conversation ─────────────────────────
    const summary = [
      `**Benchmark: ${modelName}** (${suite} suite, ${tests.length} tests)`,
      `Score: ${modelAvgScore.toFixed(1)}/5 vs baseline ${baselineAvgScore.toFixed(1)}/5 | Latency: ${modelAvgLatency}ms | Cost: $${totalCost.toFixed(4)}`,
      verdict,
      `Full report: Notebooks/AI Intelligence/Benchmark — ${shortName} — ${today}.md`,
    ].join("\n");

    return summary;
  },
};
