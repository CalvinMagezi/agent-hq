import { Hono } from "hono";
import { vaultClient } from "../context";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

const router = new Hono();

router.get("/", async (c) => {
    try {
        const budgetPath = path.join(vaultClient.vaultPath, "_system/budget.md");
        if (!fs.existsSync(budgetPath)) {
            return c.json({
                today: 0,
                month: 0,
                budget: 50.00,
                frontmatter: {}
            });
        }

        const { data } = matter(fs.readFileSync(budgetPath, "utf-8"));
        // Ideally we would parse the actual cost numbers from logs,
        // but assuming for this demo that the frontmatter in budget.md has current usage
        return c.json({
            today: data?.spentToday || 0,
            month: data?.spentThisMonth || 0,
            budget: data?.monthlyBudget || 50.00,
            frontmatter: data
        });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
