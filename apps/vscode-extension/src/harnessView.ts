import * as vscode from 'vscode';
import { execSync } from 'child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HarnessDefinition {
    id: string;
    label: string;
    cli: string;
    description: string;
    icon: string;
}

const KNOWN_HARNESSES: HarnessDefinition[] = [
    { id: 'hq',       label: 'HQ Chat',  cli: 'hq',       description: 'Full context via relay + governance', icon: 'home' },
    { id: 'claude',   label: 'Claude',   cli: 'claude',   description: 'Claude Code — vault-contextualized',   icon: 'sparkle' },
    { id: 'opencode', label: 'OpenCode', cli: 'opencode', description: 'OpenCode — vault-contextualized',      icon: 'code' },
    { id: 'codex',    label: 'Codex',    cli: 'codex',    description: 'Codex — vault-contextualized',         icon: 'symbol-misc' },
    { id: 'gemini',   label: 'Gemini',   cli: 'gemini',   description: 'Gemini — vault-contextualized',        icon: 'star' },
];

// ── Auto-detection ────────────────────────────────────────────────────────────

export function detectInstalledHarnesses(): HarnessDefinition[] {
    const config = vscode.workspace.getConfiguration('agentHQ');
    const userHarnesses = config.get<HarnessDefinition[]>('harnesses', []);

    const detected = KNOWN_HARNESSES.map(h => {
        try {
            execSync(`which ${h.cli}`, { stdio: 'pipe' });
            return { ...h, installed: true };
        } catch {
            return { ...h, installed: false };
        }
    });

    if (userHarnesses.length) {
        return [...userHarnesses, ...detected.filter(h => !userHarnesses.some(u => u.id === h.id))];
    }
    return detected;
}

// ── Tree Items ────────────────────────────────────────────────────────────────

export class HarnessItem extends vscode.TreeItem {
    constructor(
        public readonly harness: HarnessDefinition & { installed?: boolean },
        isActive: boolean
    ) {
        super(harness.label, vscode.TreeItemCollapsibleState.None);
        const installed = harness.installed !== false;
        this.description = installed ? harness.description : 'not installed';
        this.tooltip = installed
            ? `Open ${harness.label} (${harness.cli})`
            : `${harness.cli} not found in PATH`;
        this.iconPath = new vscode.ThemeIcon(
            installed
                ? (isActive ? 'terminal-bash' : 'terminal')
                : 'circle-slash'
        );
        this.contextValue = 'harnessItem';
        if (installed) {
            this.command = {
                command: 'agentHQ.openHarness',
                title: 'Open',
                arguments: [harness.id],
            };
        }
        if (isActive) {
            this.resourceUri = vscode.Uri.parse(`agent-hq://active/${harness.id}`);
        }
    }
}

// ── HarnessProvider ───────────────────────────────────────────────────────────

export class HarnessProvider implements vscode.TreeDataProvider<HarnessItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HarnessItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private getActiveId: () => string) {}

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HarnessItem): vscode.TreeItem {
        return element;
    }

    getChildren(): HarnessItem[] {
        const harnesses = detectInstalledHarnesses();
        return harnesses.map(h => new HarnessItem(h, h.id === this.getActiveId()));
    }
}
