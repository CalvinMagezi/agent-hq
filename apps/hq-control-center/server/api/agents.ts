import { Hono } from "hono";
import { vaultClient } from "../context";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

const router = new Hono();

router.get("/", async (c) => {
    try {
        const relays = await vaultClient.getRelayHealthAll();

        // Also get worker statuses from _agent-sessions
        const sessionsDir = path.join(vaultClient.vaultPath, "_agent-sessions");
        const workers: any[] = [];

        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".md"));
            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
                    const { data } = matter(raw);
                    workers.push({
                        id: data.workerId,
                        status: data.status,
                        lastHeartbeat: data.lastHeartbeat,
                        currentJobId: data.currentJobId,
                        modelConfig: data.modelConfig
                    });
                } catch (e) {
                    // ignore
                }
            }
        }

        return c.json({ relays, workers });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
