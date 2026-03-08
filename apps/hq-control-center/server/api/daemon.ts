import { Hono } from "hono";
import { vaultClient } from "../context";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

const router = new Hono();

router.get("/", async (c) => {
    try {
        const filePath = path.join(vaultClient.vaultPath, "_system/DAEMON-STATUS.md");
        if (!fs.existsSync(filePath)) {
            return c.json({ error: "No daemon status file found" }, 404);
        }

        const { data, content } = matter(fs.readFileSync(filePath, "utf-8"));

        // Parse the markdown table
        // Format: | Task | Last Run | Last Success | Runs | Errors | Last Error |
        const lines = content.split("\n");
        const tasks = [];

        let inTable = false;
        for (const line of lines) {
            if (line.trim().startsWith("| Task |") || line.trim().startsWith("|Task|")) {
                inTable = true;
                continue;
            }
            if (inTable && line.trim().startsWith("|---")) {
                continue;
            }

            if (inTable && line.trim().startsWith("|")) {
                const parts = line.split("|").map(s => s.trim());
                if (parts.length >= 7) {
                    tasks.push({
                        task: parts[1],
                        lastRun: parts[2],
                        lastSuccess: parts[3],
                        runs: parts[4],
                        errors: parts[5],
                        lastError: parts[6]
                    });
                }
            }
        }

        return c.json({ meta: data, tasks });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
