/**
 * SBLU Registry Client
 *
 * Reads and writes _system/SBLU-REGISTRY.md — the live trust-level state
 * for all Strategic Business Logic Units.
 *
 * A trust level change is the ONLY deployment needed to promote/demote an SBLU.
 */

import * as fs from "fs";
import * as path from "path";

export type TrustLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface SBLUEntry {
    name: string;
    displayName: string;
    task: string;
    /** Currently serving model (Ollama tag). null = not yet trained */
    model: string | null;
    /** Base model to pull for fine-tuning */
    baseModel: string;
    /** Target fine-tuned model Ollama tag */
    targetModel: string;
    trustLevel: TrustLevel;
    trainedAt: string | null;
    lastEvalAt: string | null;
    errorRate7d: number | null;
    qualityScore: number | null;
    circuitState: CircuitState;
    lastCircuitOpen: string | null;
    runIntervalHours: number;
    shadowRunCount: number;
    canaryRunCount: number;
    totalRunCount: number;
    errorCount: number;
    outputSchema: string;
}

const REGISTRY_FILE = "_system/SBLU-REGISTRY.md";

/** Parse a YAML block from the SBLU-REGISTRY.md file for a named SBLU */
function parseSBLUBlock(content: string, sbluName: string): SBLUEntry | null {
    // Match the yaml block for this SBLU (between ```yaml ... ```)
    const pattern = new RegExp(
        `### ${sbluName}\\s+\`\`\`yaml([\\s\\S]*?)\`\`\``,
        "i",
    );
    const match = content.match(pattern);
    if (!match) return null;

    const yamlBlock = match[1]!.trim();
    const entry: Partial<SBLUEntry> = {};

    for (const line of yamlBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.substring(0, colonIdx).trim();
        const rawVal = line.substring(colonIdx + 1).trim();

        const val = rawVal === "null" ? null : rawVal.replace(/^["']|["']$/g, "");

        switch (key) {
            case "name": entry.name = String(val); break;
            case "displayName": entry.displayName = String(val); break;
            case "task": entry.task = String(val); break;
            case "model": entry.model = val; break;
            case "baseModel": entry.baseModel = String(val); break;
            case "targetModel": entry.targetModel = String(val); break;
            case "trustLevel": entry.trustLevel = Number(val) as TrustLevel; break;
            case "trainedAt": entry.trainedAt = val; break;
            case "lastEvalAt": entry.lastEvalAt = val; break;
            case "errorRate7d": entry.errorRate7d = val === null ? null : Number(val); break;
            case "qualityScore": entry.qualityScore = val === null ? null : Number(val); break;
            case "circuitState": entry.circuitState = (val as CircuitState) ?? "CLOSED"; break;
            case "lastCircuitOpen": entry.lastCircuitOpen = val; break;
            case "runIntervalHours": entry.runIntervalHours = Number(val); break;
            case "shadowRunCount": entry.shadowRunCount = Number(val); break;
            case "canaryRunCount": entry.canaryRunCount = Number(val); break;
            case "totalRunCount": entry.totalRunCount = Number(val); break;
            case "errorCount": entry.errorCount = Number(val); break;
            case "outputSchema": entry.outputSchema = rawVal.replace(/^["']+|["']+$/g, ""); break;
        }
    }

    // Fill in defaults for any missing fields
    return {
        name: entry.name ?? sbluName,
        displayName: entry.displayName ?? sbluName,
        task: entry.task ?? "",
        model: entry.model ?? null,
        baseModel: entry.baseModel ?? "",
        targetModel: entry.targetModel ?? `sblu-${sbluName}:v1`,
        trustLevel: entry.trustLevel ?? 0,
        trainedAt: entry.trainedAt ?? null,
        lastEvalAt: entry.lastEvalAt ?? null,
        errorRate7d: entry.errorRate7d ?? null,
        qualityScore: entry.qualityScore ?? null,
        circuitState: entry.circuitState ?? "CLOSED",
        lastCircuitOpen: entry.lastCircuitOpen ?? null,
        runIntervalHours: entry.runIntervalHours ?? 4,
        shadowRunCount: entry.shadowRunCount ?? 0,
        canaryRunCount: entry.canaryRunCount ?? 0,
        totalRunCount: entry.totalRunCount ?? 0,
        errorCount: entry.errorCount ?? 0,
        outputSchema: entry.outputSchema ?? "",
    };
}

/** Serialize an SBLUEntry back to a YAML block string */
function serializeSBLUBlock(entry: SBLUEntry): string {
    const nullOrVal = (v: unknown) => (v === null || v === undefined ? "null" : String(v));
    return [
        `### ${entry.name}`,
        "",
        "```yaml",
        `name: ${entry.name}`,
        `displayName: ${entry.displayName}`,
        `task: ${entry.task}`,
        `model: ${nullOrVal(entry.model)}`,
        `baseModel: ${entry.baseModel}`,
        `targetModel: ${entry.targetModel}`,
        `trustLevel: ${entry.trustLevel}`,
        `trainedAt: ${nullOrVal(entry.trainedAt)}`,
        `lastEvalAt: ${nullOrVal(entry.lastEvalAt)}`,
        `errorRate7d: ${nullOrVal(entry.errorRate7d)}`,
        `qualityScore: ${nullOrVal(entry.qualityScore)}`,
        `circuitState: ${entry.circuitState}`,
        `lastCircuitOpen: ${nullOrVal(entry.lastCircuitOpen)}`,
        `runIntervalHours: ${entry.runIntervalHours}`,
        `shadowRunCount: ${entry.shadowRunCount}`,
        `canaryRunCount: ${entry.canaryRunCount}`,
        `totalRunCount: ${entry.totalRunCount}`,
        `errorCount: ${entry.errorCount}`,
        `outputSchema: "${entry.outputSchema}"`,
        "```",
    ].join("\n");
}

export class SBLURegistry {
    private vaultPath: string;
    private registryPath: string;

    constructor(vaultPath: string) {
        this.vaultPath = vaultPath;
        this.registryPath = path.join(vaultPath, REGISTRY_FILE);
    }

    /** Read one SBLU entry from the registry */
    read(sbluName: string): SBLUEntry | null {
        if (!fs.existsSync(this.registryPath)) return null;
        const content = fs.readFileSync(this.registryPath, "utf-8");
        return parseSBLUBlock(content, sbluName);
    }

    /** Update specific fields of an SBLU entry in the registry */
    update(sbluName: string, patch: Partial<SBLUEntry>): boolean {
        if (!fs.existsSync(this.registryPath)) return false;

        const content = fs.readFileSync(this.registryPath, "utf-8");
        const existing = parseSBLUBlock(content, sbluName);
        if (!existing) return false;

        const updated = { ...existing, ...patch, name: sbluName };
        const newBlock = serializeSBLUBlock(updated);

        // Replace the existing block in the file
        const pattern = new RegExp(
            `### ${sbluName}\\s+\`\`\`yaml[\\s\\S]*?\`\`\``,
            "i",
        );
        const newContent = content.replace(pattern, newBlock);

        // Also update lastUpdated in frontmatter
        const ts = new Date().toISOString();
        const frontmatterUpdated = newContent.replace(
            /lastUpdated: "[^"]+"/,
            `lastUpdated: "${ts}"`,
        );

        fs.writeFileSync(this.registryPath, frontmatterUpdated, "utf-8");
        return true;
    }

    /** Increment run counters and record last eval timestamp */
    recordRun(sbluName: string, opts: {
        shadowRun?: boolean;
        canaryRun?: boolean;
        error?: boolean;
        qualityScore?: number;
    }): void {
        const entry = this.read(sbluName);
        if (!entry) return;

        const patch: Partial<SBLUEntry> = {
            totalRunCount: entry.totalRunCount + 1,
            lastEvalAt: new Date().toISOString(),
        };
        if (opts.shadowRun) patch.shadowRunCount = entry.shadowRunCount + 1;
        if (opts.canaryRun) patch.canaryRunCount = entry.canaryRunCount + 1;
        if (opts.error) patch.errorCount = entry.errorCount + 1;
        if (opts.qualityScore !== undefined) patch.qualityScore = opts.qualityScore;

        this.update(sbluName, patch);
    }

    /** Update the circuit state of an SBLU */
    setCircuitState(sbluName: string, state: CircuitState): void {
        const patch: Partial<SBLUEntry> = { circuitState: state };
        if (state === "OPEN") {
            patch.lastCircuitOpen = new Date().toISOString();
        }
        this.update(sbluName, patch);
    }

    /** Promote an SBLU to the next trust level (if promotion criteria are met) */
    promote(sbluName: string): { promoted: boolean; reason: string } {
        const entry = this.read(sbluName);
        if (!entry) return { promoted: false, reason: "SBLU not found in registry" };
        if (entry.trustLevel >= 4) {
            return { promoted: false, reason: "Already at primary level — manual promotion to autonomous required" };
        }

        const nextLevel = (entry.trustLevel + 1) as TrustLevel;

        // Check promotion criteria
        if (entry.errorRate7d !== null && entry.errorRate7d > 0.02) {
            return { promoted: false, reason: `Error rate ${(entry.errorRate7d * 100).toFixed(1)}% exceeds 2% threshold` };
        }
        if (entry.qualityScore !== null && entry.qualityScore < 0.85) {
            return { promoted: false, reason: `Quality score ${entry.qualityScore.toFixed(2)} below 0.85 threshold` };
        }
        if (entry.circuitState !== "CLOSED") {
            return { promoted: false, reason: `Circuit breaker is ${entry.circuitState} — must be CLOSED` };
        }
        if (entry.trustLevel === 1 && entry.shadowRunCount < 10) {
            return { promoted: false, reason: `Need at least 10 shadow runs (have ${entry.shadowRunCount})` };
        }

        this.update(sbluName, { trustLevel: nextLevel });
        return { promoted: true, reason: `Promoted from ${entry.trustLevel} to ${nextLevel}` };
    }

    /** Demote an SBLU by one trust level */
    demote(sbluName: string, reason: string): void {
        const entry = this.read(sbluName);
        if (!entry || entry.trustLevel === 0) return;
        const prev = (entry.trustLevel - 1) as TrustLevel;
        this.update(sbluName, { trustLevel: prev });
        console.warn(`[sblu-registry] Demoted ${sbluName} from ${entry.trustLevel} → ${prev}: ${reason}`);
    }
}
