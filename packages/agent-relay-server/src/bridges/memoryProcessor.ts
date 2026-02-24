/**
 * MemoryProcessor — Parses and stores [REMEMBER:], [GOAL:], [DONE:] tags.
 *
 * Extracted from apps/discord-relay/src/memory.ts.
 * Processes LLM responses for memory intent tags and stores them
 * in the vault's _system/MEMORY.md file.
 */

import type { VaultBridge } from "./vaultBridge";
import * as fs from "fs";
import * as path from "path";

export class MemoryProcessor {
  private bridge: VaultBridge;

  constructor(bridge: VaultBridge) {
    this.bridge = bridge;
  }

  /**
   * Parse an LLM response for memory tags, persist them to vault,
   * and return the cleaned response with tags removed.
   */
  async processResponse(response: string): Promise<string> {
    let clean = response;

    // [REMEMBER: fact] — min 5 chars of content
    const rememberMatches = [...response.matchAll(/\[REMEMBER:\s*([^\]]{5,}?)\]/gi)];
    for (const match of rememberMatches) {
      const fact = match[1].trim();
      if (fact && !this.looksLikeArtifact(fact)) {
        await this.appendToMemory("fact", fact);
      }
      clean = clean.replace(match[0], "");
    }

    // [GOAL: text] or [GOAL: text | DEADLINE: date]
    const goalMatches = [
      ...response.matchAll(/\[GOAL:\s*([^\]|]{5,}?)(?:\s*\|\s*DEADLINE:\s*([^\]]+?))?\]/gi),
    ];
    for (const match of goalMatches) {
      const goal = match[1].trim();
      if (goal && !this.looksLikeArtifact(goal)) {
        await this.appendToMemory("goal", goal, match[2]?.trim());
      }
      clean = clean.replace(match[0], "");
    }

    // [DONE: search text]
    const doneMatches = [...response.matchAll(/\[DONE:\s*([^\]]{3,}?)\]/gi)];
    for (const match of doneMatches) {
      const text = match[1].trim();
      if (text && !this.looksLikeArtifact(text)) {
        await this.markGoalDone(text);
      }
      clean = clean.replace(match[0], "");
    }

    return clean.trim();
  }

  private async appendToMemory(
    type: "fact" | "goal",
    content: string,
    deadline?: string,
  ): Promise<void> {
    const memoryPath = path.join(this.bridge.vaultDir, "_system", "MEMORY.md");

    try {
      const timestamp = new Date().toISOString().split("T")[0];
      let entry: string;

      if (type === "goal") {
        entry = deadline
          ? `\n- **[GOAL]** ${content} _(by ${deadline})_ — added ${timestamp}`
          : `\n- **[GOAL]** ${content} — added ${timestamp}`;
      } else {
        entry = `\n- ${content} — added ${timestamp}`;
      }

      if (fs.existsSync(memoryPath)) {
        fs.appendFileSync(memoryPath, entry, "utf-8");
      }
    } catch {
      // Memory write failure is non-fatal
    }
  }

  private async markGoalDone(searchText: string): Promise<void> {
    const memoryPath = path.join(this.bridge.vaultDir, "_system", "MEMORY.md");

    try {
      if (!fs.existsSync(memoryPath)) return;

      const content = fs.readFileSync(memoryPath, "utf-8");
      const lowerSearch = searchText.toLowerCase();
      const lines = content.split("\n");
      const updated = lines.map((line) => {
        if (
          line.toLowerCase().includes(lowerSearch) &&
          line.includes("[GOAL]") &&
          !line.includes("~~")
        ) {
          // Strike through the goal
          return line.replace(/\*\*\[GOAL\]\*\*/, "**[DONE]**").replace(searchText, `~~${searchText}~~`);
        }
        return line;
      });

      fs.writeFileSync(memoryPath, updated.join("\n"), "utf-8");
    } catch {
      // Non-fatal
    }
  }

  private looksLikeArtifact(text: string): boolean {
    const trimmed = text.trim();
    if (/^[\]\[|:}\{]/.test(trimmed) || /[\]\[|:}\{]$/.test(trimmed)) return true;
    if (/\[(REMEMBER|GOAL|DONE):/i.test(trimmed)) return true;
    if (!/[a-zA-Z]{3,}/.test(trimmed)) return true;
    return false;
  }
}
