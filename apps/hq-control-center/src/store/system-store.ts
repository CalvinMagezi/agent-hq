import { create } from 'zustand';
import type {
    DaemonStatusPayload,
    SystemStatsPayload,
    EnvConfig,
    DependencyCheckResult
} from '../../electron/types';

interface SystemState {
    // Daemon
    daemonRunning: boolean;
    daemonPid: number | null;
    daemonUptime: number | null;
    daemonLogs: Array<{ stream: 'stdout' | 'stderr', data: string, timestamp: number }>;

    // OS System
    cpuUsagePercent: number;
    memUsedMB: number;
    memTotalMB: number;

    // App Env
    config: EnvConfig | null;
    vaultPath: string | null;
    deps: DependencyCheckResult | null;
    wizardCompleted: boolean;

    // Actions
    appendLog: (log: { stream: 'stdout' | 'stderr', data: string, timestamp: number }) => void;
    updateDaemonStatus: (status: DaemonStatusPayload) => void;
    updateSystemStats: (stats: SystemStatsPayload) => void;
    setConfig: (config: EnvConfig) => void;
    setVaultPath: (path: string) => void;
    setDeps: (deps: DependencyCheckResult) => void;
}

export const useSystemStore = create<SystemState>((set) => ({
    daemonRunning: false,
    daemonPid: null,
    daemonUptime: null,
    daemonLogs: [],

    cpuUsagePercent: 0,
    memUsedMB: 0,
    memTotalMB: 0,

    config: null,
    vaultPath: null,
    deps: null,
    wizardCompleted: true,

    appendLog: (log) => set((state) => ({
        daemonLogs: [...state.daemonLogs, log].slice(-1000) // Keep last 1000 lines
    })),

    updateDaemonStatus: (status) => set({
        daemonRunning: status.running,
        daemonPid: status.pid,
        daemonUptime: status.uptime
    }),

    updateSystemStats: (stats) => set({
        cpuUsagePercent: stats.cpuUsagePercent,
        memUsedMB: stats.memUsedMB,
        memTotalMB: stats.memTotalMB
    }),

    setConfig: (config) => set({
        config,
        wizardCompleted: !!config.OPENROUTER_API_KEY || !!config.GEMINI_API_KEY
    }),

    setVaultPath: (vaultPath) => set({ vaultPath }),

    setDeps: (deps) => set({ deps })
}));
