import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback, useRef, useEffect } from 'react'
import { getPlans, getPlanDetail } from '~/server/plans'
import type { PlanSummary, PlanDetail, PlanStatus, PlanMode } from '~/server/plans'
import { MarkdownViewer } from '~/components/MarkdownViewer'

export const Route = createFileRoute('/plans')({
  loader: async () => {
    const result = await getPlans({ data: { includeArchived: false } })
    return result
  },
  component: PlansPage,
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function relTime(iso?: string): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

const STATUS_STYLES: Record<string, { bg: string; color: string; dot: string; label: string }> = {
  in_progress: { bg: 'rgba(0,255,136,0.1)',   color: 'var(--accent-green)',  dot: '#00ff88', label: 'In Progress' },
  delegated:   { bg: 'rgba(255,179,0,0.1)',   color: 'var(--accent-amber)',  dot: '#ffb300', label: 'Delegated'  },
  planning:    { bg: 'rgba(255,179,0,0.1)',   color: 'var(--accent-amber)',  dot: '#ffb300', label: 'Planning'   },
  completed:   { bg: 'rgba(59,130,246,0.1)',  color: 'var(--accent-blue)',   dot: '#3b82f6', label: 'Completed'  },
  failed:      { bg: 'rgba(239,68,68,0.1)',   color: '#f87171',              dot: '#f87171', label: 'Failed'     },
  abandoned:   { bg: 'rgba(100,100,100,0.1)', color: 'var(--text-dim)',      dot: '#666',    label: 'Abandoned'  },
}

const MODE_STYLES: Record<string, { icon: string; color: string }> = {
  act:       { icon: '⚡', color: 'var(--accent-green)' },
  sketch:    { icon: '✏️', color: 'var(--accent-amber)' },
  blueprint: { icon: '🗺', color: 'var(--accent-blue)'  },
}

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: 'all',         label: 'All'         },
  { key: 'in_progress', label: 'Active'      },
  { key: 'delegated',   label: 'Delegated'   },
  { key: 'completed',   label: 'Completed'   },
  { key: 'failed',      label: 'Failed'      },
  { key: 'abandoned',   label: 'Abandoned'   },
]

// ─── Plan Card ───────────────────────────────────────────────────────────────

