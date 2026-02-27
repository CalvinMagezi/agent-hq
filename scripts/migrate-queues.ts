import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { VaultClient } from "@repo/vault-client";

const VAULT_PATH = process.env.VAULT_PATH ?? path.resolve(import.meta.dir, "..", ".vault");

async function migrate() {
    console.log(`[migrate] Starting queue migration for vault at ${VAULT_PATH}`);
    const vault = new VaultClient(VAULT_PATH);

    // 1. Migrate Jobs
    const jobsPendingDir = path.join(VAULT_PATH, "_jobs/pending");
    let migrationCount = 0;

    if (fs.existsSync(jobsPendingDir)) {
        const files = fs.readdirSync(jobsPendingDir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
            try {
                const filePath = path.join(jobsPendingDir, f);
                const { data, content } = matter(fs.readFileSync(filePath, "utf-8"));

                console.log(`[migrate] Migrating job: ${data.jobId}`);
                // Read instruction from body
                const instruction = content.replace(/^#\s+.*?\n+/, "").trim() || content.trim();

                await vault.createJob({
                    instruction,
                    type: data.type ?? "background",
                    priority: data.priority ?? 50,
                    securityProfile: data.securityProfile,
                });

                // Backup legacy file
                fs.renameSync(filePath, filePath + ".bak");
                migrationCount++;
            } catch (err) {
                console.error(`[migrate] Failed to migrate job file ${f}:`, err);
            }
        }
    }

    // 2. Migrate Delegated Tasks
    const tasksPendingDir = path.join(VAULT_PATH, "_delegation/pending");
    if (fs.existsSync(tasksPendingDir)) {
        const files = fs.readdirSync(tasksPendingDir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
            try {
                const filePath = path.join(tasksPendingDir, f);
                const { data, content } = matter(fs.readFileSync(filePath, "utf-8"));

                console.log(`[migrate] Migrating delegated task: ${data.taskId}`);
                const instruction = content.replace(/^#\s+.*?\n+/, "").trim() || content.trim();

                await vault.createDelegatedTasks(data.jobId ?? "legacy-migrated", [{
                    taskId: data.taskId,
                    instruction,
                    targetHarnessType: data.targetHarnessType ?? "any",
                    priority: data.priority ?? 50,
                    deadlineMs: data.deadlineMs,
                    dependsOn: data.dependsOn,
                    modelOverride: data.modelOverride,
                    traceId: data.traceId,
                    spanId: data.spanId,
                    parentSpanId: data.parentSpanId,
                    securityConstraints: data.securityConstraints,
                }]);

                // Backup legacy file
                fs.renameSync(filePath, filePath + ".bak");
                migrationCount++;
            } catch (err) {
                console.error(`[migrate] Failed to migrate task file ${f}:`, err);
            }
        }
    }

    console.log(`[migrate] Migration complete. Processed ${migrationCount} item(s).`);
}

migrate().catch(console.error);
