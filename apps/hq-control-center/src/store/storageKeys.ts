// ─── Centralized localStorage Keys ────────────────────────────────────────────
// All renderer-side localStorage keys in one place to avoid collisions
// and make it easy to find/change them.

export const STORAGE_KEYS = {
    /** Last active tab in TabShell ('dash' | 'terminal' | 'sim' | 'graph' | 'settings') */
    ACTIVE_TAB: 'hq:activeTab',
    /** Zoom level for the VaultGraph D3 view */
    GRAPH_ZOOM: 'hq:graphZoom',
    /** Zoom level for the SimulationRoom canvas */
    SIM_ZOOM: 'hq:simZoom',
} as const;

export type StorageKey = typeof STORAGE_KEYS[keyof typeof STORAGE_KEYS];
