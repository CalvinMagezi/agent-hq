import React from 'react'

interface WorkflowRun {
  runId: string
  teamName: string
  status: string
  startedAt: string
  completedAt: string
  durationMs: number
  stagesCompleted: number
  totalStages: number
  gateResults?: Record<string, string>
}

interface TeamRunMonitorProps {
  workflows: WorkflowRun[]
  selectedRunId?: string
  onSelectRun?: (runId: string) => void
}

const STATUS_ICONS: Record<string, string> = {
  completed: '✅',
  blocked: '🚫',
  failed: '❌',
  running: '⏳',
}

const GATE_ICONS: Record<string, string> = {
  PASS: '✅',
  NEEDS_WORK: '🔄',
  BLOCKED: '🚫',
}

export function TeamRunMonitor({ workflows, selectedRunId, onSelectRun }: TeamRunMonitorProps) {
  const selected = workflows.find(w => w.runId === selectedRunId)

  return (
    <div className="run-monitor">
      <div className="run-monitor__list">
        <h3>Recent Runs</h3>
        {workflows.length === 0 && (
          <p className="run-monitor__empty">No workflow runs yet. Launch a team to get started.</p>
        )}
        {workflows.map(run => {
          const duration = run.durationMs
            ? (run.durationMs < 60000 ? `${Math.round(run.durationMs / 1000)}s` : `${Math.round(run.durationMs / 60000)}m`)
            : '—'
          return (
            <div
              key={run.runId}
              className={`run-monitor__run-item ${selectedRunId === run.runId ? 'run-monitor__run-item--selected' : ''}`}
              onClick={() => onSelectRun?.(run.runId)}
            >
              <div className="run-monitor__run-header">
                <span className="run-monitor__run-status">{STATUS_ICONS[run.status] ?? '⏳'}</span>
                <span className="run-monitor__run-team">{run.teamName}</span>
                <span className="run-monitor__run-duration">{duration}</span>
              </div>
              <div className="run-monitor__run-meta">
                <span>{run.stagesCompleted}/{run.totalStages} stages</span>
                <span>{run.startedAt ? new Date(run.startedAt).toLocaleString() : ''}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="run-monitor__detail">
        {!selected && (
          <div className="run-monitor__empty-detail">Select a run to view details</div>
        )}
        {selected && (
          <>
            <h3>{selected.teamName} — {selected.runId}</h3>
            <div className="run-monitor__status-row">
              <span>{STATUS_ICONS[selected.status] ?? '⏳'} {selected.status}</span>
              <span>
                {selected.durationMs
                  ? `${Math.round(selected.durationMs / 1000)}s`
                  : 'Running...'}
              </span>
            </div>

            {/* Stage progress bar */}
            <div className="run-monitor__stages">
              {Array.from({ length: selected.totalStages }).map((_, i) => (
                <div
                  key={i}
                  className={`run-monitor__stage-block ${i < selected.stagesCompleted ? 'run-monitor__stage-block--done' : ''}`}
                  title={`Stage ${i + 1}`}
                />
              ))}
            </div>

            {/* Gate results */}
            {selected.gateResults && Object.keys(selected.gateResults).length > 0 && (
              <div className="run-monitor__gates">
                <h4>Gate Results</h4>
                {Object.entries(selected.gateResults).map(([gateId, outcome]) => (
                  <div key={gateId} className="run-monitor__gate">
                    <span className="run-monitor__gate-icon">{GATE_ICONS[outcome] ?? '❓'}</span>
                    <span className="run-monitor__gate-id">{gateId}</span>
                    <span className="run-monitor__gate-outcome">{outcome}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
