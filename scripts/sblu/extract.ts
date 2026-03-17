/**
 * SBLU Training Data Extractor
 *
 * Generates JSONL training datasets for fine-tuning SBLU models via MLX-LM.
 *
 * For SBLU-1 Cartographer, it extracts:
 * - Historical vault snapshots (file lists + link structures)
 * - Past LINK-HEALTH.md outputs as ground truth
 * - Synthetic examples generated from current vault state
 *
 * Output format (JSONL, one per line):
 * { "prompt": "<system>\n...\n<user>\n...", "completion": "{...json...}" }
 *
 * Usage:
 *   bun scripts/sblu/extract.ts --sblu cartographer --vault /path/to/.vault --out /tmp/train.jsonl
 */

import * as fs from "fs";
import * as path from "path";
import { walkVaultFiles } from "@repo/vault-native";

// ── CLI Args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string, defaultVal = "") => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? (args[idx + 1] ?? defaultVal) : defaultVal;
};

const SBLU_NAME = getArg("--sblu", "cartographer");
const VAULT_PATH = getArg("--vault", process.env.VAULT_PATH ?? "");
const OUT_FILE = getArg("--out", `/tmp/sblu-${SBLU_NAME}-train.jsonl`);
const MIN_EXAMPLES = parseInt(getArg("--min", "30"), 10);

if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
    console.error(`Error: --vault path not specified or does not exist: "${VAULT_PATH}"`);
    process.exit(1);
}

// ── Training Example Format ───────────────────────────────────────────

interface TrainingExample {
    prompt: string;
    completion: string;
    quality_score: number; // 0–1
    source: "historical" | "synthetic" | "preference";
}

// ── Cartographer Extractor ────────────────────────────────────────────

function collectMarkdownFiles(vaultPath: string, maxFiles = 2000): string[] {
    const skipDirs = ["_embeddings", ".git", "node_modules", ".obsidian"];
    const files = walkVaultFiles(vaultPath, skipDirs, "md");
    return files.slice(0, maxFiles);
}

function extractWikilinks(content: string): string[] {
    const links: string[] = [];
    const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const target = m[1]!.trim();
        if (target) links.push(target);
    }
    return links;
}

