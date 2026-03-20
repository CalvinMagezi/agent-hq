import { useHQStore } from "../store/hqStore";

export const RelayPanel = () => {
    const agents = useHQStore(s => s.agents);
    // Filter only relays
    const relays = agents.filter(a => a.relayId || a.id?.startsWith("relay-"));

    return (
        <div className="hq-panel p-4 flex flex-col h-full">
            <h2 className="hq-header mb-4">Relay Status</h2>
            <div className="flex-1 space-y-3">
                {relays.length === 0 ? (
                    <div className="text-text-dim text-sm italic py-4 text-center">No relays found</div>
                ) : (
                    relays.map((relay, i) => {
                        const isHealthy = relay.status === "healthy" || relay.status === "online";
                        const name = relay.relayId || relay.id;

                        return (
                            <div key={i} className="flex items-center justify-between">
                                <span className="text-sm">{name}</span>
                                <div className="flex items-center gap-2">
                                    <span className={`status-dot ${isHealthy ? 'active' : 'error'}`} />
                                    <span className={`text-xs ${isHealthy ? 'text-text-primary' : 'text-accent-red'}`}>
                                        {isHealthy ? 'healthy' : 'offline'}
                                    </span>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};
