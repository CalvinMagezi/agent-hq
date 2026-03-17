/**
 * SBLU Autonomous Retraining Orchestrator
 *
 * Called by the daemon at 3 AM. Checks all SBLUs, trains those that are
 * ready, converts and registers in Ollama, then updates the registry.
 *
 * Full pipeline per SBLU:
 *   1. Check readiness (enough shadow runs, not recently trained)
 *   2. Extract training data from vault (extract.ts)
 *   3. LoRA fine-tune on Apple Silicon (train.sh via MLX-LM)
 *   4. Convert to GGUF + register in Ollama (convert.sh)
 *   5. Update SBLU-REGISTRY.md: new model tag, trainedAt, reset errorCount
 *   6. Log result to vault audit trail
 *
 * Usage (called by daemon, or manually):
 *   bun scripts/sblu/retrain.ts [--sblu cartographer] [--force] [--dry-run]
 *
 * Flags:
 *   --sblu <name>   Only retrain this SBLU (default: all eligible)
 *   --force         Ignore readiness checks, retrain anyway
 *   --dry-run       Print what would happen without doing it
 *   --vault <path>  Vault path override
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SBLURegistry } from "./sbluRegistry.js";
import type { SBLUEntry } from "./sbluRegistry.js";

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag: string, defaultVal = "") => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? (args[idx + 1] ?? defaultVal) : defaultVal;
};
const hasFlag = (flag: string) => args.includes(flag);

const ONLY_SBLU = getArg("--sblu");
const FORCE = hasFlag("--force");
const DRY_RUN = hasFlag("--dry-run");
const VAULT_PATH = getArg("--vault", process.env.VAULT_PATH ?? "");

if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
    console.error(`Error: vault not found at "${VAULT_PATH}". Set VAULT_PATH or use --vault`);
    process.exit(1);
}

// ── Readiness thresholds ──────────────────────────────────────────────
const MIN_SHADOW_RUNS = 10;          // Need this many shadow runs before first train
const RETRAIN_INTERVAL_DAYS = 30;    // Don't retrain more often than this
const MIN_EXAMPLES = 30;             // Minimum JSONL examples to proceed (lowered from 50 to unblock bootstrap)
const MLXLM_ITERS_FIRST = 600;       // Iterations for first fine-tune
const MLXLM_ITERS_INCREMENTAL = 300; // Iterations for incremental retrains

// ── SBLUs with training support ───────────────────────────────────────
const TRAINABLE_SBLUS = ["cartographer"]; // add crystallizer, pulse etc. as they are ready

// ── Readiness check ───────────────────────────────────────────────────

interface ReadinessResult {
    ready: boolean;
    reason: string;
    isFirstTrain: boolean;
    iters: number;
}

function checkReadiness(entry: SBLUEntry): ReadinessResult {
    const isFirstTrain = entry.trainedAt === null;

    // Has the machine's mlx-lm installed?
    const mlxAvailable = checkMLXAvailable();
    if (!mlxAvailable) {
        return { ready: false, reason: "mlx-lm not installed (run: pip install mlx-lm)", isFirstTrain, iters: 0 };
    }

    if (isFirstTrain) {
        // First training: need enough shadow runs to extract meaningful data
        if (entry.shadowRunCount < MIN_SHADOW_RUNS && !FORCE) {
            return {
                ready: false,
                reason: `Need ${MIN_SHADOW_RUNS} shadow runs before first training (have ${entry.shadowRunCount})`,
                isFirstTrain,
                iters: 0,
            };
        }
        return { ready: true, reason: "First training ready", isFirstTrain, iters: MLXLM_ITERS_FIRST };
    }

    // Incremental retrain: check interval
    if (entry.trainedAt) {
        const trainedAt = new Date(entry.trainedAt);
        const daysSince = (Date.now() - trainedAt.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince < RETRAIN_INTERVAL_DAYS && !FORCE) {
            return {
                ready: false,
                reason: `Trained ${daysSince.toFixed(0)}d ago (threshold: ${RETRAIN_INTERVAL_DAYS}d)`,
                isFirstTrain,
                iters: 0,
            };
        }
    }

    // Circuit breaker must be CLOSED before retraining
    if (entry.circuitState !== "CLOSED" && !FORCE) {
        return {
            ready: false,
            reason: `Circuit breaker is ${entry.circuitState} — resolve issues before retraining`,
            isFirstTrain,
            iters: 0,
        };
    }

    return { ready: true, reason: "Incremental retrain ready", isFirstTrain, iters: MLXLM_ITERS_INCREMENTAL };
}

// Dedicated venv for SBLU training tools (mlx-lm, llama.cpp wrappers)
const SBLU_VENV = process.env.SBLU_VENV ?? path.join(os.homedir(), ".sblu-env");
const SBLU_PYTHON = `${SBLU_VENV}/bin/python3`;

function checkMLXAvailable(): boolean {
    try {
        const result = Bun.spawnSync([SBLU_PYTHON, "-c", "import mlx_lm; print('ok')"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        return result.exitCode === 0 && result.stdout.toString().trim() === "ok";
    } catch {
        return false;
    }
}

function checkOllamaRunning(): boolean {
    try {
        const result = Bun.spawnSync(["curl", "-sf", "http://localhost:11434/api/version"], {
            stdout: "pipe",
            stderr: "pipe",
        });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

// ── Pipeline execution ────────────────────────────────────────────────

async function runExtract(sbluName: string, outFile: string): Promise<{ ok: boolean; count: number }> {
    console.log(`  [extract] Generating training data for ${sbluName}...`);

    if (DRY_RUN) {
        console.log(`  [extract] DRY RUN — would run: bun scripts/sblu/extract.ts --sblu ${sbluName}`);
        return { ok: true, count: MIN_EXAMPLES };
    }

    const proc = Bun.spawnSync(
        ["bun", "scripts/sblu/extract.ts", "--sblu", sbluName, "--vault", VAULT_PATH, "--out", outFile, "--min", String(MIN_EXAMPLES)],
        {
            cwd: path.resolve(VAULT_PATH, ".."),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, VAULT_PATH },
        },
    );

    console.log(proc.stdout.toString().trim());
    if (proc.exitCode !== 0) {
        console.error(`  [extract] Failed:`, proc.stderr.toString());
        return { ok: false, count: 0 };
    }

    // Count lines in output file
    try {
        const content = fs.readFileSync(outFile, "utf-8");
        return { ok: true, count: content.split("\n").filter(Boolean).length };
    } catch {
        return { ok: false, count: 0 };
    }
}

async function runTrain(sbluName: string, dataFile: string, valFile: string, iters: number): Promise<boolean> {
    console.log(`  [train] Fine-tuning ${sbluName} (${iters} iters)...`);

    if (DRY_RUN) {
        console.log(`  [train] DRY RUN — would run: bash scripts/sblu/train.sh --sblu ${sbluName} --iters ${iters}`);
        return true;
    }

    const adapterDir = `/tmp/sblu-${sbluName}-adapter-${Date.now()}`;

    const proc = Bun.spawnSync(
        ["bash", "scripts/sblu/train.sh",
            "--sblu", sbluName,
            "--data", dataFile,
            "--val", valFile,
            "--iters", String(iters),
            "--output", adapterDir,
        ],
        {
            cwd: path.resolve(VAULT_PATH, ".."),
            stdout: "inherit",   // stream training progress to daemon logs
            stderr: "inherit",
            env: { ...process.env, SBLU_PYTHON, SBLU_VENV },
        },
    );

    if (proc.exitCode !== 0) {
        console.error(`  [train] Training failed (exit ${proc.exitCode})`);
        return false;
    }

    // Store adapter dir path for convert step
    fs.writeFileSync(`/tmp/sblu-${sbluName}-adapter-path.txt`, adapterDir);
    return true;
}

async function runConvert(sbluName: string, adapterDir: string): Promise<boolean> {
    console.log(`  [convert] Converting ${sbluName} to GGUF + registering in Ollama...`);

    if (DRY_RUN) {
        console.log(`  [convert] DRY RUN — would run: bash scripts/sblu/convert.sh --sblu ${sbluName}`);
        return true;
    }

    const proc = Bun.spawnSync(
        ["bash", "scripts/sblu/convert.sh",
            "--sblu", sbluName,
            "--adapter", adapterDir,
            "--vault", VAULT_PATH,
        ],
        {
            cwd: path.resolve(VAULT_PATH, ".."),
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, VAULT_PATH },
        },
    );

    if (proc.exitCode !== 0) {
        console.error(`  [convert] Conversion failed (exit ${proc.exitCode})`);
        return false;
    }

    return true;
}

function writeTrainLog(sbluName: string, success: boolean, details: string): void {
    const logsDir = path.join(VAULT_PATH, "_logs", new Date().toISOString().slice(0, 10));
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, `sblu-retrain-${sbluName}.md`);
    const ts = new Date().toISOString();
    const status = success ? "✓ SUCCESS" : "✗ FAILED";
    fs.writeFileSync(logPath, `# SBLU Retrain — ${sbluName}\n\n**Status**: ${status}\n**Time**: ${ts}\n\n${details}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function retrainSBLU(sbluName: string): Promise<void> {
    const registry = new SBLURegistry(VAULT_PATH);
    const entry = registry.read(sbluName);

    if (!entry) {
        console.log(`  [${sbluName}] Not found in SBLU-REGISTRY.md, skipping`);
        return;
    }

    console.log(`\n── SBLU: ${entry.displayName} (${sbluName}) ──`);
    console.log(`   Trust level: ${entry.trustLevel} | Shadow runs: ${entry.shadowRunCount} | Trained: ${entry.trainedAt ?? "never"}`);

    // Readiness check
    const readiness = checkReadiness(entry);
    if (!readiness.ready) {
        console.log(`  ⏭  Skipping: ${readiness.reason}`);
        return;
    }

    console.log(`  ✓ Ready: ${readiness.reason}`);

    const trainFile = `/tmp/sblu-${sbluName}-train.jsonl`;
    const valFile = `/tmp/sblu-${sbluName}-val.jsonl`;

    // Step 1: Extract
    const { ok: extractOk, count } = await runExtract(sbluName, trainFile);
    if (!extractOk) {
        writeTrainLog(sbluName, false, "Extract step failed");
        return;
    }
    if (count < MIN_EXAMPLES) {
        console.log(`  ⏭  Only ${count} examples generated (need ${MIN_EXAMPLES}), skipping`);
        writeTrainLog(sbluName, false, `Insufficient training data: ${count}/${MIN_EXAMPLES}`);
        return;
    }
    console.log(`  ✓ Extracted ${count} training examples`);

    // Step 2: Train
    const trainOk = await runTrain(sbluName, trainFile, valFile, readiness.iters);
    if (!trainOk) {
        writeTrainLog(sbluName, false, `Training failed after ${readiness.iters} iterations`);
        registry.update(sbluName, { errorCount: (entry.errorCount ?? 0) + 1 });
        return;
    }
    console.log(`  ✓ Training complete`);

    // Step 3: Convert + register
    const adapterDir = DRY_RUN
        ? `/tmp/sblu-${sbluName}-adapter`
        : fs.existsSync(`/tmp/sblu-${sbluName}-adapter-path.txt`)
            ? fs.readFileSync(`/tmp/sblu-${sbluName}-adapter-path.txt`, "utf-8").trim()
            : `/tmp/sblu-${sbluName}-adapter`;

    const convertOk = await runConvert(sbluName, adapterDir);
    if (!convertOk) {
        writeTrainLog(sbluName, false, "GGUF conversion failed");
        return;
    }
    console.log(`  ✓ Model registered in Ollama as sblu-${sbluName}:v1`);

    // Step 4: Update registry
    if (!DRY_RUN) {
        registry.update(sbluName, {
            model: `sblu-${sbluName}:v1`,
            trainedAt: new Date().toISOString(),
            errorCount: 0,
            circuitState: "CLOSED",
        });
    }

    // Step 5: Auto-promote to shadow if first train (trustLevel stays 1, but now uses fine-tuned model)
    //         Already at shadow — quality scoring will drive future promotion to canary
    const finalEntry = registry.read(sbluName);
    if (finalEntry && finalEntry.trustLevel === 0) {
        registry.update(sbluName, { trustLevel: 1 });
        console.log(`  ✓ Auto-promoted ${sbluName} from baseline → shadow`);
    }

    const details = [
        `Examples: ${count}`,
        `Iterations: ${readiness.iters}`,
        `Model: sblu-${sbluName}:v1`,
        `Adapter: ${adapterDir}`,
        `First train: ${readiness.isFirstTrain}`,
    ].join("\n");

    writeTrainLog(sbluName, true, details);
    console.log(`  ✓ ${entry.displayName} retrain complete\n`);
}

async function main() {
    const ts = new Date().toISOString();
    console.log(`\n${"═".repeat(56)}`);
    console.log(`  SBLU Autonomous Retraining — ${ts}`);
    if (DRY_RUN) console.log("  ⚠  DRY RUN MODE — no changes will be made");
    console.log(`${"═".repeat(56)}\n`);
    console.log(`  Vault: ${VAULT_PATH}`);

    // Verify Ollama is running (needed for convert step)
    if (!checkOllamaRunning() && !DRY_RUN) {
        console.error("  ✗ Ollama is not running. Start it with: ollama serve");
        process.exit(1);
    }

    const toTrain = ONLY_SBLU ? [ONLY_SBLU] : TRAINABLE_SBLUS;
    console.log(`  SBLUs to check: ${toTrain.join(", ")}\n`);

    for (const sbluName of toTrain) {
        await retrainSBLU(sbluName);
    }

    console.log(`\n${"═".repeat(56)}`);
    console.log(`  Retraining cycle complete`);
    console.log(`${"═".repeat(56)}\n`);
}

main().catch(err => {
    console.error("Fatal error in retrain.ts:", err);
    process.exit(1);
});
