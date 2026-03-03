/**
 * Agent skills bridge — re-exports from @repo/hq-tools so the agent
 * continues to work with its existing imports while skills now live in
 * the shared package accessible to all agents.
 */

import * as fs from "fs";
import * as path from "path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
    SKILLS_DIR,
    getAutoLoadedSkillContent,
    buildSkillsSummary,
} from "@repo/hq-tools";

export { SKILLS_DIR, getAutoLoadedSkillContent, buildSkillsSummary };

// ── SkillLoader shim ────────────────────────────────────────────────────────
// Kept for any code that calls SkillLoader.getSkill() etc. directly.
// Delegates path resolution to @repo/hq-tools/skills/ (globally shared).

export interface Skill {
    name: string;
    description: string;
    instruction: string;
}

export class SkillLoader {
    static getSkill(name: string): Skill | null {
        const candidates = [name, name.replace(/\s+/g, "-"), name.replace(/\s+/g, "_")];
        for (const n of candidates) {
            const skillPath = path.join(SKILLS_DIR, n, "SKILL.md");
            if (fs.existsSync(skillPath)) {
                const content = fs.readFileSync(skillPath, "utf-8");
                let description = `Specialized skill for ${n}`;
                const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
                if (match) {
                    const descMatch = match[1].match(/description:\s*(.*)/);
                    if (descMatch) description = descMatch[1].trim();
                }
                return { name: n, description, instruction: content };
            }
        }
        return null;
    }

    static listSkills(): string[] {
        if (!fs.existsSync(SKILLS_DIR)) return [];
        return fs.readdirSync(SKILLS_DIR).filter(f =>
            fs.statSync(path.join(SKILLS_DIR, f)).isDirectory()
        );
    }

    static getAutoLoadedContent(): string {
        return getAutoLoadedSkillContent();
    }

    static loadAllSkills(): string {
        return buildSkillsSummary();
    }
}

// ── Pi SDK tool wrappers ─────────────────────────────────────────────────────
// These remain as Pi SDK AgentTool entries so they appear directly in the
// agent's tool list (for STANDARD/GUARDED profiles). They read skills from
// the shared @repo/hq-tools/skills/ directory.

const LoadSkillSchema = Type.Object({
    skillName: Type.String({
        description: "Skill name to load (e.g. 'pdf', 'docx', 'xlsx', 'pptx', 'frontend-design', 'mcp-builder')"
    })
});

export const LoadSkillTool: AgentTool<typeof LoadSkillSchema> = {
    name: "load_skill",
    description: "REQUIRED: Load full instructions for a specialized skill domain (pdf, docx, xlsx, pptx, frontend-design, mcp-builder, etc.) before starting related work.",
    parameters: LoadSkillSchema,
    label: "Load Skill",
    execute: async (_toolCallId, args) => {
        const skill = SkillLoader.getSkill(args.skillName);
        if (!skill) {
            return {
                content: [{ type: "text", text: `Skill '${args.skillName}' not found. Available: ${SkillLoader.listSkills().join(", ")}` }],
                details: {}
            };
        }
        return {
            content: [{ type: "text", text: `Skill '${skill.name}' loaded.\n\nINSTRUCTIONS:\n${skill.instruction}` }],
            details: { skill }
        };
    }
};

const ListSkillsSchema = Type.Object({});

export const ListSkillsTool: AgentTool<typeof ListSkillsSchema> = {
    name: "list_skills",
    description: "List all available skills that can be loaded via load_skill.",
    parameters: ListSkillsSchema,
    label: "List Skills",
    execute: async (_toolCallId, _args) => {
        const skills = SkillLoader.listSkills();
        return {
            content: [{ type: "text", text: `Available Skills:\n${skills.map(s => `- ${s}`).join("\n")}` }],
            details: { skills }
        };
    }
};
