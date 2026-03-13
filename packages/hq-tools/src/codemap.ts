/**
 * @repo/hq-tools/codemap
 *
 * Progressive codebase understanding engine.
 * Inspired by CodeBuff.
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import { 
  upsertCodemapEntry, 
  getCodemapForProject, 
  getConventionsForProject, 
  type CodemapEntry, 
  type CodemapConvention 
} from "./planDB.js";

export class CodemapEngine {
  constructor(private db: Database) {}

  /**
   * Update an entry with new observations.
   * Gathers confidence based on observation count.
   */
  async observeFile(project: string, filePath: string, data: Partial<CodemapEntry>): Promise<void> {
    const existing = this.db.prepare("SELECT confidence, observations FROM codemap_entries WHERE project = ? AND file_path = ?").get(project, filePath) as any;
    
    const observations = (existing?.observations || 0) + 1;
    // confidence = min(1.0, 0.2 + 0.1 × observations)
    const confidence = Math.min(1.0, 0.2 + 0.1 * observations);

    upsertCodemapEntry(this.db, {
      ...data,
      project,
      file_path: filePath,
      confidence,
      observations
    });
  }

  /**
   * Query the codemap for a project and return a token-efficient summary.
   */
  getSummary(project: string): string {
    const entries = getCodemapForProject(this.db, project);
    const conventions = getConventionsForProject(this.db, project);

    if (entries.length === 0) return `No codemap data for project: ${project}.`;

    const coreFiles = entries.filter(e => e.confidence > 0.7).slice(0, 10);
    const recentFiles = [...entries].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);

    let summary = `## ${project} (${entries.length} files mapped, ${conventions.length} conventions)\n`;
    
    if (coreFiles.length > 0) {
      summary += `Core: ${coreFiles.map(e => `${e.file_path}${e.purpose ? ` (${e.purpose})` : ""}`).join(", ")}\n`;
    }

    if (conventions.length > 0) {
      const convByCat = conventions.reduce((acc, c) => {
        acc[c.category] = acc[c.category] || [];
        acc[c.category].push(c.rule);
        return acc;
      }, {} as Record<string, string[]>);

      summary += `Patterns: ${Object.entries(convByCat).map(([cat, rules]) => `${cat}: ${rules.join(", ")}`).join("; ")}\n`;
    }

    if (recentFiles.length > 0) {
      summary += `Recent: ${recentFiles.map(e => path.basename(e.file_path)).join(", ")}\n`;
    }

    return summary;
  }

  /**
   * Apply decay to stale entries.
   * -0.05/month if file mtime changed but codemap not updated.
   * (This will be called by the background worker/daemon)
   */
  applyDecay(): void {
    // Simple implementation: decay confidence for entries not updated in 30 days
    this.db.prepare(`
      UPDATE codemap_entries
      SET confidence = MAX(0.1, confidence - 0.05)
      WHERE updated_at < ?
    `).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  }
}
