import { useHQStore } from '~/store/hqStore'

export function EventLog() {
    const eventLog = useHQStore((state) => state.eventLog)

    return (
        <div className="hq-panel h-64 flex flex-col">
            <div className="p-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <h2 className="text-xs font-mono tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>Live Event Log</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {eventLog.length === 0 ? (
                    <div className="text-xs italic text-center py-4" style={{ color: 'var(--text-dim)' }}>Waiting for events...</div>
                ) : (
                    eventLog.map((event, i) => {
                        let color = 'var(--text-dim)'
                        if (event.type.startsWith('job:')) color = 'var(--accent-green)'
                        else if (event.type.startsWith('note:')) color = 'var(--accent-blue)'
                        else if (event.type.startsWith('system:')) color = 'var(--accent-amber)'
                        else if (event.type.includes('error')) color = 'var(--accent-red)'

                        return (
                            <div key={i} className="flex flex-col gap-1 text-xs font-mono p-2 rounded" style={{ background: 'var(--bg-base)' }}>
                                <div className="flex justify-between items-center">
                                    <span style={{ color }} className="font-bold">{event.type}</span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
                                        {event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''}
                                    </span>
                                </div>
                                {event.path && (
                                    <div className="text-[10px] break-all truncate" style={{ color: 'var(--text-primary)', opacity: 0.8 }}>
                                        {event.path.split('/').pop()}
                                    </div>
                                )}
                            </div>
                        )
                    })
                )}
            </div>
        </div>
    )
}
