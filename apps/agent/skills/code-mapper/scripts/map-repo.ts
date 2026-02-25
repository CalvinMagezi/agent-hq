#!/usr/bin/env bun
/**
 * map-repo.ts — Deterministic ts-morph codebase parser.
 *
 * Usage:
 * bun run map-repo.ts --target /path/to/repo --vault-dest /path/to/vault/Architecture/repo
 */

import { Project } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import matter from "gray-matter";

const args = process.argv.slice(2);
let targetPath = "";
let vaultDest = "";

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") targetPath = args[++i];
    if (args[i] === "--vault-dest") vaultDest = args[++i];
}

if (!targetPath || !vaultDest) {
    console.error("Usage: bun run map-repo.ts --target <repo-path> --vault-dest <vault-destination>");
    process.exit(1);
}

targetPath = path.resolve(targetPath);
vaultDest = path.resolve(vaultDest);

console.log(`Mapping repository: ${targetPath}`);
console.log(`Destination vault path: ${vaultDest}`);

const repoName = path.basename(targetPath);
const tsConfigFilePath = fs.existsSync(path.join(targetPath, "tsconfig.json"))
    ? path.join(targetPath, "tsconfig.json")
    : undefined;

const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: !tsConfigFilePath,
});

if (!tsConfigFilePath) {
    project.addSourceFilesAtPaths(path.join(targetPath, "**/*.{ts,tsx}"));
}

const sourceFiles = project.getSourceFiles();
console.log(`Found ${sourceFiles.length} source files.`);

let processedCount = 0;

for (const sourceFile of sourceFiles) {
    const filePath = sourceFile.getFilePath();

    // Only process files within the target repository
    if (!filePath.startsWith(targetPath)) {
        continue;
    }

    if (filePath.includes("/node_modules/") || filePath.includes("/dist/") || filePath.includes("/.")) {
        continue;
    }

    let relPath = path.relative(targetPath, filePath).split(path.sep).join("/");
    const exports = Array.from(sourceFile.getExportedDeclarations().keys());
    const importDeclarations = sourceFile.getImportDeclarations();
    const outboundLinks: string[] = [];

    for (const importDecl of importDeclarations) {
        let isLocal = false;
        let importedRelPath = "";
        const moduleSpecifier = importDecl.getModuleSpecifierValue();

        const importedSourceFile = importDecl.getModuleSpecifierSourceFile();
        if (importedSourceFile) {
            const importedPath = importedSourceFile.getFilePath();
            if (importedPath.startsWith(targetPath) && !importedPath.includes("/node_modules/")) {
                isLocal = true;
                importedRelPath = path.relative(targetPath, importedPath);
            }
        } else if (moduleSpecifier.startsWith(".")) {
            isLocal = true;
            const dir = path.dirname(filePath);
            const resolved = path.resolve(dir, moduleSpecifier);
            importedRelPath = path.relative(targetPath, resolved);
        }

        if (isLocal) {
            importedRelPath = importedRelPath.split(path.sep).join("/");
            importedRelPath = importedRelPath.replace(/\.tsx?$/, "");

            // Check if it's a directory import that resolves to an index
            if (!importedRelPath.endsWith("index") && !fs.existsSync(path.join(targetPath, importedRelPath + ".ts")) && !fs.existsSync(path.join(targetPath, importedRelPath + ".tsx"))) {
                if (fs.existsSync(path.join(targetPath, importedRelPath))) {
                    importedRelPath += "/index";
                }
            }
            outboundLinks.push(`[[${importedRelPath}]]`);
        }
    }

    const uniqueLinks = Array.from(new Set(outboundLinks));
    const frontmatter = { type: "file", repo: repoName, path: relPath, exports };
    const noteFilename = relPath.replace(/\.tsx?$/, ".md");
    const noteAbsPath = path.join(vaultDest, noteFilename);

    const dir = path.dirname(noteAbsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let body = `# ${path.basename(filePath)}\n\n## Summary\n*(Pending AI documentation)*\n\n## Outbound Dependencies\n`;
    if (uniqueLinks.length > 0) {
        body += uniqueLinks.map(link => `- ${link}`).join("\n") + "\n";
    } else {
        body += `*(None)*\n`;
    }
    body += `\n## Inbound Dependents (Backlinks)\n*(Auto-populated by Obsidian)*\n`;

    const output = matter.stringify("\n" + body, frontmatter);
    fs.writeFileSync(noteAbsPath, output, "utf-8");
    processedCount++;
}

console.log(`Successfully mapped ${processedCount} files to ${vaultDest}.`);
