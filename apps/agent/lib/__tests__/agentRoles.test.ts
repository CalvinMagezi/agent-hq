import { describe, test, expect } from "bun:test";
import {
    detectRole,
    getRoleConfig,
    getAllRoleConfigs,
    buildRolePromptSection,
    type AgentRole,
} from "../agentRoles";

describe("agentRoles", () => {
    describe("detectRole", () => {
        const cases: Array<[string, AgentRole]> = [
            // Coder
            ["Fix the TypeScript error in app.ts", "coder"],
            ["Implement a new login endpoint", "coder"],
            ["Refactor the authentication module", "coder"],
            ["Debug the failing test in user.test.ts", "coder"],
            ["Add a new React component for the dashboard", "coder"],
            ["Migrate the database schema to v3", "coder"],

            // Researcher
            ["Research the best authentication patterns for Next.js", "researcher"],
            ["Investigate why the build is slow", "researcher"],
            ["Find out how the API authentication works", "researcher"],
            ["Explore options for caching strategies", "researcher"],
            ["What is the difference between JWT and session tokens?", "researcher"],

            // Reviewer
            ["Review the PR for security issues", "reviewer"],
            ["Audit the code for potential vulnerabilities", "reviewer"],
            ["Code review the authentication changes", "reviewer"],
            ["Validate the schema migration is correct", "reviewer"],

            // Planner
            ["Plan the implementation of the new feature", "planner"],
            ["Design the architecture for the messaging system", "planner"],
            ["Create an RFC for the new API", "planner"],
            ["Outline a plan for the auth migration approach", "planner"],

            // DevOps
            ["Deploy the app to production", "devops"],
            ["Set up the CI/CD pipeline for GitHub Actions", "devops"],
            ["Configure Docker for the microservices", "devops"],
            ["Fix the Nginx reverse proxy configuration", "devops"],

            // Workspace
            ["Schedule a meeting for tomorrow at 2pm", "workspace"],
            ["Check my Gmail for the latest messages", "workspace"],
            ["Create a Google Doc with the project brief", "workspace"],
            ["Share the spreadsheet with the team", "workspace"],
        ];

        for (const [instruction, expected] of cases) {
            test(`"${instruction.substring(0, 50)}..." → ${expected}`, () => {
                expect(detectRole(instruction)).toBe(expected);
            });
        }

        test("falls back to coder for ambiguous instructions", () => {
            expect(detectRole("do something")).toBe("coder");
            expect(detectRole("handle this task")).toBe("coder");
        });
    });

    describe("getRoleConfig", () => {
        test("returns config for all roles", () => {
            const roles: AgentRole[] = ["coder", "researcher", "reviewer", "planner", "devops", "workspace"];
            for (const role of roles) {
                const config = getRoleConfig(role);
                expect(config.role).toBe(role);
                expect(config.description).toBeTruthy();
                expect(config.systemPromptSuffix).toBeTruthy();
                expect(config.preferredHarness).toBeTruthy();
                expect(config.outputGuidance).toBeTruthy();
            }
        });

        test("researcher has model hint for fast model", () => {
            const config = getRoleConfig("researcher");
            expect(config.modelHint).toBe("gemini-2.5-flash");
        });

        test("reviewer has model hint for smart model", () => {
            const config = getRoleConfig("reviewer");
            expect(config.modelHint).toBe("claude-opus-4-6");
        });

        test("workspace prefers gemini-cli harness", () => {
            const config = getRoleConfig("workspace");
            expect(config.preferredHarness).toBe("gemini-cli");
        });

        test("coder prefers claude-code harness", () => {
            const config = getRoleConfig("coder");
            expect(config.preferredHarness).toBe("claude-code");
        });
    });

    describe("getAllRoleConfigs", () => {
        test("returns all 6 roles", () => {
            const configs = getAllRoleConfigs();
            expect(Object.keys(configs)).toHaveLength(6);
        });
    });

    describe("buildRolePromptSection", () => {
        test("includes role name, guidance, and output format", () => {
            const section = buildRolePromptSection("reviewer");
            expect(section).toContain("REVIEWER");
            expect(section).toContain("Behavioral Guidance");
            expect(section).toContain("DO NOT modify any files");
            expect(section).toContain("Expected Output Format");
            expect(section).toContain("approved/rejected");
        });

        test("includes turn budget when maxTurns is set", () => {
            const section = buildRolePromptSection("coder");
            expect(section).toContain("Turn Budget");
            expect(section).toContain("100 turns");
        });

        test("contains role description", () => {
            const section = buildRolePromptSection("researcher");
            expect(section).toContain("Investigates questions");
        });
    });

    describe("priority: reviewer > coder for review-like instructions", () => {
        test("code review routes to reviewer, not coder", () => {
            expect(detectRole("Review this pull request")).toBe("reviewer");
            expect(detectRole("Audit the auth module code")).toBe("reviewer");
        });

        test("planner routes before coder for planning instructions", () => {
            expect(detectRole("Plan the refactoring of the API")).toBe("planner");
            expect(detectRole("Design the new schema")).toBe("planner");
        });
    });
});
