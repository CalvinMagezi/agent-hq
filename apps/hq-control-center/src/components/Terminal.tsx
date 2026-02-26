import { useEffect, useRef } from 'react';
import { useSystemStore } from '../store/system-store';

export function Terminal() {
    const { daemonLogs } = useSystemStore();
    const terminalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [daemonLogs]);

    const toggleDaemon = async () => {
        const running = useSystemStore.getState().daemonRunning;
        if (running) {
            await window.electronAPI.stopDaemon();
        } else {
            await window.electronAPI.startDaemon();
        }
    };

    return (
        <div className="terminal-container flex flex-col h-full bg-[#0a0a0f] text-[#e4e4e7]">
            <div className="terminal-header flex justify-between items-center p-4 border-b border-gray-800">
                <h2 className="text-xl font-bold">Agent HQ Daemon</h2>
                <button
                    onClick={toggleDaemon}
                    className={`px-4 py-2 rounded font-semibold transition-colors ${useSystemStore().daemonRunning
                        ? 'bg-red-500 hover:bg-red-600 text-white'
                        : 'bg-green-500 hover:bg-green-600 text-white'
                        }`}
                >
                    {useSystemStore().daemonRunning ? 'Stop HQ' : 'Boot HQ'}
                </button>
            </div>
            <div
                className="terminal-output flex-1 overflow-y-auto p-4 font-mono text-sm"
                ref={terminalRef}
            >
                {daemonLogs.length === 0 ? (
                    <div className="text-gray-500 italic">No output yet. Boot HQ to start.</div>
                ) : (
                    daemonLogs.map((log, i) => (
                        <div key={i} className={`log-line mb-1 ${log.stream === 'stderr' ? 'text-red-400' : 'text-gray-300'}`}>
                            <span className="text-gray-600 mr-2">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                            {log.data}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
