import { Hono } from "hono";
import { vaultClient } from "../context";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

const router = new Hono();

router.get("/", async (c) => {
    const statusFilter = c.req.query("status"); // optional filter

    try {
        const jobsDir = path.join(vaultClient.vaultPath, "_jobs");
        const jobs = [];

        // helper to read a flat dir
        const readFlatDir = (sub: string, statusText: string) => {
            const d = path.join(jobsDir, sub);
            if (!fs.existsSync(d)) return;
            const files = fs.readdirSync(d).filter(f => f.endsWith(".md"));
            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(d, f), "utf-8");
                    const { data } = matter(raw);
                    const nameClean = f.replace(".md", "");

                    jobs.push({
                        jobId: data?.jobId || nameClean,
                        status: statusText,
                        type: data?.type || "unknown",
                        priority: data?.priority || 50,
                        createdAt: data?.createdAt || "",
                        updatedAt: data?.updatedAt || "",
                        instruction: data?.instruction || "",
                    });
                } catch (e) {
                    // ignore
                }
            }
        };

        if (!statusFilter || statusFilter === "running") readFlatDir("running", "running");
        if (!statusFilter || statusFilter === "done") readFlatDir("done", "done");
        if (!statusFilter || statusFilter === "failed") readFlatDir("failed", "failed");
        if (!statusFilter || statusFilter === "pending") readFlatDir("pending", "pending");

        // sort by created at desc
        jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        return c.json({ jobs });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

router.get("/:id/logs", async (c) => {
    const jobId = c.req.param("id");
    try {
        const logsDir = path.join(vaultClient.vaultPath, "_logs");
        let logContent = "Log not found or not yet flushed.";

        if (fs.existsSync(logsDir)) {
            // Find the log across days
            const days = fs.readdirSync(logsDir).filter(d => fs.statSync(path.join(logsDir, d)).isDirectory());
            // Sort desc so newest day is checked first
            days.sort().reverse();

            for (const day of days) {
                const p = path.join(logsDir, day, `job-${jobId}.md`);
                if (fs.existsSync(p)) {
                    logContent = fs.readFileSync(p, "utf-8");
                    break;
                }
            }
        }
        return c.json({ content: logContent });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
