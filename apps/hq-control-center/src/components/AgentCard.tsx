import React, { useState } from 'react'
import type { AgentSummary } from '../server/teams'

interface AgentCardProps {
  agent: AgentSummary
  onDragStart?: (agentName: string) => void
  compact?: boolean
}

const VERTICAL_COLORS: Record<string, string> = {
  engineering: '#3b82f6',
  qa: '#f59e0b',
  research: '#8b5cf6',
  content: '#06b6d4',
  ops: '#ef4444',
}

const HARNESS_ICONS: Record<string, string> = {
  'claude-code': '🤖',
  opencode: '⚡',
  'gemini-cli': '♊',
  any: '🔀',
}

export function AgentCard({ agent, onDragStart, compact = false }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const color = VERTICAL_COLORS[agent.vertical] ?? '#6b7280'
  const harnessIcon = HARNESS_ICONS[agent.preferredHarness] ?? '🤖'
  const successRate = agent.performanceProfile?.targetSuccessRate

  return (
    <div
      draggable={!!onDragStart}
      onDragStart={() => onDragStart?.(agent.name)}
      onClick={() => !compact && setExpanded(e => !e)}
      style={{ borderLeft: `4px solid ${color}` }}
      className={`agent-card ${compact ? 'agent-card--compact' : ''} ${expanded ? 'agent-card--expanded' : ''}`}
      title={agent.name}
    >
      <div className="agent-card__header">
        <div className="agent-card__title">
          <span className="agent-card__harness-icon">{harnessIcon}</span>
          <span className="agent-card__name">{agent.displayName}</span>
        </div>
        <div className="agent-card__badges">
          {agent.defaultsTo && (
            <span className={`agent-card__verdict-badge agent-card__verdict-badge--${agent.defaultsTo.toLowerCase().replace('_', '-')}`}>
              {agent.defaultsTo}
            </span>
          )}
          {successRate !== undefined && (
            <span
              className="agent-card__success-rate"
              style={{
                color: successRate >= 0.85 ? '#22c55e' : successRate >= 0.7 ? '#f59e0b' : '#ef4444',
              }}
            >
              {Math.round(successRate * 100)}%
            </span>
          )}
        </div>
      </div>

      {!compact && (
        <div className="agent-card__meta">
          <span
            className="agent-card__vertical"
            style={{ backgroundColor: color + '22', color }}
          >
            {agent.vertical}
          </span>
          <span className="agent-card__role">{agent.baseRole}</span>
        </div>
      )}

      {!compact && expanded && (
        <div className="agent-card__tags">
          {agent.tags.slice(0, 5).map(tag => (
            <span key={tag} className="agent-card__tag">#{tag}</span>
          ))}
        </div>
      )}
    </div>
  )
}
