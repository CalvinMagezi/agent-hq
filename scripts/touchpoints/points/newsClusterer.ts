/**
 * News Clusterer — Touch Point
 * 
 * Reacts to news pulse writes in HEARTBEAT.md, clusters headlines into 
 * high-level topics using Ollama, and produces compact index + deep briefs.
 * 
 * Triggers: system:modified on _system/HEARTBEAT.md
 * Outputs:
 *  - _system/NEWS-BRIEFS.md (compact index)
 *  - Notebooks/News Briefs/{Topic} {Date}.md (per-topic detail)
 * Emits: news-linker
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import type { TouchPoint, TouchPointResult } from "../types.js";

const DEBOUNCE_MS = 120_000; // 2 minutes to allow news pulse to finish writing

interface Cluster {
  topic: string;
  summary: string;
  headlines: number[];
  sources: string[];
}

export const newsClusterer: TouchPoint = {
  name: "news-clusterer",
  description: "Cluster HEARTBEAT news pulse into topic briefs using Ollama",
  triggers: ["system:modified"],
  pathFilter: "_system/HEARTBEAT.md",
  debounceMs: DEBOUNCE_MS,

  async evaluate(event, ctx) {
    const heartbeatPath = path.join(ctx.vaultPath, "_system/HEARTBEAT.md");
    if (!fs.existsSync(heartbeatPath)) return null;

    const raw = fs.readFileSync(heartbeatPath, "utf-8");
    const newsMarker = "<!-- agent-hq-news-pulse -->";
    const markerIndex = raw.indexOf(newsMarker);
    if (markerIndex === -1) return null;

    const newsContent = raw.slice(markerIndex + newsMarker.length).trim();
    // Extract headlines: "- **[Source]** [Title](URL)"
    const headlineLines = newsContent.split("\n").filter(l => l.trim().startsWith("- **["));
    if (headlineLines.length < 3) return null; // Too few to cluster

    // Clean headlines for LLM (just Title and Source)
    const cleanedHeadlines = headlineLines.map(line => {
      const match = line.match(/- \*\*\[(.*?)\]\*\* \[(.*?)\]\(.*?\)/);
      return match ? `${match[2]} (${match[1]})` : line.trim();
    });

    const prompt = `Cluster these news headlines into 3-6 logical topics. 
Return JSON ONLY as an array of objects:
[{"topic":"Short Label","summary":"1 sentence summary","headlines":[index0, index1],"sources":["Source1", "Source2"]}]

Headlines:
${cleanedHeadlines.map((h, i) => `${i}: ${h}`).join("\n")}
`;

    const systemPrompt = "You are a news intelligence analyst. Cluster headlines into distinct topics. Be concise. Return JSON only.";

    let clusters: Cluster[] = [];
    try {
      const response = await ctx.llm(prompt, systemPrompt);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        clusters = JSON.parse(jsonMatch[0]);
      } else {
        console.warn("[news-clusterer] Failed to find JSON in LLM response");
        return null;
      }
    } catch (err) {
      console.error("[news-clusterer] LLM or Parse error:", err);
      return null;
    }

    if (!Array.isArray(clusters) || clusters.length === 0) return null;

    const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const updatedAt = new Date().toISOString();
    
    // 1. Prepare NEWS-BRIEFS.md (compact index)
    let briefsContent = `---\nnoteType: system-file\nupdatedAt: ${updatedAt}\n---\n# News Briefs\n_${clusters.length} topics from ${headlineLines.length} headlines (${dateStr})_\n\n`;

    const briefPaths: string[] = [];
    const topicLabels: string[] = [];

    const newsBriefsDir = path.join(ctx.vaultPath, "Notebooks/News Briefs");
    if (!ctx.dryRun && !fs.existsSync(newsBriefsDir)) {
      fs.mkdirSync(newsBriefsDir, { recursive: true });
    }

    for (const cluster of clusters) {
      const safeLabel = cluster.topic.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 50);
      
      const briefFileName = `${cluster.topic.replace(/[/\\?%*:|"<>]/g, "-")} ${dateStr}.md`;
      const briefRelPath = `Notebooks/News Briefs/${briefFileName}`;
      const briefFullPath = path.join(ctx.vaultPath, briefRelPath);

      const srcCount = (cluster.sources || []).length;
      briefsContent += `## ${cluster.topic} (${srcCount} source${srcCount !== 1 ? "s" : ""}${srcCount >= 2 ? " agree" : ""})\n`;
      briefsContent += `${cluster.summary}\n`;
      briefsContent += `→ See: [[${briefFileName.replace(".md", "")}]]\n\n`;

      // 2. Prepare Detailed Brief File
      const clusterHeadlines = (cluster.headlines || [])
        .map(idx => headlineLines[idx])
        .filter(Boolean);
      
      const sourceCount = (cluster.sources || []).length;
      const sourceAgreement = sourceCount >= 2;

      const briefFileContent = matter.stringify(
        `# ${cluster.topic} — ${dateStr}\n\n**${sourceCount} source${sourceCount !== 1 ? "s" : ""}${sourceAgreement ? " agree" : ""}** on this topic.\n\n## Headlines\n${clusterHeadlines.join("\n")}\n`,
        {
          noteType: "news-brief",
          topic: safeLabel,
          sources: cluster.sources || [],
          sourceAgreement,
          headlineCount: clusterHeadlines.length,
          createdAt: updatedAt,
          tags: ["news", "automated-brief"],
          embeddingStatus: "pending"
        }
      );

      if (!ctx.dryRun) {
        fs.writeFileSync(briefFullPath, briefFileContent, "utf-8");
      }
      
      briefPaths.push(briefRelPath);
      topicLabels.push(cluster.topic);
    }

    // 3. Write NEWS-BRIEFS.md
    const briefsPath = path.join(ctx.vaultPath, "_system/NEWS-BRIEFS.md");
    if (!ctx.dryRun) {
      fs.writeFileSync(briefsPath, briefsContent, "utf-8");
    }

    return {
      observation: `Clustered ${headlineLines.length} headlines into ${clusters.length} topics.`,
      actions: [`Created ${clusters.length} briefs in Notebooks/News Briefs/`, `Updated _system/NEWS-BRIEFS.md`],
      meaningful: true,
      emit: [{
        touchPoint: "news-linker",
        data: { briefPaths, topicLabels }
      }]
    };
  }
};
