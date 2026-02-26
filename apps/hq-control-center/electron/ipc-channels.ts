export const IPC = {
    // Renderer → Main (invoke)
    START_DAEMON: 'daemon:start',
    STOP_DAEMON: 'daemon:stop',
    SAVE_ENV_CONFIG: 'config:save-env',
    TRIGGER_WORKFLOW: 'workflow:trigger',
    GET_ENV_CONFIG: 'config:get-env',
    GET_VAULT_PATH: 'vault:get-path',
    CHECK_DEPENDENCIES: 'system:check-deps',
    GET_VAULT_GRAPH: 'vault:get-graph',
    LOAD_LAYOUT: 'layout:load',
    SAVE_LAYOUT: 'layout:save',

    // Main → Renderer (send)
    DAEMON_LOG: 'daemon:log',
    DAEMON_STATUS: 'daemon:status',
    VAULT_UPDATE: 'vault:update',
    SYSTEM_STATS: 'system:stats',
    VAULT_GRAPH_UPDATE: 'vault:graph-updated',
} as const;
