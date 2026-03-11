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
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const harnessView_1 = require("./harnessView");
const jobQueueView_1 = require("./jobQueueView");
const vaultReader_1 = require("./vaultReader");
const approvalHandler_1 = require("./approvalHandler");
const contextBuilder_1 = require("./contextBuilder");
// ── Global state ─────────────────────────────────────────────────────────────
const terminals = new Map();
let activeHarnessId = 'hq';
let statusBar;
let vaultStatusBar;
let harnessProvider;
let jobQueueProvider;
let approvalHandler;
let currentReader = null;
const cleanupFns = new Map();
// ── Activation ────────────────────────────────────────────────────────────────
function activate(context) {
    const config = vscode.workspace.getConfiguration('agentHQ');
    activeHarnessId = config.get('defaultHarness', 'hq');
    // ── Harness status bar (left) ─────────────────────────────────────────────
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'agentHQ.switchHarness';
    context.subscriptions.push(statusBar);
    updateStatusBar();
    statusBar.show();
    // ── Vault status bar (right, priority 99) ─────────────────────────────────
    vaultStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    vaultStatusBar.command = 'agentHQ.refreshQueue';
    context.subscriptions.push(vaultStatusBar);
    vaultStatusBar.show();
    // ── Harness tree view ─────────────────────────────────────────────────────
    harnessProvider = new harnessView_1.HarnessProvider(() => activeHarnessId);
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentHQ.harnessView', harnessProvider));
    // ── Job queue tree view ───────────────────────────────────────────────────
    jobQueueProvider = new jobQueueView_1.JobQueueProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('agentHQ.jobQueueView', jobQueueProvider));
    // ── Approval handler ──────────────────────────────────────────────────────
    approvalHandler = new approvalHandler_1.ApprovalHandler();
    context.subscriptions.push({ dispose: () => approvalHandler.dispose() });
    // ── Detect vault + wire file watchers ────────────────────────────────────
    initVault(context);
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('agentHQ.openChat', openChat), vscode.commands.registerCommand('agentHQ.switchHarness', switchHarness), vscode.commands.registerCommand('agentHQ.newSession', newSession), vscode.commands.registerCommand('agentHQ.openHarness', openHarness), vscode.commands.registerCommand('agentHQ.refreshQueue', () => { jobQueueProvider.refresh(); updateVaultStatusBar(); }), vscode.commands.registerCommand('agentHQ.createJob', createJobFromSelection), vscode.commands.registerCommand('agentHQ.createJobFile', createJobFromFile), vscode.commands.registerCommand('agentHQ.approveRequest', (item) => resolveApproval(item, true)), vscode.commands.registerCommand('agentHQ.denyRequest', (item) => resolveApproval(item, false)), vscode.commands.registerCommand('agentHQ.openJobFile', openJobFile), vscode.window.onDidCloseTerminal(async (t) => {
        for (const [id, term] of terminals) {
            if (term === t) {
                terminals.delete(id);
                const cleanup = cleanupFns.get(id);
                if (cleanup) {
                    await cleanup();
                    cleanupFns.delete(id);
                }
                break;
            }
        }
    }));
}
// ── Vault init + watchers ─────────────────────────────────────────────────────
function initVault(context) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const vaultPath = vaultReader_1.VaultReader.detect(folders);
    if (!vaultPath) {
        currentReader = null;
        jobQueueProvider.setReader(null);
        updateVaultStatusBar();
        return;
    }
    currentReader = new vaultReader_1.VaultReader(vaultPath);
    jobQueueProvider.setReader(currentReader);
    approvalHandler.activate(currentReader, () => { jobQueueProvider.refresh(); updateVaultStatusBar(); });
    updateVaultStatusBar();
    const watchDirs = ['_jobs/pending', '_jobs/running', '_approvals/pending', '_system'];
    for (const dir of watchDirs) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.join(vaultPath, dir), '*.md'));
        const refresh = () => { jobQueueProvider.refresh(); updateVaultStatusBar(); };
        watcher.onDidCreate(refresh);
        watcher.onDidChange(refresh);
        watcher.onDidDelete(refresh);
        context.subscriptions.push(watcher);
    }
}
// ── Status bar helpers ────────────────────────────────────────────────────────
function updateStatusBar() {
    const all = (0, harnessView_1.detectInstalledHarnesses)();
    const harness = all.find(h => h.id === activeHarnessId);
    if (statusBar && harness) {
        statusBar.text = `$(terminal) ${harness.label}`;
        statusBar.tooltip = `Agent-HQ: ${harness.description} — click to switch`;
    }
}
function updateVaultStatusBar() {
    if (!currentReader) {
        vaultStatusBar.text = '$(error) HQ: no vault';
        vaultStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        return;
    }
    try {
        const health = currentReader.health();
        if (health.pendingApprovals > 0) {
            vaultStatusBar.text = `$(warning) HQ: ${health.pendingApprovals} approval${health.pendingApprovals !== 1 ? 's' : ''}`;
            vaultStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        else if (health.runningJobs > 0) {
            vaultStatusBar.text = `$(loading~spin) HQ: ${health.runningJobs} running`;
            vaultStatusBar.backgroundColor = undefined;
        }
        else {
            vaultStatusBar.text = '$(check) HQ: idle';
            vaultStatusBar.backgroundColor = undefined;
        }
    }
    catch {
        vaultStatusBar.text = '$(error) HQ: no vault';
        vaultStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}
// ── Terminal helpers ──────────────────────────────────────────────────────────
function spawnTerminal(harness) {
    const config = vscode.workspace.getConfiguration('agentHQ');
    const hqPath = config.get('hqPath', 'hq');
    const command = harness.id === 'hq' ? `${hqPath} chat` : `${harness.cli}`;
    return vscode.window.createTerminal({
        name: `Agent-HQ: ${harness.label}`,
        shellPath: process.env.SHELL || '/bin/zsh',
        shellArgs: ['-c', command],
    });
}
function getOrCreateTerminal(harness) {
    let terminal = terminals.get(harness.id);
    if (!terminal || terminal.exitStatus !== undefined) {
        terminal = spawnTerminal(harness);
        terminals.set(harness.id, terminal);
    }
    return terminal;
}
// ── Commands ──────────────────────────────────────────────────────────────────
function openChat() {
    const all = (0, harnessView_1.detectInstalledHarnesses)();
    const harness = all.find(h => h.id === activeHarnessId);
    if (!harness) {
        return;
    }
    getOrCreateTerminal(harness).show();
}
async function openHarness(harnessId) {
    const all = (0, harnessView_1.detectInstalledHarnesses)();
    const harness = all.find(h => h.id === harnessId);
    if (!harness) {
        return;
    }
    activeHarnessId = harnessId;
    updateStatusBar();
    harnessProvider.refresh();
    // Context injection for non-HQ harnesses
    if (harness.id !== 'hq' && currentReader) {
        const builder = new contextBuilder_1.ContextBuilder(currentReader);
        const context = await builder.buildContext();
        const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        let cleanup;
        if (harness.id === 'claude') {
            cleanup = await builder.injectIntoCLAUDEMd(workDir, context);
        }
        else {
            cleanup = await builder.injectIntoAGENTSMd(workDir, context);
        }
        if (cleanup) {
            cleanupFns.set(harness.id, cleanup);
        }
    }
    getOrCreateTerminal(harness).show();
}
async function switchHarness() {
    const all = (0, harnessView_1.detectInstalledHarnesses)();
    const pick = await vscode.window.showQuickPick(all.map(h => ({
        label: `${h.id === activeHarnessId ? '$(check) ' : ''}${h.label}`,
        description: h.description,
        id: h.id,
    })), { title: 'Agent-HQ: Switch Harness' });
    if (pick) {
        openHarness(pick.id);
    }
}
async function newSession() {
    const all = (0, harnessView_1.detectInstalledHarnesses)();
    const harness = all.find(h => h.id === activeHarnessId);
    if (!harness) {
        return;
    }
    const existing = terminals.get(activeHarnessId);
    if (existing) {
        existing.dispose();
        terminals.delete(activeHarnessId);
        const cleanup = cleanupFns.get(activeHarnessId);
        if (cleanup) {
            await cleanup();
            cleanupFns.delete(activeHarnessId);
        }
    }
    openHarness(harness.id);
}
async function createJobFromSelection() {
    if (!currentReader) {
        vscode.window.showErrorMessage('Agent-HQ: No vault found. Set agentHQ.vaultPath in settings.');
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const selection = editor?.document.getText(editor.selection) ?? '';
    const filename = editor?.document.fileName ? path.basename(editor.document.fileName) : '';
    const prefill = selection
        ? `${selection}\n\n(from ${filename})`
        : filename ? `Analyze ${filename}` : '';
    const instruction = await vscode.window.showInputBox({
        title: 'Agent-HQ: Create Job',
        prompt: 'Enter job instruction',
        value: prefill,
    });
    if (!instruction) {
        return;
    }
    const jobId = currentReader.createJob(instruction);
    const action = await vscode.window.showInformationMessage(`Agent-HQ: Job created: ${jobId}`, 'View Queue');
    if (action === 'View Queue') {
        vscode.commands.executeCommand('agentHQ.jobQueueView.focus');
    }
    jobQueueProvider.refresh();
}
async function createJobFromFile() {
    if (!currentReader) {
        vscode.window.showErrorMessage('Agent-HQ: No vault found. Set agentHQ.vaultPath in settings.');
        return;
    }
    const editor = vscode.window.activeTextEditor;
    const filename = editor?.document.fileName ? path.basename(editor.document.fileName) : 'current file';
    const prefill = `Analyze ${filename}`;
    const instruction = await vscode.window.showInputBox({
        title: 'Agent-HQ: Create Job from File',
        prompt: 'Enter job instruction',
        value: prefill,
    });
    if (!instruction) {
        return;
    }
    const jobId = currentReader.createJob(instruction);
    vscode.window.showInformationMessage(`Agent-HQ: Job created: ${jobId}`);
    jobQueueProvider.refresh();
}
async function resolveApproval(item, approved) {
    if (!currentReader) {
        return;
    }
    try {
        currentReader.resolveApproval(item.approval.filePath, approved);
        vscode.window.showInformationMessage(`Agent-HQ: ${approved ? '✅ Approved' : '❌ Denied'}: ${item.approval.title}`);
        jobQueueProvider.refresh();
        updateVaultStatusBar();
    }
    catch (e) {
        vscode.window.showErrorMessage(`Failed to resolve approval: ${e}`);
    }
}
async function openJobFile(filePath) {
    try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
}
function deactivate() {
    terminals.forEach(t => t.dispose());
    terminals.clear();
}
//# sourceMappingURL=extension.js.map