import React, { useState, useCallback } from 'react'
import type { AgentSummary, TeamSummaryItem } from '../server/teams'
import { AgentCard } from './AgentCard'

interface Stage {
  stageId: string
  pattern: 'sequential' | 'parallel' | 'gated'
  agents: string[]
  description: string
}

interface TeamBuilderProps {
  agents: AgentSummary[]
  onSave: (team: any) => void
  onLaunch: (team: any, instruction: string) => void
}

export function TeamBuilder({ agents, onSave, onLaunch }: TeamBuilderProps) {
  const [teamName, setTeamName] = useState('')
  const [teamDisplayName, setTeamDisplayName] = useState('')
  const [stages, setStages] = useState<Stage[]>([
    { stageId: 'stage-1', pattern: 'sequential', agents: [], description: 'Stage 1' },
  ])
  const [filterVertical, setFilterVertical] = useState<string>('all')
  const [draggingAgent, setDraggingAgent] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [showLaunch, setShowLaunch] = useState(false)

  const verticals = ['all', 'engineering', 'qa', 'research', 'content', 'ops']

  const filteredAgents = filterVertical === 'all'
    ? agents
    : agents.filter(a => a.vertical === filterVertical)

  const addStage = () => {
    setStages(prev => [...prev, {
      stageId: `stage-${prev.length + 1}`,
      pattern: 'sequential',
      agents: [],
      description: `Stage ${prev.length + 1}`,
    }])
  }

  const dropAgentOnStage = useCallback((stageId: string) => {
    if (!draggingAgent) return
    setStages(prev =>
      prev.map(s =>
        s.stageId === stageId && !s.agents.includes(draggingAgent)
          ? { ...s, agents: [...s.agents, draggingAgent] }
          : s
      )
    )
    setDraggingAgent(null)
  }, [draggingAgent])

  const removeAgentFromStage = (stageId: string, agentName: string) => {
    setStages(prev =>
      prev.map(s =>
        s.stageId === stageId
          ? { ...s, agents: s.agents.filter(a => a !== agentName) }
          : s
      )
    )
  }

  const updateStagePattern = (stageId: string, pattern: Stage['pattern']) => {
    setStages(prev => prev.map(s => s.stageId === stageId ? { ...s, pattern } : s))
  }

  const buildManifest = () => ({
    name: teamName,
    displayName: teamDisplayName || teamName,
    version: '1.0.0',
    description: `Custom team: ${teamDisplayName || teamName}`,
    estimatedDurationMins: stages.length * 15,
    tags: ['custom'],
    stages: stages.filter(s => s.agents.length > 0).map(s => ({
      stageId: s.stageId,
      description: s.description,
      pattern: s.pattern,
      agents: s.agents,
      taskIds: s.agents.map(a => `${s.stageId}-${a}`),
    })),
  })

  return (
    <div className="team-builder">
      <div className="team-builder__sidebar">
        <h3>Agent Library</h3>
        <div className="team-builder__filter">
          {verticals.map(v => (
            <button
              key={v}
              className={`team-builder__filter-btn ${filterVertical === v ? 'active' : ''}`}
              onClick={() => setFilterVertical(v)}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="team-builder__agent-list">
          {filteredAgents.map(agent => (
            <AgentCard
              key={agent.name}
              agent={agent}
              compact
              onDragStart={setDraggingAgent}
            />
          ))}
        </div>
      </div>

      <div className="team-builder__canvas">
        <div className="team-builder__team-meta">
          <input
            className="team-builder__input"
            placeholder="Team ID (kebab-case)"
            value={teamName}
            onChange={e => setTeamName(e.target.value)}
          />
          <input
            className="team-builder__input"
            placeholder="Display Name"
            value={teamDisplayName}
            onChange={e => setTeamDisplayName(e.target.value)}
          />
        </div>

        <div className="team-builder__stages">
          {stages.map(stage => (
            <div
              key={stage.stageId}
              className="team-builder__stage"
              onDragOver={e => e.preventDefault()}
              onDrop={() => dropAgentOnStage(stage.stageId)}
            >
              <div className="team-builder__stage-header">
                <input
                  className="team-builder__stage-name"
                  value={stage.description}
                  onChange={e => setStages(prev =>
                    prev.map(s => s.stageId === stage.stageId ? { ...s, description: e.target.value } : s)
                  )}
                />
                <select
                  value={stage.pattern}
                  onChange={e => updateStagePattern(stage.stageId, e.target.value as Stage['pattern'])}
                  className="team-builder__pattern-select"
                >
                  <option value="sequential">Sequential</option>
                  <option value="parallel">Parallel</option>
                  <option value="gated">Gated</option>
                </select>
              </div>
              <div className="team-builder__stage-agents">
                {stage.agents.length === 0 && (
                  <div className="team-builder__drop-hint">Drop agents here</div>
                )}
                {stage.agents.map(agentName => {
                  const a = agents.find(x => x.name === agentName)
                  return (
                    <div key={agentName} className="team-builder__stage-agent">
                      <span>{a?.displayName ?? agentName}</span>
                      <button
                        className="team-builder__remove-btn"
                        onClick={() => removeAgentFromStage(stage.stageId, agentName)}
                      >×</button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          <button className="team-builder__add-stage" onClick={addStage}>+ Add Stage</button>
        </div>
      </div>

      <div className="team-builder__preview">
        <h3>Team Manifest</h3>
        <pre className="team-builder__yaml">
          {JSON.stringify(buildManifest(), null, 2)}
        </pre>
        <div className="team-builder__actions">
          <button
            className="team-builder__save-btn"
            onClick={() => onSave(buildManifest())}
            disabled={!teamName || stages.every(s => s.agents.length === 0)}
          >
            Save Team
          </button>
          <button
            className="team-builder__launch-btn"
            onClick={() => setShowLaunch(true)}
            disabled={!teamName}
          >
            Launch
          </button>
        </div>

        {showLaunch && (
          <div className="team-builder__launch-modal">
            <textarea
              className="team-builder__instruction"
              placeholder="Enter the task instruction for the team..."
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              rows={4}
            />
            <div className="team-builder__launch-actions">
              <button
                className="team-builder__launch-confirm"
                onClick={() => { onLaunch(buildManifest(), instruction); setShowLaunch(false) }}
                disabled={!instruction.trim()}
              >
                Launch Workflow
              </button>
              <button onClick={() => setShowLaunch(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
