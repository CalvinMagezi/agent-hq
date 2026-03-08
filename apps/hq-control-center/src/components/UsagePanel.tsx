import type { UsageResult } from '~/server/usage'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

interface Props {
  usage: UsageResult
}

export function UsagePanel({ usage }: Props) {
  const { today, month, budget, dailyTrend, byModel } = usage
  const pct = budget > 0 ? Math.min((month / budget) * 100, 100) : 0

  const ringColor =
    pct > 90 ? 'var(--accent-red)' : pct > 70 ? 'var(--accent-amber)' : 'var(--accent-green)'

  return (
    <div className="hq-panel h-full flex flex-col p-4">
      <div className="flex justify-between items-center mb-4">
        <div className="hq-section-title mb-0">Usage & Costs</div>
        <div className="text-right">
          <div className="text-xl font-mono font-bold" style={{ color: ringColor }}>${month.toFixed(2)}</div>
          <div className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">/ ${budget.toFixed(0)} Budget</div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Trend line chart */}
        <div className="h-40 lg:h-full w-full bg-slate-900/40 rounded-lg border border-slate-800/60 p-3 flex flex-col">
          <div className="flex justify-between items-center mb-2">
            <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">30-Day Trend</p>
            <span className="text-xs font-mono text-slate-400">Today: ${today.toFixed(2)}</span>
          </div>
          <div className="flex-1 min-h-[100px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyTrend}>
                <XAxis dataKey="date" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '8px', zIndex: 100 }}
                  itemStyle={{ color: '#818cf8', fontWeight: 'bold', fontSize: '13px' }}
                  labelStyle={{ color: '#94a3b8', fontSize: '12px', marginBottom: '4px' }}
                  formatter={(val: any) => [`$${Number(val).toFixed(4)}`, 'Cost']}
                />
                <Line type="monotone" dataKey="cost" stroke="#818cf8" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#818cf8', stroke: '#1e1e2f', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Bar chart */}
        <div className="h-48 lg:h-full w-full bg-slate-900/40 rounded-lg border border-slate-800/60 p-3 flex flex-col">
          <p className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-2">Cost By Model</p>
          <div className="flex-1 min-h-[100px]">
            {byModel && byModel.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byModel} layout="vertical" margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis dataKey="model" type="category" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={100} tickFormatter={(val) => val.split('/').pop() || val} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '8px', zIndex: 100 }}
                    itemStyle={{ color: '#34d399', fontWeight: 'bold', fontSize: '13px' }}
                    labelStyle={{ color: '#94a3b8', fontSize: '12px', marginBottom: '4px' }}
                    formatter={(val: any) => [`$${Number(val).toFixed(4)}`, 'Cost']}
                  />
                  <Bar dataKey="cost" fill="#34d399" radius={[0, 4, 4, 0]} barSize={14} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-slate-600 font-mono">
                No usage data
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
