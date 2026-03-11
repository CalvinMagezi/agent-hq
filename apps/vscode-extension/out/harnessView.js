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
exports.HarnessProvider = exports.HarnessItem = void 0;
exports.detectInstalledHarnesses = detectInstalledHarnesses;
const vscode = __importStar(require("vscode"));
const child_process_1 = require("child_process");
const KNOWN_HARNESSES = [
    { id: 'hq', label: 'HQ Chat', cli: 'hq', description: 'Full context via relay + governance', icon: 'home' },
    { id: 'claude', label: 'Claude', cli: 'claude', description: 'Claude Code — vault-contextualized', icon: 'sparkle' },
    { id: 'opencode', label: 'OpenCode', cli: 'opencode', description: 'OpenCode — vault-contextualized', icon: 'code' },
    { id: 'codex', label: 'Codex', cli: 'codex', description: 'Codex — vault-contextualized', icon: 'symbol-misc' },
    { id: 'gemini', label: 'Gemini', cli: 'gemini', description: 'Gemini — vault-contextualized', icon: 'star' },
];
// ── Auto-detection ────────────────────────────────────────────────────────────
function detectInstalledHarnesses() {
    const config = vscode.workspace.getConfiguration('agentHQ');
    const userHarnesses = config.get('harnesses', []);
    const detected = KNOWN_HARNESSES.map(h => {
        try {
            (0, child_process_1.execSync)(`which ${h.cli}`, { stdio: 'pipe' });
            return { ...h, installed: true };
        }
        catch {
            return { ...h, installed: false };
        }
    });
    if (userHarnesses.length) {
        return [...userHarnesses, ...detected.filter(h => !userHarnesses.some(u => u.id === h.id))];
    }
    return detected;
}
// ── Tree Items ────────────────────────────────────────────────────────────────
class HarnessItem extends vscode.TreeItem {
    constructor(harness, isActive) {
        super(harness.label, vscode.TreeItemCollapsibleState.None);
        this.harness = harness;
        const installed = harness.installed !== false;
        this.description = installed ? harness.description : 'not installed';
        this.tooltip = installed
            ? `Open ${harness.label} (${harness.cli})`
            : `${harness.cli} not found in PATH`;
        this.iconPath = new vscode.ThemeIcon(installed
            ? (isActive ? 'terminal-bash' : 'terminal')
            : 'circle-slash');
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
exports.HarnessItem = HarnessItem;
// ── HarnessProvider ───────────────────────────────────────────────────────────
class HarnessProvider {
    constructor(getActiveId) {
        this.getActiveId = getActiveId;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const harnesses = detectInstalledHarnesses();
        return harnesses.map(h => new HarnessItem(h, h.id === this.getActiveId()));
    }
}
exports.HarnessProvider = HarnessProvider;
//# sourceMappingURL=harnessView.js.map