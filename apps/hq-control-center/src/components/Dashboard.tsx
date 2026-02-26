import { useSystemStore } from '../store/system-store';
import { useRelayStore } from '../store/relay-store';

export function Dashboard() {
    const {
        cpuUsagePercent, memUsedMB, memTotalMB,
        daemonRunning, daemonUptime
    } = useSystemStore();

    const {
        connected,
        systemStatus,
        activeJobs,
        traces,
        agents
    } = useRelayStore();

    const formatUptime = (ms: number | null) => {
        if (!ms) return '0s';
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        if (h > 0) return `${h}h ${m % 60}m`;
        if (m > 0) return `${m}m ${s % 60}s`;
        return `${s}s`;
    };

    return (
        <div className="dashboard-container">
            <header className="dash-header">
                <h2>System Nervous System</h2>
                <div className="badges">
                    <span className={`badge ${daemonRunning ? 'active' : 'inactive'}`}>
                        Daemon {daemonRunning ? 'Running' : 'Stopped'} ({formatUptime(daemonUptime)})
                    </span>
                    <span className={`badge ${connected ? 'active' : 'inactive'}`}>
                        Relay {connected ? 'Connected' : 'Offline'}
                    </span>
                </div>
            </header>

            <section className="metrics-grid">
                <div className="metric-card">
                    <h3>CPU Usage</h3>
                    <div className="metric-value">{cpuUsagePercent}%</div>
                    <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${cpuUsagePercent}%` }} />
                    </div>
                </div>
                <div className="metric-card">
                    <h3>Memory</h3>
                    <div className="metric-value">{memUsedMB} / {memTotalMB} MB</div>
                    <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${Math.min(100, (memUsedMB / (memTotalMB || 1)) * 100)}%` }} />
                    </div>
                </div>
                <div className="metric-card">
                    <h3>Active Agents</h3>
                    <div className="metric-value">{agents.filter((a: any) => a.status !== 'offline').length}</div>
                    <div className="sub-text">{agents.length} Total Workers</div>
                </div>
                <div className="metric-card">
                    <h3>Pending Jobs</h3>
                    <div className="metric-value">{systemStatus?.pendingJobs || 0}</div>
                    <div className="sub-text">{activeJobs.size} Currently Tracking</div>
                </div>
            </section>

            <section className="jobs-section">
                <h3>Active Traces</h3>
                {traces.size === 0 ? (
                    <p className="empty-state">No active traces</p>
                ) : (
                    <div className="trace-list">
                        {Array.from(traces.values()).map(trace => (
                            <div key={trace.traceId} className="trace-card">
                                <div className="trace-header">
                                    <strong>{trace.jobId.slice(0, 8)}</strong>
                                    <span>{trace.summary}</span>
                                </div>
                                <div className="progress-bar">
                                    <div className="progress-fill" style={{
                                        width: `${(trace.completedTasks / (trace.totalTasks || 1)) * 100}%`
                                    }} />
                                </div>
                                {trace.latestEvent?.message && (
                                    <div className="trace-latest">
                                        Last Event: {trace.latestEvent.message}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
