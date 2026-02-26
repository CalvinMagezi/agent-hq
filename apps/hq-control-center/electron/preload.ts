import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC } from './ipc-channels';
import type {
  ElectronAPI,
  EnvConfig,
  DaemonLogPayload,
  DaemonStatusPayload,
  VaultUpdatePayload,
  SystemStatsPayload,
  VaultGraphPayload,
  LayoutPayload
} from './types';

const api: ElectronAPI = {
  startDaemon: () => ipcRenderer.invoke(IPC.START_DAEMON),
  stopDaemon: () => ipcRenderer.invoke(IPC.STOP_DAEMON),
  saveEnvConfig: (config: EnvConfig) => ipcRenderer.invoke(IPC.SAVE_ENV_CONFIG, config),
  triggerWorkflow: (name: string) => ipcRenderer.invoke(IPC.TRIGGER_WORKFLOW, name),
  getEnvConfig: () => ipcRenderer.invoke(IPC.GET_ENV_CONFIG),
  getVaultPath: () => ipcRenderer.invoke(IPC.GET_VAULT_PATH),
  checkDependencies: () => ipcRenderer.invoke(IPC.CHECK_DEPENDENCIES),
  getVaultGraph: () => ipcRenderer.invoke(IPC.GET_VAULT_GRAPH),
  loadLayout: () => ipcRenderer.invoke(IPC.LOAD_LAYOUT),
  saveLayout: (layout: LayoutPayload) => ipcRenderer.invoke(IPC.SAVE_LAYOUT, layout),

  onDaemonLog: (cb) => {
    const listener = (_e: IpcRendererEvent, p: DaemonLogPayload) => cb(p);
    ipcRenderer.on(IPC.DAEMON_LOG, listener);
    return () => { ipcRenderer.removeListener(IPC.DAEMON_LOG, listener); };
  },
  onDaemonStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, p: DaemonStatusPayload) => cb(p);
    ipcRenderer.on(IPC.DAEMON_STATUS, listener);
    return () => { ipcRenderer.removeListener(IPC.DAEMON_STATUS, listener); };
  },
  onVaultUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, p: VaultUpdatePayload) => cb(p);
    ipcRenderer.on(IPC.VAULT_UPDATE, listener);
    return () => { ipcRenderer.removeListener(IPC.VAULT_UPDATE, listener); };
  },
  onSystemStats: (cb) => {
    const listener = (_e: IpcRendererEvent, p: SystemStatsPayload) => cb(p);
    ipcRenderer.on(IPC.SYSTEM_STATS, listener);
    return () => { ipcRenderer.removeListener(IPC.SYSTEM_STATS, listener); };
  },
  onVaultGraphUpdate: (cb) => {
    const listener = (_e: IpcRendererEvent, p: VaultGraphPayload) => cb(p);
    ipcRenderer.on(IPC.VAULT_GRAPH_UPDATE, listener);
    return () => { ipcRenderer.removeListener(IPC.VAULT_GRAPH_UPDATE, listener); };
  }
};

contextBridge.exposeInMainWorld('electronAPI', api);
