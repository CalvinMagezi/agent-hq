import { Hono } from "hono";
import { searchClient } from "../context";

const router = new Hono();

router.get("/", async (c) => {
    const q = c.req.query("q") || "";
    if (!q) {
        return c.json({ results: [] });
    }

    try {
        const results = await searchClient.search(q, {
            limit: 20
        });
        return c.json({ results });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
