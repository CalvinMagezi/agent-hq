export interface BashAnalysis {
    isDangerous: boolean;
    reason?: string;
}

/**
 * A tiny shell tokenizer that handles basic quoting and escapes.
 * Extracts "tokens" (arguments) to make semantic checking easier than raw regex.
 */
export function tokenizeBash(cmd: string): string[] {
    const tokens: string[] = [];
    let currentToken = "";
    let state: "NORMAL" | "IN_SINGLE_QUOTE" | "IN_DOUBLE_QUOTE" = "NORMAL";
    let escapeNext = false;

    // A tiny state machine to walk through characters
    for (let i = 0; i < cmd.length; i++) {
        const char = cmd[i];

        if (escapeNext) {
            currentToken += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\' && state !== "IN_SINGLE_QUOTE") {
            escapeNext = true;
            // Depending on strictness, we might want to preserve the backslash
            // but for command recognition it's often better to just eat it or keep it.
            // Let's keep the raw string but note the escape.
            currentToken += char;
            continue;
        }

        if (state === "NORMAL") {
            if (char === "'") {
                state = "IN_SINGLE_QUOTE";
                currentToken += char;
            } else if (char === '"') {
                state = "IN_DOUBLE_QUOTE";
                currentToken += char;
            } else if (/\s/.test(char)) {
                if (currentToken.length > 0) {
                    tokens.push(currentToken);
                    currentToken = "";
                }
            } else if (char === ';' || char === '|' || char === '&' || char === '<' || char === '>') {
                // Delimiters split tokens
                if (currentToken.length > 0) {
                    tokens.push(currentToken);
                    currentToken = "";
                }
                tokens.push(char); // Push the delimiter itself as a token
            } else {
                currentToken += char;
            }
        } else if (state === "IN_SINGLE_QUOTE") {
            currentToken += char;
            if (char === "'") {
                state = "NORMAL";
            }
        } else if (state === "IN_DOUBLE_QUOTE") {
            currentToken += char;
            if (char === '"') {
                state = "NORMAL";
            }
        }
    }

    if (currentToken.length > 0) {
        tokens.push(currentToken);
    }

    return tokens;
}

/**
 * Helper to strip quotes and evaluate concatenation tricks (e.g. `r""m`)
 */
