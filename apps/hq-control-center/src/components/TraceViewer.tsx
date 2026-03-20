import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronRight, ChevronDown, Activity, Clock, CheckCircle, XCircle } from 'lucide-react'

// Basic types matching TraceDB
type Status = 'active' | 'completed' | 'failed' | 'cancelled'
interface Span {
    spanId: string
    parentSpanId: string | null
    taskId: string | null
    type: string
    name: string
    status: Status
    startedAt: number
    completedAt: number | null
}
interface TraceTree {
    traceId: string
    jobId: string
    rootInstruction: string | null
    status: Status
    startedAt: number
    completedAt: number | null
    spans: Span[]
}

const STATUS_ICONS = {
    active: <Activity className="w-4 h-4 text-indigo-400" />,
    completed: <CheckCircle className="w-4 h-4 text-emerald-500" />,
    failed: <XCircle className="w-4 h-4 text-rose-500" />,
    cancelled: <XCircle className="w-4 h-4 text-slate-500" />,
}

function formatDuration(start: number, end: number | null) {
    const ms = (end ?? Date.now()) - start
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

function SpanNode({ span, spans, depth = 0, traceStart, traceEnd }: { span: Span, spans: Span[], depth?: number, traceStart: number, traceEnd: number }) {
    const [expanded, setExpanded] = useState(true)
    const children = spans.filter(s => s.parentSpanId === span.spanId).sort((a, b) => a.startedAt - b.startedAt)

    // Calculate relative position and width for a mini-gantt bar
    // If trace is ongoing, use Date.now() for scaling
    const totalDuration = Math.max(100, traceEnd - traceStart)
    const spanStartOffset = span.startedAt - traceStart
    const spanDuration = (span.completedAt ?? Date.now()) - span.startedAt

    const leftPct = Math.max(0, Math.min(100, (spanStartOffset / totalDuration) * 100))
    const widthPct = Math.max(1, Math.min(100 - leftPct, (spanDuration / totalDuration) * 100))

    return (
        <div className="flex flex-col text-sm border-l border-slate-800/50">
            <div
                className="flex items-center group hover:bg-slate-800/30 py-1.5 px-2 rounded-r transition-colors cursor-default"
                style={{ paddingLeft: `${depth * 1.5}rem` }}
            >
                <div className="w-4 h-4 mr-2 flex items-center justify-center shrink-0">
                    {children.length > 0 ? (
                        <button onClick={() => setExpanded(!expanded)} className="text-slate-500 hover:text-slate-300">
                            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                    ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />
                    )}
                </div>

                <div className="flex items-center w-64 shrink-0 overflow-hidden pr-4">
                    <span className="mr-2 shrink-0">{STATUS_ICONS[span.status]}</span>
                    <span className="font-mono text-xs text-slate-300 truncate" title={span.name}>
                        {span.name}
                    </span>
                </div>

                {/* Gantt Bar Area */}
                <div className="flex-1 relative h-6 flex items-center min-w-[200px]">
                    {/* Background grid lines could go here */}
                    <div
                        className={`absolute h-4 rounded-sm transition-all duration-300 ${span.status === 'active' ? 'bg-indigo-500/80 shadow-[0_0_8px_rgba(99,102,241,0.4)]' : span.status === 'failed' ? 'bg-rose-500/80' : 'bg-slate-600/80'}`}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '4px' }}
                    />
                </div>

                <div className="w-20 text-right shrink-0 ml-4 font-mono text-xs text-slate-500 flex items-center justify-end">
                    <Clock className="w-3 h-3 mr-1 inline-block opacity-50" />
                    {formatDuration(span.startedAt, span.completedAt)}
                </div>
            </div>

            {expanded && children.length > 0 && (
                <div className="flex flex-col">
                    {children.map(child => (
                        <SpanNode key={child.spanId} span={child} spans={spans} depth={depth + 1} traceStart={traceStart} traceEnd={traceEnd} />
                    ))}
                </div>
            )}
        </div>
    )
}

function TraceCard({ trace }: { trace: TraceTree }) {
    // Find root spans (those without parentSpanId, or parentSpanId that doesn't exist in the list)
    const spanIds = new Set(trace.spans.map(s => s.spanId))
    const roots = trace.spans.filter(s => !s.parentSpanId || !spanIds.has(s.parentSpanId)).sort((a, b) => a.startedAt - b.startedAt)

    const traceEnd = trace.completedAt ?? Date.now()
    const traceStart = trace.startedAt

    return (
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-lg overflow-hidden flex flex-col">
            <div className="bg-slate-800/40 px-4 py-3 border-b border-slate-800/60 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    {STATUS_ICONS[trace.status]}
                    <div className="flex flex-col">
                        <span className="font-mono text-xs text-slate-200 font-bold tracking-tight">Trace: {trace.traceId}</span>
                        <span className="font-mono text-[10px] text-slate-500">Job: {trace.jobId}</span>
                    </div>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono text-slate-400">
                    <span>{trace.spans.length} spans</span>
                    <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {formatDuration(traceStart, traceEnd)}</span>
                </div>
            </div>

            <div className="p-2 overflow-x-auto">
                <div className="min-w-[600px] flex flex-col py-2">
                    {roots.length > 0 ? roots.map(root => (
                        <SpanNode key={root.spanId} span={root} spans={trace.spans} traceStart={traceStart} traceEnd={traceEnd} />
                    )) : (
                        <div className="text-center py-4 text-xs font-mono text-slate-500">No spans recorded</div>
                    )}
                </div>
            </div>
        </div>
    )
}

export function TraceViewer() {
    const [traces, setTraces] = useState<TraceTree[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let mounted = true
        const fetchTraces = async () => {
            try {
                const res = await fetch(`${window.location.origin}/traces`)
                if (!res.ok) throw new Error('Failed to fetch traces list')
                const data = await res.json()

                const activeIds = (data.traces || []).map((t: any) => t.traceId)

                const trees = await Promise.all(activeIds.map(async (id: string) => {
                    const tres = await fetch(`${window.location.origin}/traces/${id}`)
                    if (!tres.ok) return null
                    const tdata = await tres.json()
                    return tdata.trace
                }))

                if (mounted) {
                    setTraces(trees.filter(Boolean))
                    setError(null)
                }
            } catch (err: any) {
                if (mounted) setError(err.message)
            } finally {
                if (mounted) setLoading(false)
            }
        }

        fetchTraces()
        const int = setInterval(fetchTraces, 3000)
        return () => { mounted = false; clearInterval(int) }
    }, [])

    if (loading && traces.length === 0) {
        return <div className="hq-panel p-6 flex justify-center text-slate-500 text-sm font-mono animate-pulse">Loading Orchestration Traces...</div>
    }

    if (error) {
        // If the trace API fails (e.g. no DB yet), silently hide or show small message
        return null
    }

    if (traces.length === 0) {
        return null // Only show trace viewer when there are active traces
    }

    return (
        <div className="hq-panel overflow-hidden mb-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/50">
                <h2 className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-0 flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5" />
                    Active Orchestration Traces
                </h2>
                <span className="text-xs bg-indigo-500/20 text-indigo-400 px-2 py-0.5 rounded font-mono border border-indigo-500/30">
                    {traces.length} Live
                </span>
            </div>

            <div className="flex flex-col gap-4 p-4 max-h-[500px] overflow-y-auto custom-scrollbar bg-slate-950/30">
                {traces.map(trace => (
                    <TraceCard key={trace.traceId} trace={trace} />
                ))}
            </div>
        </div>
    )
}
