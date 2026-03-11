/**
 * News Linker — Touch Point
 * 
 * Receives topic briefs from news-clusterer, searches the vault for 
 * related project/memory notes, and appends them as wikilinks.
 * 
 * Triggers: Chain-only (from news-clusterer)
 */

import * as fs from "fs";
import * as path from "path";
import type { TouchPoint } from "../types.js";

interface TopicState {
  count: number;
  lastSeen: string;
  firstSeen: string;
}

export const newsLinker: TouchPoint = {
  name: "news-linker",
  description: "Link news briefs to related vault notes using keyword search",
  triggers: [], // Chain-only

  async evaluate(_event, ctx, incomingData) {
    if (!incomingData || !Array.isArray(incomingData.briefPaths) || !Array.isArray(incomingData.topicLabels)) {
      return null;
    }

    const briefPaths = incomingData.briefPaths as string[];
    const topicLabels = incomingData.topicLabels as string[];
    const actions: string[] = [];

    const statePath = path.join(ctx.vaultPath, "_system/.news-topics-state.json");
    let topicState: Record<string, TopicState> = {};
    if (fs.existsSync(statePath)) {
      try {
        topicState = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      } catch {
        /* skip invalid state */
      }
    }

    const today = new Date().toISOString().split("T")[0];

    for (let i = 0; i < briefPaths.length; i++) {
      const briefRelPath = briefPaths[i];
      const topicLabel = topicLabels[i];
      const fullPath = path.join(ctx.vaultPath, briefRelPath);

      if (!fs.existsSync(fullPath)) continue;

      // 1. Search for related notes
      // We look for top 10 matches, then filter for Projects/Memories
      const results = ctx.search.keywordSearch(topicLabel, 10)
        .filter(r => (r.notePath.includes("Projects/") || r.notePath.includes("Memories/")) && !r.notePath.includes("News Briefs/"))
        .slice(0, 3);

      if (results.length > 0) {
        const links = results.map(r => {
          // Extract just the basename for the wikilink if possible, or use title
          const title = r.title || path.basename(r.notePath, ".md");
          return `- [[${title}]]`;
        }).join("\n");
        
        const relatedSection = `\n## Related in Vault\n${links}\n`;
        
        if (!ctx.dryRun) {
          fs.appendFileSync(fullPath, relatedSection, "utf-8");
        }
        actions.push(`Linked ${results.length} notes to "${topicLabel}"`);
      }

      // 2. Update topic state
      const safeKey = topicLabel.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-");
      if (!topicState[safeKey]) {
        topicState[safeKey] = { count: 1, firstSeen: today, lastSeen: today };
      } else {
        topicState[safeKey].count++;
        topicState[safeKey].lastSeen = today;
      }
    }

    if (!ctx.dryRun) {
      try {
        const dir = path.dirname(statePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(topicState, null, 2), "utf-8");
      } catch (err) {
        console.error("[news-linker] Failed to write topic state:", err);
      }
    }

    return {
      observation: `Processed ${briefPaths.length} news briefs for vault linking.`,
      actions,
      meaningful: false
    };
  }
};
