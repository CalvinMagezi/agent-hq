import * as vscode from 'vscode';
import { VaultReader, VaultJob, VaultApproval } from './vaultReader';

// ── Tree Item classes ─────────────────────────────────────────────────────────

class SectionItem extends vscode.TreeItem {
    constructor(
        label: string,
        count: number,
        public readonly children: JobItem[] | ApprovalItem[]
    ) {
        super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'sectionItem';
    }
}

export class JobItem extends vscode.TreeItem {
    constructor(public readonly job: VaultJob, isRunning: boolean) {
        super(
            job.instruction.length > 60
                ? job.instruction.slice(0, 57) + '...'
                : job.instruction,
            vscode.TreeItemCollapsibleState.None
        );
        this.description = job.jobId;
        this.tooltip = job.instruction;
        this.iconPath = new vscode.ThemeIcon(isRunning ? 'loading~spin' : 'clock');
        this.contextValue = 'jobItem';
        this.command = {
            command: 'agentHQ.openJobFile',
            title: 'Open Job File',
            arguments: [job.filePath],
        };
    }
}

export class ApprovalItem extends vscode.TreeItem {
    constructor(public readonly approval: VaultApproval) {
        super(approval.title, vscode.TreeItemCollapsibleState.None);
        this.description = approval.riskLevel;
        this.tooltip = approval.description || approval.title;
        const icon = approval.riskLevel === 'critical' || approval.riskLevel === 'high'
            ? 'error'
            : 'warning';
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'approvalItem';
        this.command = {
            command: 'agentHQ.openJobFile',
            title: 'Open Approval File',
            arguments: [approval.filePath],
        };
    }
}

type TreeNode = SectionItem | JobItem | ApprovalItem;

// ── JobQueueProvider ──────────────────────────────────────────────────────────

export class JobQueueProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private reader: VaultReader | null = null;
    private sections: SectionItem[] = [];

    setReader(reader: VaultReader | null) {
        this.reader = reader;
        this.refresh();
    }

    refresh() {
        this._buildSections();
        this._onDidChangeTreeData.fire();
    }

    private _buildSections() {
        if (!this.reader) {
            this.sections = [];
            return;
        }
        const running = this.reader.listJobs('running').map(j => new JobItem(j, true));
        const pending = this.reader.listJobs('pending').map(j => new JobItem(j, false));
        const approvals = this.reader.listApprovals().map(a => new ApprovalItem(a));
        this.sections = [
            new SectionItem('Running', running.length, running),
            new SectionItem('Pending', pending.length, pending),
            new SectionItem('Approvals', approvals.length, approvals),
        ];
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!element) {
            return this.sections;
        }
        if (element instanceof SectionItem) {
            return element.children as TreeNode[];
        }
        return [];
    }
}
