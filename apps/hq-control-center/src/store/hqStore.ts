import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

  chatPanelOpen: boolean
  setChatPanelOpen: (v: boolean) => void
  chatContext: { type: 'file' | 'selection'; path: string; content?: string } | null
  setChatContext: (ctx: { type: 'file' | 'selection'; path: string; content?: string } | null) => void
}

export const useHQStore = create<HQState>()(
  persist(
    (set) => ({
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

      chatPanelOpen: false,
      setChatPanelOpen: (v) => set({ chatPanelOpen: v }),
      chatContext: null,
      setChatContext: (ctx) => set({ chatContext: ctx }),
    }), {
    name: 'hq-store',
    partialize: (state) => ({ chatPanelOpen: state.chatPanelOpen }),
  }))
