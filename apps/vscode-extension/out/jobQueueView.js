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
exports.JobQueueProvider = exports.ApprovalItem = exports.JobItem = void 0;
const vscode = __importStar(require("vscode"));
// ── Tree Item classes ─────────────────────────────────────────────────────────
class SectionItem extends vscode.TreeItem {
    constructor(label, count, children) {
        super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
        this.children = children;
        this.contextValue = 'sectionItem';
    }
}
class JobItem extends vscode.TreeItem {
    constructor(job, isRunning) {
        super(job.instruction.length > 60
            ? job.instruction.slice(0, 57) + '...'
            : job.instruction, vscode.TreeItemCollapsibleState.None);
        this.job = job;
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
exports.JobItem = JobItem;
class ApprovalItem extends vscode.TreeItem {
    constructor(approval) {
        super(approval.title, vscode.TreeItemCollapsibleState.None);
        this.approval = approval;
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
exports.ApprovalItem = ApprovalItem;
// ── JobQueueProvider ──────────────────────────────────────────────────────────
class JobQueueProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.reader = null;
        this.sections = [];
    }
    setReader(reader) {
        this.reader = reader;
        this.refresh();
    }
    refresh() {
        this._buildSections();
        this._onDidChangeTreeData.fire();
    }
    _buildSections() {
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
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return this.sections;
        }
        if (element instanceof SectionItem) {
            return element.children;
        }
        return [];
    }
}
exports.JobQueueProvider = JobQueueProvider;
//# sourceMappingURL=jobQueueView.js.map