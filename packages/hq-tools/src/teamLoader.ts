import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import type { TeamManifest } from "./types/teamManifest.js";

export const TEAMS_DIR = path.resolve(process.cwd(), "packages/hq-tools/teams");
// User-defined teams go into the vault registry instead
// Defaulting it relative to the workspace root
export const VAULT_TEAMS_DIR = path.resolve(__dirname, "../../../../.vault/_team-registry");

export function parseTeamFile(filePath: string): TeamManifest | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, "utf-8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  
  try {
    // Some teams might just have yaml, no markdown body, others might have markdown.
    const yamlStr = match ? match[1] : content;
    const fm = yaml.load(yamlStr) as TeamManifest;
    return fm;
  } catch (err) {
    console.error(`Failed to parse team at ${filePath}:`, err);
    return null;
  }
}

export function getBuiltInTeam(name: string): TeamManifest | null {
  return parseTeamFile(path.join(TEAMS_DIR, `${name}.md`));
}

export function getCustomTeam(name: string): TeamManifest | null {
  return parseTeamFile(path.join(VAULT_TEAMS_DIR, `${name}.md`));
}

export function getTeam(name: string): TeamManifest | null {
  return getBuiltInTeam(name) || getCustomTeam(name);
}

export function listBuiltInTeams(): TeamManifest[] {
  if (!fs.existsSync(TEAMS_DIR)) return [];
  
  const files = fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith(".md"));
  return files
    .map(f => parseTeamFile(path.join(TEAMS_DIR, f)))
    .filter((t): t is TeamManifest => t !== null);
}

export function listCustomTeams(): TeamManifest[] {
  if (!fs.existsSync(VAULT_TEAMS_DIR)) return [];
  
  const files = fs.readdirSync(VAULT_TEAMS_DIR).filter(f => f.endsWith(".md"));
  return files
    .map(f => parseTeamFile(path.join(VAULT_TEAMS_DIR, f)))
    .filter((t): t is TeamManifest => t !== null);
}

export function getAllTeams(): TeamManifest[] {
  return [...listBuiltInTeams(), ...listCustomTeams()];
}
