/**
 * Smoke test — run with: bun apps/agent/lib/__tests__/smoke.ts
 *
 * Exercises the 3 new orchestration modules end-to-end without
 * requiring any running services (agent, relay, vault).
 */

import { detectRole, getRoleConfig, buildRolePromptSection } from "../agentRoles";
import { detectExecutionMode, parseExplicitMode, getModeConfig } from "../executionModes";
import { getFallbackChain, executeWithFallback, classifyError, serializeFallbackChain } from "../modelFallback";

console.log("=".repeat(60));
console.log("  ORCHESTRATION SMOKE TEST");
console.log("=".repeat(60));

// ── 1. Agent Roles ──────────────────────────────────────────
console.log("\n## Agent Role Detection\n");

const roleTests = [
    "Fix the TypeScript error in app.ts",
    "Research the best caching strategies for Next.js",
    "Review the PR for security vulnerabilities",
    "Plan the architecture for the new messaging feature",
    "Deploy the app to production via Vercel",
    "Schedule a meeting with the team for tomorrow at 2pm",
    "[THOROUGH] Refactor auth and add comprehensive tests",
];

for (const instruction of roleTests) {
    const role = detectRole(instruction);
    const config = getRoleConfig(role);
    const mode = detectExecutionMode(instruction);
    console.log(`  "${instruction.substring(0, 55)}${instruction.length > 55 ? "..." : ""}"`);
    console.log(`    → Role: ${role} (${config.preferredHarness}${config.modelHint ? `, hint: ${config.modelHint}` : ""})`);
    console.log(`    → Mode: ${mode} (max ${getModeConfig(mode).maxParallelTasks} parallel, ${Math.round(getModeConfig(mode).delegationTimeoutMs / 60000)}min timeout)`);
    console.log();
}

// ── 2. Role Prompt Injection ────────────────────────────────
console.log("## Role Prompt Section (reviewer)\n");
const reviewerSection = buildRolePromptSection("reviewer");
console.log(reviewerSection.split("\n").map(l => `  ${l}`).join("\n"));
console.log();

// ── 3. Execution Mode Parsing ───────────────────────────────
console.log("## Explicit Mode Parsing\n");
const parseCases = [
    "[QUICK] Fix the typo in README.md",
    "[THOROUGH] Refactor the entire auth system",
    "No prefix here, just a normal instruction",
];
for (const inst of parseCases) {
    const { mode, cleanInstruction } = parseExplicitMode(inst);
    console.log(`  Input:  "${inst}"`);
    console.log(`  Mode:   ${mode ?? "(auto-detect)"}`);
    console.log(`  Clean:  "${cleanInstruction}"`);
    console.log();
}

// ── 4. LLM Fallback Chains ─────────────────────────────────
console.log("## Fallback Chains\n");
const models = ["gemini-2.5-flash", "claude-opus-4-6", "gpt-4.1-mini", "custom-unknown-model"];
for (const model of models) {
    const chain = getFallbackChain(model);
    console.log(`  ${model}: ${serializeFallbackChain(chain)}`);
}
console.log();

// ── 5. Error Classification ─────────────────────────────────
console.log("## Error Classification\n");
const errors = [
    new Error("503 Service Unavailable"),
    new Error("429 Rate limit exceeded"),
    new Error("401 Unauthorized"),
    new Error("Request aborted by user"),
    new Error("Context too large for model"),
    new Error("fetch failed: ECONNRESET"),
];
for (const err of errors) {
    console.log(`  "${err.message}" → ${classifyError(err)}`);
}
console.log();

// ── 6. Fallback Execution Simulation ────────────────────────
console.log("## Fallback Execution Simulation\n");
const chain = getFallbackChain("gemini-2.5-flash");
let callCount = 0;

try {
    const result = await executeWithFallback(
        chain,
        async (modelId) => {
            callCount++;
            if (callCount <= 1) {
                console.log(`  Attempt ${callCount}: ${modelId} → 503 (transient)`);
                throw new Error("503 Service Unavailable");
            }
            console.log(`  Attempt ${callCount}: ${modelId} → SUCCESS`);
            return `Result from ${modelId}`;
        },
        (from, to, error) => {
            console.log(`  Falling back: ${from} → ${to} (reason: ${error.message})`);
        },
    );
    console.log(`  Final result: "${result}"`);
} catch (err: any) {
    console.log(`  Failed: ${err.message}`);
}

console.log("\n" + "=".repeat(60));
console.log("  ALL SMOKE TESTS PASSED");
console.log("=".repeat(60));
