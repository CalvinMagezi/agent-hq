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
  { key: 'browse', label: 'Agent Library', icon: '🤖' },
  { key: 'builder', label: 'Team Builder', icon: '🏗️' },
  { key: 'monitor', label: 'Run Monitor', icon: '📡' },
  { key: 'performance', label: 'Performance', icon: '📊' },
]

function TeamsView() {
  const { agents, teams, leaderboard, workflows, pendingOptimizations } = Route.useLoaderData()
  const [activeTab, setActiveTab] = useState<MainTab>('browse')
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [selectedTeamForScore, setSelectedTeamForScore] = useState<string | undefined>(
    teams[0]?.name
  )
  const [launchFeedback, setLaunchFeedback] = useState<string | null>(null)
  const [browseFilter, setBrowseFilter] = useState('all')

  const verticals = ['all', 'engineering', 'qa', 'research', 'content', 'ops']

  const filteredAgents = browseFilter === 'all'
    ? agents
    : agents.filter((a: AgentSummary) => a.vertical === browseFilter)

  const handleLaunchTeam = useCallback(async (teamOrName: any, instruction: string) => {
    const teamName = typeof teamOrName === 'string' ? teamOrName : teamOrName.name
    setLaunchFeedback('Launching workflow…')
    try {
      const result = await launchTeamWorkflow({ data: { teamName, instruction } })
      setLaunchFeedback(`✅ Workflow queued: ${result.workflowId}`)
      setActiveTab('monitor')
    } catch (e: any) {
      setLaunchFeedback(`❌ Failed: ${e.message}`)
    }
    setTimeout(() => setLaunchFeedback(null), 5000)
  }, [])

  const handleSaveTeam = useCallback(async (team: any) => {
    await saveCustomTeam({ data: team })
    setLaunchFeedback(`✅ Team '${team.name}' saved`)
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
    <div className="teams-page">
      {/* Header */}
      <div className="teams-page__header">
        <h1 className="teams-page__title">Vertical Agent Teams</h1>
        <p className="teams-page__subtitle">Build, run and optimize specialized agent pipelines</p>
        {launchFeedback && (
          <div className="teams-page__feedback">{launchFeedback}</div>
        )}
      </div>

      {/* Tab Bar */}
      <div className="teams-page__tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            className={`teams-page__tab ${activeTab === tab.key ? 'teams-page__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className="teams-page__tab-icon">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="teams-page__content">

        {/* ── Browse ── */}
        {activeTab === 'browse' && (
          <div className="teams-browse">
            {/* Vertical filter */}
            <div className="teams-browse__filter">
              {verticals.map(v => (
                <button
                  key={v}
                  className={`teams-browse__filter-btn ${browseFilter === v ? 'active' : ''}`}
                  onClick={() => setBrowseFilter(v)}
                >
                  {v}
                </button>
              ))}
            </div>

            {/* Agent grid */}
            <div className="teams-browse__grid">
              {filteredAgents.map((agent: AgentSummary) => (
                <AgentCard key={agent.name} agent={agent} />
              ))}
            </div>

            {/* Team quick-launch cards */}
            <h2 className="teams-browse__section-title">Built-in Teams</h2>
            <div className="teams-browse__team-grid">
              {teams.map((team: TeamSummaryItem) => (
                <div key={team.name} className="team-card">
                  <div className="team-card__header">
                    <span className="team-card__name">{team.displayName}</span>
                    {team.isCustom && <span className="team-card__custom-badge">Custom</span>}
                  </div>
                  <p className="team-card__desc">{team.description.substring(0, 120)}</p>
                  <div className="team-card__meta">
                    <span>⏱ ~{team.estimatedDurationMins}m</span>
                    <span>📋 {team.stageCount} stages</span>
                    <span>🤖 {team.agents.length} agents</span>
                  </div>
                  <div className="team-card__tags">
                    {team.tags.map(tag => (
                      <span key={tag} className="team-card__tag">#{tag}</span>
                    ))}
                  </div>
                  <button
                    className="team-card__launch-btn"
                    onClick={() => {
                      const instruction = prompt(`Task for ${team.displayName}:`)
                      if (instruction) handleLaunchTeam(team.name, instruction)
                    }}
                  >
                    Launch Team ↗
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Builder ── */}
        {activeTab === 'builder' && (
          <TeamBuilder
            agents={agents}
            onSave={handleSaveTeam}
            onLaunch={handleLaunchTeam}
          />
        )}

        {/* ── Monitor ── */}
        {activeTab === 'monitor' && (
          <TeamRunMonitor
            workflows={workflows}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
          />
        )}

        {/* ── Performance ── */}
        {activeTab === 'performance' && (
          <div className="teams-perf">
            <TeamPerformancePanel
              teamNames={teams.map((t: TeamSummaryItem) => t.name)}
              getPerformance={fetchTeamPerf}
              leaderboard={leaderboard}
              pendingOptimizations={pendingOptimizations}
              onApproveOptimization={handleApproveOpt}
            />

            <div className="teams-perf__scorecard">
              <div className="teams-perf__scorecard-select">
                {teams.map((t: TeamSummaryItem) => (
                  <button
                    key={t.name}
                    className={`teams-perf__team-btn ${selectedTeamForScore === t.name ? 'active' : ''}`}
                    onClick={() => setSelectedTeamForScore(t.name)}
                  >
                    {t.displayName}
                  </button>
                ))}
              </div>
              {selectedTeamForScore && (
                <TeamScorecard
                  teamName={selectedTeamForScore}
                  runs={scorecardRuns}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