function normalizeToken(token: string): string {
    // Basic unquoting
    let normalized = token.replace(/['"]/g, "");

    // Evaluate basic backslash escapes (e.g., \r\m -> rm)
    normalized = normalized.replace(/\\/g, "");

    return normalized.toLowerCase();
}

/**
 * Analyzes a bash command semantically to look for dangerous structures
 * that simple regexes might miss (like `eval $(echo rm -rf)`).
 */
export function analyzeBashCommand(cmd: string): BashAnalysis {
    // 1. Check for pure nasty substrings that are virtually always malicious/blocked
    if (/\$\{IFS\}/i.test(cmd) || /\$IFS/i.test(cmd)) {
        return { isDangerous: true, reason: "IFS injection detected" };
    }

    // Check for hex/octal encoding evasion
    if (/\\x[0-9a-f]{2}/i.test(cmd) || /\\[0-7]{3}/.test(cmd)) {
        return { isDangerous: true, reason: "Hex/Octal encoding evasion detected" };
    }

    const tokens = tokenizeBash(cmd);
    const normalizedTokens = tokens.map(normalizeToken);

    // Context tracking during iteration
    let isEvalContext = false;

    for (let i = 0; i < normalizedTokens.length; i++) {
        const token = normalizedTokens[i];

        if (token === "eval") {
            isEvalContext = true;
            // eval combined with command substitution is blocked
            if (i + 1 < tokens.length && (tokens[i + 1].startsWith("$(") || tokens[i + 1].startsWith("`"))) {
                return { isDangerous: true, reason: "Command substitution inside eval" };
            }
        }

        // Destructive file operations
        if (token === "rm") {
            // Check subsequent tokens for dangerous flags
            for (let j = i + 1; j < Math.min(i + 4, normalizedTokens.length); j++) {
                const nextToken = normalizedTokens[j];
                // Break checking if we hit a separator
                if ([';', '|', '&', '&&', '||'].includes(nextToken)) break;

                if (nextToken.includes("-") && nextToken.includes("r") && nextToken.includes("f")) {
                    return { isDangerous: true, reason: "Destructive rm -rf detected" };
                }
                if (nextToken === "--recursive" || nextToken === "--force") {
                    // Check if both are present in the flags
                    let hasRecursive = false;
                    let hasForce = false;
                    for (let k = i + 1; k < Math.min(i + 5, normalizedTokens.length); k++) {
                        if ([';', '|', '&'].includes(normalizedTokens[k])) break;
                        if (normalizedTokens[k].includes("-") && normalizedTokens[k].includes("r")) hasRecursive = true;
                        if (normalizedTokens[k].includes("-") && normalizedTokens[k].includes("f")) hasForce = true;
                        if (normalizedTokens[k] === "--recursive") hasRecursive = true;
                        if (normalizedTokens[k] === "--force") hasForce = true;
                    }
                    if (hasRecursive && hasForce) {
                        return { isDangerous: true, reason: "Destructive rm --recursive --force detected" };
                    }
                }
            }
        }

        // Check for privilege escalation
        if (token === "sudo") {
            return { isDangerous: true, reason: "Sudo/Privilege escalation blocked" };
        }

        if (token === "chmod") {
            for (let j = i + 1; j < Math.min(i + 3, normalizedTokens.length); j++) {
                if (normalizedTokens[j] === "777") {
                    return { isDangerous: true, reason: "chmod 777 blocked" };
                }
            }
        }

        // Git force operations
        if (token === "git") {
            if (normalizedTokens[i + 1] === "push" && (normalizedTokens[i + 2] === "--force" || normalizedTokens[i + 2] === "-f")) {
                return { isDangerous: true, reason: "Git force push blocked" };
            }
            if (normalizedTokens[i + 1] === "reset" && normalizedTokens[i + 2] === "--hard") {
                return { isDangerous: true, reason: "Git reset --hard blocked" };
            }
        }

        // Database/destructive text ops
        if (token === "drop" && normalizedTokens[i + 1] === "table") {
            return { isDangerous: true, reason: "Database DROP TABLE blocked" };
        }
        if (token === "truncate") {
            return { isDangerous: true, reason: "Database TRUNCATE blocked" };
        }
        if (token === "delete" && normalizedTokens[i + 1] === "from") {
            return { isDangerous: true, reason: "Database DELETE FROM blocked" };
        }

        // Disk ops
        if (token === "mkfs") {
            return { isDangerous: true, reason: "Disk formatting (mkfs) blocked" };
        }
        if (token === "dd") {
            for (let j = i + 1; j < Math.min(i + 5, normalizedTokens.length); j++) {
                if (normalizedTokens[j].startsWith("if=")) {
                    return { isDangerous: true, reason: "Raw disk manipulation (dd) blocked" };
                }
            }
        }

        // Direct device writing
        if (token === ">" || token === ">>") {
            if (i + 1 < normalizedTokens.length && normalizedTokens[i + 1].startsWith("/dev/sd")) {
                return { isDangerous: true, reason: "Writing directly to block device blocked" };
            }
        }

        // Command substitution combined with dangerous ops: e.g. echo something | tee /dev/sd*
        if (token === "tee") {
            for (let j = i + 1; j < Math.min(i + 4, normalizedTokens.length); j++) {
                if (normalizedTokens[j].startsWith("/dev/sd")) {
                    return { isDangerous: true, reason: "Tee to block device blocked" };
                }
            }
        }
    }

    // Catch command substitution structures via raw string
    if (/\$\(\s*rm\s+-/i.test(cmd) || /`\s*rm\s+-/i.test(cmd)) {
        return { isDangerous: true, reason: "Command substitution with rm detected" };
    }

    return { isDangerous: false };
}
