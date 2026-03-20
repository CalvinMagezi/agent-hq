import { Hono } from "hono";
import { vaultClient } from "../context";
import * as fs from "fs";
import * as path from "path";

const router = new Hono();

router.get("/", async (c) => {
    try {
        const notebooksDir = path.join(vaultClient.vaultPath, "Notebooks");

        // Construct a folder tree map
        const tree = { name: "Notebooks", path: "Notebooks", type: "dir", children: [] };

        const buildTree = (dir: string, node: any) => {
            if (!fs.existsSync(dir)) return;

            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue; // skip hidden

                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(vaultClient.vaultPath, fullPath);

                if (entry.isDirectory()) {
                    const childNode = { name: entry.name, path: relativePath, type: "dir", children: [] };
                    node.children.push(childNode);
                    buildTree(fullPath, childNode);
                } else if (entry.name.endsWith(".md")) {
                    node.children.push({ name: entry.name, path: relativePath, type: "file" });
                }
            }
        };

        buildTree(notebooksDir, tree);

        return c.json({ tree });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

router.get("/*", async (c) => {
    const notePath = c.req.param("*");
    if (!notePath || !notePath.endsWith(".md")) {
        return c.json({ error: "Only markdown notes are accessible" }, 400);
    }

    try {
        const note = await vaultClient.readNote(notePath);
        return c.json({ note });
    } catch (err: any) {
        return c.json({ error: err.message }, 500);
    }
});

export default router;
