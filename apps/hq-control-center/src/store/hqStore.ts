import { create } from 'zustand'
import type { Job } from '~/server/jobs'
import type { RelayAgent, WorkerAgent } from '~/server/agents'
import type { DaemonTask } from '~/server/daemon'
import type { UsageResult } from '~/server/usage'

export interface VaultEvent {
  type: string
  path?: string
  timestamp?: string | number
  [key: string]: any
}

interface HQState {
  wsConnected: boolean
  setWsConnected: (v: boolean) => void

  jobs: Job[]
  setJobs: (jobs: Job[]) => void

  relays: RelayAgent[]
  setRelays: (relays: RelayAgent[]) => void

  workers: WorkerAgent[]
  setWorkers: (workers: WorkerAgent[]) => void

  daemonTasks: DaemonTask[]
  setDaemonTasks: (tasks: DaemonTask[]) => void

  usage: UsageResult
  setUsage: (usage: UsageResult) => void

  eventLog: VaultEvent[]
  addEvent: (event: VaultEvent) => void

  selectedJobId: string | null
  setSelectedJobId: (id: string | null) => void
}

export const useHQStore = create<HQState>((set) => ({
  wsConnected: false,
  setWsConnected: (wsConnected) => set({ wsConnected }),

  jobs: [],
  setJobs: (jobs) => set({ jobs }),

  relays: [],
  setRelays: (relays) => set({ relays }),

  workers: [],
  setWorkers: (workers) => set({ workers }),

  daemonTasks: [],
  setDaemonTasks: (daemonTasks) => set({ daemonTasks }),

  usage: { today: 0, month: 0, budget: 50, dailyTrend: [], byModel: [] },
  setUsage: (usage) => set({ usage }),

  eventLog: [],
  addEvent: (event) => set((state) => {
    const newLog = [event, ...state.eventLog].slice(0, 50)
    return { eventLog: newLog }
  }),

  selectedJobId: null,
  setSelectedJobId: (id) => set({ selectedJobId: id }),
}))
