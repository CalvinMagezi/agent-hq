import chokidar from 'chokidar';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { VaultGraphPayload, VaultUpdatePayload } from './types';
import { EnvManager } from './env-manager';
import { IPC } from './ipc-channels';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class VaultManager {
    private watcher: any = null;
    private vaultPath: string | null = null;
    private mainWindow: BrowserWindow | null = null;

    // In-memory representation of the graph
    private nodes: Map<string, { id: string; title: string; tags: string[] }> = new Map();
    private edges: Set<string> = new Set(); // Stored as "source|target"

    // Debounce timer for graph broadcasts
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(mainWindow: BrowserWindow | null) {
        this.mainWindow = mainWindow;
    }

    public setMainWindow(window: BrowserWindow) {
        this.mainWindow = window;
    }

    public async init() {
        const envManager = new EnvManager();
        const config = await envManager.readEnv();

        // Fallback to monorepo root .vault if not set
        this.vaultPath = config.VAULT_PATH || path.resolve(__dirname, '../../../.vault');

        try {
            await fs.access(this.vaultPath);
        } catch {
            // Vault doesn't exist yet, we'll watch the directory above it or just do nothing
            console.log(`[VaultManager] Vault path does not exist: ${this.vaultPath}`);
            return;
        }

        console.log(`[VaultManager] Initializing watch on: ${this.vaultPath}`);

        this.watcher = chokidar.watch('**/*.md', {
            cwd: this.vaultPath,
            ignored: /(^|[\/\\])\./, // ignore dotfiles
            persistent: true
        });

        this.watcher
            .on('add', async (filePath: string) => {
                await this.processFile(filePath);
                this.broadcastUpdate('add', filePath);
                this.scheduleBroadcastGraph();
            })
            .on('change', async (filePath: string) => {
                await this.processFile(filePath);
                this.broadcastUpdate('change', filePath);
                this.scheduleBroadcastGraph();
            })
            .on('unlink', (filePath: string) => {
                this.removeFile(filePath);
                this.broadcastUpdate('unlink', filePath);
                this.scheduleBroadcastGraph();
            });
    }

    public stop() {
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer);
            this.broadcastTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    /** Schedule a debounced graph broadcast (coalesces rapid file changes) */
    private scheduleBroadcastGraph() {
        if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
        this.broadcastTimer = setTimeout(() => {
            this.broadcastGraph();
            this.broadcastTimer = null;
        }, 500);
    }

    private async processFile(relativePath: string) {
        if (!this.vaultPath) return;

        const fullPath = path.join(this.vaultPath, relativePath);
        try {
            const content = await fs.readFile(fullPath, 'utf-8');

            const title = path.basename(relativePath, '.md');
            const id = this.normalizeId(title);

            // Extract tags: basic regex for #tag
            const tags: string[] = [];
            const tagRegex = /(?:^|\s)#([a-zA-Z0-9_-]+)/g;
            let match;
            while ((match = tagRegex.exec(content)) !== null) {
                if (!tags.includes(match[1])) tags.push(match[1]);
            }

            this.nodes.set(id, { id, title, tags });

            // Clean old edges from this node
            const edgesToRemove = Array.from(this.edges).filter(e => e.startsWith(`${id}|`));
            edgesToRemove.forEach(e => this.edges.delete(e));

            // Extract wikilinks: [[Link]] or [[Link|Alias]]
            const linkRegex = /\[\[(.*?)\]\]/g;
            while ((match = linkRegex.exec(content)) !== null) {
                const linkTarget = match[1].split('|')[0].trim();
                const targetId = this.normalizeId(linkTarget);
                if (targetId) {
                    this.edges.add(`${id}|${targetId}`);
                }
            }
        } catch (err) {
            console.error(`[VaultManager] Failed to process ${relativePath}:`, err);
        }
    }

    private removeFile(relativePath: string) {
        const title = path.basename(relativePath, '.md');
        const id = this.normalizeId(title);

        this.nodes.delete(id);

        // Remove all edges referencing this node
        const edgesToRemove = Array.from(this.edges).filter(e => e.startsWith(`${id}|`) || e.endsWith(`|${id}`));
        edgesToRemove.forEach(e => this.edges.delete(e));
    }

    private normalizeId(name: string): string {
        return name.toLowerCase().replace(/\s+/g, '-');
    }

    private broadcastUpdate(event: 'add' | 'change' | 'unlink', filePath: string) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const payload: VaultUpdatePayload = {
                event,
                path: filePath,
                timestamp: Date.now()
            };
            this.mainWindow.webContents.send(IPC.VAULT_UPDATE, payload);
        }
    }

    private broadcastGraph() {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            const payload: VaultGraphPayload = {
                nodes: Array.from(this.nodes.values()),
                edges: Array.from(this.edges).map(e => {
                    const [source, target] = e.split('|');
                    return { source, target };
                })
            };
            // Use the correct IPC channel constant (was hardcoded 'vault:graph-update', missing trailing 'd')
            this.mainWindow.webContents.send(IPC.VAULT_GRAPH_UPDATE, payload);
        }
    }

    public getGraph(): VaultGraphPayload {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: Array.from(this.edges).map(e => {
                const [source, target] = e.split('|');
                return { source, target };
            })
        };
    }
}

export const vaultManager = new VaultManager(null);
