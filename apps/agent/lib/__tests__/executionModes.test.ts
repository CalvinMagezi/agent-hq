import { describe, test, expect } from "bun:test";
import {
    detectExecutionMode,
    parseExplicitMode,
    getModeConfig,
    getAllModeConfigs,
    type ExecutionMode,
} from "../executionModes";

describe("executionModes", () => {
    describe("detectExecutionMode", () => {
        // Quick mode
        test("simple tasks → quick", () => {
            expect(detectExecutionMode("Fix the typo in README.md")).toBe("quick");
            expect(detectExecutionMode("Rename the variable to camelCase")).toBe("quick");
            expect(detectExecutionMode("Update version to 2.0")).toBe("quick");
            expect(detectExecutionMode("Change the button color to blue")).toBe("quick");
            expect(detectExecutionMode("Add a comment explaining the function")).toBe("quick");
        });

        test("very short instructions → quick", () => {
            expect(detectExecutionMode("fix it")).toBe("quick");
            expect(detectExecutionMode("bump version")).toBe("quick");
        });

        // Thorough mode
        test("complex tasks → thorough", () => {
            expect(detectExecutionMode("Refactor the entire authentication system")).toBe("thorough");
            expect(detectExecutionMode("Architect the new microservices infrastructure")).toBe("thorough");
            expect(detectExecutionMode("Redesign the database schema for scalability")).toBe("thorough");
            expect(detectExecutionMode("Comprehensive security audit of the codebase")).toBe("thorough");
            expect(detectExecutionMode("Migrate the legacy codebase from JavaScript to TypeScript")).toBe("thorough");
        });

        test("long instructions (>100 words) → thorough", () => {
            const longInstruction = Array(101).fill("word").join(" ");
            expect(detectExecutionMode(longInstruction)).toBe("thorough");
        });

        test("multiple goals with bullet list → thorough", () => {
            const bullets = `Do the following:
- Update the API endpoints
- Add authentication middleware
- Write integration tests
- Deploy to staging`;
            expect(detectExecutionMode(bullets)).toBe("thorough");
        });

        // Standard mode (15+ words, no quick/thorough keywords)
        test("medium complexity tasks → standard", () => {
            expect(detectExecutionMode("Add a new API endpoint for user profiles with input validation and proper error handling for all edge cases")).toBe("standard");
            expect(detectExecutionMode("Create a helper function for date formatting and use it across the entire application to ensure consistency everywhere")).toBe("standard");
        });

        // Explicit prefix overrides auto-detection
        test("[QUICK] prefix overrides to quick", () => {
            expect(detectExecutionMode("[QUICK] Refactor the entire auth system")).toBe("quick");
        });

        test("[THOROUGH] prefix overrides to thorough", () => {
            expect(detectExecutionMode("[THOROUGH] Fix the typo")).toBe("thorough");
        });
    });

    describe("parseExplicitMode", () => {
        test("parses [QUICK] prefix", () => {
            const result = parseExplicitMode("[QUICK] Fix the typo in README.md");
            expect(result.mode).toBe("quick");
            expect(result.cleanInstruction).toBe("Fix the typo in README.md");
        });

        test("parses [THOROUGH] prefix (case insensitive)", () => {
            const result = parseExplicitMode("[Thorough] Refactor everything");
            expect(result.mode).toBe("thorough");
            expect(result.cleanInstruction).toBe("Refactor everything");
        });

        test("parses [STANDARD] prefix", () => {
            const result = parseExplicitMode("[STANDARD] Build the new feature");
            expect(result.mode).toBe("standard");
            expect(result.cleanInstruction).toBe("Build the new feature");
        });

        test("returns null mode for no prefix", () => {
            const result = parseExplicitMode("Just do the thing");
            expect(result.mode).toBeNull();
            expect(result.cleanInstruction).toBe("Just do the thing");
        });

        test("does not parse mid-string brackets", () => {
            const result = parseExplicitMode("Please do [QUICK] this task");
            expect(result.mode).toBeNull();
            expect(result.cleanInstruction).toBe("Please do [QUICK] this task");
        });

        test("trims whitespace after prefix", () => {
            const result = parseExplicitMode("[QUICK]    lots of spaces");
            expect(result.cleanInstruction).toBe("lots of spaces");
        });
    });

    describe("getModeConfig", () => {
        test("quick mode has low limits", () => {
            const config = getModeConfig("quick");
            expect(config.maxParallelTasks).toBe(1);
            expect(config.contextBudgetMultiplier).toBe(0.5);
            expect(config.delegationTimeoutMs).toBe(5 * 60 * 1000);
            expect(config.enableDraftPlan).toBe(false);
        });

        test("standard mode has moderate limits", () => {
            const config = getModeConfig("standard");
            expect(config.maxParallelTasks).toBe(3);
            expect(config.contextBudgetMultiplier).toBe(1.0);
            expect(config.delegationTimeoutMs).toBe(30 * 60 * 1000);
            expect(config.enableDraftPlan).toBe(true);
        });

        test("thorough mode has high limits", () => {
            const config = getModeConfig("thorough");
            expect(config.maxParallelTasks).toBe(5);
            expect(config.contextBudgetMultiplier).toBe(2.0);
            expect(config.delegationTimeoutMs).toBe(60 * 60 * 1000);
            expect(config.enableDraftPlan).toBe(true);
        });

        test("quick mode prefers fast model", () => {
            expect(getModeConfig("quick").preferredModel).toBe("gemini-2.5-flash");
        });

        test("thorough mode prefers smart model", () => {
            expect(getModeConfig("thorough").preferredModel).toBe("claude-opus-4-6");
        });

        test("standard mode uses empty string (default model)", () => {
            expect(getModeConfig("standard").preferredModel).toBe("");
        });
    });

    describe("getAllModeConfigs", () => {
        test("returns all 3 modes", () => {
            const configs = getAllModeConfigs();
            expect(Object.keys(configs)).toHaveLength(3);
            expect(configs.quick).toBeTruthy();
            expect(configs.standard).toBeTruthy();
            expect(configs.thorough).toBeTruthy();
        });
    });
});
