import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createTempVault, cleanupTempVault } from "./helpers";
import { getBacklinks, getOutboundLinks, getFileExports, getFileFrontmatter } from "../graph";

let vaultPath: string;

beforeEach(() => {
    const tmp = createTempVault();
    vaultPath = tmp.vaultPath;
});

afterEach(() => {
    cleanupTempVault(vaultPath);
});

describe("Graph Utilities", () => {
    test("getBacklinks finds notes linking to target", () => {
        fs.mkdirSync(path.join(vaultPath, "Architecture"), { recursive: true });
        fs.writeFileSync(path.join(vaultPath, "Architecture/foo.md"), "Here is a link [[Architecture/bar]]", "utf-8");
        fs.writeFileSync(path.join(vaultPath, "Architecture/baz.md"), "Another link [[Architecture/bar]]", "utf-8");
        fs.writeFileSync(path.join(vaultPath, "Architecture/qux.md"), "Link to [[Architecture/qux]]", "utf-8");

        const backlinks = getBacklinks(vaultPath, "Architecture/bar");
        expect(backlinks).toHaveLength(2);
        // Sort array before matching to ensure deterministic tests
        expect(backlinks.sort()).toEqual(["Architecture/baz.md", "Architecture/foo.md"].sort());
    });

    test("getOutboundLinks extracts wikilinks from Outbound Dependencies section", () => {
        const notePath = path.join(vaultPath, "test.md");
        const content = `
# Title
## Summary
Blah blah
## Outbound Dependencies
- [[Architecture/foo]]
- [[Architecture/bar]]
## Inbound Dependents
- [[Architecture/baz]]
    `;
        fs.writeFileSync(notePath, content, "utf-8");

        const links = getOutboundLinks(vaultPath, "test.md");
        expect(links).toEqual(["Architecture/foo", "Architecture/bar"]);
    });

    test("getFileExports reads exports from frontmatter", () => {
        const notePath = path.join(vaultPath, "exports.md");
        const content = `---\nexports:\n  - foo\n  - bar\n---\n# Title`;
        fs.writeFileSync(notePath, content, "utf-8");

        const exports = getFileExports(vaultPath, "exports.md");
        expect(exports).toEqual(["foo", "bar"]);
    });
});
