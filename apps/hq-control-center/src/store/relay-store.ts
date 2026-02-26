import { create } from 'zustand';
import type {
    SystemStatusResponseMessage,
    JobStatusMessage,
    TraceProgressMessage,
    SystemEventMessage,
    SystemAgentsMessage
} from '@repo/agent-relay-protocol';
import { RelayClient, RelayClientConfig } from '@repo/agent-relay-protocol';

interface RelayState {
    connected: boolean;
    systemStatus: SystemStatusResponseMessage | null;
    activeJobs: Map<string, JobStatusMessage>;
    traces: Map<string, TraceProgressMessage>;
    events: SystemEventMessage[];
    agents: SystemAgentsMessage['agents'];

    connect: (apiKey?: string) => void;
    disconnect: () => void;
    getClient: () => RelayClient | null;
}

let globalClient: RelayClient | null = null;
let reconnectTimer: any = null;

export const useRelayStore = create<RelayState>((set) => ({
    connected: false,
    systemStatus: null,
    activeJobs: new Map(),
    traces: new Map(),
    events: [],
    agents: [],

    connect: (apiKey?: string) => {
        if (globalClient) {
            globalClient.disconnect();
        }

        const config: RelayClientConfig = {
            apiKey: apiKey || 'local-master-key',
            clientType: 'web'
        };

        const client = new RelayClient(config);
        globalClient = client;

        client.on('system:status-response', (msg: any) => {
            set({ connected: true, systemStatus: msg });
        });

        client.on('job:status', (msg: any) => {
            set((state) => {
                const newJobs = new Map(state.activeJobs);
                newJobs.set(msg.jobId, msg);
                return { activeJobs: newJobs, connected: true };
            });
        });

        client.on('trace:progress', (msg: any) => {
            set((state) => {
                const newTraces = new Map(state.traces);
                newTraces.set(msg.traceId, msg);
                return { traces: newTraces, connected: true };
            });
        });

        client.on('system:event', (msg: any) => {
            set((state) => {
                const newEvents = [msg, ...state.events].slice(0, 50);
                return { events: newEvents, connected: true };
            });
        });

        client.on('system:agents', (msg: any) => {
            set({ agents: msg.agents, connected: true });
        });

        client.connect()
            .then(() => {
                set({ connected: true });
                client.subscribeToEvents(['job:*', 'system:*']);
                client.subscribeToTraces();

                clearInterval(reconnectTimer);
                reconnectTimer = setInterval(() => {
                    client.getStatus().catch(() => set({ connected: false }));
                }, 5000);
            })
            .catch((err: any) => {
                console.error('Relay connection failed:', err);
                set({ connected: false });
            });
    },

    disconnect: () => {
        if (globalClient) {
            globalClient.disconnect();
            globalClient = null;
        }
        clearInterval(reconnectTimer);
        set({ connected: false });
    },

    getClient: () => globalClient
}));
