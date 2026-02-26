"use strict";
const electron = require("electron");
const IPC = {
  // Renderer → Main (invoke)
  START_DAEMON: "daemon:start",
  STOP_DAEMON: "daemon:stop",
  SAVE_ENV_CONFIG: "config:save-env",
  TRIGGER_WORKFLOW: "workflow:trigger",
  GET_ENV_CONFIG: "config:get-env",
  GET_VAULT_PATH: "vault:get-path",
  CHECK_DEPENDENCIES: "system:check-deps",
  GET_VAULT_GRAPH: "vault:get-graph",
  LOAD_LAYOUT: "layout:load",
  SAVE_LAYOUT: "layout:save",
  // Main → Renderer (send)
  DAEMON_LOG: "daemon:log",
  DAEMON_STATUS: "daemon:status",
  VAULT_UPDATE: "vault:update",
  SYSTEM_STATS: "system:stats",
  VAULT_GRAPH_UPDATE: "vault:graph-updated"
};
const api = {
  startDaemon: () => electron.ipcRenderer.invoke(IPC.START_DAEMON),
  stopDaemon: () => electron.ipcRenderer.invoke(IPC.STOP_DAEMON),
  saveEnvConfig: (config) => electron.ipcRenderer.invoke(IPC.SAVE_ENV_CONFIG, config),
  triggerWorkflow: (name) => electron.ipcRenderer.invoke(IPC.TRIGGER_WORKFLOW, name),
  getEnvConfig: () => electron.ipcRenderer.invoke(IPC.GET_ENV_CONFIG),
  getVaultPath: () => electron.ipcRenderer.invoke(IPC.GET_VAULT_PATH),
  checkDependencies: () => electron.ipcRenderer.invoke(IPC.CHECK_DEPENDENCIES),
  getVaultGraph: () => electron.ipcRenderer.invoke(IPC.GET_VAULT_GRAPH),
  loadLayout: () => electron.ipcRenderer.invoke(IPC.LOAD_LAYOUT),
  saveLayout: (layout) => electron.ipcRenderer.invoke(IPC.SAVE_LAYOUT, layout),
  onDaemonLog: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on(IPC.DAEMON_LOG, listener);
    return () => {
      electron.ipcRenderer.removeListener(IPC.DAEMON_LOG, listener);
    };
  },
  onDaemonStatus: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on(IPC.DAEMON_STATUS, listener);
    return () => {
      electron.ipcRenderer.removeListener(IPC.DAEMON_STATUS, listener);
    };
  },
  onVaultUpdate: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on(IPC.VAULT_UPDATE, listener);
    return () => {
      electron.ipcRenderer.removeListener(IPC.VAULT_UPDATE, listener);
    };
  },
  onSystemStats: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on(IPC.SYSTEM_STATS, listener);
    return () => {
      electron.ipcRenderer.removeListener(IPC.SYSTEM_STATS, listener);
    };
  },
  onVaultGraphUpdate: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on(IPC.VAULT_GRAPH_UPDATE, listener);
    return () => {
      electron.ipcRenderer.removeListener(IPC.VAULT_GRAPH_UPDATE, listener);
    };
  }
};
electron.contextBridge.exposeInMainWorld("electronAPI", api);