/** Build the cartographer prompt from a file list (same format as production) */
function buildCartographerPrompt(files: string[]): string {
    const notebookFiles = files.filter(f => f.startsWith("Notebooks/")).slice(0, 200);
    const fileTree = notebookFiles.join("\n");
    return `You are analyzing a personal knowledge vault. Here are the note file paths:

## Notes (${notebookFiles.length} shown)
${fileTree}

## Currently Orphaned Notes
(computed separately)

Identify 3-8 pairs or small groups of notes that are likely semantically related but are NOT yet linked to each other. Focus on notes that share a topic, project, or concept based on their file paths/titles.

Return ONLY valid JSON with this exact schema:
{
  "cluster_gaps": [
    {
      "notes": ["path/to/note-a.md", "path/to/note-b.md"],
      "suggested_link": "Brief description of why these should be connected",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;
}

/**
 * Parse historical LINK-HEALTH.md files to extract past outputs as ground truth.
 * (These may exist as git history or archived copies.)
 */
function extractHistoricalExamples(vaultPath: string): TrainingExample[] {
    const examples: TrainingExample[] = [];

    // Check for archived link health reports
    const archiveDir = path.join(vaultPath, "_logs");
    if (!fs.existsSync(archiveDir)) return examples;

    // Walk through log directories for any LINK-HEALTH snapshots
    try {
        const dateDirs = fs.readdirSync(archiveDir);
        for (const dateDir of dateDirs) {
            const linkHealthPath = path.join(archiveDir, dateDir, "LINK-HEALTH.md");
            if (!fs.existsSync(linkHealthPath)) continue;

            const content = fs.readFileSync(linkHealthPath, "utf-8");
            // Try to extract cluster_gaps JSON from the content
            const gapMatch = content.match(/cluster_gaps.*?(\[[\s\S]*?\])/i);
            if (gapMatch) {
                try {
                    const gaps = JSON.parse(gapMatch[1]!);
                    if (Array.isArray(gaps) && gaps.length > 0) {
                        const files = collectMarkdownFiles(vaultPath, 500);
                        const prompt = buildCartographerPrompt(files);
                        examples.push({
                            prompt,
                            completion: JSON.stringify({ cluster_gaps: gaps }),
                            quality_score: 0.9,
                            source: "historical",
                        });
                    }
                } catch {
                    // Skip malformed entries
                }
            }
        }
    } catch {
        // Log archive not available
    }

    return examples;
}

/**
 * Generate synthetic training examples from the current vault state.
 * Uses multiple heuristics: path-proximity, tag overlap, and temporal clustering.
 */
function generateSyntheticExamples(vaultPath: string, count: number): TrainingExample[] {
    const examples: TrainingExample[] = [];
    const allFiles = collectMarkdownFiles(vaultPath, 2000);
    const matter = require("gray-matter");

    // Pre-load tag and mtime data for enhanced heuristics
    const tagIndex = new Map<string, string[]>(); // tag → [files]
    const mtimeIndex = new Map<string, number>();  // file → mtime ms
    const notebookFiles = allFiles.filter(f => f.startsWith("Notebooks/"));

    for (const relPath of notebookFiles) {
        const fullPath = path.join(vaultPath, relPath);
        try {
            const stat = fs.statSync(fullPath);
            mtimeIndex.set(relPath, stat.mtimeMs);
            const raw = fs.readFileSync(fullPath, "utf-8");
            const { data } = matter(raw);
            if (Array.isArray(data.tags)) {
                for (const tag of data.tags) {
                    if (typeof tag === "string") {
                        const existing = tagIndex.get(tag) ?? [];
                        existing.push(relPath);
                        tagIndex.set(tag, existing);
                    }
                }
            }
        } catch { /* skip */ }
    }

    // ── Strategy 1: Path-proximity (same project, unlinked) ──────────
    for (let i = 0; i < Math.ceil(count * 0.5); i++) {
        const sampleSize = 50 + Math.floor(Math.random() * 150);
        const shuffled = [...allFiles].sort(() => Math.random() - 0.5);
        const sample = shuffled.slice(0, sampleSize);
        const sampleNotebooks = sample.filter(f => f.startsWith("Notebooks/"));

        const projectGroups = new Map<string, string[]>();
        for (const file of sampleNotebooks) {
            const parts = file.split("/");
            if (parts.length >= 3) {
                const project = parts[2]!;
                if (!projectGroups.has(project)) projectGroups.set(project, []);
                projectGroups.get(project)!.push(file);
            }
        }

        const gaps: Array<{ notes: string[]; suggested_link: string; confidence: "high" | "medium" | "low" }> = [];
        for (const [project, files] of projectGroups) {
            if (files.length < 2 || gaps.length >= 5) break;
            const pair = files.sort(() => Math.random() - 0.5).slice(0, 2);
            gaps.push({
                notes: pair,
                suggested_link: `Both notes are part of the ${project} project and likely share context`,
                confidence: "medium",
            });
        }

        if (gaps.length > 0) {
            examples.push({
                prompt: buildCartographerPrompt(sample),
                completion: JSON.stringify({ cluster_gaps: gaps }),
                quality_score: 0.7,
                source: "synthetic",
            });
        }
    }

    // ── Strategy 2: Tag overlap (notes sharing 2+ tags in different folders) ──
    const tagPairs = new Set<string>();
    for (const [tag, files] of tagIndex) {
        if (files.length < 2) continue;
        for (let i = 0; i < files.length && tagPairs.size < Math.ceil(count * 0.3); i++) {
            for (let j = i + 1; j < files.length; j++) {
                const a = files[i]!, b = files[j]!;
                const folderA = a.split("/").slice(0, 3).join("/");
                const folderB = b.split("/").slice(0, 3).join("/");
                if (folderA === folderB) continue; // same folder = not interesting
                const pairKey = [a, b].sort().join("|");
                if (tagPairs.has(pairKey)) continue;
                tagPairs.add(pairKey);

                const sample = [...allFiles].sort(() => Math.random() - 0.5).slice(0, 100);
                if (!sample.includes(a)) sample.push(a);
                if (!sample.includes(b)) sample.push(b);

                examples.push({
                    prompt: buildCartographerPrompt(sample),
                    completion: JSON.stringify({ cluster_gaps: [{
                        notes: [a, b],
                        suggested_link: `Both notes share the tag "${tag}" but are in different project folders`,
                        confidence: "high",
                    }] }),
                    quality_score: 0.75,
                    source: "synthetic",
                });
                break; // one per tag to diversify
            }
        }
    }

    // ── Strategy 3: Temporal clustering (modified within 2h window, different projects) ──
    const sortedByMtime = [...mtimeIndex.entries()].sort((a, b) => b[1] - a[1]);
    const TWO_HOURS = 2 * 60 * 60 * 1000;

    for (let i = 0; i < sortedByMtime.length - 1 && examples.length < count * 1.2; i++) {
        const [fileA, mtimeA] = sortedByMtime[i]!;
        const [fileB, mtimeB] = sortedByMtime[i + 1]!;
        if (Math.abs(mtimeA - mtimeB) > TWO_HOURS) continue;

        const folderA = fileA.split("/").slice(0, 3).join("/");
        const folderB = fileB.split("/").slice(0, 3).join("/");
        if (folderA === folderB) continue;

        const sample = [...allFiles].sort(() => Math.random() - 0.5).slice(0, 100);
        if (!sample.includes(fileA)) sample.push(fileA);
        if (!sample.includes(fileB)) sample.push(fileB);

        examples.push({
            prompt: buildCartographerPrompt(sample),
            completion: JSON.stringify({ cluster_gaps: [{
                notes: [fileA, fileB],
                suggested_link: `Both notes were modified around the same time, suggesting related work`,
                confidence: "low",
            }] }),
            quality_score: 0.65,
            source: "synthetic",
        });
    }

    return examples;
}

/** Convert training examples to MLX-LM compatible JSONL format */
function formatForMLX(examples: TrainingExample[]): string[] {
    const SYSTEM_PROMPT =
        "You are SBLU-1 Vault Cartographer, a precision knowledge graph analyst. You identify structural gaps in a personal knowledge vault by analyzing file paths and note titles. You output only valid JSON matching the requested schema. No prose, no markdown fences.";

    return examples.map(ex => {
        // MLX-LM chat format
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: ex.prompt },
            { role: "assistant", content: ex.completion },
        ];

        return JSON.stringify({
            messages,
            quality_score: ex.quality_score,
            source: ex.source,
        });
    });
}

// ── Crystallizer Extractor ────────────────────────────────────────────

/**
 * Extract crystallizer training data from memory.db consolidation history.
 * Each consolidation record has the memory IDs used + the insight produced,
 * which we can reconstruct into (input, output) pairs for fine-tuning.
 */
function extractCrystallizerExamples(vaultPath: string): TrainingExample[] {
    const examples: TrainingExample[] = [];
    const dbPath = path.join(vaultPath, "_embeddings", "memory.db");
    if (!fs.existsSync(dbPath)) {
        console.log("  memory.db not found — no crystallizer examples");
        return examples;
    }

    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });

    try {
        const consolidations = db.prepare(
            "SELECT * FROM consolidations ORDER BY created_at DESC LIMIT 200"
        ).all() as Array<{ id: number; source_ids: string; insight: string; connections: string; created_at: string }>;

        for (const c of consolidations) {
            const sourceIds: number[] = JSON.parse(c.source_ids);
            if (sourceIds.length < 2) continue;

            // Fetch the source memories
            const placeholders = sourceIds.map(() => "?").join(",");
            const memories = db.prepare(
                `SELECT id, source, harness, summary, topics FROM memories WHERE id IN (${placeholders})`
            ).all(...sourceIds) as Array<{ id: number; source: string; harness: string; summary: string; topics: string }>;

            if (memories.length < 2) continue;

            const memorySummary = memories
                .map(m => `[Memory #${m.id}] (${m.source}/${m.harness}) ${m.summary.slice(0, 200)}`)
                .join("\n");

            const allTopics = [...new Set(memories.flatMap(m => {
                try { return JSON.parse(m.topics) as string[]; } catch { return []; }
            }))];
            const topicCluster = allTopics[0] ?? "general";

            const connections: Array<{ from_id: number; to_id: number; relationship: string }> =
                JSON.parse(c.connections);

            examples.push({
                prompt: `Consolidate these memories (topic cluster: "${topicCluster}"):\n\n${memorySummary}`,
                completion: JSON.stringify({ connections, insight: c.insight }),
                quality_score: 0.95, // High quality — these are real vault decisions
                source: "historical",
            });
        }

        console.log(`  Extracted ${examples.length} crystallizer examples from memory.db`);
    } finally {
        db.close();
    }

    return examples;
}

