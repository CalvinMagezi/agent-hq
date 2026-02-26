import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from './ipc-channels';
import { daemonManager } from './daemon-manager';
import { envManager } from './env-manager';
import { vaultManager } from './vault-manager';
import { loadLayout, saveLayout } from './layoutManager';
import type { LayoutPayload } from './types';

// Debounce timer for layout saves (bunched rapid saves during drag)
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function setupIpcHandlers(mainWindow: BrowserWindow) {
    ipcMain.handle(IPC.START_DAEMON, async () => {
        return daemonManager.start(mainWindow);
    });

    ipcMain.handle(IPC.STOP_DAEMON, async () => {
        return daemonManager.stop();
    });

    ipcMain.handle(IPC.SAVE_ENV_CONFIG, async (_, config) => {
        return await envManager.writeEnv(config);
    });

    ipcMain.handle(IPC.GET_ENV_CONFIG, async () => {
        return await envManager.readEnv();
    });

    ipcMain.handle(IPC.CHECK_DEPENDENCIES, async () => {
        return await daemonManager.checkDependencies();
    });

    ipcMain.handle(IPC.GET_VAULT_PATH, async () => {
        return await envManager.getVaultPath();
    });

    ipcMain.handle(IPC.GET_VAULT_GRAPH, async () => {
        return vaultManager.getGraph();
    });

    ipcMain.handle(IPC.TRIGGER_WORKFLOW, async (_, name: string) => {
        return await daemonManager.triggerWorkflow(name);
    });

    // ─── Layout Handlers ─────────────────────────────────────
    ipcMain.handle(IPC.LOAD_LAYOUT, async () => {
        return await loadLayout();
    });

    ipcMain.handle(IPC.SAVE_LAYOUT, async (_, layout: LayoutPayload) => {
        // Debounce: coalesce rapid saves during drag operations
        if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
        return new Promise<boolean>(resolve => {
            saveDebounceTimer = setTimeout(async () => {
                const result = await saveLayout(layout);
                resolve(result);
            }, 500);
        });
    });
}
