import * as fs from 'fs';
import * as vscode from 'vscode';
import { VaultReader, VaultApproval } from './vaultReader';

export class ApprovalHandler {
    private watcher: vscode.FileSystemWatcher | null = null;

    activate(reader: VaultReader, onRefresh: () => void): void {
        const pendingDir = `${reader.vaultPath}/_approvals/pending`;
        const pattern = new vscode.RelativePattern(pendingDir, '*.md');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.watcher.onDidCreate(async (uri) => {
            // Small delay to let the file finish writing
            await new Promise(r => setTimeout(r, 300));
            let approval: VaultApproval | null = null;
            try {
                const approvals = reader.listApprovals();
                approval = approvals.find(a => a.filePath === uri.fsPath) ?? null;
            } catch { /* ignore */ }

            const title = approval?.title ?? 'Approval Required';
            const risk = approval?.riskLevel ?? 'unknown';
            const desc = approval?.description ?? '';

            const action = await vscode.window.showInformationMessage(
                `🔔 Agent-HQ approval needed (${risk} risk): ${title}`,
                { detail: desc, modal: false },
                'Approve',
                'Deny',
                'View'
            );

            if (action === 'View') {
                await vscode.window.showTextDocument(uri);
            } else if (action === 'Approve' || action === 'Deny') {
                try {
                    reader.resolveApproval(uri.fsPath, action === 'Approve');
                    vscode.window.showInformationMessage(
                        `Agent-HQ: ${action === 'Approve' ? '✅ Approved' : '❌ Denied'}: ${title}`
                    );
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to resolve approval: ${e}`);
                }
            }
            onRefresh();
        });

        this.watcher.onDidDelete(() => onRefresh());
        this.watcher.onDidChange(() => onRefresh());
    }

    dispose(): void {
        this.watcher?.dispose();
    }
}
