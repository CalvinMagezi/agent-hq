import * as fs from "fs";
import * as path from "path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.join(__dirname, "skills");

// Skills that are auto-loaded into context for every HQ task (no need to call load_skill)
const AUTO_LOAD_SKILLS = ["obsidian"];

export interface Skill {
    name: string;
    description: string;
    instruction: string;
}

export class SkillLoader {
    static getSkill(name: string): Skill | null {
        // Try exact match, then kebab-case, then snake_case
        const namesToTry = [name, name.replace(/\s+/g, "-"), name.replace(/\s+/g, "_")];
        
        for (const n of namesToTry) {
            const skillPath = path.join(SKILLS_DIR, n, "SKILL.md");
            if (fs.existsSync(skillPath)) {
                const content = fs.readFileSync(skillPath, "utf-8");
                
                // Basic YAML frontmatter parsing for description
                let description = `Specialized skill for ${n}`;
                const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
                if (match) {
                    const yaml = match[1];
                    const descMatch = yaml.match(/description:\s*(.*)/);
                    if (descMatch) description = descMatch[1].trim();
                }

                return {
                    name: n,
                    description,
                    instruction: content
                };
            }
        }
        return null;
    }

    static listSkills(): string[] {
        if (!fs.existsSync(SKILLS_DIR)) {
            console.warn(`[SkillLoader] Skills directory not found: ${SKILLS_DIR}`);
            return [];
        }
        return fs.readdirSync(SKILLS_DIR).filter(file => {
            return fs.statSync(path.join(SKILLS_DIR, file)).isDirectory();
        });
    }

    /**
     * Returns the full instruction content for all auto-loaded skills (e.g. obsidian).
     * These are injected directly into the agent prompt without requiring load_skill.
     */
    static getAutoLoadedContent(): string {
        let content = "";
        for (const name of AUTO_LOAD_SKILLS) {
            const skill = this.getSkill(name);
            if (skill) {
                content += `\n${skill.instruction}\n`;
            }
        }
        return content;
    }

    static loadAllSkills(): string {
        const skills = this.listSkills();
        const autoLoaded = new Set(AUTO_LOAD_SKILLS);
        let allInstructions = "# AVAILABLE SKILLS\n\nI have access to the following specialized skill workflows. Skills marked [AUTO-LOADED] are already in my context. For others, I MUST use the 'load_skill' tool to load the full documentation before I begin any task related to these domains:\n\n";

        for (const name of skills) {
            const skill = this.getSkill(name);
            if (skill) {
                const tag = autoLoaded.has(name) ? " [AUTO-LOADED]" : "";
                allInstructions += `- **${name}**${tag}: ${skill.description}\n`;
            }
        }

        allInstructions += "\nExample: If the user says 'Build a landing page', I will first call load_skill(skillName='frontend-design').";

        return allInstructions;
    }
}

const LoadSkillSchema = Type.Object({
    skillName: Type.String({ description: "The name of the skill to load (directory name in skills/)" })
});

export const LoadSkillTool: AgentTool<typeof LoadSkillSchema> = {
    name: "load_skill",
    description: "REQUIRED: Use this to load full instructions, best practices, and automated workflows for specialized domains (frontend-design, docx, pptx, etc.) before starting the task.",
    parameters: LoadSkillSchema,
    label: "Load Skill",
    execute: async (toolCallId, args) => {
        const skill = SkillLoader.getSkill(args.skillName);
        if (!skill) {
            return {
                content: [{ type: "text", text: `Skill '${args.skillName}' not found.` }],
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
    description: "List all available skills that can be loaded.",
    parameters: ListSkillsSchema,
    label: "List Skills",
    execute: async (toolCallId, args) => {
        const skills = SkillLoader.listSkills();
        return {
            content: [{ type: "text", text: `Available Skills:\n${skills.map(s => `- ${s}`).join("\n")}` }],
            details: { skills }
        };
    }
};
