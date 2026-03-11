/**
 * list_skills + load_skill — HQ Tools
 *
 * Skills are prompt-based capability modules (SKILL.md files) that inject
 * specialized instructions into an agent's context. By living in packages/hq-tools/skills/,
 * they are globally accessible to any agent via the hq_discover/hq_call gateway.
 *
 * Skills available: pdf, docx, pptx, xlsx, frontend-design, mcp-builder,
 *                   skill-creator, code-mapper, obsidian, prompt-builder, find-skills
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

// Skills live alongside this package so any consumer can access them
export const SKILLS_DIR = path.resolve(process.cwd(), "packages/hq-tools/skills");

// Skills auto-injected into agent context without requiring explicit load_skill
export const AUTO_LOAD_SKILLS = ["obsidian", "code-mapper", "google-workspace", "voice"];

interface SkillMeta {
  name: string;
  description: string;
}

interface SkillFull extends SkillMeta {
  instruction: string;
}

function parseSkill(name: string): SkillFull | null {
  const skillPath = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(skillPath)) return null;

  const content = fs.readFileSync(skillPath, "utf-8");
  let description = `Specialized skill for ${name}`;
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (match) {
    const descMatch = match[1].match(/description:\s*(.*)/);
    if (descMatch) description = descMatch[1].trim();
  }
  return { name, description, instruction: content };
}

function listSkillNames(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR).filter((f) =>
    fs.statSync(path.join(SKILLS_DIR, f)).isDirectory()
  );
}

/** Returns full instruction content for auto-loaded skills (for agent prompt injection) */
export function getAutoLoadedSkillContent(): string {
  return AUTO_LOAD_SKILLS.map((name) => parseSkill(name)?.instruction ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Returns a formatted skills summary for injecting into agent prompts */
export function buildSkillsSummary(): string {
  const autoLoaded = new Set(AUTO_LOAD_SKILLS);
  const skills = listSkillNames()
    .map((name) => parseSkill(name))
    .filter((s): s is SkillFull => s !== null);

  let out =
    "# AVAILABLE SKILLS\n\nI have access to the following specialized skill workflows. Skills marked [AUTO-LOADED] are already in my context. For others, use hq_call('load_skill', {skillName}) before starting domain-specific work:\n\n";
  for (const s of skills) {
    const tag = autoLoaded.has(s.name) ? " [AUTO-LOADED]" : "";
    out += `- **${s.name}**${tag}: ${s.description}\n`;
  }
  return out;
}

// ── HQ Tools ────────────────────────────────────────────────────────────────

export const ListSkillsTool: HQTool<Record<string, never>, { skills: SkillMeta[] }> = {
  name: "list_skills",
  description:
    "List all available HQ skills (pdf, docx, xlsx, pptx, frontend-design, etc.). Returns skill names and descriptions. Call load_skill next to get the full instructions.",
  tags: ["skills", "capabilities", "list", "discover", "pdf", "docx", "xlsx", "pptx"],
  schema: Type.Object({}),
  async execute(_input, _ctx) {
    const skills = listSkillNames()
      .map((name) => parseSkill(name))
      .filter((s): s is SkillFull => s !== null)
      .map(({ name, description }) => ({ name, description }));
    return { skills };
  },
};

interface LoadSkillInput {
  skillName: string;
}

export const LoadSkillTool: HQTool<LoadSkillInput, { name: string; instruction: string }> = {
  name: "load_skill",
  description:
    "Load the full instructions for a skill before starting domain-specific work (e.g. load_skill('pdf') before any PDF task). Use list_skills first to see what's available.",
  tags: ["skill", "load", "instructions", "pdf", "docx", "xlsx", "pptx", "frontend", "mcp"],
  schema: Type.Object({
    skillName: Type.String({
      description:
        "Name of the skill to load (e.g. 'pdf', 'docx', 'xlsx', 'pptx', 'frontend-design', 'mcp-builder')",
    }),
  }),
  async execute(input, _ctx) {
    // Try exact match, then kebab-case, then snake_case
    const candidates = [
      input.skillName,
      input.skillName.replace(/\s+/g, "-"),
      input.skillName.replace(/\s+/g, "_"),
    ];
    let skill: SkillFull | null = null;
    for (const name of candidates) {
      skill = parseSkill(name);
      if (skill) break;
    }
    if (!skill) {
      const available = listSkillNames().join(", ");
      throw new Error(
        `Skill '${input.skillName}' not found. Available: ${available}`
      );
    }
    return { name: skill.name, instruction: skill.instruction };
  },
};
