import React, { useState } from 'react'
import type { TeamPerformanceData } from '../server/teams'

interface TeamPerformancePanelProps {
  teamNames: string[]
  getPerformance: (teamName: string) => Promise<TeamPerformanceData | null>
  leaderboard: Array<{ agentName: string; successScore: number; totalRuns: number }>
  pendingOptimizations: any[]
  onApproveOptimization: (file: string, approved: boolean) => void
}

type PanelTab = 'metrics' | 'leaderboard' | 'optimizations'

function StatCard({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center p-4 rounded-xl"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
    >
      <div className="text-2xl font-mono font-bold" style={{ color: color ?? 'var(--text-primary)' }}>
        {value}
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest mt-1" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-xs font-mono font-bold rounded-lg transition-colors"
      style={{
        background: active ? 'rgba(0,255,136,0.12)' : 'transparent',
        color: active ? 'var(--accent-green)' : 'var(--text-dim)',
        border: active ? '1px solid rgba(0,255,136,0.25)' : '1px solid transparent',
        minHeight: 36,
      }}
    >
      {children}
    </button>
  )
}

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

  return (
    <div className="flex flex-col gap-4">
      {/* Tab bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <TabBtn active={activeTab === 'metrics'} onClick={() => setActiveTab('metrics')}>📊 Metrics</TabBtn>
        <TabBtn active={activeTab === 'leaderboard'} onClick={() => setActiveTab('leaderboard')}>🏆 Leaderboard</TabBtn>
        <TabBtn active={activeTab === 'optimizations'} onClick={() => setActiveTab('optimizations')}>
          ⚡ Optimizations{pendingOptimizations.length > 0 ? ` (${pendingOptimizations.length})` : ''}
        </TabBtn>
      </div>

      {/* Metrics tab */}
      {activeTab === 'metrics' && (
        <div className="flex flex-col gap-4">
          {/* Team selector */}
          <div className="flex flex-wrap gap-2">
            {teamNames.map(name => (
              <button
                key={name}
                onClick={() => loadPerformance(name)}
                className="px-3 py-1.5 text-xs font-mono rounded-lg transition-colors"
                style={{
                  background: selectedTeam === name ? 'rgba(68,136,255,0.15)' : 'var(--bg-elevated)',
                  color: selectedTeam === name ? 'var(--accent-blue)' : 'var(--text-dim)',
                  border: `1px solid ${selectedTeam === name ? 'rgba(68,136,255,0.3)' : 'var(--border)'}`,
                  minHeight: 36,
                }}
              >
                {name}
              </button>
            ))}
          </div>

          {loading && (
            <div className="text-xs font-mono animate-pulse" style={{ color: 'var(--text-dim)' }}>Loading…</div>
          )}

          {!loading && teamPerf && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard value={String(teamPerf.totalRuns)} label="Total Runs" />
              <StatCard
                value={`${Math.round(teamPerf.successRate * 100)}%`}
                label="Success Rate"
                color={teamPerf.successRate >= 0.8 ? '#22c55e' : '#f59e0b'}
              />
              <StatCard value={`${Math.round(teamPerf.avgDurationMs / 60000)}m`} label="Avg Duration" />
            </div>
          )}

          {!loading && !teamPerf && selectedTeam && (
            <div className="text-xs font-mono py-6 text-center" style={{ color: 'var(--text-dim)' }}>
              No data yet for {selectedTeam}.<br />Run this team to start collecting metrics.
            </div>
          )}

          {!selectedTeam && (
            <div className="text-xs font-mono py-6 text-center" style={{ color: 'var(--text-dim)' }}>
              Select a team above to view metrics.
            </div>
          )}
        </div>
      )}

      {/* Leaderboard tab */}
      {activeTab === 'leaderboard' && (
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          {leaderboard.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
              No agent data yet. Run a team workflow to populate the leaderboard.
            </div>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['#', 'Agent', 'Success', 'Runs'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((agent, i) => (
                  <tr
                    key={agent.agentName}
                    className="transition-colors hover:bg-white/[0.02]"
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    <td className="px-4 py-3 font-bold" style={{ color: 'var(--text-dim)' }}>{i + 1}</td>
                    <td className="px-4 py-3 font-bold" style={{ color: 'var(--text-primary)' }}>{agent.agentName}</td>
                    <td className="px-4 py-3">
                      <span
                        className="px-2 py-0.5 rounded font-bold"
                        style={{
                          background: agent.successScore >= 0.85 ? '#22c55e22' : agent.successScore >= 0.7 ? '#f59e0b22' : '#ef444422',
                          color: agent.successScore >= 0.85 ? '#22c55e' : agent.successScore >= 0.7 ? '#f59e0b' : '#ef4444',
                        }}
                      >
                        {Math.round(agent.successScore * 100)}%
                      </span>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>{agent.totalRuns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Optimizations tab */}
      {activeTab === 'optimizations' && (
        <div className="flex flex-col gap-3">
          {pendingOptimizations.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs font-mono rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-dim)' }}>
              No pending optimizations.<br />The optimizer runs weekly after 5+ team runs.
            </div>
          ) : (
            pendingOptimizations.map(opt => (
              <div
                key={opt._file}
                className="rounded-xl p-4 flex flex-col gap-3"
                style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
              >
                <div className="text-xs font-mono font-bold" style={{ color: 'var(--text-primary)' }}>{opt.teamName}</div>

                {opt.agentSubstitutions?.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
                      Agent Substitutions
                    </div>
                    {opt.agentSubstitutions.map((sub: any, i: number) => (
                      <div key={i} className="text-xs font-mono px-3 py-2 rounded-lg" style={{ background: 'var(--bg-elevated)' }}>
                        <span style={{ color: 'var(--accent-amber)' }}>{sub.currentAgent}</span>
                        {' → '}
                        <span style={{ color: 'var(--accent-green)' }}>{sub.recommendedAgent}</span>
                        <span className="ml-2" style={{ color: 'var(--text-dim)' }}>{sub.reason}</span>
                      </div>
                    ))}
                  </div>
                )}

                {opt.gateAdjustments?.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text-dim)' }}>
                      Gate Adjustments
                    </div>
                    {opt.gateAdjustments.map((adj: any, i: number) => (
                      <div key={i} className="text-xs font-mono px-3 py-2 rounded-lg" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
                        {adj.gateId}: maxRetries {adj.currentMaxRetries} → {adj.recommendedMaxRetries}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => onApproveOptimization(opt._file, true)}
                    className="flex-1 py-2 rounded-lg text-xs font-mono font-bold transition-colors"
                    style={{ background: 'rgba(0,255,136,0.15)', color: 'var(--accent-green)', border: '1px solid rgba(0,255,136,0.25)', minHeight: 44 }}
                  >
                    ✓ Approve
                  </button>
                  <button
                    onClick={() => onApproveOptimization(opt._file, false)}
                    className="flex-1 py-2 rounded-lg text-xs font-mono font-bold transition-colors"
                    style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--accent-red)', border: '1px solid rgba(255,68,68,0.2)', minHeight: 44 }}
                  >
                    ✗ Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
