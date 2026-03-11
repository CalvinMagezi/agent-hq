"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultReader = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
// ── Inline frontmatter parser (no gray-matter dependency) ─────────────────────
function parseFrontmatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) {
        return { data: {}, body: raw };
    }
    const data = {};
    for (const line of match[1].split('\n')) {
        const m = line.match(/^(\w[\w-]*):\s*['"]?(.*?)['"]?\s*$/);
        if (m) {
            data[m[1]] = m[2];
        }
    }
    return { data, body: match[2] };
}
// ── VaultReader ───────────────────────────────────────────────────────────────
class VaultReader {
    constructor(vaultPath) {
        this.vaultPath = vaultPath;
    }
    /** Auto-detect vault path: config → workspace .vault/ → VAULT_PATH env → default */
    static detect(folders) {
        const config = vscode.workspace.getConfiguration('agentHQ');
        const configPath = config.get('vaultPath', '');
        if (configPath) {
            return configPath;
        }
        for (const folder of folders) {
            const candidate = path.join(folder.uri.fsPath, '.vault');
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        const envPath = process.env.VAULT_PATH;
        if (envPath && fs.existsSync(envPath)) {
            return envPath;
        }
        return null;
    }
    /** Read all job files in a status directory */
    listJobs(status) {
        const dir = path.join(this.vaultPath, '_jobs', status);
        if (!fs.existsSync(dir)) {
            return [];
        }
        const jobs = [];
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
            try {
                const filePath = path.join(dir, file);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const { data } = parseFrontmatter(raw);
                jobs.push({
                    jobId: data.jobId ?? file.replace('.md', ''),
                    status: data.status ?? status,
                    instruction: data.instruction ?? '(no instruction)',
                    priority: parseInt(data.priority ?? '5', 10),
                    createdAt: data.createdAt ?? '',
                    filePath,
                });
            }
            catch { /* skip malformed files */ }
        }
        return jobs;
    }
    /** Read all pending approval files */
    listApprovals() {
        const dir = path.join(this.vaultPath, '_approvals', 'pending');
        if (!fs.existsSync(dir)) {
            return [];
        }
        const approvals = [];
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
            try {
                const filePath = path.join(dir, file);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const { data } = parseFrontmatter(raw);
                approvals.push({
                    approvalId: data.approvalId ?? file.replace('.md', ''),
                    title: data.title ?? '(untitled)',
                    description: data.description ?? '',
                    riskLevel: data.riskLevel ?? 'medium',
                    createdAt: data.createdAt ?? '',
                    filePath,
                });
            }
            catch { /* skip malformed files */ }
        }
        return approvals;
    }
    /** Read a system file body */
    readSystemFile(name) {
        const filePath = path.join(this.vaultPath, '_system', `${name}.md`);
        if (!fs.existsSync(filePath)) {
            return '';
        }
        const { body } = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
        return body.trim();
    }
    /** Write a new pending job file */
    createJob(instruction, priority = 5) {
        const ts = Date.now();
        const rand = Math.random().toString(36).slice(2, 6);
        const jobId = `job-${ts}-${rand}`;
        const dir = path.join(this.vaultPath, '_jobs', 'pending');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${jobId}.md`);
        const content = [
            '---',
            `jobId: ${jobId}`,
            `status: pending`,
            `instruction: "${instruction.replace(/"/g, '\\"')}"`,
            `priority: ${priority}`,
            `createdAt: ${new Date().toISOString()}`,
            '---',
            '',
            instruction,
        ].join('\n');
        fs.writeFileSync(filePath, content, 'utf-8');
        return jobId;
    }
    /** Move an approval from pending → resolved with the given status */
    resolveApproval(filePath, approved) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const START = '---';
        const END = '---';
        const updated = raw.replace(/^status:\s*pending/m, `status: ${approved ? 'approved' : 'denied'}`);
        const resolvedDir = path.join(this.vaultPath, '_approvals', 'resolved');
        fs.mkdirSync(resolvedDir, { recursive: true });
        const destPath = path.join(resolvedDir, path.basename(filePath));
        fs.writeFileSync(destPath, updated, 'utf-8');
        fs.unlinkSync(filePath);
    }
    /** Aggregate health metrics */
    health() {
        const pending = this.listJobs('pending');
        const running = this.listJobs('running');
        const approvals = this.listApprovals();
        let lastHeartbeat = null;
        try {
            const hbPath = path.join(this.vaultPath, '_system', 'HEARTBEAT.md');
            if (fs.existsSync(hbPath)) {
                const { data } = parseFrontmatter(fs.readFileSync(hbPath, 'utf-8'));
                lastHeartbeat = data.lastProcessed ?? null;
            }
        }
        catch { /* ignore */ }
        return {
            pendingJobs: pending.length,
            runningJobs: running.length,
            pendingApprovals: approvals.length,
            lastHeartbeat,
        };
    }
}
exports.VaultReader = VaultReader;
//# sourceMappingURL=vaultReader.js.map