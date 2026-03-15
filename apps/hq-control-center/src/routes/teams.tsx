import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback } from 'react'
import {
  getAgentLibrary,
  getTeamList,
  getTeamPerformance,
  getAgentLeaderboard,
  getActiveWorkflows,
  getPendingOptimizations,
  applyOptimization,
  saveCustomTeam,
  launchTeamWorkflow,
} from '~/server/teams'
import { AgentCard } from '~/components/AgentCard'
import { TeamBuilder } from '~/components/TeamBuilder'
import { TeamRunMonitor } from '~/components/TeamRunMonitor'
import { TeamPerformancePanel } from '~/components/TeamPerformancePanel'
import { TeamScorecard } from '~/components/TeamScorecard'
import type { AgentSummary, TeamSummaryItem } from '~/server/teams'

export const Route = createFileRoute('/teams')({
  loader: async () => {
    const [agentsResult, teamsResult, leaderboardResult, workflowsResult, optsResult] = await Promise.all([
      getAgentLibrary(),
      getTeamList(),
      getAgentLeaderboard(),
      getActiveWorkflows(),
      getPendingOptimizations(),
    ])
    return {
      agents: agentsResult.agents,
      teams: teamsResult.teams,
      leaderboard: leaderboardResult.leaderboard,
      workflows: workflowsResult.workflows,
      pendingOptimizations: optsResult.optimizations,
    }
  },
  component: TeamsView,
})

type MainTab = 'browse' | 'builder' | 'monitor' | 'performance'

const TABS: { key: MainTab; label: string; icon: string }[] = [
  { key: 'browse', label: 'Browse', icon: '🤖' },
  { key: 'builder', label: 'Builder', icon: '🏗' },
  { key: 'monitor', label: 'Monitor', icon: '📡' },
  { key: 'performance', label: 'Performance', icon: '📊' },
]

const VERTICAL_COLORS: Record<string, string> = {
  engineering: '#3b82f6',
  qa: '#f59e0b',
  research: '#8b5cf6',
  content: '#06b6d4',
  ops: '#ef4444',
}

// ── Launch modal ──────────────────────────────────────────────────────────────

