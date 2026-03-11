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
}

export function TeamScorecard({ teamName, runs }: TeamScorecardProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  const sorted = [...runs].sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1)).slice(0, 20)

  return (
    <div className="scorecard">
      <h3 className="scorecard__title">{teamName} — Run History</h3>

      {sorted.length === 0 && (
        <div className="scorecard__empty">No runs recorded yet for this team.</div>
      )}

      <table className="scorecard__table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Stages</th>
            <th>Gates</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(run => {
            const isExpanded = expandedRunId === run.runId
            const durationStr = run.durationMs
              ? `${Math.round(run.durationMs / 1000)}s`
              : '—'
            const gateCount = run.gateResults ? Object.keys(run.gateResults).length : 0
            const gatePasses = run.gateResults
              ? Object.values(run.gateResults).filter(v => v === 'PASS').length
              : 0

            return (
              <>
                <tr
                  key={run.runId}
                  className={`scorecard__row ${isExpanded ? 'scorecard__row--expanded' : ''}`}
                  onClick={() => setExpandedRunId(isExpanded ? null : run.runId)}
                >
                  <td>{run.startedAt ? new Date(run.startedAt).toLocaleString() : '—'}</td>
                  <td>
                    <span
                      className="scorecard__status-badge"
                      style={{ color: STATUS_COLORS[run.status] ?? '#6b7280' }}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td>{durationStr}</td>
                  <td>{run.stagesCompleted}/{run.totalStages}</td>
                  <td>{gateCount > 0 ? `${gatePasses}/${gateCount} PASS` : '—'}</td>
                </tr>

                {isExpanded && run.gateResults && Object.keys(run.gateResults).length > 0 && (
                  <tr key={`${run.runId}-detail`} className="scorecard__detail-row">
                    <td colSpan={5}>
                      <div className="scorecard__gate-detail">
                        <strong>Gate Results:</strong>
                        {Object.entries(run.gateResults).map(([gateId, outcome]) => (
                          <span
                            key={gateId}
                            className="scorecard__gate-chip"
                            style={{
                              color: outcome === 'PASS' ? '#22c55e' : outcome === 'BLOCKED' ? '#ef4444' : '#f59e0b',
                            }}
                          >
                            {gateId}: {outcome}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