// ── Weaver Extractor ──────────────────────────────────────────────────

/**
 * Extract weaver training data from the weaver training log.
 * Each entry is a (job instruction + search queries → context selected) tuple.
 */
function extractWeaverExamples(vaultPath: string): TrainingExample[] {
    const examples: TrainingExample[] = [];
    const logPath = path.join(vaultPath, "_embeddings", "weaver-training.jsonl");
    if (!fs.existsSync(logPath)) {
        console.log("  weaver-training.jsonl not found — no weaver examples yet");
        return examples;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as {
                jobInstruction: string;
                queryUsed: string;
                contextSelected: string[];
                relevanceScore: number;
                ts: string;
            };
            if (!entry.jobInstruction || !entry.contextSelected?.length) continue;

            examples.push({
                prompt: `Given this task, select the most relevant vault notes:\n\nTask: ${entry.jobInstruction}\n\nSearch query used: ${entry.queryUsed}`,
                completion: JSON.stringify({ selected_notes: entry.contextSelected }),
                quality_score: Math.min(1, entry.relevanceScore ?? 0.8),
                source: "historical",
            });
        } catch {
            // Skip malformed
        }
    }

    console.log(`  Extracted ${examples.length} weaver examples from weaver-training.jsonl`);
    return examples;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
    console.log(`\nSBLU Training Data Extractor`);
    console.log(`SBLU: ${SBLU_NAME}`);
    console.log(`Vault: ${VAULT_PATH}`);
    console.log(`Output: ${OUT_FILE}`);
    console.log(`Min examples: ${MIN_EXAMPLES}\n`);

    if (!["cartographer", "crystallizer", "weaver"].includes(SBLU_NAME)) {
        console.error(`Extractor for "${SBLU_NAME}" not yet implemented. Supported: cartographer, crystallizer, weaver`);
        process.exit(1);
    }

    // ── Crystallizer ───────────────────────────────────────────────────
    if (SBLU_NAME === "crystallizer") {
        const allExamples = extractCrystallizerExamples(VAULT_PATH);
        if (allExamples.length === 0) {
            console.error("No crystallizer training data available yet. Need consolidation history in memory.db.");
            process.exit(1);
        }

        const SYSTEM_PROMPT = `You are SBLU-2 Memory Crystallizer, a memory consolidation agent. You receive batches of related memories and identify connections and cross-cutting insights. You output only valid JSON. No prose, no markdown fences.`;

        const jsonl = allExamples.map(ex => JSON.stringify({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: ex.prompt },
                { role: "assistant", content: ex.completion },
            ],
            quality_score: ex.quality_score,
            source: ex.source,
        }));

        const splitIdx = Math.max(1, Math.floor(jsonl.length * 0.9));
        const trainFile = OUT_FILE.replace(".jsonl", "-train.jsonl");
        const valFile = OUT_FILE.replace(".jsonl", "-val.jsonl");
        fs.writeFileSync(trainFile, jsonl.slice(0, splitIdx).join("\n") + "\n", "utf-8");
        fs.writeFileSync(valFile, jsonl.slice(splitIdx).join("\n") + "\n", "utf-8");
        fs.writeFileSync(OUT_FILE, jsonl.join("\n") + "\n", "utf-8");
        console.log(`\n✓ Wrote ${jsonl.length} crystallizer examples`);
        console.log(`  Training: ${splitIdx} → ${trainFile}`);
        console.log(`  Validation: ${jsonl.length - splitIdx} → ${valFile}`);
        return;
    }

    // ── Weaver ─────────────────────────────────────────────────────────
    if (SBLU_NAME === "weaver") {
        const allExamples = extractWeaverExamples(VAULT_PATH);
        if (allExamples.length < 10) {
            console.error(`Only ${allExamples.length} weaver examples available (need 10+). Let the system accumulate more job completions first.`);
            process.exit(1);
        }

        const SYSTEM_PROMPT = `You are SBLU-4 Context Weaver, a context selection specialist. Given a task description, you select the most relevant vault notes to include in the agent's context window. You output only valid JSON. No prose, no markdown fences.`;

        const jsonl = allExamples.map(ex => JSON.stringify({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: ex.prompt },
                { role: "assistant", content: ex.completion },
            ],
            quality_score: ex.quality_score,
            source: ex.source,
        }));

        const splitIdx = Math.max(1, Math.floor(jsonl.length * 0.9));
        const trainFile = OUT_FILE.replace(".jsonl", "-train.jsonl");
        const valFile = OUT_FILE.replace(".jsonl", "-val.jsonl");
        fs.writeFileSync(trainFile, jsonl.slice(0, splitIdx).join("\n") + "\n", "utf-8");
        fs.writeFileSync(valFile, jsonl.slice(splitIdx).join("\n") + "\n", "utf-8");
        fs.writeFileSync(OUT_FILE, jsonl.join("\n") + "\n", "utf-8");
        console.log(`\n✓ Wrote ${jsonl.length} weaver examples`);
        console.log(`  Training: ${splitIdx} → ${trainFile}`);
        console.log(`  Validation: ${jsonl.length - splitIdx} → ${valFile}`);
        return;
    }

    const allExamples: TrainingExample[] = [];

    // 1. Extract from historical link health reports
    console.log("Extracting historical examples...");
    const historical = extractHistoricalExamples(VAULT_PATH);
    allExamples.push(...historical);
    console.log(`  Found ${historical.length} historical examples`);

    // 2. Generate synthetic examples to reach minimum
    const needed = Math.max(0, MIN_EXAMPLES - allExamples.length);
    if (needed > 0) {
        console.log(`Generating ${needed} synthetic examples...`);
        const synthetic = generateSyntheticExamples(VAULT_PATH, needed);
        allExamples.push(...synthetic);
        console.log(`  Generated ${synthetic.length} synthetic examples`);
    }

    if (allExamples.length === 0) {
        console.error("No training examples could be generated.");
        process.exit(1);
    }

    // 3. Shuffle and format
    const shuffled = allExamples.sort(() => Math.random() - 0.5);
    const jsonl = formatForMLX(shuffled);

    // 4. Write JSONL file
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, jsonl.join("\n") + "\n", "utf-8");

    // 5. Also write a small validation split (10%)
    const splitIdx = Math.max(1, Math.floor(jsonl.length * 0.9));
    const trainSet = jsonl.slice(0, splitIdx);
    const valSet = jsonl.slice(splitIdx);

    const trainFile = OUT_FILE.replace(".jsonl", "-train.jsonl");
    const valFile = OUT_FILE.replace(".jsonl", "-val.jsonl");

    fs.writeFileSync(trainFile, trainSet.join("\n") + "\n", "utf-8");
    fs.writeFileSync(valFile, valSet.join("\n") + "\n", "utf-8");

    console.log(`\n✓ Wrote ${jsonl.length} examples to ${OUT_FILE}`);
    console.log(`  Training split: ${trainSet.length} → ${trainFile}`);
    console.log(`  Validation split: ${valSet.length} → ${valFile}`);
    console.log(`\nQuality distribution:`);

    const bySource = allExamples.reduce(
        (acc, ex) => {
            acc[ex.source] = (acc[ex.source] ?? 0) + 1;
            return acc;
        },
        {} as Record<string, number>,
    );
    for (const [src, count] of Object.entries(bySource)) {
        console.log(`  ${src}: ${count}`);
    }

    console.log(`\nNext step: bun scripts/sblu/train.sh --data ${trainFile} --val ${valFile}`);
}

main().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
});
