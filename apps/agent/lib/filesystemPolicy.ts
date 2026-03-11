import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// We'll use a simple fallback if minimatch isn't directly available,
// but let's try to load it if present (many CLI tools depend on it)
let minimatch: any;
try {
    minimatch = require("minimatch");
} catch {
    // Basic glob-to-regex fallback if minimatch is missing
    minimatch = (target: string, pattern: string) => {
        const escapeRegex = (s: string) => s.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
        const regexStr = '^' + pattern.split('*').map(escapeRegex).join('.*') + '$';
        return new RegExp(regexStr).test(target);
    };
}

export interface FilesystemPolicy {
    blockedPatterns: string[];
}

const DEFAULT_BLOCKED_PATTERNS = [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
    "~/.config/gws/credentials.enc",
    "**/id_rsa",
    "**/id_ed25519",
    "**/*.pem",
    "**/.env"
];

const homeDir = os.homedir();

/**
 * Normalizes a pattern or path, replacing ~ with the actual home directory.
 */
function normalizePath(p: string): string {
    if (p.startsWith("~/")) {
        return path.join(homeDir, p.slice(2));
    }
    return p;
}

/**
 * Loads the filesystem policy from ~/.config/agent-hq/filesystem-policy.json.
 * If the file doesn't exist, it uses default blocked patterns.
 */
export function loadFilesystemPolicy(): FilesystemPolicy {
    const policyPath = path.join(homeDir, ".config", "agent-hq", "filesystem-policy.json");

    if (fs.existsSync(policyPath)) {
        try {
            const raw = fs.readFileSync(policyPath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.blockedPatterns)) {
                return {
                    blockedPatterns: parsed.blockedPatterns
                };
            }
        } catch (err) {
            console.error("[ToolGuardian] Error parsing filesystem-policy.json, using defaults.", err);
        }
    }

    return {
        blockedPatterns: [...DEFAULT_BLOCKED_PATTERNS]
    };
}

/**
 * Validates a target path against the loaded filesystem policy.
 * Returns true if the path is allowed, false if blocked.
 */
export function validatePathAgainstPolicy(targetPath: string, policy: FilesystemPolicy): boolean {
    const resolvedTarget = path.resolve(normalizePath(targetPath));

    for (const pattern of policy.blockedPatterns) {
        const normalizedPattern = normalizePath(pattern);

        // Exact match or prefix match for directories implicitly trailing
        if (resolvedTarget === normalizedPattern || resolvedTarget.startsWith(normalizedPattern + path.sep)) {
            return false; // blocked
        }

        // Glob match
        if (minimatch(resolvedTarget, normalizedPattern, { dot: true })) {
            return false; // blocked
        }
    }

    return true; // allowed
}
