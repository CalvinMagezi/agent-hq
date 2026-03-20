import { ServerWebSocket } from "bun";
import { vaultClient, vaultSync } from "./context";
import type { WsMessage } from "../shared/types"; // Need to create this types file later

// Keep track of connected clients
const clients = new Set<ServerWebSocket<any>>();

export function handleWsOpen(ws: ServerWebSocket<any>) {
    clients.add(ws);
    // Send initial snapshot (to be implemented)
    sendSnapshot(ws);
}

export function handleWsClose(ws: ServerWebSocket<any>) {
    clients.delete(ws);
}

export function handleWsMessage(ws: ServerWebSocket<any>, message: string | Buffer) {
    try {
        const data = JSON.parse(message.toString());
        if (data.type === "pong") {
            // Handle pong keepalive
        }
    } catch (e) {
        // ignore
    }
}

// Subscribe to VaultSync events
vaultSync.eventBus.on("*", async (event) => {
    // Translate vault events to WS events and fan out
    if (event.type.startsWith("job:")) {
        // Fetch updated job details if needed or just broadcast the event
        // For simplicity, we can fetch the job from the job queue if it's not a deletion
        broadcast({ type: "event", event });
    } else if (event.type.startsWith("task:") || event.type === "system:modified" || event.type.startsWith("note:")) {
        broadcast({ type: "event", event });
    }
});

function broadcast(msg: any) {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
        client.send(payload);
    }
}

async function sendSnapshot(ws: ServerWebSocket<any>) {
    // Implement full state snapshot payload
    ws.send(JSON.stringify({ type: "snapshot", data: {} }));
}
