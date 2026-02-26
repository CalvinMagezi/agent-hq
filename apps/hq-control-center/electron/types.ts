export interface DaemonLogPayload {
    stream: 'stdout' | 'stderr';
    data: string;
    timestamp: number;
}

export interface DaemonStatusPayload {
    running: boolean;
    pid: number | null;
    uptime: number | null;
}

export interface SystemStatsPayload {
    cpuUsagePercent: number;
    memUsedMB: number;
    memTotalMB: number;
    timestamp: number;
}

export interface VaultUpdatePayload {
    event: 'add' | 'change' | 'unlink';
    path: string;
    timestamp: number;
}

export interface VaultGraphPayload {
    nodes: Array<{ id: string; title: string; tags: string[] }>;
    edges: Array<{ source: string; target: string }>;
}

// ─── Layout Persistence ────────────────────────────────────────────────────────

export interface PlacedFurniturePayload {
    key: string;
    col: number;
    row: number;
    rotation: 0 | 90 | 180 | 270;
    /** Footprint [cols, rows] — cached from catalog for IPC transport */
    footprint?: [number, number];
}

export interface LayoutPayload {
    version: number;
    furniture: PlacedFurniturePayload[];
    savedAt: number;
}

// ─── Env / Config ──────────────────────────────────────────────────────────────

export interface EnvConfig {
    OPENROUTER_API_KEY?: string;
    GEMINI_API_KEY?: string;
    DEFAULT_MODEL?: string;
    BRAVE_SEARCH_API_KEY?: string;
    AGENTHQ_API_KEY?: string;
    VAULT_PATH?: string;
    [key: string]: string | undefined;
}

export interface DependencyCheckResult {
    bunInstalled: boolean;
    bunVersion: string | null;
    nodeVersion: string;
    envFileExists: boolean;
    vaultPathExists: boolean;
}

export interface ElectronAPI {
    // Renderer → Main
    startDaemon: () => Promise<boolean>;
    stopDaemon: () => Promise<boolean>;
    saveEnvConfig: (config: EnvConfig) => Promise<boolean>;
    triggerWorkflow: (name: string) => Promise<string>;
    getEnvConfig: () => Promise<EnvConfig>;
    getVaultPath: () => Promise<string>;
    checkDependencies: () => Promise<DependencyCheckResult>;
    getVaultGraph: () => Promise<VaultGraphPayload>;
    loadLayout: () => Promise<LayoutPayload | null>;
    saveLayout: (layout: LayoutPayload) => Promise<boolean>;

    // Main → Renderer (listeners)
    onDaemonLog: (cb: (payload: DaemonLogPayload) => void) => () => void;
    onDaemonStatus: (cb: (payload: DaemonStatusPayload) => void) => () => void;
    onVaultUpdate: (cb: (payload: VaultUpdatePayload) => void) => () => void;
    onSystemStats: (cb: (payload: SystemStatsPayload) => void) => () => void;
    onVaultGraphUpdate: (cb: (payload: VaultGraphPayload) => void) => () => void;
}