function LaunchModal({ team, onLaunch, onClose }: {
  team: TeamSummaryItem
  onLaunch: (teamName: string, instruction: string) => void
  onClose: () => void
}) {
  const [instruction, setInstruction] = useState('')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--bg-surface)', border: '1px solid rgba(68,136,255,0.3)' }}
      >
        <div>
          <div className="text-sm font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
            Launch: {team.displayName}
          </div>
          <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--text-dim)' }}>
            {team.stageCount} stages · ~{team.estimatedDurationMins}m · {team.agents.length} agents
          </div>
        </div>

        <textarea
          autoFocus
          placeholder="Describe the task for this team to work on..."
          value={instruction}
          onChange={e => setInstruction(e.target.value)}
          rows={5}
          className="w-full resize-none outline-none text-xs font-mono p-3 rounded-xl"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
          }}
        />

        <div className="flex gap-2">
          <button
            onClick={() => { onLaunch(team.name, instruction); onClose() }}
            disabled={!instruction.trim()}
            className="flex-1 py-3 rounded-xl text-xs font-mono font-bold transition-colors"
            style={{
              background: instruction.trim() ? 'rgba(68,136,255,0.15)' : 'var(--bg-elevated)',
              color: instruction.trim() ? 'var(--accent-blue)' : 'var(--text-dim)',
              border: `1px solid ${instruction.trim() ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
              cursor: instruction.trim() ? 'pointer' : 'not-allowed',
              minHeight: 44,
            }}
          >
            Launch ↗
          </button>
          <button
            onClick={onClose}
            className="px-5 py-3 rounded-xl text-xs font-mono"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)', border: '1px solid var(--border)', minHeight: 44 }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Team card ─────────────────────────────────────────────────────────────────

function TeamCard({ team, onLaunch }: { team: TeamSummaryItem; onLaunch: (t: TeamSummaryItem) => void }) {
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3 transition-all"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono font-bold truncate" style={{ color: 'var(--text-primary)' }}>
              {team.displayName}
            </span>
            {team.isCustom && (
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wide flex-shrink-0"
                style={{ background: 'rgba(0,255,136,0.12)', color: 'var(--accent-green)', border: '1px solid rgba(0,255,136,0.2)' }}
              >
                Custom
              </span>
            )}
          </div>
          <p className="text-[10px] font-mono mt-1 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            {team.description.substring(0, 100)}{team.description.length > 100 ? '…' : ''}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
        <span>⏱ ~{team.estimatedDurationMins}m</span>
        <span>📋 {team.stageCount} stages</span>
        <span>🤖 {team.agents.length} agents</span>
      </div>

      {team.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {team.tags.map(tag => (
            <span
              key={tag}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-dim)' }}
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      <button
        onClick={() => onLaunch(team)}
        className="w-full py-2.5 rounded-lg text-xs font-mono font-bold transition-colors mt-auto"
        style={{
          background: 'rgba(68,136,255,0.1)',
          color: 'var(--accent-blue)',
          border: '1px solid rgba(68,136,255,0.25)',
          minHeight: 44,
        }}
      >
        Launch Team ↗
      </button>
    </div>
  )
}

// ── Main view ────────────────────────────────────────────────────────────────

function TeamsView() {
  const { agents, teams, leaderboard, workflows, pendingOptimizations } = Route.useLoaderData()
  const [activeTab, setActiveTab] = useState<MainTab>('browse')
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [selectedTeamForScore, setSelectedTeamForScore] = useState<string | undefined>(teams[0]?.name)
  const [launchFeedback, setLaunchFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [browseFilter, setBrowseFilter] = useState('all')
  const [launchingTeam, setLaunchingTeam] = useState<TeamSummaryItem | null>(null)

  const verticals = ['all', 'engineering', 'qa', 'research', 'content', 'ops']

  const filteredAgents = browseFilter === 'all'
    ? agents
    : agents.filter((a: AgentSummary) => a.vertical === browseFilter)

  const handleLaunchTeam = useCallback(async (teamOrName: any, instruction: string) => {
    const teamName = typeof teamOrName === 'string' ? teamOrName : teamOrName.name
    setLaunchFeedback({ type: 'ok', text: 'Launching workflow…' })
    try {
      const result = await launchTeamWorkflow({ data: { teamName, instruction } })
      setLaunchFeedback({ type: 'ok', text: `✅ Workflow queued: ${result.workflowId}` })
      setActiveTab('monitor')
    } catch (e: any) {
      setLaunchFeedback({ type: 'err', text: `❌ Failed: ${e.message}` })
    }
    setTimeout(() => setLaunchFeedback(null), 5000)
  }, [])

  const handleSaveTeam = useCallback(async (team: any) => {
    await saveCustomTeam({ data: team })
    setLaunchFeedback({ type: 'ok', text: `✅ Team '${team.name}' saved` })
    setTimeout(() => setLaunchFeedback(null), 3000)
  }, [])

  const handleApproveOpt = useCallback(async (file: string, approved: boolean) => {
    await applyOptimization({ data: { file, approved } })
  }, [])

  const fetchTeamPerf = useCallback(async (teamName: string) => {
    const result = await getTeamPerformance({ data: teamName })
    return result.performance
  }, [])

  const scorecardRuns = selectedTeamForScore
    ? workflows
        .filter((w: any) => w.teamName === selectedTeamForScore)
        .map((w: any) => ({
          runId: w.runId ?? w.retroFile ?? '',
          teamName: w.teamName,
          status: w.status ?? 'completed',
          startedAt: w.startedAt ?? '',
          durationMs: w.durationMs ?? 0,
          stagesCompleted: w.stagesCompleted ?? 0,
          totalStages: w.totalStages ?? 1,
          gateResults: w.gateResults,
        }))
    : []

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div
        className="flex-shrink-0 px-5 pt-4 pb-0 border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-sm font-mono font-bold tracking-wide" style={{ color: 'var(--text-primary)' }}>
              Vertical Agent Teams
            </h1>
            <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text-dim)' }}>
              {agents.length} agents · {teams.length} teams
            </p>
          </div>
          {launchFeedback && (
            <div
              className="px-3 py-1.5 rounded-lg text-xs font-mono"
              style={{
                background: launchFeedback.type === 'ok' ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,68,0.1)',
                color: launchFeedback.type === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)',
                border: `1px solid ${launchFeedback.type === 'ok' ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,68,0.2)'}`,
              }}
            >
              {launchFeedback.text}
            </div>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1">
          {TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-mono font-bold transition-colors rounded-t-lg"
              style={{
                color: activeTab === tab.key ? 'var(--accent-green)' : 'var(--text-dim)',
                borderBottom: activeTab === tab.key ? '2px solid var(--accent-green)' : '2px solid transparent',
                background: activeTab === tab.key ? 'rgba(0,255,136,0.06)' : 'transparent',
                minHeight: 40,
              }}
            >
              <span>{tab.icon}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 pb-20 md:pb-4">

        {/* ── Browse ── */}
        {activeTab === 'browse' && (
          <div className="flex flex-col gap-6">
            {/* Agent library */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>
                  Agent Library
                </div>
                <div className="flex flex-wrap gap-1">
                  {verticals.map(v => (
                    <button
                      key={v}
                      onClick={() => setBrowseFilter(v)}
                      className="px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-wide transition-colors"
                      style={{
                        background: browseFilter === v ? 'rgba(68,136,255,0.15)' : 'var(--bg-elevated)',
                        color: browseFilter === v ? 'var(--accent-blue)' : 'var(--text-dim)',
                        border: `1px solid ${browseFilter === v ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {filteredAgents.map((agent: AgentSummary) => (
                  <AgentCard key={agent.name} agent={agent} />
                ))}
                {filteredAgents.length === 0 && (
                  <div className="col-span-full py-8 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
                    No agents for this vertical yet.
                  </div>
                )}
              </div>
            </section>

            {/* Built-in teams */}
            <section>
              <div className="text-[10px] font-mono uppercase tracking-widest font-bold mb-3" style={{ color: 'var(--text-dim)' }}>
                Built-in Teams
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {teams.map((team: TeamSummaryItem) => (
                  <TeamCard key={team.name} team={team} onLaunch={setLaunchingTeam} />
                ))}
                {teams.length === 0 && (
                  <div className="col-span-full py-8 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
                    No teams found. Check that <code>packages/hq-tools/teams/</code> exists.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/* ── Builder ── */}
        {activeTab === 'builder' && (
          <div className="flex flex-col min-h-0" style={{ height: '100%' }}>
            <TeamBuilder
              agents={agents}
              onSave={handleSaveTeam}
              onLaunch={handleLaunchTeam}
            />
          </div>
        )}

        {/* ── Monitor ── */}
        {activeTab === 'monitor' && (
          <div className="flex flex-col min-h-0" style={{ height: '100%' }}>
            <TeamRunMonitor
              workflows={workflows}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
            />
          </div>
        )}

        {/* ── Performance ── */}
        {activeTab === 'performance' && (
          <div className="flex flex-col gap-6">
            <TeamPerformancePanel
              teamNames={teams.map((t: TeamSummaryItem) => t.name)}
              getPerformance={fetchTeamPerf}
              leaderboard={leaderboard}
              pendingOptimizations={pendingOptimizations}
              onApproveOptimization={handleApproveOpt}
            />

            {/* Scorecard selector */}
            <div className="flex flex-col gap-3">
              <div className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text-dim)' }}>
                Run History by Team
              </div>
              <div className="flex flex-wrap gap-2">
                {teams.map((t: TeamSummaryItem) => (
                  <button
                    key={t.name}
                    onClick={() => setSelectedTeamForScore(t.name)}
                    className="px-3 py-1.5 text-xs font-mono rounded-lg transition-colors"
                    style={{
                      background: selectedTeamForScore === t.name ? 'rgba(255,179,0,0.12)' : 'var(--bg-elevated)',
                      color: selectedTeamForScore === t.name ? 'var(--accent-amber)' : 'var(--text-dim)',
                      border: `1px solid ${selectedTeamForScore === t.name ? 'rgba(255,179,0,0.3)' : 'var(--border)'}`,
                      minHeight: 36,
                    }}
                  >
                    {t.displayName}
                  </button>
                ))}
              </div>
              {selectedTeamForScore && (
                <TeamScorecard teamName={selectedTeamForScore} runs={scorecardRuns} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Launch modal */}
      {launchingTeam && (
        <LaunchModal
          team={launchingTeam}
          onLaunch={handleLaunchTeam}
          onClose={() => setLaunchingTeam(null)}
        />
      )}
    </div>
  )
}
