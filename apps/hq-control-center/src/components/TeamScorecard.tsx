import React, { useState } from 'react'

interface RunRecord {
  runId: string
  teamName: string
  status: string
  startedAt: string
  durationMs: number
  stagesCompleted: number
  totalStages: number
  gateResults?: Record<string, string>
}

interface TeamScorecardProps {
  teamName: string
  runs: RunRecord[]
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  blocked: '#f59e0b',
  failed: '#ef4444',
  running: '#4488ff',
}

const GATE_COLORS: Record<string, string> = {
  PASS: '#22c55e',
  NEEDS_WORK: '#f59e0b',
  BLOCKED: '#ef4444',
}

export function TeamScorecard({ teamName, runs }: TeamScorecardProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  const sorted = [...runs].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1)).slice(0, 20)

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
    >
      <div
        className="px-4 py-3 border-b text-[10px] font-mono uppercase tracking-widest font-bold"
        style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
      >
        {teamName} — Run History
      </div>

      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
          No runs recorded yet for this team.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Date', 'Status', 'Duration', 'Stages', 'Gates'].map(h => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-[10px] uppercase tracking-widest"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(run => {
                const isExpanded = expandedRunId === run.runId
                const durationStr = run.durationMs
                  ? run.durationMs < 60000 ? `${Math.round(run.durationMs / 1000)}s` : `${Math.round(run.durationMs / 60000)}m`
                  : '—'
                const gateCount = run.gateResults ? Object.keys(run.gateResults).length : 0
                const gatePasses = run.gateResults
                  ? Object.values(run.gateResults).filter(v => v === 'PASS').length
                  : 0

                return (
                  <React.Fragment key={run.runId}>
                    <tr
                      onClick={() => setExpandedRunId(isExpanded ? null : run.runId)}
                      className="cursor-pointer transition-colors hover:bg-white/[0.02]"
                      style={{
                        borderBottom: '1px solid var(--border)',
                        background: isExpanded ? 'rgba(255,255,255,0.03)' : 'transparent',
                      }}
                    >
                      <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>
                        {run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="px-2 py-0.5 rounded text-[10px] font-bold"
                          style={{
                            background: (STATUS_COLORS[run.status] ?? '#6b7280') + '22',
                            color: STATUS_COLORS[run.status] ?? '#6b7280',
                          }}
                        >
                          {run.status}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>{durationStr}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-primary)' }}>
                        {run.stagesCompleted}/{run.totalStages}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--text-dim)' }}>
                        {gateCount > 0 ? `${gatePasses}/${gateCount}` : '—'}
                      </td>
                    </tr>

                    {isExpanded && run.gateResults && Object.keys(run.gateResults).length > 0 && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'rgba(0,0,0,0.15)' }}>
                        <td colSpan={5} className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <span className="text-[10px] font-mono uppercase tracking-widest mr-2" style={{ color: 'var(--text-dim)' }}>
                              Gates:
                            </span>
                            {Object.entries(run.gateResults).map(([gateId, outcome]) => (
                              <span
                                key={gateId}
                                className="text-[10px] font-mono px-2 py-0.5 rounded font-bold"
                                style={{
                                  background: (GATE_COLORS[outcome] ?? '#6b7280') + '22',
                                  color: GATE_COLORS[outcome] ?? '#6b7280',
                                }}
                              >
                                {gateId}: {outcome}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
