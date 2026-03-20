import { create } from 'zustand'

export interface HQState {
    // Websocket connection status
    wsConnected: boolean;
    setWsConnected: (connected: boolean) => void;

    // Jobs
    jobs: any[];
    setJobs: (jobs: any[]) => void;
    updateJob: (job: any) => void;

    // Agents (Relays & Workers combined list)
    agents: any[];
    setAgents: (agents: any[]) => void;
    updateAgent: (agent: any) => void;

    // Daemon matching DAEMON-STATUS
    daemonTasks: any[];
    setDaemonTasks: (tasks: any[]) => void;

    usage: { today: number; month: number; budget: number };
    setUsage: (usage: any) => void;
}

export const useHQStore = create<HQState>((set) => ({
    wsConnected: false,
    setWsConnected: (connected) => set({ wsConnected: connected }),

    jobs: [],
    setJobs: (jobs) => set({ jobs }),
    updateJob: (job) => set((state) => ({
        jobs: state.jobs.map(j => j.jobId === job.jobId ? { ...j, ...job } : j)
    })),

    agents: [],
    setAgents: (agents) => set({ agents }),
    updateAgent: (agent) => set((state) => ({
        agents: state.agents.map(a => a.id === agent.id ? { ...a, ...agent } : a)
    })),

    daemonTasks: [],
    setDaemonTasks: (tasks) => set({ daemonTasks: tasks }),

    usage: { today: 0, month: 0, budget: 50 },
    setUsage: (usage) => set({ usage })
}))
