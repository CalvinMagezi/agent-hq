import React, { useState } from 'react'
import type { TeamPerformanceData } from '../server/teams'

interface TeamPerformancePanelProps {
  teamNames: string[]
  getPerformance: (teamName: string) => Promise<TeamPerformanceData | null>
  leaderboard: Array<{ agentName: string; successScore: number; totalRuns: number }>
  pendingOptimizations: any[]
  onApproveOptimization: (file: string, approved: boolean) => void
}

type PanelTab = 'metrics' | 'leaderboard' | 'gates' | 'optimizations'

export function TeamPerformancePanel({
  teamNames,
  getPerformance,
  leaderboard,
  pendingOptimizations,
  onApproveOptimization,
}: TeamPerformancePanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('metrics')
  const [selectedTeam, setSelectedTeam] = useState<string>(teamNames[0] ?? '')
  const [teamPerf, setTeamPerf] = useState<TeamPerformanceData | null>(null)
  const [loading, setLoading] = useState(false)

  const loadPerformance = async (team: string) => {
    setSelectedTeam(team)
    setLoading(true)
    const data = await getPerformance(team)
    setTeamPerf(data)
    setLoading(false)
  }

  const tabs: { key: PanelTab; label: string }[] = [
    { key: 'metrics', label: 'Team Metrics' },
    { key: 'leaderboard', label: 'Agent Leaderboard' },
    { key: 'gates', label: 'Gate Analysis' },
    { key: 'optimizations', label: `Optimizations${pendingOptimizations.length > 0 ? ` (${pendingOptimizations.length})` : ''}` },
  ]

  return (
    <div className="perf-panel">
      <div className="perf-panel__tabs">
        {tabs.map(tab => (
          <button
            key={tab.key}
            className={`perf-panel__tab ${activeTab === tab.key ? 'perf-panel__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'metrics' && (
        <div className="perf-panel__metrics">
          <div className="perf-panel__team-select">
            {teamNames.map(name => (
              <button
                key={name}
                className={`perf-panel__team-btn ${selectedTeam === name ? 'active' : ''}`}
                onClick={() => loadPerformance(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {loading && <div className="perf-panel__loading">Loading…</div>}

          {!loading && teamPerf && (
            <div className="perf-panel__stats">
              <div className="perf-panel__stat">
                <div className="perf-panel__stat-value">{teamPerf.totalRuns}</div>
                <div className="perf-panel__stat-label">Total Runs</div>
              </div>
              <div className="perf-panel__stat">
                <div
                  className="perf-panel__stat-value"
                  style={{ color: teamPerf.successRate >= 0.8 ? '#22c55e' : '#f59e0b' }}
                >
                  {Math.round(teamPerf.successRate * 100)}%
                </div>
                <div className="perf-panel__stat-label">Success Rate</div>
              </div>
              <div className="perf-panel__stat">
                <div className="perf-panel__stat-value">
                  {Math.round(teamPerf.avgDurationMs / 60000)}m
                </div>
                <div className="perf-panel__stat-label">Avg Duration</div>
              </div>
            </div>
          )}

          {!loading && !teamPerf && selectedTeam && (
            <div className="perf-panel__empty">No data yet for {selectedTeam}.</div>
          )}
        </div>
      )}

      {activeTab === 'leaderboard' && (
        <div className="perf-panel__leaderboard">
          <table className="perf-panel__table">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>Success Score</th>
                <th>Total Runs</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((agent, i) => (
                <tr key={agent.agentName}>
                  <td>{i + 1}</td>
                  <td className="perf-panel__agent-name">{agent.agentName}</td>
                  <td>
                    <span
                      className="perf-panel__score-badge"
                      style={{
                        backgroundColor:
                          agent.successScore >= 0.85 ? '#22c55e22' :
                          agent.successScore >= 0.7 ? '#f59e0b22' : '#ef444422',
                        color:
                          agent.successScore >= 0.85 ? '#22c55e' :
                          agent.successScore >= 0.7 ? '#d97706' : '#ef4444',
                      }}
                    >
                      {Math.round(agent.successScore * 100)}%
                    </span>
                  </td>
                  <td>{agent.totalRuns}</td>
                </tr>
              ))}
              {leaderboard.length === 0 && (
                <tr><td colSpan={4} className="perf-panel__empty">No agent data yet. Run a team workflow to populate data.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'gates' && (
        <div className="perf-panel__gates">
          <p className="perf-panel__description">
            Gate analysis requires team run history. After 3+ runs, gate failure rates will appear here.
          </p>
          <div className="perf-panel__empty">Run more workflows to gather gate data.</div>
        </div>
      )}

      {activeTab === 'optimizations' && (
        <div className="perf-panel__optimizations">
          {pendingOptimizations.length === 0 && (
            <div className="perf-panel__empty">
              No pending optimizations. The optimizer runs weekly after 5+ team runs.
            </div>
          )}
          {pendingOptimizations.map(opt => (
            <div key={opt._file} className="perf-panel__opt-card">
              <h4>{opt.teamName}</h4>

              {opt.agentSubstitutions?.length > 0 && (
                <div className="perf-panel__opt-section">
                  <strong>Agent Substitutions</strong>
                  {opt.agentSubstitutions.map((sub: any, i: number) => (
                    <div key={i} className="perf-panel__opt-item">
                      {sub.currentAgent} → {sub.recommendedAgent}
                      <span className="perf-panel__opt-reason">{sub.reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {opt.gateAdjustments?.length > 0 && (
                <div className="perf-panel__opt-section">
                  <strong>Gate Adjustments</strong>
                  {opt.gateAdjustments.map((adj: any, i: number) => (
                    <div key={i} className="perf-panel__opt-item">
                      {adj.gateId}: maxRetries {adj.currentMaxRetries} → {adj.recommendedMaxRetries}
                    </div>
                  ))}
                </div>
              )}

              <div className="perf-panel__opt-actions">
                <button
                  className="perf-panel__approve-btn"
                  onClick={() => onApproveOptimization(opt._file, true)}
                >
                  ✓ Approve
                </button>
                <button
                  className="perf-panel__reject-btn"
                  onClick={() => onApproveOptimization(opt._file, false)}
                >
                  ✗ Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