function PlanCard({ plan, selected, onClick }: {
  plan: PlanSummary
  selected: boolean
  onClick: () => void
}) {
  const st = STATUS_STYLES[plan.status] ?? STATUS_STYLES.abandoned
  const md = MODE_STYLES[plan.planningMode] ?? MODE_STYLES.sketch

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl p-4 transition-all"
      style={{
        background: selected ? 'rgba(255,255,255,0.06)' : 'var(--bg-elevated)',
        border: `1px solid ${selected ? 'rgba(255,255,255,0.15)' : 'var(--border)'}`,
        outline: 'none',
      }}
    >
      {/* Top row: status badge + mode + time */}
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold flex-shrink-0"
          style={{ background: st.bg, color: st.color }}
        >
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: st.dot }} />
          {st.label}
        </span>
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: md.color }}>
          {md.icon} {plan.planningMode}
        </span>
        <span className="flex-1" />
        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-dim)' }}>
          {relTime(plan.updatedAt || plan.createdAt)}
        </span>
      </div>

      {/* Title */}
      <p
        className="text-[13px] font-mono font-bold leading-snug mb-1.5"
        style={{
          color: 'var(--text-primary)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {plan.title}
      </p>

      {/* Project + meta row */}
      <div className="flex items-center gap-3 mt-2">
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ background: 'var(--bg-surface)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}
        >
          {plan.project}
        </span>
        {plan.phaseCount > 0 && (
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
            {plan.phaseCount} phase{plan.phaseCount !== 1 ? 's' : ''}
          </span>
        )}
        {plan.assetCount > 0 && (
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
            {plan.assetCount} asset{plan.assetCount !== 1 ? 's' : ''}
          </span>
        )}
        {plan.archived && (
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>archived</span>
        )}
      </div>

      {/* Outcome snippet for completed plans */}
      {plan.outcome && (
        <p
          className="text-[11px] font-mono mt-2 leading-relaxed"
          style={{
            color: 'var(--text-dim)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {plan.outcome}
        </p>
      )}
    </button>
  )
}

// ─── Plan Detail Panel ───────────────────────────────────────────────────────

function PlanDetailPanel({ planId, onClose }: { planId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getPlanDetail({ data: { planId } })
      setDetail(result.plan)
    } catch (e: any) {
      setError(e.message || 'Failed to load plan')
    } finally {
      setLoading(false)
    }
  }, [planId])

  // Load when planId changes
  useEffect(() => { load() }, [load])

  const st = detail ? (STATUS_STYLES[detail.status] ?? STATUS_STYLES.abandoned) : null
  const md = detail ? (MODE_STYLES[detail.planningMode] ?? MODE_STYLES.sketch) : null

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Panel header */}
      <div
        className="flex items-center gap-3 px-5 py-3.5 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          onClick={onClose}
          className="text-[11px] font-mono px-2 py-1 rounded transition-colors flex-shrink-0"
          style={{ color: 'var(--text-dim)', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          ← Back
        </button>
        {detail && (
          <>
            <div className="flex items-center gap-2 min-w-0">
              {st && (
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-bold flex-shrink-0"
                  style={{ background: st.bg, color: st.color }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: st.dot }} />
                  {st.label}
                </span>
              )}
              <p className="text-xs font-mono font-bold truncate min-w-0" style={{ color: 'var(--text-primary)' }}>
                {detail.title}
              </p>
            </div>
            <span className="flex-1" />
            <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-dim)' }}>
              {detail.planId}
            </span>
          </>
        )}
      </div>

      {/* Loading / error */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs font-mono animate-pulse" style={{ color: 'var(--text-dim)' }}>Loading plan…</span>
        </div>
      )}
      {error && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-xs font-mono" style={{ color: '#f87171' }}>{error}</span>
        </div>
      )}

      {/* Detail content */}
      {!loading && !error && detail && (
        <div className="flex-1 overflow-y-auto pb-16 md:pb-0">
          {/* Meta strip */}
          <div
            className="px-5 py-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
          >
            <span className="text-[11px] font-mono" style={{ color: md?.color }}>
              {md?.icon} {detail.planningMode} mode
            </span>
            <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>
              project: <span style={{ color: 'var(--text-primary)' }}>{detail.project}</span>
            </span>
            {detail.phaseCount > 0 && (
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>
                {detail.phaseCount} phases
              </span>
            )}
            {detail.assetCount > 0 && (
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>
                {detail.assetCount} assets
              </span>
            )}
            {detail.ambiguityScore > 0 && (
              <span className="text-[11px] font-mono" style={{ color: 'var(--text-dim)' }}>
                ambiguity: {Math.round(detail.ambiguityScore * 100)}%
              </span>
            )}
            <span className="flex-1" />
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>
              created {relTime(detail.createdAt)}
            </span>
          </div>

          {/* Assets strip */}
          {detail.assets.length > 0 && (
            <div
              className="px-5 py-2.5 flex items-center gap-2 flex-wrap border-b"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
            >
              <span className="text-[10px] font-mono uppercase tracking-widest font-bold mr-1" style={{ color: 'var(--text-dim)' }}>Assets</span>
              {detail.assets.map((a, i) => (
                <span
                  key={i}
                  className="text-[10px] font-mono px-2 py-0.5 rounded"
                  style={{
                    background: a.type === 'diagram' ? 'rgba(59,130,246,0.1)' : a.type === 'screenshot' ? 'rgba(0,255,136,0.08)' : 'rgba(167,139,250,0.1)',
                    color: a.type === 'diagram' ? 'var(--accent-blue)' : a.type === 'screenshot' ? 'var(--accent-green)' : '#a78bfa',
                    border: '1px solid transparent',
                  }}
                >
                  {a.type === 'diagram' ? '◈' : a.type === 'screenshot' ? '📷' : '📄'} {a.label}
                </span>
              ))}
            </div>
          )}

          {/* Plan markdown content */}
          <div className="px-5 py-6">
            {detail.content ? (
              <MarkdownViewer content={detail.content} />
            ) : (
              <p className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>No content in plan.md</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function PlansPage() {
  const { plans: initialPlans, total: initialTotal } = Route.useLoaderData()

  const [plans, setPlans] = useState<PlanSummary[]>(initialPlans)
  const [total, setTotal] = useState(initialTotal)
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchPlans = useCallback(async (opts: {
    status?: string; search?: string; includeArchived?: boolean
  }) => {
    setLoading(true)
    try {
      const result = await getPlans({ data: opts })
      setPlans(result.plans)
      setTotal(result.total)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  const handleStatusChange = (key: string) => {
    setStatusFilter(key)
    setSelectedPlanId(null)
    fetchPlans({ status: key, search, includeArchived })
  }

  const handleSearchChange = (q: string) => {
    setSearch(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchPlans({ status: statusFilter, search: q, includeArchived })
    }, 220)
  }

  const handleArchivedToggle = () => {
    const next = !includeArchived
    setIncludeArchived(next)
    fetchPlans({ status: statusFilter, search, includeArchived: next })
  }

  // Counts per status for badges
  const countByStatus = initialPlans.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  if (selectedPlanId) {
    return (
      <div className="h-full overflow-hidden">
        <PlanDetailPanel planId={selectedPlanId} onClose={() => setSelectedPlanId(null)} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto pb-16 md:pb-0">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">

        {/* Header */}
        <div className="mb-7">
          <h2
            className="text-lg font-bold tracking-[0.25em] uppercase mb-1"
            style={{ color: 'var(--text-primary)' }}
          >
            Plans
          </h2>
          <p className="text-xs font-mono" style={{ color: 'var(--text-dim)' }}>
            {total} plan{total !== 1 ? 's' : ''} · search, filter, and view full plan details
          </p>
        </div>

        {/* Search bar */}
        <div
          className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl mb-5"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          <span style={{ color: 'var(--text-dim)', fontSize: '14px' }}>⌕</span>
          <input
            ref={searchRef}
            type="text"
            placeholder="Search plans by title, project, or ID…"
            value={search}
            onChange={e => handleSearchChange(e.target.value)}
            className="flex-1 bg-transparent text-sm font-mono outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          {loading && (
            <span className="text-[10px] font-mono animate-pulse" style={{ color: 'var(--text-dim)' }}>
              searching…
            </span>
          )}
          {search && (
            <button
              onClick={() => handleSearchChange('')}
              className="text-[11px] font-mono"
              style={{ color: 'var(--text-dim)' }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Status filter tabs */}
        <div className="flex items-center gap-1 mb-5 overflow-x-auto pb-1">
          {STATUS_TABS.map(tab => {
            const count = tab.key === 'all'
              ? initialPlans.length
              : (countByStatus[tab.key] || 0)
            const active = statusFilter === tab.key
            return (
              <button
                key={tab.key}
                onClick={() => handleStatusChange(tab.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold transition-colors flex-shrink-0"
                style={{
                  background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-dim)',
                  border: `1px solid ${active ? 'rgba(255,255,255,0.12)' : 'transparent'}`,
                }}
              >
                {tab.label}
                {count > 0 && (
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[9px]"
                    style={{
                      background: active ? 'rgba(255,255,255,0.12)' : 'var(--bg-elevated)',
                      color: active ? 'var(--text-primary)' : 'var(--text-dim)',
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
          <span className="flex-1" />
          <button
            onClick={handleArchivedToggle}
            className="px-3 py-1.5 rounded-lg text-[11px] font-mono font-bold transition-colors flex-shrink-0"
            style={{
              background: includeArchived ? 'rgba(255,255,255,0.06)' : 'transparent',
              color: includeArchived ? 'var(--text-primary)' : 'var(--text-dim)',
              border: `1px solid ${includeArchived ? 'rgba(255,255,255,0.1)' : 'transparent'}`,
            }}
          >
            {includeArchived ? '◉' : '○'} Archived
          </button>
        </div>

        {/* Plan list */}
        {plans.length === 0 ? (
          <div
            className="text-center py-20 rounded-xl"
            style={{ border: '1px dashed var(--border)' }}
          >
            <p className="text-sm font-mono mb-2" style={{ color: 'var(--text-dim)' }}>
              {search ? `No plans matching "${search}"` : 'No plans found'}
            </p>
            <p className="text-xs font-mono" style={{ color: 'var(--text-dim)', opacity: 0.5 }}>
              Create a plan with{' '}
              <code
                className="px-1.5 py-0.5 rounded"
                style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
              >
                hq_call plan_create
              </code>
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {plans.map(plan => (
              <PlanCard
                key={plan.planId}
                plan={plan}
                selected={selectedPlanId === plan.planId}
                onClick={() => setSelectedPlanId(plan.planId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
