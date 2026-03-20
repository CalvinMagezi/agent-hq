import { useEffect, useRef } from 'react';
import { useHQStore } from '../store/hqStore';

export function useWebSocket() {
    const ws = useRef<WebSocket | null>(null);
    const { setWsConnected, updateJob, updateAgent } = useHQStore();

    useEffect(() => {
        // Connect to WebSocket using current host but ws:// protocol
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;

        // During dev (Vite proxy) this points to Vite which proxies to Bun server ws route
        const wsUrl = `${protocol}//${host}/ws`;

        const connect = () => {
            ws.current = new WebSocket(wsUrl);

            ws.current.onopen = () => {
                setWsConnected(true);
            };

            ws.current.onclose = () => {
                setWsConnected(false);
                // Quick reconnect
                setTimeout(connect, 3000);
            };

            ws.current.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);

                    if (message.type === 'snapshot') {
                        // Fill initial store state if backend sends it all over WS
                        // For now relying on REST API for initial load
                    } else if (message.type === 'event') {
                        // Handle specific VaultSync events
                        const vEvent = message.event;

                        if (vEvent.type.startsWith('job:')) {
                            // Fire job update logic - ideally we'd fetch the updated job
                            // Or the backend would send the partial job state
                        }
                    }

                } catch (err) {
                    console.error("Failed to parse WS msg", err);
                }
            };
        };

        connect();

        return () => {
            if (ws.current) {
                ws.current.close();
            }
        };
    }, []);

    return ws;
}
