import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

// Retrieve metadata safely
export function getFileFrontmatter(vaultPath: string, notePath: string): Record<string, any> | null {
    const absPath = path.resolve(vaultPath, notePath);
    if (!fs.existsSync(absPath)) return null;

    try {
        const raw = fs.readFileSync(absPath, "utf-8");
        const { data } = matter(raw);
        return data;
    } catch {
        return null;
    }
}

export function getFileExports(vaultPath: string, notePath: string): string[] {
    const data = getFileFrontmatter(vaultPath, notePath);
    if (!data) return [];
    return Array.isArray(data.exports) ? data.exports : [];
}

// Blast radius calculation
export function getBacklinks(vaultPath: string, notePath: string): string[] {
    const results: string[] = [];

    // We handle notePath both with and without .md extension
    const baseName = notePath.replace(/\.md$/, "");
    const searchString = `[[${notePath}]]`;
    const searchStringOld = `[[${baseName}]]`;

    const scanDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            // Skip hidden and system folders to optimize
            if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

            if (entry.isDirectory()) {
                scanDir(fullPath);
            } else if (entry.name.endsWith(".md")) {
                try {
                    const raw = fs.readFileSync(fullPath, "utf-8");
                    if (raw.includes(searchString) || raw.includes(searchStringOld)) {
                        results.push(path.relative(vaultPath, fullPath));
                    }
                } catch { /* skip */ }
            }
        }
    };

    scanDir(vaultPath);
    return results;
}

// Dependency context extraction
export function getOutboundLinks(vaultPath: string, notePath: string): string[] {
    const absPath = path.resolve(vaultPath, notePath);
    if (!fs.existsSync(absPath)) return [];

    try {
        const raw = fs.readFileSync(absPath, "utf-8");
        const { content } = matter(raw);

        // Match only within Outbound Dependencies section if present
        const sectionMatch = content.match(/## Outbound Dependencies([\s\S]*?)(##|$)/);
        const textToSearch = sectionMatch ? sectionMatch[1] : content;

        const links: string[] = [];
        const regex = /\[\[(.*?)\]\]/g;
        let match;
        while ((match = regex.exec(textToSearch)) !== null) {
            links.push(match[1]);
        }
        return links;
    } catch {
        return [];
    }
}
