import * as fs from 'fs';
import * as path from 'path';
import { VaultReader } from './vaultReader';

const MARKER_START = '<!-- agent-hq:start -->';
const MARKER_END = '<!-- agent-hq:end -->';

export class ContextBuilder {
    constructor(private readonly reader: VaultReader) {}

    /** Assemble the vault context markdown block */
    async buildContext(): Promise<string> {
        const [soul, memory, prefs] = await Promise.all([
            Promise.resolve(this.reader.readSystemFile('SOUL')),
            Promise.resolve(this.reader.readSystemFile('MEMORY')),
            Promise.resolve(this.reader.readSystemFile('PREFERENCES')),
        ]);

        const health = this.reader.health();
        const running = this.reader.listJobs('running');
        const pending = this.reader.listJobs('pending');

        const queueSummary = [
            `- Running: ${health.runningJobs} job(s)`,
            ...running.slice(0, 3).map(j => `  - [${j.jobId}] ${j.instruction.slice(0, 80)}`),
            `- Pending: ${health.pendingJobs} job(s)`,
            ...pending.slice(0, 3).map(j => `  - [${j.jobId}] ${j.instruction.slice(0, 80)}`),
            health.pendingApprovals > 0
                ? `- ⚠️ ${health.pendingApprovals} approval(s) pending`
                : '',
        ].filter(Boolean).join('\n');

        return `# Agent-HQ: Vault Context & Governance

## Identity
${soul || 'You are a helpful AI assistant.'}

## Memory
${memory || '(no memory yet)'}

## Preferences
${prefs || '(no preferences set)'}

## Current Queue
${queueSummary || '- Queue empty'}

## Governance — Security Profile: STANDARD

You are operating as part of the Agent-HQ ecosystem with STANDARD security.

### Rules
- **Never** delete files, force-push git, drop databases, or run irreversible scripts without an approval.
- **Never** expose or log API keys or secrets from env vars.
- For risky operations, write an approval request FIRST and wait before proceeding.

### Approval Request Format
When you need approval for a risky action, write this file and WAIT:

File path: ${this.reader.vaultPath}/_approvals/pending/approval-{timestamp}-{hash}.md

\`\`\`yaml
---
approvalId: approval-{timestamp}-{hash}
title: Short description of the action
description: What you want to do and why
toolName: bash
riskLevel: low|medium|high|critical
status: pending
createdAt: {ISO timestamp}
timeoutMinutes: 10
---
\`\`\`

Then poll ${this.reader.vaultPath}/_approvals/resolved/ every 10 seconds. Proceed only when the file appears there with \`status: approved\`.

### Memory Management
To persist a fact: append a new line to ${this.reader.vaultPath}/_system/MEMORY.md.

### Vault Path
Your vault is at: ${this.reader.vaultPath}
`;
    }

    /** Inject context into CLAUDE.md, return async cleanup fn */
    async injectIntoCLAUDEMd(workDir: string, context: string): Promise<() => Promise<void>> {
        const claudeMdPath = path.join(workDir, 'CLAUDE.md');
        const existing = fs.existsSync(claudeMdPath)
            ? fs.readFileSync(claudeMdPath, 'utf-8')
            : '';
        const block = `${MARKER_START}\n${context}\n${MARKER_END}`;
        const newContent = existing.includes(MARKER_START)
            ? existing.replace(
                new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`),
                block
            )
            : `${block}\n\n${existing}`;
        fs.writeFileSync(claudeMdPath, newContent, 'utf-8');

        return async () => {
            if (!fs.existsSync(claudeMdPath)) { return; }
            const current = fs.readFileSync(claudeMdPath, 'utf-8');
            const cleaned = current
                .replace(
                    new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`),
                    ''
                )
                .trim();
            if (existing) {
                fs.writeFileSync(claudeMdPath, cleaned ? cleaned + '\n' : '', 'utf-8');
            } else if (!cleaned) {
                fs.unlinkSync(claudeMdPath);
            } else {
                fs.writeFileSync(claudeMdPath, cleaned + '\n', 'utf-8');
            }
        };
    }

    /** Inject context into AGENTS.md, return async cleanup fn */
    async injectIntoAGENTSMd(workDir: string, context: string): Promise<() => Promise<void>> {
        const agentsMdPath = path.join(workDir, 'AGENTS.md');
        const existing = fs.existsSync(agentsMdPath)
            ? fs.readFileSync(agentsMdPath, 'utf-8')
            : '';
        const block = `${MARKER_START}\n${context}\n${MARKER_END}`;
        const newContent = existing.includes(MARKER_START)
            ? existing.replace(
                new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`),
                block
            )
            : `${block}\n\n${existing}`;
        fs.writeFileSync(agentsMdPath, newContent, 'utf-8');

        return async () => {
            if (!fs.existsSync(agentsMdPath)) { return; }
            const current = fs.readFileSync(agentsMdPath, 'utf-8');
            const cleaned = current
                .replace(
                    new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n*`),
                    ''
                )
                .trim();
            cleaned
                ? fs.writeFileSync(agentsMdPath, cleaned + '\n', 'utf-8')
                : fs.unlinkSync(agentsMdPath);
        };
    }
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
