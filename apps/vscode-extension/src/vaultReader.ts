import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VaultJob {
    jobId: string;
    status: string;
    instruction: string;
    priority: number;
    createdAt: string;
    filePath: string;
}

export interface VaultApproval {
    approvalId: string;
    title: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    createdAt: string;
    filePath: string;
}

export interface VaultHealth {
    pendingJobs: number;
    runningJobs: number;
    pendingApprovals: number;
    lastHeartbeat: string | null;
}

// ── Inline frontmatter parser (no gray-matter dependency) ─────────────────────

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) { return { data: {}, body: raw }; }
    const data: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const m = line.match(/^(\w[\w-]*):\s*['"]?(.*?)['"]?\s*$/);
        if (m) { data[m[1]] = m[2]; }
    }
    return { data, body: match[2] };
}

// ── VaultReader ───────────────────────────────────────────────────────────────

export class VaultReader {
    constructor(public readonly vaultPath: string) {}

    /** Auto-detect vault path: config → workspace .vault/ → VAULT_PATH env → default */
    static detect(folders: readonly vscode.WorkspaceFolder[]): string | null {
        const config = vscode.workspace.getConfiguration('agentHQ');
        const configPath = config.get<string>('vaultPath', '');
        if (configPath) { return configPath; }

        for (const folder of folders) {
            const candidate = path.join(folder.uri.fsPath, '.vault');
            if (fs.existsSync(candidate)) { return candidate; }
        }

        const envPath = process.env.VAULT_PATH;
        if (envPath && fs.existsSync(envPath)) { return envPath; }

        return null;
    }

    /** Read all job files in a status directory */
    listJobs(status: 'pending' | 'running'): VaultJob[] {
        const dir = path.join(this.vaultPath, '_jobs', status);
        if (!fs.existsSync(dir)) { return []; }
        const jobs: VaultJob[] = [];
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
            } catch { /* skip malformed files */ }
        }
        return jobs;
    }

    /** Read all pending approval files */
    listApprovals(): VaultApproval[] {
        const dir = path.join(this.vaultPath, '_approvals', 'pending');
        if (!fs.existsSync(dir)) { return []; }
        const approvals: VaultApproval[] = [];
        for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
            try {
                const filePath = path.join(dir, file);
                const raw = fs.readFileSync(filePath, 'utf-8');
                const { data } = parseFrontmatter(raw);
                approvals.push({
                    approvalId: data.approvalId ?? file.replace('.md', ''),
                    title: data.title ?? '(untitled)',
                    description: data.description ?? '',
                    riskLevel: (data.riskLevel as VaultApproval['riskLevel']) ?? 'medium',
                    createdAt: data.createdAt ?? '',
                    filePath,
                });
            } catch { /* skip malformed files */ }
        }
        return approvals;
    }

    /** Read a system file body */
    readSystemFile(name: string): string {
        const filePath = path.join(this.vaultPath, '_system', `${name}.md`);
        if (!fs.existsSync(filePath)) { return ''; }
        const { body } = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
        return body.trim();
    }

    /** Write a new pending job file */
    createJob(instruction: string, priority: number = 5): string {
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
    resolveApproval(filePath: string, approved: boolean): void {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const START = '---';
        const END = '---';
        const updated = raw.replace(
            /^status:\s*pending/m,
            `status: ${approved ? 'approved' : 'denied'}`
        );
        const resolvedDir = path.join(this.vaultPath, '_approvals', 'resolved');
        fs.mkdirSync(resolvedDir, { recursive: true });
        const destPath = path.join(resolvedDir, path.basename(filePath));
        fs.writeFileSync(destPath, updated, 'utf-8');
        fs.unlinkSync(filePath);
    }

    /** Aggregate health metrics */
    health(): VaultHealth {
        const pending = this.listJobs('pending');
        const running = this.listJobs('running');
        const approvals = this.listApprovals();
        let lastHeartbeat: string | null = null;
        try {
            const hbPath = path.join(this.vaultPath, '_system', 'HEARTBEAT.md');
            if (fs.existsSync(hbPath)) {
                const { data } = parseFrontmatter(fs.readFileSync(hbPath, 'utf-8'));
                lastHeartbeat = data.lastProcessed ?? null;
            }
        } catch { /* ignore */ }
        return {
            pendingJobs: pending.length,
            runningJobs: running.length,
            pendingApprovals: approvals.length,
            lastHeartbeat,
        };
    }
}
