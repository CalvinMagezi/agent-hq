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
exports.ApprovalHandler = void 0;
const vscode = __importStar(require("vscode"));
class ApprovalHandler {
    constructor() {
        this.watcher = null;
    }
    activate(reader, onRefresh) {
        const pendingDir = `${reader.vaultPath}/_approvals/pending`;
        const pattern = new vscode.RelativePattern(pendingDir, '*.md');
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidCreate(async (uri) => {
            // Small delay to let the file finish writing
            await new Promise(r => setTimeout(r, 300));
            let approval = null;
            try {
                const approvals = reader.listApprovals();
                approval = approvals.find(a => a.filePath === uri.fsPath) ?? null;
            }
            catch { /* ignore */ }
            const title = approval?.title ?? 'Approval Required';
            const risk = approval?.riskLevel ?? 'unknown';
            const desc = approval?.description ?? '';
            const action = await vscode.window.showInformationMessage(`🔔 Agent-HQ approval needed (${risk} risk): ${title}`, { detail: desc, modal: false }, 'Approve', 'Deny', 'View');
            if (action === 'View') {
                await vscode.window.showTextDocument(uri);
            }
            else if (action === 'Approve' || action === 'Deny') {
                try {
                    reader.resolveApproval(uri.fsPath, action === 'Approve');
                    vscode.window.showInformationMessage(`Agent-HQ: ${action === 'Approve' ? '✅ Approved' : '❌ Denied'}: ${title}`);
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Failed to resolve approval: ${e}`);
                }
            }
            onRefresh();
        });
        this.watcher.onDidDelete(() => onRefresh());
        this.watcher.onDidChange(() => onRefresh());
    }
    dispose() {
        this.watcher?.dispose();
    }
}
exports.ApprovalHandler = ApprovalHandler;
//# sourceMappingURL=approvalHandler.js.map