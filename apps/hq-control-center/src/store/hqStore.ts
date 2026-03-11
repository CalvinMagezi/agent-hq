import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Job } from '~/server/jobs'
import type { RelayAgent, WorkerAgent } from '~/server/agents'
import type { DaemonTask } from '~/server/daemon'
import type { UsageResult } from '~/server/usage'
import type { PinnedNote } from '~/server/notes'
import type { AgentSummary, TeamSummaryItem } from '~/server/teams'

export interface WorkflowRunSummary {
  runId: string
  teamName: string
  status: 'running' | 'completed' | 'blocked' | 'failed'
  stagesCompleted: number
  totalStages: number
  startedAt: string
  completedAt?: string
}

export interface OptimizationRecommendation {
  teamName: string
  agentSubstitutions: Array<{ stage: string; currentAgent: string; recommendedAgent: string; reason: string; confidence: number }>
  gateAdjustments: Array<{ gateId: string; currentMaxRetries: number; recommendedMaxRetries: number; reason: string }>
  newAgentSuggestions: Array<{ vertical: string; gapIdentified: string; suggestedName: string }>
  createdAt?: string
}

export interface AgentLeaderboardEntry {
  agentName: string
  vertical: string
  successScore: number
  totalRuns: number
  avgTurns: number
}

export interface TeamsState {
  agents: AgentSummary[]
  teams: TeamSummaryItem[]
  activeWorkflows: WorkflowRunSummary[]
  pendingOptimizations: OptimizationRecommendation[]
  leaderboard: AgentLeaderboardEntry[]
}

export interface CustomTeamDraft {
  displayName: string
  description: string
  stages: Array<{
    stageId: string
    pattern: 'sequential' | 'parallel' | 'gated'
    agents: string[]
    gates?: Array<{ evaluatorAgent: string; maxRetries: number; blockOnFailure: boolean }>
  }>
  synthesisAgent?: string
}

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

  pinnedNotes: PinnedNote[]
  setPinnedNotes: (notes: PinnedNote[]) => void
  pinnedVersion: number
  bumpPinnedVersion: () => void

  // ── Teams / Agent Library ────────────────────────────────────────────────
  teamsData: TeamsState
  setTeamsData: (data: Partial<TeamsState>) => void
  selectedTeamName: string | null
  setSelectedTeamName: (name: string | null) => void
  teamBuilderDraft: CustomTeamDraft | null
  setTeamBuilderDraft: (draft: CustomTeamDraft | null) => void
  teamsVersion: number
  bumpTeamsVersion: () => void
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

      pinnedNotes: [],
      setPinnedNotes: (notes) => set({ pinnedNotes: notes }),
      pinnedVersion: 0,
      bumpPinnedVersion: () => set((s) => ({ pinnedVersion: s.pinnedVersion + 1 })),

      // ── Teams ──────────────────────────────────────────────────────────────
      teamsData: { agents: [], teams: [], activeWorkflows: [], pendingOptimizations: [], leaderboard: [] },
      setTeamsData: (data) => set((s) => ({ teamsData: { ...s.teamsData, ...data } })),
      selectedTeamName: null,
      setSelectedTeamName: (name) => set({ selectedTeamName: name }),
      teamBuilderDraft: null,
      setTeamBuilderDraft: (draft) => set({ teamBuilderDraft: draft }),
      teamsVersion: 0,
      bumpTeamsVersion: () => set((s) => ({ teamsVersion: s.teamsVersion + 1 })),
    }), {
    name: 'hq-store',
    partialize: (state) => ({ chatPanelOpen: state.chatPanelOpen, selectedTeamName: state.selectedTeamName }),
  }))
